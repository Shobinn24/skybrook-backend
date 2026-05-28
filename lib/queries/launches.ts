import { and, asc, inArray, min } from "drizzle-orm";
import { db } from "@/lib/db";
import { incomingShipments, productLaunches, skus } from "@/lib/db/schema";
import { deriveLaunchName, isLaunchBlockedFamily } from "@/lib/domain/sku-naming";

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
  // (productName, shipmentName) where productName is the colorway-
  // suffixed launchName (e.g., "Shapewear Black"). The skus catalog
  // stores the BASE name (e.g., "Shapewear"), so we can't join directly
  // on productName. Instead: pull every active SKU and bucket by its
  // own deriveLaunchName output. Bulk resolution avoids N+1.
  const launchNames = new Set(launchRows.map((r) => r.productName));
  const skuRows = await db
    .select({ sku: skus.sku, productName: skus.productName })
    .from(skus);
  const skusByProduct = new Map<string, string[]>();
  for (const r of skuRows) {
    const derived = deriveLaunchName(r.sku, r.productName);
    if (!launchNames.has(derived)) continue;
    const bucket = skusByProduct.get(derived) ?? [];
    bucket.push(r.sku);
    skusByProduct.set(derived, bucket);
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
  const resolved = launchRows.map((r) => {
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

  // Sort: products missing ETA Ant bubble to the TOP so they don't get
  // forgotten (Scott 2026-05-28: "2 products missing ETA Ant should be
  // right at the top"). Among rows that DO have an ETA Ant, sort
  // ascending so the soonest-arriving launches come next. createdAt is
  // the tiebreaker for stable ordering when ETAs match.
  resolved.sort((a, b) => {
    if (a.etaAnt === b.etaAnt) return a.createdAt.localeCompare(b.createdAt);
    if (a.etaAnt === null) return -1; // a missing → top
    if (b.etaAnt === null) return 1;  // b missing → top
    return a.etaAnt.localeCompare(b.etaAnt);
  });

  return resolved;
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

/** Distinct launch names derived from the SKU catalog — feeds the
 * "Product" dropdown when adding a launch.
 *
 * Returns colorway-suffixed names ("Shapewear Black", "Super High-Waist
 * 5-Pack Multi Color") rather than base productNames ("Shapewear",
 * "Super High-Waist 5-Pack") so that what the operator picks matches
 * what they see in the launches table after save. The auto-populate
 * job already inserts launches under derived names; without this, the
 * manual-add path would silently insert a name that no SKU bucket
 * resolves to, producing null ETAs.
 *
 * Excludes:
 *   - "ev-" placeholder fallback rows
 *   - SKUs in LAUNCH_BLOCKLISTED_FAMILIES (hw/og/9055/mixed). Scott
 *     2026-05-08: "HW and OG are not launched, those are old products."
 *     Hiding them from the dropdown matches the auto-populate filter. */
export async function getDistinctProductNames(): Promise<string[]> {
  const rows = await db
    .select({ sku: skus.sku, productName: skus.productName })
    .from(skus);
  const derived = new Set<string>();
  for (const r of rows) {
    if (isLaunchBlockedFamily(r.sku)) continue;
    const name = deriveLaunchName(r.sku, r.productName);
    if (name && !name.startsWith("ev-")) {
      derived.add(name);
    }
  }
  return Array.from(derived).sort((a, b) => a.localeCompare(b));
}
