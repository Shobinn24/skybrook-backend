/**
 * Overstock view (SPEC §5.5).
 *
 * Marketing-facing slice of inventory: SKUs whose stock significantly
 * exceeds projected demand. The "overstocked" classification is the
 * same ⚫ flag the sustainability logic already computes during the
 * daily reconcile job (§5.3) — this query is a thin filter + per-page
 * summary, not a re-derivation, so we never disagree with the flag
 * shown on the Sustainability and Inventory pages.
 */

import { getInventoryRows, type InventoryRow } from "./inventory";

export type OverstockRow = InventoryRow;

export type OverstockSummary = {
  /** Number of SKU × location rows currently flagged ⚫ overstocked. */
  count: number;
  /** Total dollar value of inventory tied up in overstocked SKUs. The
   * marketing leverage signal — "how much capital is sitting waiting
   * to be sold through". */
  totalStockValueUsd: number;
  /** Median days-of-stock across overstocked rows; surfaces how
   * extreme the overstock skew is (e.g., median 180 means half are
   * sitting on >6 months of inventory). null if no overstocked rows.
   */
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
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

/** Pull both warehouses (US + CN), filter to ⚫ overstocked, sort by
 * stock-value descending so the biggest-leverage marketing
 * candidates land at the top. Caller can re-sort client-side without
 * a roundtrip if needed.
 */
export async function getOverstockRows(): Promise<OverstockResult> {
  const [us, cn] = await Promise.all([
    getInventoryRows("US"),
    getInventoryRows("CN"),
  ]);
  const rows = [...us, ...cn].filter((r) => r.flag === "overstocked");
  rows.sort((a, b) => b.stockValueUsd - a.stockValueUsd);

  const totalStockValueUsd = rows.reduce((acc, r) => acc + r.stockValueUsd, 0);
  // Some flag computations leave daysOfStock null when velocity is zero
  // (the "infinite DOS" case is exactly what an overstock row often is —
  // can't divide by zero, but the flag still fires). Filter out nulls
  // and Infinity so the median is meaningful for real comparisons; if
  // every overstocked row has null DOS, we return null rather than NaN.
  const finiteDos = rows
    .map((r) => r.daysOfStock)
    .filter((d): d is number => d !== null && Number.isFinite(d));

  return {
    rows,
    summary: {
      count: rows.length,
      totalStockValueUsd,
      medianDaysOfStock: median(finiteDos),
    },
  };
}
