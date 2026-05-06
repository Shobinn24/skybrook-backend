// Thresholds locked 2026-04-23 by Scott; revisit later if needed.
export const thresholds = {
  // SPEC §5.3 sustainability flags
  watchDays: 14,       // 🟡 watch: DOS ≤ 14 (when projection has <2 POs to walk through)
  atRiskDays: 7,       // 🔴 at_risk: DOS < 7 fallback
  overstockFutureWeeks: 40, // ⚫ overstocked: future weeks of stock > 40 (≈ 280 days). Counts on-hand + still-incoming POs.
};
