import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { incomingShipments, skus, stockSnapshots } from "@/lib/db/schema";
import { getReceivedShipmentKeys, shipmentReceiptKey } from "./incoming";
import type { Location } from "@/lib/domain/warehouse-routing";

export type StockLevel = {
  sku: string;
  location: Location;
  snapshotDate: string;
  onHand: number;
  productName: string;
  productLine: string | null;
  unitCostUsd: string | null;
  unitCostIntlUsd: string | null;
};

// Unit-cost resolution lives in lib/domain/unit-cost.ts (one canonical
// implementation; the re-export preserves the established import path
// for the query layer).
import { resolveUnitCost, unitCostForLocation } from "@/lib/domain/unit-cost";
export { unitCostForLocation };

export async function getStockLevels(filters: { sku?: string; location?: Location } = {}): Promise<StockLevel[]> {
  // DISTINCT ON pushes latest-per-(sku, location) into Postgres. The old
  // version selected EVERY snapshot row ever taken (the table grows by
  // ~2x SKU count per day) and deduped in JS — fine at launch, but a
  // guaranteed page-killer as history accumulates, and this query feeds
  // /inventory, /stock-value, /overstock, and all three rollups.
  const rows = await db
    .selectDistinctOn([stockSnapshots.sku, stockSnapshots.location], {
      sku: stockSnapshots.sku,
      location: stockSnapshots.location,
      snapshotDate: stockSnapshots.snapshotDate,
      onHand: stockSnapshots.onHand,
      productName: skus.productName,
      productLine: skus.productLine,
      unitCostUsd: skus.unitCostUsd,
      unitCostIntlUsd: skus.unitCostIntlUsd,
    })
    .from(stockSnapshots)
    .leftJoin(skus, eq(skus.sku, stockSnapshots.sku))
    .where(
      and(
        filters.sku ? eq(stockSnapshots.sku, filters.sku) : sql`true`,
        filters.location ? eq(stockSnapshots.location, filters.location) : sql`true`
      )
    )
    .orderBy(
      stockSnapshots.sku,
      stockSnapshots.location,
      desc(stockSnapshots.snapshotDate),
    );

  return rows.map((r) => ({
    sku: r.sku,
    location: r.location,
    snapshotDate: r.snapshotDate,
    onHand: r.onHand,
    productName: r.productName ?? r.sku,
    productLine: r.productLine,
    unitCostUsd: r.unitCostUsd,
    unitCostIntlUsd: r.unitCostIntlUsd,
  }));
}

export async function getStockValue(filters: { location?: Location; productLine?: string } = {}) {
  const rows = await getStockLevels({ location: filters.location });
  const filtered = filters.productLine
    ? rows.filter((r) => r.productLine === filters.productLine)
    : rows;
  const total = filtered.reduce((n, r) => n + r.onHand * unitCostForLocation(r), 0);
  return { totalUsd: total, rowCount: filtered.length };
}

export type StockValueByLineRow = {
  productLine: string | null;
  totalUsd: number;
  skuCount: number;
  unitCount: number;
};

/** Stock value rolled up by `skus.productLine` for the given warehouse
 * (or both, if `location` is omitted). Closes the per-product-line
 * sub-bullet of SPEC §5.7 q2 ("total dollar value of current stock").
 *
 * SKUs missing a product_line collapse into a single `productLine: null`
 * bucket so the UI can render an explicit "Uncategorized" row rather
 * than silently dropping that capital from the totals.
 *
 * Sorted by totalUsd descending — biggest dollar buckets surface
 * first, matching the marketing/operations decision flow ("which line
 * is holding the most capital").
 */
export async function getStockValueByProductLine(
  filters: { location?: Location } = {},
): Promise<StockValueByLineRow[]> {
  const rows = await getStockLevels({ location: filters.location });
  const buckets = new Map<string | null, { totalUsd: number; skuCount: number; unitCount: number }>();
  for (const r of rows) {
    const key = r.productLine;
    const value = r.onHand * unitCostForLocation(r);
    const cur = buckets.get(key) ?? { totalUsd: 0, skuCount: 0, unitCount: 0 };
    cur.totalUsd += value;
    cur.skuCount += 1;
    cur.unitCount += r.onHand;
    buckets.set(key, cur);
  }
  return Array.from(buckets.entries())
    .map(([productLine, agg]) => ({ productLine, ...agg }))
    .sort((a, b) => b.totalUsd - a.totalUsd);
}

export type StockValueByProductRow = {
  productName: string;
  totalUsd: number;
  skuCount: number;
  unitCount: number;
  /** Units inbound that haven't been received yet — sum of pending PO
   * quantities across the SKUs in this product, minus anything Scott
   * has marked received via /incoming. */
  futureUnitCount: number;
  /** Future stock value: incoming units × per-warehouse unit cost. Listed
   * separately from `totalUsd` (current stock value) so Scott can see
   * tied-up capital that's still in transit. */
  futureValueUsd: number;
};

