import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { skus, stockSnapshots } from "@/lib/db/schema";
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

// Pick the per-warehouse cost. CN uses the INTL column; US uses the US
// column. When the location-specific cost is null (Scott hasn't priced
// that SKU internationally yet, or the migration just landed) we fall
// back to US so the dashboard stays usable rather than zeroing out CN
// stock value.
export function unitCostForLocation(row: {
  location: Location;
  unitCostUsd: string | null;
  unitCostIntlUsd: string | null;
}): number {
  if (row.location === "US") {
    return Number(row.unitCostUsd ?? 0);
  }
  return Number(row.unitCostIntlUsd ?? row.unitCostUsd ?? 0);
}

export async function getStockLevels(filters: { sku?: string; location?: Location } = {}): Promise<StockLevel[]> {
  const rows = await db
    .select({
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
    .orderBy(desc(stockSnapshots.snapshotDate));

  // Keep only the latest snapshot per (sku, location).
  const seen = new Set<string>();
  const latest: StockLevel[] = [];
  for (const r of rows) {
    const k = `${r.sku}:${r.location}`;
    if (seen.has(k)) continue;
    seen.add(k);
    latest.push({
      sku: r.sku,
      location: r.location,
      snapshotDate: r.snapshotDate,
      onHand: r.onHand,
      productName: r.productName ?? r.sku,
      productLine: r.productLine,
      unitCostUsd: r.unitCostUsd,
      unitCostIntlUsd: r.unitCostIntlUsd,
    });
  }
  return latest;
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
 */
export async function getStockValueByProduct(
  filters: { location?: Location } = {},
): Promise<StockValueByProductRow[]> {
  const rows = await getStockLevels({ location: filters.location });
  const buckets = new Map<string, { totalUsd: number; skuCount: number; unitCount: number }>();
  for (const r of rows) {
    // productName is non-null (defaulted to sku in getStockLevels), so
    // every row gets a bucket — no "uncategorized" sink to lose capital in.
    const key = r.productName;
    const value = r.onHand * unitCostForLocation(r);
    const cur = buckets.get(key) ?? { totalUsd: 0, skuCount: 0, unitCount: 0 };
    cur.totalUsd += value;
    cur.skuCount += 1;
    cur.unitCount += r.onHand;
    buckets.set(key, cur);
  }
  return Array.from(buckets.entries())
    .map(([productName, agg]) => ({ productName, ...agg }))
    .sort((a, b) => b.totalUsd - a.totalUsd);
}
