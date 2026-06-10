// Single source of truth for per-warehouse unit-cost resolution.
//
// History: this logic existed in four diverging copies — stock.ts
// (CN: intl ?? US ?? 0), inventory.ts (separate value + source-label
// logic), factory-order-calc.ts (CN: intl ?? 0, NO US fallback), and
// the SKU detail page (intl ?? US display). The divergence was real:
// the same SKU could be valued differently one page over, and the
// factory-order path (the one that writes money) was the strictest.
// Keep ALL call sites on this module; document any intentional mode
// difference at the call site.

import type { Location } from "@/lib/domain/warehouse-routing";

export type UnitCostFields = {
  unitCostUsd: string | number | null;
  unitCostIntlUsd: string | number | null;
};

export type UnitCostSource = "intl" | "us" | "none";

export type ResolvedUnitCost = {
  value: number;
  /** Which skus column actually supplied the value. */
  source: UnitCostSource;
};

/** A cost counts only when present and > 0 — the cost sheet leaves
 * unpriced SKUs blank (null), and an explicit 0 is never a real cost. */
function pricedNumber(v: string | number | null): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Resolve the unit cost for a SKU at a warehouse.
 *
 * - US always uses the US cost column (no cross-warehouse fallback —
 *   a missing US cost is surfaced by the missing-cost checks, not
 *   papered over with the INTL number).
 * - CN, mode "fallback" (default — dashboards, stock valuation): INTL
 *   cost when priced, else the US cost, so CN stock value stays usable
 *   instead of zeroing while pricing catches up.
 * - CN, mode "strict" (factory orders): INTL cost or 0, never the US
 *   fallback. An order line priced at the wrong warehouse's cost is
 *   wrong-but-plausible money; an explicit $0 line is loud and caught
 *   by the factory_orders.approved_zero_lines freshness alert.
 */
export function resolveUnitCost(
  location: Location,
  costs: UnitCostFields,
  opts: { mode?: "fallback" | "strict" } = {},
): ResolvedUnitCost {
  const us = pricedNumber(costs.unitCostUsd);
  const intl = pricedNumber(costs.unitCostIntlUsd);
  if (location === "US") {
    return us !== null ? { value: us, source: "us" } : { value: 0, source: "none" };
  }
  if (intl !== null) return { value: intl, source: "intl" };
  if (opts.mode !== "strict" && us !== null) return { value: us, source: "us" };
  return { value: 0, source: "none" };
}

/** Legacy row-shaped convenience used across the query layer (default
 * "fallback" mode). Prefer resolveUnitCost in new code. */
export function unitCostForLocation(row: UnitCostFields & { location: Location }): number {
  return resolveUnitCost(row.location, row).value;
}
