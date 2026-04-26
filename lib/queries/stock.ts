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
};

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
    });
  }
  return latest;
}

export async function getStockValue(filters: { location?: Location; productLine?: string } = {}) {
  const rows = await getStockLevels({ location: filters.location });
  const filtered = filters.productLine
    ? rows.filter((r) => r.productLine === filters.productLine)
    : rows;
  const total = filtered.reduce((n, r) => n + r.onHand * Number(r.unitCostUsd ?? 0), 0);
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
    const value = r.onHand * Number(r.unitCostUsd ?? 0);
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
