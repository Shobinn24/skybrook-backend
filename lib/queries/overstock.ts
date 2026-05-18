/**
 * Overstock view (SPEC §5.5).
 *
 * Marketing-facing slice of inventory: PRODUCTS whose rolled-up stock
 * significantly exceeds projected demand.
 *
 * Phase 2 (Scott 2026-05-18): the "overstocked" determination is now
 * PRODUCT-LEVEL, not per-SKU. We sum on-hand + incoming stock and 7d
 * velocity across every SKU of a product (both warehouses), then flag
 * the product when the combined days-of-stock exceeds
 * `thresholds.productOverstockDays` (300 days). The per-SKU
 * sustainability flag (`flag === "overstocked"`) is still computed in
 * the daily reconcile job and remains the operational signal on
 * /sustainability + /inventory; the /overstock page no longer uses it.
 *
 * The query returns the full SKU-level InventoryRow records for every
 * SKU of an overstocked product (across both locations) so the page can
 * still drill from product → SKU. Sorted by parent product's stock
 * value desc, then by SKU asc within product.
 */

import { thresholds } from "@/config/thresholds";
import { getInventoryRows, type InventoryRow } from "./inventory";

export type OverstockRow = InventoryRow;

export type OverstockSummary = {
  /** Number of unique products whose rolled-up DOS exceeded the
   * threshold. (Not SKU count — Phase 2.) */
  count: number;
  /** Total dollar value of inventory across every SKU of every
   * overstocked product. */
  totalStockValueUsd: number;
  /** Median rolled-up DOS across the flagged PRODUCTS (one value per
   * product, not per SKU). null when nothing is overstocked or every
   * overstocked product has zero combined velocity (Infinity DOS). */
  medianDaysOfStock: number | null;
};

export type OverstockResult = {
  rows: OverstockRow[];
  summary: OverstockSummary;
};

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) return (sorted[mid - 1] + sorted[mid]) / 2;
  return sorted[mid];
}

type ProductRollup = {
  productName: string;
  rows: InventoryRow[];
  totalOnHand: number;
  totalFutureStock: number;
  totalVelocityPerDay: number;
  totalStockValueUsd: number;
  /** futureStock / velocity (across all SKUs of the product, both
   * locations). Infinity when there's stock but zero combined velocity. */
  productDaysOfStock: number;
};

function rollupByProduct(rows: InventoryRow[]): ProductRollup[] {
  const byName = new Map<string, ProductRollup>();
  for (const r of rows) {
    const existing = byName.get(r.productName) ?? {
      productName: r.productName,
      rows: [],
      totalOnHand: 0,
      totalFutureStock: 0,
      totalVelocityPerDay: 0,
      totalStockValueUsd: 0,
      productDaysOfStock: 0,
    };
    existing.rows.push(r);
    existing.totalOnHand += r.onHand;
    existing.totalFutureStock += r.futureStock;
    existing.totalVelocityPerDay += r.velocityPerDay7d ?? 0;
    existing.totalStockValueUsd += r.stockValueUsd;
    byName.set(r.productName, existing);
  }
  for (const p of byName.values()) {
    p.productDaysOfStock =
      p.totalVelocityPerDay > 0
        ? p.totalFutureStock / p.totalVelocityPerDay
        : p.totalFutureStock > 0
          ? Infinity
          : 0;
  }
  return [...byName.values()];
}

/**
 * Pull every SKU at both warehouses, group by product, then surface
 * the SKUs of every product whose rolled-up DOS exceeds the
 * Phase-2 threshold (300d).
 */
export async function getOverstockRows(): Promise<OverstockResult> {
  const [us, cn] = await Promise.all([
    getInventoryRows("US"),
    getInventoryRows("CN"),
  ]);
  const all = [...us, ...cn];
  const rollups = rollupByProduct(all);

  const threshold = thresholds.productOverstockDays;
  const overstocked = rollups.filter((p) => p.productDaysOfStock > threshold);

  // Sort products by total stock value desc — biggest-leverage first.
  overstocked.sort((a, b) => b.totalStockValueUsd - a.totalStockValueUsd);

  // Emit SKU rows in product order; within product, biggest stock-value SKUs first.
  const rows: InventoryRow[] = [];
  for (const p of overstocked) {
    const sortedSkus = [...p.rows].sort(
      (a, b) => b.stockValueUsd - a.stockValueUsd,
    );
    rows.push(...sortedSkus);
  }

  const totalStockValueUsd = overstocked.reduce(
    (acc, p) => acc + p.totalStockValueUsd,
    0,
  );

  const finiteDos = overstocked
    .map((p) => p.productDaysOfStock)
    .filter((d): d is number => Number.isFinite(d));

  return {
    rows,
    summary: {
      count: overstocked.length,
      totalStockValueUsd,
      medianDaysOfStock: median(finiteDos),
    },
  };
}
