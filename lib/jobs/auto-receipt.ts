// Daily job that detects shipments which appear to have arrived (stock
// jump matches an overdue PO's quantity) and inserts receipts for them.
// Runs after the normal ingest so today's stock_snapshots is already
// in place.

import { asc, desc, eq, inArray, lt, lte } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  dailySales,
  incomingReceipts,
  incomingShipments,
  stockSnapshots,
} from "@/lib/db/schema";
import { detectAutoReceipts, type StockSnapshot, type OverduePO } from "@/lib/domain/auto-receipt";
import { getReceivedShipmentKeys, shipmentReceiptKey } from "@/lib/queries/incoming";
import { logger } from "@/lib/logger";

function locationToChannel(location: "US" | "CN"): "shopify_us" | "shopify_intl" {
  return location === "US" ? "shopify_us" : "shopify_intl";
}

export async function runAutoReceiptDetection(input: {
  /** YYYY-MM-DD; treated as "the most recent fully-stocked day".
   * Snapshots dated today are the "after" side; the day before is "before". */
  asOfDate: string;
}): Promise<{
  matched: number;
  inserted: number;
}> {
  const today = input.asOfDate;
  // "Yesterday" = the most recent snapshot date strictly before today,
  // NOT calendar today-1. Snapshot dates have gaps (days the inventory
  // sheet wasn't refreshed), and a calendar-yesterday with no snapshot
  // makes the day-over-day diff silently skip — so an arrival landing
  // right after a gap (e.g. the 2026-05-17 KAI deliveries, with 05-16
  // missing) would never be detected. Diffing against the prior SNAPSHOT
  // date makes this gap-resilient.
  const priorDateRows = await db
    .selectDistinct({ d: stockSnapshots.snapshotDate })
    .from(stockSnapshots)
    .where(lt(stockSnapshots.snapshotDate, today))
    .orderBy(desc(stockSnapshots.snapshotDate))
    .limit(1);
  const yesterday = priorDateRows[0]?.d;
  if (!yesterday) {
    logger.info("auto-receipt.skip.no-prior-snapshot", { today });
    return { matched: 0, inserted: 0 };
  }

  // Pull today + yesterday snapshots in one query.
  const allSnapshots = await db
    .select({
      sku: stockSnapshots.sku,
      location: stockSnapshots.location,
      snapshotDate: stockSnapshots.snapshotDate,
      onHand: stockSnapshots.onHand,
    })
    .from(stockSnapshots)
    .where(inArray(stockSnapshots.snapshotDate, [today, yesterday]))
    .orderBy(asc(stockSnapshots.snapshotDate));
  const todayRows: StockSnapshot[] = [];
  const yesterdayRows: StockSnapshot[] = [];
  for (const r of allSnapshots) {
    if (r.snapshotDate === today) todayRows.push(r as StockSnapshot);
    else if (r.snapshotDate === yesterday) yesterdayRows.push(r as StockSnapshot);
  }
  if (todayRows.length === 0 || yesterdayRows.length === 0) {
    logger.info("auto-receipt.skip.no-snapshots", { today, yesterday });
    return { matched: 0, inserted: 0 };
  }

  // Sales that happened today, per sku × location. Used to "back out"
  // same-day depletion so a delivery netted by sales still matches.
  const salesRows = await db
    .select({
      sku: dailySales.sku,
      channel: dailySales.channel,
      unitsSold: dailySales.unitsSold,
    })
    .from(dailySales)
    .where(eq(dailySales.salesDate, today));
  const todaySales = salesRows.map((r) => ({
    sku: r.sku,
    location: r.channel === "shopify_us" ? ("US" as const) : ("CN" as const),
    units: r.unitsSold,
  }));

  // Overdue POs: ETA <= today AND no receipt yet.
  const allOverdue = await db
    .select()
    .from(incomingShipments)
    .where(lte(incomingShipments.expectedArrival, today));
  const receivedKeys = await getReceivedShipmentKeys();
  const overduePOs: OverduePO[] = [];
  for (const r of allOverdue) {
    const k = shipmentReceiptKey({
      shipmentName: r.shipmentName,
      destination: r.destination,
      expectedArrival: r.expectedArrival,
    });
    if (receivedKeys.has(k)) continue;
    overduePOs.push({
      sku: r.sku,
      destination: r.destination,
      shipmentName: r.shipmentName,
      expectedArrival: r.expectedArrival,
      quantity: r.quantity,
    });
  }

  const matches = detectAutoReceipts({
    todaySnapshots: todayRows,
    yesterdaySnapshots: yesterdayRows,
    todaySales,
    overduePOs,
  });

  if (matches.length === 0) {
    logger.info("auto-receipt.no-matches", { today, overdueCount: overduePOs.length });
    return { matched: 0, inserted: 0 };
  }

  // Multiple SKUs from the same product can each independently fire on
  // the same shipment (PO of bshort in 8 sizes → 8 stock jumps, each
  // matches a per-SKU PO row, all share shipmentName). De-dupe by
  // natural key before inserting.
  const seen = new Set<string>();
  const uniqueMatches = matches.filter((m) => {
    const k = shipmentReceiptKey({
      shipmentName: m.shipmentName,
      destination: m.destination,
      expectedArrival: m.expectedArrival,
    });
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  let inserted = 0;
  for (const m of uniqueMatches) {
    const result = await db
      .insert(incomingReceipts)
      .values({
        shipmentName: m.shipmentName,
        destination: m.destination,
        expectedArrival: m.expectedArrival,
        note: `Auto-detected ${today}: ${m.reasoning}`,
      })
      .onConflictDoNothing({
        target: [
          incomingReceipts.shipmentName,
          incomingReceipts.destination,
          incomingReceipts.expectedArrival,
        ],
      })
      .returning({ id: incomingReceipts.id });
    if (result.length > 0) inserted += 1;
  }

  logger.info("auto-receipt.done", {
    today,
    matched: matches.length,
    uniqueMatches: uniqueMatches.length,
    inserted,
  });
  return { matched: matches.length, inserted };
}