/** Stock value rolled up by `skus.productName` for the given warehouse
 * (or both, if `location` is omitted). Resolves Scott's punch-list #10
 * (2026-04-28): "split it up by product not main/sec".
 *
 * Where `getStockValueByProductLine` groups by the warehouse / brand
 * dimension (Main / HF / Sec), this groups by the actual garment line
 * — "Style 9055", "Boyshort Beige", etc. — which is the lens Scott
 * uses for capital-tied-up decisions. Names come from the velocity
 * sheet (`5af248d`) with the SKU-pattern parser as fallback, so the
 * vast majority of SKUs land in a meaningful bucket and only the ones
 * we couldn't name fall into the SKU-as-name bucket.
 *
 * Sorted by totalUsd descending — biggest dollar buckets surface
 * first.
 *
 * `futureUnitCount` + `futureValueUsd` are computed against
 * `incoming_shipments` joined with `incoming_receipts` (received POs
 * are excluded — those units are already in stock_snapshots and
 * already counted in `totalUsd`).
 */
export async function getStockValueByProduct(
  filters: { location?: Location } = {},
): Promise<StockValueByProductRow[]> {
  const rows = await getStockLevels({ location: filters.location });

  // Per-SKU lookup of (US cost, INTL cost) so we can value future stock at
  // its destination warehouse's cost. Built from the same row set so the
  // costs match what `totalUsd` uses below.
  const costBySku = new Map<string, { us: number; intl: number }>();
  for (const r of rows) {
    if (!costBySku.has(r.sku)) {
      costBySku.set(r.sku, {
        us: resolveUnitCost("US", r).value,
        intl: resolveUnitCost("CN", r).value,
      });
    }
  }
  // productName lookup so future-stock SKUs not currently in stock
  // (e.g. brand new product launching soon) still bucket correctly.
  const productNameBySku = new Map<string, string>();
  for (const r of rows) productNameBySku.set(r.sku, r.productName);

  // Pull pending incoming, filtered to the same warehouse(s) as `rows`.
  const incomingFilter = filters.location
    ? eq(incomingShipments.destination, filters.location)
    : sql`true`;
  const incomingRows = await db
    .select()
    .from(incomingShipments)
    .where(incomingFilter);
  const receivedKeys = await getReceivedShipmentKeys();
  const skuName = await db.select({ sku: skus.sku, productName: skus.productName }).from(skus);
  for (const k of skuName) {
    if (!productNameBySku.has(k.sku)) productNameBySku.set(k.sku, k.productName);
  }

  const buckets = new Map<
    string,
    {
      totalUsd: number;
      skuCount: number;
      unitCount: number;
      futureUnitCount: number;
      futureValueUsd: number;
      seenSkus: Set<string>;
    }
  >();
  for (const r of rows) {
    // productName is non-null (defaulted to sku in getStockLevels), so
    // every row gets a bucket — no "uncategorized" sink to lose capital in.
    const key = r.productName;
    const value = r.onHand * unitCostForLocation(r);
    const cur =
      buckets.get(key) ?? {
        totalUsd: 0,
        skuCount: 0,
        unitCount: 0,
        futureUnitCount: 0,
        futureValueUsd: 0,
        seenSkus: new Set<string>(),
      };
    cur.totalUsd += value;
    cur.unitCount += r.onHand;
    if (!cur.seenSkus.has(r.sku)) {
      cur.seenSkus.add(r.sku);
      cur.skuCount += 1;
    }
    buckets.set(key, cur);
  }

  for (const i of incomingRows) {
    const receiptKey = shipmentReceiptKey({
      shipmentName: i.shipmentName,
      destination: i.destination,
      expectedArrival: i.expectedArrival,
    });
    if (receivedKeys.has(receiptKey)) continue;
    const productName = productNameBySku.get(i.sku) ?? i.sku;
    const cost = costBySku.get(i.sku);
    const unitCost = i.destination === "US" ? cost?.us ?? 0 : cost?.intl ?? 0;
    const cur =
      buckets.get(productName) ?? {
        totalUsd: 0,
        skuCount: 0,
        unitCount: 0,
        futureUnitCount: 0,
        futureValueUsd: 0,
        seenSkus: new Set<string>(),
      };
    cur.futureUnitCount += i.quantity;
    cur.futureValueUsd += i.quantity * unitCost;
    if (!cur.seenSkus.has(i.sku)) {
      cur.seenSkus.add(i.sku);
      cur.skuCount += 1;
    }
    buckets.set(productName, cur);
  }

  return Array.from(buckets.entries())
    .map(([productName, agg]) => ({
      productName,
      totalUsd: agg.totalUsd,
      skuCount: agg.skuCount,
      unitCount: agg.unitCount,
      futureUnitCount: agg.futureUnitCount,
      futureValueUsd: agg.futureValueUsd,
    }))
    .sort((a, b) => b.totalUsd - a.totalUsd);
}
