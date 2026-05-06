// Inventory-tab at-risk classification per Scott 2026-05-06:
//
//   "Inventory tab status: At risk --> Can we adjust this so it
//    displays at risk based off the sustainability report? And show X
//    number of SKUs at risk of running out. Probably limit this to
//    only count SKUs at risk of running out in the next 45 days
//    (on the inventory tab)."
//
// The display rule is INVENTORY-TAB-ONLY. Other tabs (sustainability,
// sku detail, overstock) keep the underlying projection-based flag
// values stored in sustainability_flags.
//
// Logic per row:
//  - overstocked stays overstocked.
//  - If the projected run-out date OR DOS-implied run-out lands
//    within `horizonDays`, render "at_risk".
//  - If the row was at_risk but the run-out is beyond the horizon,
//    soften to "watch" so the KPI count means exactly what Scott
//    asked for.
//  - Otherwise preserve the underlying flag.

import type { InventoryRow } from "@/lib/queries/inventory";

export const AT_RISK_HORIZON_DAYS = 45;

function addDays(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** True when this row's projected run-out (or DOS-implied run-out)
 * falls inside the horizon window. */
export function isAtRiskWithin(
  row: Pick<InventoryRow, "runOutDate" | "daysOfStock" | "flag">,
  asOfDate: string,
  horizonDays: number = AT_RISK_HORIZON_DAYS,
): boolean {
  // Overstocked is excluded — these have far more stock than needed,
  // so they're never "at risk of running out".
  if (row.flag === "overstocked") return false;
  // Projection-based date is the strongest signal when present.
  if (row.runOutDate !== null) {
    return row.runOutDate <= addDays(asOfDate, horizonDays);
  }
  // Fallback: DOS-implied run-out. Used when the SKU has no upcoming
  // POs to walk through, so the projection didn't produce a date.
  if (row.daysOfStock !== null && Number.isFinite(row.daysOfStock)) {
    return row.daysOfStock <= horizonDays;
  }
  return false;
}

export type DisplayFlag = "healthy" | "watch" | "at_risk" | "overstocked" | null;

/** Transform a row's projection flag for inventory-tab display. The
 * underlying `row.flag` is unchanged in the database — only the
 * displayed value flips when the run-out window check disagrees. */
export function transformedDisplayFlag(
  row: Pick<InventoryRow, "runOutDate" | "daysOfStock" | "flag">,
  asOfDate: string,
  horizonDays: number = AT_RISK_HORIZON_DAYS,
): DisplayFlag {
  if (row.flag === "overstocked") return "overstocked";
  if (isAtRiskWithin(row, asOfDate, horizonDays)) return "at_risk";
  // Was projected at_risk but beyond horizon → soften to watch so the
  // 45-day KPI count stays honest.
  if (row.flag === "at_risk") return "watch";
  return row.flag;
}

/** Returns a copy of the row list with each `flag` adjusted for the
 * inventory-tab horizon rule. Non-flag fields are passed through. */
export function applyAtRiskWindow<R extends Pick<InventoryRow, "runOutDate" | "daysOfStock" | "flag">>(
  rows: ReadonlyArray<R>,
  asOfDate: string,
  horizonDays: number = AT_RISK_HORIZON_DAYS,
): R[] {
  return rows.map((r) => ({ ...r, flag: transformedDisplayFlag(r, asOfDate, horizonDays) }));
}
