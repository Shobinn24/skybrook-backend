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

import { and, desc, eq, gte, inArray, like, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  dailySales,
  incomingShipments,
  productLaunches,
  skus,
  stockSnapshots,
} from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import {
  deriveLaunchName,
  isLaunchBlockedFamily,
  isMainColor,
  LAUNCH_BLOCKED_NAME_PREFIXES,
} from "@/lib/domain/sku-naming";

/** Sales lookback window. A SKU with any sales in this window is
 *  treated as "currently selling" and not flagged as a new launch. */
const SALES_LOOKBACK_DAYS = 60;

const AUTO_ADDED_NOTE = "Auto-added: new variant detected in incoming shipment";

export type LaunchAutoPopulateResult = {
  candidatePairs: number;
  skippedAltColor: number;
  skippedLaunchBlockedFamily: number;
  skippedHasStock: number;
  skippedHasSales: number;
  skippedAlreadyLaunched: number;
  inserted: number;
  staleDeleted: number;
  duplicateShipmentsCollapsed: number;
};

/**
 * Cleanup pass run at the start of every auto-populate. Two cases:
 *
 *   1. Stale `ev-*` placeholder rows whose underlying SKU's
 *      `skus.productName` has since been resolved to a friendly label
 *      (FAMILY_LABELS / FAMILY_ALIAS in lib/domain/sku-naming.ts).
 *
 *   2. Auto-added launches in a LAUNCH_BLOCKLISTED_FAMILIES family
 *      (hw / og / 9055 / mixed). Originally only the bare names ("HW",
 *      "OG", "Style 9055") were matched, but pack/HF variants like
 *      "HW 1-Pack" and "OG 5-Pack HF" slipped through (Scott 2026-05-11).
 *      Now we match any auto-added row whose productName equals or
 *      starts with one of the blocklisted family labels. Scott
 *      2026-05-08: "HW and OG are not launched, those are old products."
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

  // Match each blocklisted family label as either the exact productName
  // ("HW") or as a prefix followed by a space ("HW 1-Pack",
  // "OG 5-Pack HF"). The trailing-space guard prevents matching
  // unrelated labels that happen to share a prefix.
  const blockedPatterns = LAUNCH_BLOCKED_NAME_PREFIXES.flatMap((label) => [
    eq(productLaunches.productName, label),
    like(productLaunches.productName, `${label} %`),
  ]);
  const blockedFamilyResult =
    blockedPatterns.length > 0
      ? await db
          .delete(productLaunches)
          .where(
            and(eq(productLaunches.note, AUTO_ADDED_NOTE), or(...blockedPatterns)),
          )
          .returning({ id: productLaunches.id })
      : [];

  return stalePlaceholderResult.length + blockedFamilyResult.length;
}

/**
 * Collapse multi-shipment auto-added launches down to one row per
 * productName, keeping the row whose shipment has the earliest
 * `expected_arrival`. Scott 2026-05-08: "Why is each product in there
 * multiple times?" — a single product launches once; subsequent
 * shipments are restocks, not separate launches.
 *
 * Manual launches (note != AUTO_ADDED_NOTE) are preserved untouched.
 * Idempotent: running twice deletes nothing the second time.
 */
