import { and, asc, inArray, min } from "drizzle-orm";
import { db } from "@/lib/db";
import { incomingShipments, launchInfo, productLaunches, skus } from "@/lib/db/schema";
import { launchInfoKeyFor, normalizeLaunchInfoName } from "@/lib/domain/launch-info-mapping";
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
  // Launch-prep facts. Since 2026-07-08 price/name/colours/composition
  // come from the "Launch Info" sheet tab (source of truth — the team
  // edits the SHEET, the tool displays read-only), with the 2026-07-07
  // manual columns as fallback. Content LINKS are the exception: the
  // tool edit wins and the sheet only fills blanks (Scott 2026-07-08
  // wants to add them himself in the tool).
  sellingPriceUsd: string | null;
  externalProductName: string | null;
  factoryContentUrl: string | null;
  imageToolContentUrl: string | null;
  colours: string | null;
  mainComposition: string | null;
  linerComposition: string | null;
  /** True when a Launch Info sheet row backs this launch's prep facts. */
  prepFromSheet: boolean;
  // Landed COGS — derived live from skus.unit_cost_usd (EVSKUmap) as the
  // average over the launch's SKU bucket. landedCogsIntlUsd is null when
  // no bucket SKU carries its own unit_cost_intl_usd (rendering a dash
  // beats echoing the US number); partially-priced buckets blend real
  // INTL prices with per-SKU US fallbacks.
  landedCogsUsd: number | null;
  landedCogsIntlUsd: number | null;
  cogsSkuCount: number;
  cogsMissingCount: number;
  /** How many bucket SKUs have their own INTL price on the cost sheet. */
  cogsIntlPricedCount: number;
};

export async function getLaunches(): Promise<LaunchRow[]> {
  const launchRows = await db
    .select()
    .from(productLaunches)
    .orderBy(asc(productLaunches.createdAt));

  if (launchRows.length === 0) return [];

  // Launch Info sheet facts, indexed by normalized sheet-product name.
  const infoRows = await db.select().from(launchInfo);
  const infoByKey = new Map(
    infoRows.map((i) => [normalizeLaunchInfoName(i.product), i]),
  );

  // Resolve ETA Ant + PD per launch. A launch is identified by
  // (productName, shipmentName) where productName is the colorway-
  // suffixed launchName (e.g., "Shapewear Black"). The skus catalog
  // stores the BASE name (e.g., "Shapewear"), so we can't join directly
  // on productName. Instead: pull every active SKU and bucket by its
  // own deriveLaunchName output. Bulk resolution avoids N+1.
  const launchNames = new Set(launchRows.map((r) => r.productName));
  const skuRows = await db
    .select({
      sku: skus.sku,
      productName: skus.productName,
      unitCostUsd: skus.unitCostUsd,
      unitCostIntlUsd: skus.unitCostIntlUsd,
    })
    .from(skus);
  const skusByProduct = new Map<string, string[]>();
  // Per-launch landed-COGS accumulation (avg over the SKU bucket).
  const costsByProduct = new Map<
    string,
    { us: number[]; intl: number[]; missing: number; total: number; intlPriced: number }
  >();
  for (const r of skuRows) {
    const derived = deriveLaunchName(r.sku, r.productName);
    if (!launchNames.has(derived)) continue;
    const bucket = skusByProduct.get(derived) ?? [];
    bucket.push(r.sku);
    skusByProduct.set(derived, bucket);

    const acc = costsByProduct.get(derived) ?? { us: [], intl: [], missing: 0, total: 0, intlPriced: 0 };
    acc.total += 1;
    const us = r.unitCostUsd === null ? null : Number(r.unitCostUsd);
    if (us === null || Number.isNaN(us) || us <= 0) {
      acc.missing += 1;
    } else {
      acc.us.push(us);
      // INTL falls back per-SKU to the US cost when not separately priced,
      // and we COUNT how many SKUs carry a real INTL price: a bucket where
      // none do renders as "no INTL cost yet" instead of silently echoing
      // the US number (Scott 2026-07-08: "they shouldn't be the same").
      const intlRaw = r.unitCostIntlUsd === null ? null : Number(r.unitCostIntlUsd);
      const intlIsPriced = intlRaw !== null && !Number.isNaN(intlRaw) && intlRaw > 0;
      if (intlIsPriced) acc.intlPriced += 1;
      acc.intl.push(intlIsPriced ? intlRaw : us);
    }
    costsByProduct.set(derived, acc);
  }
  const avg = (xs: number[]): number | null =>
    xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;

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
    const costs = costsByProduct.get(r.productName);
    const info = infoByKey.get(launchInfoKeyFor(r.productName));
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
      sellingPriceUsd: info?.packPriceUsd ?? r.sellingPriceUsd,
      externalProductName: info?.externalName ?? r.externalProductName,
      // Tool edit WINS, sheet fills blanks — Scott adds/edits these links
      // in the tool (2026-07-08); the sheet is only a fallback source.
      factoryContentUrl: r.factoryContentUrl ?? info?.chinaPhotoshootUrl ?? null,
      imageToolContentUrl: r.imageToolContentUrl ?? info?.imageToolUrl ?? null,
      colours: info?.colours ?? null,
      mainComposition: info?.mainComposition ?? null,
      linerComposition: info?.linerComposition ?? null,
      prepFromSheet: info !== undefined,
      landedCogsUsd: costs ? avg(costs.us) : null,
      // null when NO SKU in the bucket has its own INTL price — the UI
      // shows a dash instead of a misleading copy of the US number.
      landedCogsIntlUsd: costs && costs.intlPriced > 0 ? avg(costs.intl) : null,
      cogsSkuCount: costs?.total ?? 0,
      cogsMissingCount: costs?.missing ?? 0,
      cogsIntlPricedCount: costs?.intlPriced ?? 0,
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
