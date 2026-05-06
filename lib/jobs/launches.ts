// Daily job that auto-populates the Launches tab when a brand-new
// product appears in the incoming shipments sheet.
//
// Scott 2026-05-06 round 2: "as soon as a new SKU is entered in an
// upcoming shipment, the product gets added here in the launch tab.
// Only completely new products" — restocks of existing products do
// NOT trigger.
//
// Definition of "new": a productName whose SKUs have never had any
// row in stock_snapshots. Once stock has been snapshotted (even at
// zero), the product is considered established and future shipments
// of it count as restocks.
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
  /** Distinct (productName, shipmentName) pairs visible in incoming. */
  candidatePairs: number;
  /** Pairs filtered out because the product has stock history. */
  skippedExisting: number;
  /** Pairs filtered out because a launch row already exists. */
  skippedAlreadyLaunched: number;
  /** New launch rows inserted this run. */
  inserted: number;
};

export async function runLaunchAutoPopulate(): Promise<LaunchAutoPopulateResult> {
  const start = Date.now();

  // 1. Pull (productName, shipmentName) pairs from incoming via SKU join.
  //    A single shipment may carry many SKUs of one product — group by
  //    productName so each (product, shipment) combo gets at most one
  //    candidate row.
  const incomingPairs = await db
    .selectDistinct({
      productName: skus.productName,
      shipmentName: incomingShipments.shipmentName,
    })
    .from(incomingShipments)
    .innerJoin(skus, eq(incomingShipments.sku, skus.sku))
    .where(isNotNull(skus.productName));

  if (incomingPairs.length === 0) {
    logger.info("launches.auto.no-candidates");
    return { candidatePairs: 0, skippedExisting: 0, skippedAlreadyLaunched: 0, inserted: 0 };
  }

  // 2. Build set of productNames that have any row in stock_snapshots.
  //    These are "established" products — restocks don't trigger
  //    auto-launch.
  const stockedRows = await db
    .selectDistinct({ productName: skus.productName })
    .from(skus)
    .innerJoin(stockSnapshots, eq(skus.sku, stockSnapshots.sku))
    .where(isNotNull(skus.productName));
  const productsWithStockHistory = new Set(stockedRows.map((r) => r.productName));

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

  let skippedExisting = 0;
  let skippedAlreadyLaunched = 0;
  let inserted = 0;

  for (const pair of incomingPairs) {
    if (!pair.productName) continue;
    // Default-named SKUs (productName === sku, starts with "ev-") have
    // no friendly label yet — skip until syncProductNames assigns one.
    if (pair.productName.startsWith("ev-")) continue;

    if (productsWithStockHistory.has(pair.productName)) {
      skippedExisting++;
      continue;
    }
    const key = `${pair.productName}|${pair.shipmentName}`;
    if (existingKeys.has(key)) {
      skippedAlreadyLaunched++;
      continue;
    }

    const result = await db
      .insert(productLaunches)
      .values({
        productName: pair.productName,
        shipmentName: pair.shipmentName,
        note: "Auto-added: new product detected in incoming shipment",
      })
      .onConflictDoNothing({
        target: [productLaunches.productName, productLaunches.shipmentName],
      })
      .returning({ id: productLaunches.id });
    if (result.length > 0) inserted++;
  }

  logger.info("launches.auto.done", {
    candidatePairs: incomingPairs.length,
    skippedExisting,
    skippedAlreadyLaunched,
    inserted,
    ms: Date.now() - start,
  });

  return {
    candidatePairs: incomingPairs.length,
    skippedExisting,
    skippedAlreadyLaunched,
    inserted,
  };
}
