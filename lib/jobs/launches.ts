// Daily job that auto-populates the Launches tab when a new product
// VARIANT (a SKU with no prior stock history) appears in the incoming
// shipments sheet.
//
// Scott 2026-05-06: "as soon as a new SKU is entered in an upcoming
// shipment, the product gets added here in the launch tab."
//
// Scott 2026-05-07: original rule was productName-level — a product
// only counted as "new" if its parent productName had zero stock history.
// After the 2026-05-06 color-consolidation pass collapsed colorways
// under one productName ("Boyshort", "Style 9055" etc.), every new
// colorway counted as a restock and the launches tab stayed empty.
// Loosened to variant-level: a SKU with no prior stock history triggers
// a launch row even when its productName has prior history.
//
// Multiple new SKUs of the same product in the same shipment still
// produce a single launch row — dedupe is at (productName, shipmentName)
// level.
//
// Runs after syncProductNames so the productNames here reflect the
// latest sku-naming pass (color-consolidated etc.).

import { eq, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  incomingShipments,
  productLaunches,
  skus,
  stockSnapshots,
} from "@/lib/db/schema";
import { logger } from "@/lib/logger";

export type LaunchAutoPopulateResult = {
  /** Distinct (sku, shipmentName) tuples visible in incoming. */
  candidatePairs: number;
  /** Tuples filtered out because the SKU has stock history (variant-level). */
  skippedExisting: number;
  /** Tuples filtered out because a launch row already exists. */
  skippedAlreadyLaunched: number;
  /** New launch rows inserted this run. */
  inserted: number;
};

export async function runLaunchAutoPopulate(): Promise<LaunchAutoPopulateResult> {
  const start = Date.now();

  // 1. Pull (sku, productName, shipmentName) tuples from incoming via
  //    SKU join. We dedupe at the SKU level so a SKU appearing in many
  //    POs of the same shipment only counts once.
  const rows = await db
    .select({
      sku: incomingShipments.sku,
      productName: skus.productName,
      shipmentName: incomingShipments.shipmentName,
    })
    .from(incomingShipments)
    .innerJoin(skus, eq(incomingShipments.sku, skus.sku))
    .where(isNotNull(skus.productName));

  const seen = new Set<string>();
  const tuples: Array<{ sku: string; productName: string; shipmentName: string }> = [];
  for (const r of rows) {
    if (!r.productName) continue;
    const key = `${r.sku}|${r.shipmentName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    tuples.push({
      sku: r.sku,
      productName: r.productName,
      shipmentName: r.shipmentName,
    });
  }

  if (tuples.length === 0) {
    logger.info("launches.auto.no-candidates");
    return { candidatePairs: 0, skippedExisting: 0, skippedAlreadyLaunched: 0, inserted: 0 };
  }

  // 2. Build set of SKUs that have any row in stock_snapshots — these
  //    are "established variants." A new SKU within an existing product
  //    is still considered new for launch purposes (Scott 2026-05-07
  //    decision after color consolidation collapsed productNames).
  const stockedRows = await db
    .selectDistinct({ sku: stockSnapshots.sku })
    .from(stockSnapshots);
  const skusWithStockHistory = new Set(stockedRows.map((r) => r.sku));

  // 3. Build set of existing (productName, shipmentName) pairs already
  //    in product_launches so we don't duplicate.
  const existingLaunches = await db
    .select({
      productName: productLaunches.productName,
      shipmentName: productLaunches.shipmentName,
    })
    .from(productLaunches);
  const existingKeys = new Set(
    existingLaunches.map((r) => `${r.productName}|${r.shipmentName}`),
  );

  // 4. For each tuple, decide. Tuples that pass all filters are
  //    deduplicated by (productName, shipmentName) so multiple new
  //    SKUs in one shipment produce a single launch row.
  //
  // Scott 2026-05-07: do NOT skip default-named SKUs (productName ===
  // sku, starts with "ev-"). Earlier behavior held them back until
  // syncProductNames assigned a friendly label, but for unknown family
  // codes (e.g. "hrshort", "pp") deriveProductName returns null and the
  // SKU stays default-named indefinitely, leaving the launches tab
  // empty. Insert with the SKU as placeholder productName; Scott can
  // rename in the velocity sheet later.
  let skippedExisting = 0;
  let skippedAlreadyLaunched = 0;
  const launchKeysToInsert = new Set<string>();
  for (const t of tuples) {
    if (skusWithStockHistory.has(t.sku)) {
      skippedExisting++;
      continue;
    }
    const launchKey = `${t.productName}|${t.shipmentName}`;
    if (existingKeys.has(launchKey)) {
      skippedAlreadyLaunched++;
      continue;
    }
    launchKeysToInsert.add(launchKey);
  }

  // 5. Insert deduplicated launch rows.
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
        note: "Auto-added: new variant detected in incoming shipment",
      })
      .onConflictDoNothing({
        target: [productLaunches.productName, productLaunches.shipmentName],
      })
      .returning({ id: productLaunches.id });
    if (result.length > 0) inserted++;
  }

  logger.info("launches.auto.done", {
    candidatePairs: tuples.length,
    skippedExisting,
    skippedAlreadyLaunched,
    inserted,
    ms: Date.now() - start,
  });

  return {
    candidatePairs: tuples.length,
    skippedExisting,
    skippedAlreadyLaunched,
    inserted,
  };
}