export async function collapseMultiShipmentAutoLaunches(): Promise<number> {
  const autoLaunches = await db
    .select({
      id: productLaunches.id,
      productName: productLaunches.productName,
      shipmentName: productLaunches.shipmentName,
    })
    .from(productLaunches)
    .where(eq(productLaunches.note, AUTO_ADDED_NOTE));

  const byProduct = new Map<string, Array<{ id: string; shipmentName: string }>>();
  for (const r of autoLaunches) {
    const list = byProduct.get(r.productName);
    if (list) list.push({ id: r.id, shipmentName: r.shipmentName });
    else byProduct.set(r.productName, [{ id: r.id, shipmentName: r.shipmentName }]);
  }

  const idsToDelete: string[] = [];
  for (const [, rows] of byProduct) {
    if (rows.length <= 1) continue;
    const shipNames = Array.from(new Set(rows.map((r) => r.shipmentName)));
    const etaRows = await db
      .select({
        shipmentName: incomingShipments.shipmentName,
        eta: sql<string>`min(${incomingShipments.expectedArrival})`,
      })
      .from(incomingShipments)
      .where(inArray(incomingShipments.shipmentName, shipNames))
      .groupBy(incomingShipments.shipmentName);
    const etaByShipment = new Map(etaRows.map((r) => [r.shipmentName, r.eta]));

    let earliestId: string | null = null;
    let earliestEta: string | null = null;
    for (const r of rows) {
      const eta = etaByShipment.get(r.shipmentName);
      if (!eta) continue;
      if (earliestEta === null || eta < earliestEta) {
        earliestEta = eta;
        earliestId = r.id;
      }
    }
    if (!earliestId) continue;
    for (const r of rows) {
      if (r.id !== earliestId) idsToDelete.push(r.id);
    }
  }

  if (idsToDelete.length === 0) return 0;
  const deleted = await db
    .delete(productLaunches)
    .where(inArray(productLaunches.id, idsToDelete))
    .returning({ id: productLaunches.id });
  return deleted.length;
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
  const duplicateShipmentsCollapsed = await collapseMultiShipmentAutoLaunches();

  // 1. Pull (sku, productName, shipmentName, destination, expectedArrival)
  //    tuples from incoming. Inner-join to skus so we have the canonical
  //    productName base; deriveLaunchName layers the colorway suffix on
  //    top. expectedArrival is used to pick the earliest shipment per
  //    launchName (Scott 2026-05-08: a product launches once, additional
  //    shipments are restocks).
  const rows = await db
    .select({
      sku: incomingShipments.sku,
      productName: skus.productName,
      shipmentName: incomingShipments.shipmentName,
      destination: incomingShipments.destination,
      expectedArrival: incomingShipments.expectedArrival,
    })
    .from(incomingShipments)
    .innerJoin(skus, eq(incomingShipments.sku, skus.sku));

  // Dedupe at (sku, shipmentName, destination) level. Same SKU across
  // multiple POs of the same shipment + destination only counts once.
  // Earliest `expectedArrival` wins on collisions (defensive — same
  // tuple across POs should always have the same ETA).
  const seenIdx = new Map<string, number>();
  type Tuple = {
    sku: string;
    productName: string | null;
    shipmentName: string;
    destination: string;
    expectedArrival: string;
  };
  const tuples: Tuple[] = [];
  for (const r of rows) {
    const key = `${r.sku}|${r.shipmentName}|${r.destination}`;
    const existingIdx = seenIdx.get(key);
    if (existingIdx === undefined) {
      seenIdx.set(key, tuples.length);
      tuples.push(r);
    } else if (r.expectedArrival < tuples[existingIdx].expectedArrival) {
      tuples[existingIdx] = r;
    }
  }

  if (tuples.length === 0) {
    logger.info("launches.auto.no-candidates", { staleDeleted, duplicateShipmentsCollapsed });
    return {
      candidatePairs: 0,
      skippedAltColor: 0,
      skippedLaunchBlockedFamily: 0,
      skippedHasStock: 0,
      skippedHasSales: 0,
      skippedAlreadyLaunched: 0,
      inserted: 0,
      staleDeleted,
      duplicateShipmentsCollapsed,
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

  // 4. Existing launches keyed by productName. Scott 2026-05-08: a
  //    product launches once. If any auto-added or manual launch row
  //    already exists for this productName, skip — additional shipments
  //    are restocks, not new launches.
  const existingLaunches = await db
    .select({ productName: productLaunches.productName })
    .from(productLaunches);
  const existingLaunchNames = new Set(existingLaunches.map((r) => r.productName));

  // 5. Apply filter chain. Group surviving candidates by launchName and
  //    keep the one with the earliest expected_arrival per launchName.
  let skippedAltColor = 0;
  let skippedLaunchBlockedFamily = 0;
  let skippedHasStock = 0;
  let skippedHasSales = 0;
  const skippedAlreadyLaunchedNames = new Set<string>();
  const earliestPerLaunch = new Map<string, { shipmentName: string; expectedArrival: string }>();
  for (const t of tuples) {
    // Filter 1: drop alt-color variants within og/hw/9055 (existing rule).
    if (!isMainColor(t.sku)) {
      skippedAltColor++;
      continue;
    }
    // Filter 1b: drop all SKUs in launch-blocklisted families regardless
    //   of colorway. Closes the gap where bare-name HW/OG/9055 launches
    //   were blocked but pack/HF variants ("HW 1-Pack", "OG 5-Pack")
    //   slipped through. Scott 2026-05-08 + 2026-05-11.
    if (isLaunchBlockedFamily(t.sku)) {
      skippedLaunchBlockedFamily++;
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
    if (existingLaunchNames.has(launchName)) {
      skippedAlreadyLaunchedNames.add(launchName);
      continue;
    }
    const current = earliestPerLaunch.get(launchName);
    if (!current || t.expectedArrival < current.expectedArrival) {
      earliestPerLaunch.set(launchName, {
        shipmentName: t.shipmentName,
        expectedArrival: t.expectedArrival,
      });
    }
  }
  const skippedAlreadyLaunched = skippedAlreadyLaunchedNames.size;

  // 6. Insert one row per launchName at its earliest shipment.
  let inserted = 0;
  for (const [productName, { shipmentName }] of earliestPerLaunch) {
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
    skippedLaunchBlockedFamily,
    skippedHasStock,
    skippedHasSales,
    skippedAlreadyLaunched,
    inserted,
    staleDeleted,
    duplicateShipmentsCollapsed,
    ms: Date.now() - start,
  });

  return {
    candidatePairs: tuples.length,
    skippedAltColor,
    skippedLaunchBlockedFamily,
    skippedHasStock,
    skippedHasSales,
    skippedAlreadyLaunched,
    inserted,
    staleDeleted,
    duplicateShipmentsCollapsed,
  };
}
