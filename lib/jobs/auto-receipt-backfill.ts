// One-time backfill for the auto-receipt detector.
//
// Scott 2026-05-06: "One time fix for old orders manually marking them
// is also fine. As long as it works going forward." This script walks
// the historical stock_snapshots day-by-day and reuses the same
// detector to catch deliveries we missed before the live job existed.
//
// Strategy:
//  1. Pull all distinct snapshot dates in the requested window.
//  2. For each consecutive pair (D, D+1), run the same detector that
//     runs in the daily cron.
//  3. Insert any matches as receipts with received_at = D+1 (so the
//     audit trail reflects when the delivery actually showed up in
//     stock).
//
// Idempotency: an existing receipt for the same (shipment, dest, ETA)
// blocks a duplicate insert via the natural-key unique index, AND we
// skip already-received shipments before running detection.
//
// We treat the current incoming_shipments table as historical truth.
// In practice the sheet is mostly stable across the backfill window,
// so a PO present today was also present a week ago. Edge cases (POs
// added today that didn't exist on D+1) won't false-positive because
// the stock-jump pattern is what gates the match.

import { asc, eq, inArray, lte } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  dailySales,
  incomingReceipts,
  incomingShipments,
  stockSnapshots,
} from "@/lib/db/schema";
import {
  detectAutoReceipts,
  type OverduePO,
  type StockSnapshot,
} from "@/lib/domain/auto-receipt";
import { getReceivedShipmentKeys, shipmentReceiptKey } from "@/lib/queries/incoming";
import { logger } from "@/lib/logger";

export type AutoReceiptBackfillResult = {
  /** Snapshot date pairs walked (D, D+1). */
  pairsScanned: number;
  /** Distinct shipments matched across the run. */
  shipmentsMatched: number;
  /** Receipts actually inserted (duplicates excluded). */
  inserted: number;
  /** First and last snapshot dates considered. */
  firstDate: string | null;
  lastDate: string | null;
};

export async function runAutoReceiptBackfill(input: {
  /** How far back to walk (in days from today). Default 30. */
  daysBack?: number;
} = {}): Promise<AutoReceiptBackfillResult> {
  const start = Date.now();
  const daysBack = Math.max(1, Math.min(input.daysBack ?? 30, 90));

  // 1. Collect distinct snapshot dates within the window.
  const allDateRows = await db
    .selectDistinct({ snapshotDate: stockSnapshots.snapshotDate })
    .from(stockSnapshots)
    .orderBy(asc(stockSnapshots.snapshotDate));
  const dates = allDateRows.map((r) => r.snapshotDate).slice(-daysBack - 1);
  if (dates.length < 2) {
    logger.info("auto-receipt-backfill.skip.insufficient-history", {
      datesAvailable: dates.length,
    });
    return {
      pairsScanned: 0,
      shipmentsMatched: 0,
      inserted: 0,
      firstDate: dates[0] ?? null,
      lastDate: dates[dates.length - 1] ?? null,
    };
  }

  // 2. Pull current incoming_shipments + receipts ONCE — they're the
  //    truth set we walk against. Skip any shipment already received.
  const allPOs = await db.select().from(incomingShipments);
  const receivedKeys = await getReceivedShipmentKeys();

  const matchedKeys = new Set<string>(); // shipments matched this run

  let inserted = 0;
  let shipmentsMatched = 0;
  let pairsScanned = 0;

  for (let i = 0; i < dates.length - 1; i++) {
    const yesterday = dates[i];
    const today = dates[i + 1];
    pairsScanned++;

    // Snapshots for the pair.
    const snapsAll = await db
      .select({
        sku: stockSnapshots.sku,
        location: stockSnapshots.location,
        snapshotDate: stockSnapshots.snapshotDate,
        onHand: stockSnapshots.onHand,
      })
      .from(stockSnapshots)
      .where(inArray(stockSnapshots.snapshotDate, [yesterday, today]));
    const yesterdaySnapshots: StockSnapshot[] = [];
    const todaySnapshots: StockSnapshot[] = [];
    for (const r of snapsAll) {
      if (r.snapshotDate === today) todaySnapshots.push(r as StockSnapshot);
      else yesterdaySnapshots.push(r as StockSnapshot);
    }
    if (todaySnapshots.length === 0 || yesterdaySnapshots.length === 0) continue;

    // Sales on `today`.
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
      location: (r.channel === "shopify_us" ? "US" : "CN") as "US" | "CN",
      units: r.unitsSold,
    }));

    // POs that would have been overdue on `today` and not yet
    // received (excluding ones we matched earlier in this backfill run).
    const overduePOs: OverduePO[] = [];
    for (const r of allPOs) {
      if (r.expectedArrival > today) continue;
      const k = shipmentReceiptKey({
        shipmentName: r.shipmentName,
        destination: r.destination,
        expectedArrival: r.expectedArrival,
      });
      if (receivedKeys.has(k)) continue;
      if (matchedKeys.has(k)) continue;
      overduePOs.push({
        sku: r.sku,
        destination: r.destination,
        shipmentName: r.shipmentName,
        expectedArrival: r.expectedArrival,
        quantity: r.quantity,
      });
    }
    if (overduePOs.length === 0) continue;

    const matches = detectAutoReceipts({
      todaySnapshots,
      yesterdaySnapshots,
      todaySales,
      overduePOs,
    });
    if (matches.length === 0) continue;

    // De-dupe by shipment natural key — multiple SKUs of the same
    // shipment can fire independently in a single pair.
    const seen = new Set<string>();
    for (const m of matches) {
      const k = shipmentReceiptKey({
        shipmentName: m.shipmentName,
        destination: m.destination,
        expectedArrival: m.expectedArrival,
      });
      if (seen.has(k)) continue;
      seen.add(k);
      if (matchedKeys.has(k)) continue;

      const result = await db
        .insert(incomingReceipts)
        .values({
          shipmentName: m.shipmentName,
          destination: m.destination,
          expectedArrival: m.expectedArrival,
          // Stamp received_at with `today`'s noon UTC so the audit
          // trail reflects when the delivery showed up in inventory,
          // not when the backfill script ran.
          receivedAt: new Date(`${today}T12:00:00.000Z`),
          note: `Backfill auto-detected ${today}: ${m.reasoning}`,
        })
        .onConflictDoNothing({
          target: [
            incomingReceipts.shipmentName,
            incomingReceipts.destination,
            incomingReceipts.expectedArrival,
          ],
        })
        .returning({ id: incomingReceipts.id });
      if (result.length > 0) {
        inserted++;
      }
      matchedKeys.add(k);
      shipmentsMatched++;
    }
  }

  logger.info("auto-receipt-backfill.done", {
    pairsScanned,
    shipmentsMatched,
    inserted,
    firstDate: dates[0],
    lastDate: dates[dates.length - 1],
    daysBack,
    ms: Date.now() - start,
  });

  return {
    pairsScanned,
    shipmentsMatched,
    inserted,
    firstDate: dates[0] ?? null,
    lastDate: dates[dates.length - 1] ?? null,
  };
}
