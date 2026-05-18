/**
 * Daily snapshot of the Shipping Performance stats panel.
 *
 * Spec: docs/shipping-checks-spec/ops-shipping-checks-spec.md §5
 *
 * Computes the 30-day-trailing-window stats (avg fulfilment hours, avg
 * transit days, avg total days, transit histogram) once per cron run
 * and persists into `shipping_stats_daily`. The prior-30d comparison
 * the UI displays then becomes a free lookup against yesterday's
 * snapshot offset 30 days back instead of re-aggregating 60 days of
 * orders on every page load.
 *
 * Runs after Phase 2 in `/api/cron/ingest`. Failures here are logged
 * but never bubble out — shipping-stats is a marketing/ops view, not
 * blocking infrastructure.
 */

import { desc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { shippingStatsDaily, stockSnapshots } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import {
  computeStatsWindow,
  shiftStoreLocal,
  todayStoreLocal,
  storeLocalMidnight,
  type InventoryAvailability,
} from "@/lib/domain/shipping-checks";
import { fetchOrdersSince } from "@/lib/sources/shopify-fulfillments";

// Spec is US-only — same store as `shopify_us` in the daily_sales pipeline.
const US_STORE = "incontinencepanties.myshopify.com";

const WINDOW_DAYS = 30;
// Reach back this far for orders. Need 30d of *delivered_at* coverage,
// which means we need orders that were *fulfilled* 30+10 days ago in
// the worst case (an order shipped, sat in carrier transit for 10d, then
// delivered exactly on the start of the window).
const FETCH_BACK_DAYS = 60;

export type ShippingSnapshotResult = {
  snapshotDate: string;
  windowStart: string;
  windowEnd: string;
  deliveredCount: number;
  ordersFetched: number;
};

/**
 * Build a SKU → on-hand availability lookup from the latest
 * stock_snapshots. Used to OOS-exclude orders from the stats sample
 * exactly the same way the UI flag list does.
 */
async function buildInventoryLookup(): Promise<InventoryAvailability> {
  // Pull only the latest snapshot per (sku, US-location). Sum is not
  // needed — the spec scope is US-only.
  // Pull every US row sorted newest-first, then take the first
  // observation per SKU. Cheaper than a DISTINCT ON when the table is
  // a few-hundred-K rows and lets us stay in the Drizzle query builder.
  const allUs = await db
    .select({
      sku: stockSnapshots.sku,
      onHand: stockSnapshots.onHand,
      snapshotDate: stockSnapshots.snapshotDate,
    })
    .from(stockSnapshots)
    .where(eq(stockSnapshots.location, "US"))
    .orderBy(desc(stockSnapshots.snapshotDate));
  const map = new Map<string, number>();
  for (const r of allUs) {
    if (!map.has(r.sku)) map.set(r.sku, Number(r.onHand));
  }
  // Note: untracked SKUs return undefined → spec §7.5 says include
  // the order anyway.
  return (sku: string) => map.get(sku);
}

export async function runShippingSnapshot(opts?: {
  asOfDate?: string; // YYYY-MM-DD store-local
}): Promise<ShippingSnapshotResult> {
  const start = Date.now();
  const snapshotDate = opts?.asOfDate ?? todayStoreLocal();
  const windowEnd = snapshotDate;
  const windowStart = shiftStoreLocal(snapshotDate, -WINDOW_DAYS);
  const fetchSince = shiftStoreLocal(snapshotDate, -FETCH_BACK_DAYS);
  const sinceIso = storeLocalMidnight(fetchSince).toISOString();

  logger.info("shipping.snapshot.start", {
    snapshotDate,
    windowStart,
    windowEnd,
    fetchSince,
  });

  const inventoryAvailable = await buildInventoryLookup();

  const orders = await fetchOrdersSince({
    store: US_STORE,
    sinceIso,
  });

  const stats = computeStatsWindow({
    orders,
    inventoryAvailable,
    windowStart,
    windowEnd,
  });

  await db
    .insert(shippingStatsDaily)
    .values({
      snapshotDate,
      deliveredCount: stats.deliveredCount,
      avgFulfilmentHours:
        stats.avgFulfilmentHours !== null
          ? stats.avgFulfilmentHours.toFixed(2)
          : null,
      avgTransitDays:
        stats.avgTransitDays !== null ? stats.avgTransitDays.toFixed(2) : null,
      avgTotalDays:
        stats.avgTotalDays !== null ? stats.avgTotalDays.toFixed(2) : null,
      transitHistogram: stats.transitHistogram,
    })
    .onConflictDoUpdate({
      target: shippingStatsDaily.snapshotDate,
      set: {
        deliveredCount: stats.deliveredCount,
        avgFulfilmentHours:
          stats.avgFulfilmentHours !== null
            ? stats.avgFulfilmentHours.toFixed(2)
            : null,
        avgTransitDays:
          stats.avgTransitDays !== null
            ? stats.avgTransitDays.toFixed(2)
            : null,
        avgTotalDays:
          stats.avgTotalDays !== null ? stats.avgTotalDays.toFixed(2) : null,
        transitHistogram: stats.transitHistogram,
        computedAt: new Date(),
      },
    });

  const result: ShippingSnapshotResult = {
    snapshotDate,
    windowStart,
    windowEnd,
    deliveredCount: stats.deliveredCount,
    ordersFetched: orders.length,
  };

  logger.info("shipping.snapshot.done", {
    ...result,
    ms: Date.now() - start,
  });

  return result;
}
