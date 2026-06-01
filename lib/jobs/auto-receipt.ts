// Daily job that detects shipments which appear to have arrived (stock
// jump matches an overdue PO's quantity) and inserts receipts for them.
// Runs after the normal ingest so today's stock_snapshots is already
// in place.

import { and, gte, inArray, lte } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  dailySales,
  incomingReceipts,
  incomingShipments,
  stockSnapshots,
} from "@/lib/db/schema";
import {
  detectAutoReceipts,
  selectSnapshotWindow,
  type WindowRow,
  type OverduePO,
} from "@/lib/domain/auto-receipt";
import { getReceivedShipmentKeys, shipmentReceiptKey } from "@/lib/queries/incoming";
import { logger } from "@/lib/logger";

/** asOfDate (YYYY-MM-DD) minus n days, in UTC, as YYYY-MM-DD. */
function isoMinusDays(ymd: string, n: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
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
  // Pull a recent window of snapshots and let the domain helper pick each
  // location's OWN latest two snapshot dates for the day-over-day diff.
  //
  // Why per-location: a single global today/yesterday breaks when the US and
  // CN inventory tabs advance their newest dated column on different days
  // (observed from 2026-05-30) — each tab is ingested under its own latest
  // date, so the global diff straddles regions (today's US vs yesterday's CN)
  // and silently detects nothing. Per-location pairing also stays gap-resilient
  // (a location that skipped a day pairs its latest with the date that
  // actually precedes it — e.g. the 2026-05-17 KAI deliveries with 05-16
  // missing). The window reaches back far enough to survive multi-day gaps.
  const WINDOW_DAYS = 21;
  const windowStart = isoMinusDays(today, WINDOW_DAYS);
  const windowRows: WindowRow[] = await db
    .select({
      sku: stockSnapshots.sku,
      location: stockSnapshots.location,
      snapshotDate: stockSnapshots.snapshotDate,
      onHand: stockSnapshots.onHand,
    })
    .from(stockSnapshots)
    .where(
      and(
        gte(stockSnapshots.snapshotDate, windowStart),
        lte(stockSnapshots.snapshotDate, today),
      ),
    );

  const {
    afterByLocation,
    beforeByLocation,
    todaySnapshots: todayRows,
    yesterdaySnapshots: yesterdayRows,
  } = selectSnapshotWindow({ rows: windowRows, asOfDate: today });

  if (todayRows.length === 0 || yesterdayRows.length === 0) {
    logger.info("auto-receipt.skip.no-snapshots", {
      today,
      after: Object.fromEntries(afterByLocation),
      before: Object.fromEntries(beforeByLocation),
    });
    return { matched: 0, inserted: 0 };
  }

  // Same-day sales to back out same-day depletion so a delivery partly sold
  // the same day still matches its PO quantity. Aligned PER LOCATION to that
  // location's own "after" date (which may differ from another region's).
  const afterDates = Array.from(new Set(afterByLocation.values()));
  const salesRows = afterDates.length
    ? await db
        .select({
          sku: dailySales.sku,
          channel: dailySales.channel,
          salesDate: dailySales.salesDate,
          unitsSold: dailySales.unitsSold,
        })
        .from(dailySales)
        .where(inArray(dailySales.salesDate, afterDates))
    : [];
  const todaySales = salesRows
    .map((r) => ({
      sku: r.sku,
      location: (r.channel === "shopify_us" ? "US" : "CN") as "US" | "CN",
      units: r.unitsSold,
      salesDate: r.salesDate,
    }))
    .filter((r) => afterByLocation.get(r.location) === r.salesDate)
    .map(({ sku, location, units }) => ({ sku, location, units }));

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
