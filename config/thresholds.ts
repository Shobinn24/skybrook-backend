// Thresholds locked 2026-04-23 by Scott; revisit later if needed.
export const thresholds = {
  // SPEC §5.3 sustainability flags (per-SKU operational signal)
  watchDays: 14,       // 🟡 watch: DOS ≤ 14 (when projection has <2 POs to walk through)
  atRiskDays: 7,       // 🔴 at_risk: DOS < 7 fallback
  overstockFutureWeeks: 40, // ⚫ overstocked: future weeks of stock > 40 (≈ 280 days). Counts on-hand + still-incoming POs.
  // /overstock page (Phase 2 — product-level marketing leverage signal).
  // Scott 2026-05-18: "Anything above 300 days." Applied to the product
  // rollup, NOT per-SKU — sum stock + sum velocity across every SKU of
  // a product (both locations) and flag the product if the combined DOS
  // exceeds this threshold.
  productOverstockDays: 300,
};
