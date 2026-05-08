// Daily job that auto-populates the Launches tab when a SKU appears in
// incoming shipments without current stock or recent sales at the
// destination. Scott 2026-05-07: "SKUs in incoming shipments that
// currently have 0 stock and 0 sales in the US/International respectively.
// Therefore we can deduce that they are new SKUs about to be launched."
//
// Filters applied per (sku, shipmentName, destination) tuple:
//   1. isMainColor — alt-colors of OG / HW / 9055 are NOT launches
//      (Scott 2026-05-08: "HW and OG are not launched, those are old
//      products"). Boyshort + Super HW + everything else: all colorways
//      count.
//   2. 0 stock at destination — latest stock_snapshots row for
//      (sku, destination) must be null or 0. Pre-created zero-stock rows
//      from the inventory sheet count as "no stock" (the bug under the
//      old has-history rule).
//   3. 0 sales on the destination's channel within SALES_LOOKBACK_DAYS —
//      no daily_sales rows for (sku, destinationChannel) in the window.
//
// Launch rows use deriveLaunchName so a new colorway of an advertised
// product surfaces as e.g. "Shapewear Black" instead of collapsing under
// the parent "Shapewear" launch.
//
// Multiple new SKUs of the same launchName in the same shipment dedupe
// to a single launch row.
//
// Runs after syncProductNames so productNames in the SKU join reflect
// the latest sku-naming pass.

import { and, desc, eq, gte, inArray, like, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  dailySales,
  incomingShipments,
  productLaunches,
  skus,
  stockSnapshots,
} from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { deriveLaunchName, isMainColor } from "@/lib/domain/sku-naming";

/** Sales lookback window. A SKU with any sales in this window is
 *  treated as "currently selling" and not flagged as a new launch. */
const SALES_LOOKBACK_DAYS = 60;

/** Parent product names that are alt-color buckets per Scott 2026-05-08
 *  ("HW and OG are not launched, those are old products"). Auto-added
 *  launches under these labels are always stale and get cleaned up. */
const ALT_COLOR_LAUNCH_BLOCKLIST = ["HW", "OG", "Style 9055"];

const AUTO_ADDED_NOTE = "Auto-added: new variant detected in incoming shipment";

export type LaunchAutoPopulateResult = {
  candidatePairs: number;
  skippedAltColor: number;
  skippedHasStock: number;
  skippedHasSales: number;
  skippedAlreadyLaunched: number;
  inserted: number;
  staleDeleted: number;
};

/**
 * Cleanup pass run at the start of every auto-populate. Two cases:
 *
 *   1. Stale `ev-*` placeholder rows whose underlying SKU's
 *      `skus.productName` has since been resolved to a friendly label
 *      (FAMILY_LABELS / FAMILY_ALIAS in lib/domain/sku-naming.ts).
 *
 *   2. Auto-added launches under one of ALT_COLOR_LAUNCH_BLOCKLIST.
 *      These appear when alt-color SKUs of OG / HW / 9055 (e.g.
 *      ev-pp-hw-*, ev-pp-og-*) pass through FAMILY_ALIAS and produce
 *      launch rows under the parent label. Scott 2026-05-08: those
 *      parent products are old and shouldn't ever be in the launches
 *      table.
 *
 * Idempotent. Manual launch rows (note != AUTO_ADDED_NOTE) are
 * preserved.
 */
export async function cleanupStaleDefaultLaunches(): Promise<number> {
  const stalePlaceholderResult = await db
    .delete(productLaunches)
    .where(
      and(
        like(productLaunches.productName, "ev-%"),
        sql`EXISTS (
          SELECT 1 FROM ${skus} s
          WHERE s.sku = ${productLaunches.productName}
          AND s.product_name <> ${productLaunches.productName}
        )`,
      ),
    )
    .returning({ id: productLaunches.id });

  const altColorResult = await db
    .delete(productLaunches)
    .where(
      and(
        inArray(productLaunches.productName, ALT_COLOR_LAUNCH_BLOCKLIST),
        eq(productLaunches.note, AUTO_ADDED_NOTE),
      ),
    )
    .returning({ id: productLaunches.id });

  return stalePlaceholderResult.length + altColorResult.length;
}

function destinationToChannel(dest: string): "shopify_us" | "shopify_intl" {
  return dest === "US" ? "shopify_us" : "shopify_intl";
}

function ymdDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export async function runLaunchAutoPopulate(): Promise<LaunchAutoPopulateResult> {
  const start = Date.now();
  const staleDeleted = await cleanupStaleDefaultLaunches();

  // 1. Pull (sku, productName, shipmentName, destination) tuples from
  //    incoming. Inner-join to skus so we have the canonical productName
  //    base; deriveLaunchName layers the colorway suffix on top.
  const rows = await db
    .select({
      sku: incomingShipments.sku,
      productName: skus.productName,
      shipmentName: incomingShipments.shipmentName,
      destination: incomingShipments.destination,
    })
    .from(incomingShipments)
    .innerJoin(skus, eq(incomingShipments.sku, skus.sku));

  // Dedupe at (sku, shipmentName, destination) level. Same SKU across
  // multiple POs of the same shipment + destination only counts once.
  const seen = new Set<string>();
  type Tuple = {
    sku: string;
    productName: string | null;
    shipmentName: string;
    destination: string;
  };
  const tuples: Tuple[] = [];
  for (const r of rows) {
    const key = `${r.sku}|${r.shipmentName}|${r.destination}`;
    if (seen.has(key)) continue;
    seen.add(key);
    tuples.push(r);
  }

  if (tuples.length === 0) {
    logger.info("launches.auto.no-candidates", { staleDeleted });
    return {
      candidatePairs: 0,
      skippedAltColor: 0,
      skippedHasStock: 0,
      skippedHasSales: 0,
      skippedAlreadyLaunched: 0,
      inserted: 0,
      staleDeleted,
    };
  }

  // 2. Bulk fetch latest on-hand per (sku, location) for SKUs in
  //    incoming. Last write wins per key.
  const skusInIncoming = Array.from(new Set(tuples.map((t) => t.sku)));
  const stockRows = await db
    .select({
      sku: stockSnapshots.sku,
      location: stockSnapshots.location,
      onHand: stockSnapshots.onHand,
      snapshotDate: stockSnapshots.snapshotDate,
    })
    .from(stockSnapshots)
    .where(inArray(stockSnapshots.sku, skusInIncoming))
    .orderBy(desc(stockSnapshots.snapshotDate));
  const latestStock = new Map<string, number>();
  for (const r of stockRows) {
    const k = `${r.sku}|${r.location}`;
    if (!latestStock.has(k)) latestStock.set(k, r.onHand);
  }

  // 3. Bulk fetch recent sales per (sku, channel) within SALES_LOOKBACK_DAYS.
  const since = ymdDaysAgo(SALES_LOOKBACK_DAYS);
  const salesRows = await db
    .select({
      sku: dailySales.sku,
      channel: dailySales.channel,
      unitsSold: dailySales.unitsSold,
    })
    .from(dailySales)
    .where(and(inArray(dailySales.sku, skusInIncoming), gte(dailySales.salesDate, since)));
  const recentSales = new Map<string, number>();
  for (const r of salesRows) {
    const k = `${r.sku}|${r.channel}`;
    recentSales.set(k, (recentSales.get(k) ?? 0) + r.unitsSold);
  }

  // 4. Existing launches keyed by (productName, shipmentName).
  const existingLaunches = await db
    .select({
      productName: productLaunches.productName,
      shipmentName: productLaunches.shipmentName,
    })
    .from(productLaunches);
  const existingKeys = new Set(
    existingLaunches.map((r) => `${r.productName}|${r.shipmentName}`),
  );

  // 5. Apply filter chain and dedupe by (launchName, shipmentName).
  let skippedAltColor = 0;
  let skippedHasStock = 0;
  let skippedHasSales = 0;
  let skippedAlreadyLaunched = 0;
  const launchKeysToInsert = new Set<string>();
  for (const t of tuples) {
    if (!isMainColor(t.sku)) {
      skippedAltColor++;
      continue;
    }
    const stock = latestStock.get(`${t.sku}|${t.destination}`) ?? 0;
    if (stock > 0) {
      skippedHasStock++;
      continue;
    }
    const channel = destinationToChannel(t.destination);
    const sales = recentSales.get(`${t.sku}|${channel}`) ?? 0;
    if (sales > 0) {
      skippedHasSales++;
      continue;
    }
    const baseName = t.productName ?? t.sku;
    const launchName = deriveLaunchName(t.sku, baseName);
    const launchKey = `${launchName}|${t.shipmentName}`;
    if (existingKeys.has(launchKey)) {
      skippedAlreadyLaunched++;
      continue;
    }
    launchKeysToInsert.add(launchKey);
  }

  // 6. Insert deduplicated launch rows.
  let inserted = 0;
  for (const launchKey of launchKeysToInsert) {
    const sep = launchKey.indexOf("|");
    const productName = launchKey.slice(0, sep);
    const shipmentName = launchKey.slice(sep + 1);
    const result = await db
      .insert(productLaunches)
      .values({
        productName,
        shipmentName,
        note: AUTO_ADDED_NOTE,
      })
      .onConflictDoNothing({
        target: [productLaunches.productName, productLaunches.shipmentName],
      })
      .returning({ id: productLaunches.id });
    if (result.length > 0) inserted++;
  }

  logger.info("launches.auto.done", {
    candidatePairs: tuples.length,
    skippedAltColor,
    skippedHasStock,
    skippedHasSales,
    skippedAlreadyLaunched,
    inserted,
    staleDeleted,
    ms: Date.now() - start,
  });

  return {
    candidatePairs: tuples.length,
    skippedAltColor,
    skippedHasStock,
    skippedHasSales,
    skippedAlreadyLaunched,
    inserted,
    staleDeleted,
  };
}
