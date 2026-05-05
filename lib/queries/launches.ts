import { and, asc, eq, inArray, min } from "drizzle-orm";
import { db } from "@/lib/db";
import { incomingShipments, productLaunches, skus } from "@/lib/db/schema";

/** Single launch row as the /launches page consumes it. ETA Ant + ETA
 * PD are derived live from `incoming_shipments` so they stay in sync
 * with the Incoming_new sheet; everything else is operator input.
 *
 * - `etaAnt` — first arrival at CN (Antwerp) for this launch's
 *   shipment. Null when no CN PO exists in the current sheet.
 * - `etaPd` — first arrival at US (Paradise) for this launch's
 *   shipment. Null when no US PO exists in the current sheet.
 */
export type LaunchRow = {
  id: string;
  productName: string;
  shipmentName: string;
  etaAnt: string | null;
  etaPd: string | null;
  intlSiteLive: string | null;
  intlLaunchDate: string | null;
  usSiteLive: string | null;
  usLaunchDate: string | null;
  note: string | null;
  createdAt: string;
};

export async function getLaunches(): Promise<LaunchRow[]> {
  const launchRows = await db
    .select()
    .from(productLaunches)
    .orderBy(asc(productLaunches.createdAt));

  if (launchRows.length === 0) return [];

  // Resolve ETA Ant + PD per launch. A launch is identified by
  // (productName, shipmentName); to map to incoming_shipments we need
  // the SKUs that belong to the productName, then min(eta) per warehouse
  // for that shipmentName. Bulk SKU resolution avoids N+1.
  const productNames = Array.from(new Set(launchRows.map((r) => r.productName)));
  const skuRows = await db
    .select({ sku: skus.sku, productName: skus.productName })
    .from(skus)
    .where(inArray(skus.productName, productNames));
  const skusByProduct = new Map<string, string[]>();
  for (const r of skuRows) {
    const bucket = skusByProduct.get(r.productName) ?? [];
    bucket.push(r.sku);
    skusByProduct.set(r.productName, bucket);
  }

  const shipmentNames = Array.from(new Set(launchRows.map((r) => r.shipmentName)));
  const allSkuList = Array.from(new Set(skuRows.map((r) => r.sku)));
  const incomingRows = allSkuList.length > 0 && shipmentNames.length > 0
    ? await db
        .select({
          sku: incomingShipments.sku,
          shipmentName: incomingShipments.shipmentName,
          destination: incomingShipments.destination,
          eta: min(incomingShipments.expectedArrival),
        })
        .from(incomingShipments)
        .where(
          and(
            inArray(incomingShipments.sku, allSkuList),
            inArray(incomingShipments.shipmentName, shipmentNames),
          ),
        )
        .groupBy(
          incomingShipments.sku,
          incomingShipments.shipmentName,
          incomingShipments.destination,
        )
    : [];

  // For each launch, find the earliest US ETA + earliest CN ETA across
  // its product's SKUs for this shipmentName.
  return launchRows.map((r) => {
    const productSkus = skusByProduct.get(r.productName) ?? [];
    const skuSet = new Set(productSkus);
    let etaAnt: string | null = null;
    let etaPd: string | null = null;
    for (const i of incomingRows) {
      if (i.shipmentName !== r.shipmentName) continue;
      if (!skuSet.has(i.sku)) continue;
      const eta = i.eta;
      if (!eta) continue;
      if (i.destination === "CN" && (etaAnt === null || eta < etaAnt)) {
        etaAnt = eta;
      }
      if (i.destination === "US" && (etaPd === null || eta < etaPd)) {
        etaPd = eta;
      }
    }
    return {
      id: r.id,
      productName: r.productName,
      shipmentName: r.shipmentName,
      etaAnt,
      etaPd,
      intlSiteLive: r.intlSiteLive,
      intlLaunchDate: r.intlLaunchDate,
      usSiteLive: r.usSiteLive,
      usLaunchDate: r.usLaunchDate,
      note: r.note,
      createdAt: r.createdAt.toISOString(),
    };
  });
}

/** Distinct shipmentNames present in `incoming_shipments` — feeds the
 * "Order" dropdown when adding a launch. Sorted by earliest ETA so the
 * most-relevant shipments surface first. */
export async function getDistinctShipmentNames(): Promise<string[]> {
  const rows = await db
    .selectDistinct({ shipmentName: incomingShipments.shipmentName })
    .from(incomingShipments)
    .orderBy(asc(incomingShipments.shipmentName));
  return rows.map((r) => r.shipmentName);
}

/** Distinct productNames in the SKU catalog — feeds the "Product"
 * dropdown when adding a launch. Excludes the SKU-as-name fallback
 * rows (where productName starts with "ev-") so operators only see
 * named products. */
export async function getDistinctProductNames(): Promise<string[]> {
  const rows = await db
    .selectDistinct({ productName: skus.productName })
    .from(skus)
    .orderBy(asc(skus.productName));
  return rows
    .map((r) => r.productName)
    .filter((p) => p && !p.startsWith("ev-"));
}
