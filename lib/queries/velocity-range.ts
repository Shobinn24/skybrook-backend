import { and, eq, gte, lte, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { dailySales } from "@/lib/db/schema";
import type { Location } from "@/lib/domain/warehouse-routing";

export type VelocityForRangeRow = {
  sku: string;
  unitsSold: number;
  unitsPerDay: number;
};

export type VelocityForRangeResult = {
  location: Location;
  rangeStart: string;
  /** Effective inclusive rangeEnd actually used in the SQL window — may
   * be earlier than what the caller asked for if their request extended
   * past the last complete sales day. */
  rangeEnd: string;
  /** What the caller requested before clamping. Equal to `rangeEnd`
   * when no clamping happened; UI compares the two to decide whether
   * to show a "computed through X" hint. */
  requestedRangeEnd: string;
  /** Inclusive day count between rangeStart and (clamped) rangeEnd.
   * Reflects the EFFECTIVE window, so unitsSold / rangeDays is the
   * true average over complete-data days only. */
  rangeDays: number;
  rows: VelocityForRangeRow[];
};

// Number of inclusive days between two YYYY-MM-DD dates.
function inclusiveDayCount(rangeStart: string, rangeEnd: string): number {
  const a = new Date(`${rangeStart}T00:00:00Z`).getTime();
  const b = new Date(`${rangeEnd}T00:00:00Z`).getTime();
  return Math.round((b - a) / 86_400_000) + 1;
}

/**
 * On-demand per-SKU velocity over an arbitrary date range × warehouse.
 *
 * Used by /inventory when the operator picks a non-default window so
 * they can cross-check against external spreadsheets. The default
 * 7-day velocity continues to come from the pre-computed
 * `sales_velocity` table — this query only runs when a custom range
 * is selected.
 *
 * Filtering by `routed_location` matches the per-warehouse split that
 * runPhase2 applies to `sales_velocity`. SKUs with no sales in the
 * window are omitted from the result (caller should treat absence as
 * zero velocity, same convention as the pre-computed path).
 *
 * **Freshness-day clamping** (2026-05-19 ops feedback): the input
 * `rangeEnd` is clamped to `max(salesDate)` for the requested location.
 * Without this clamp, a window that extends past the last complete
 * sales day silently inflates the denominator (e.g., 7-day window
 * containing 1 empty future day = sums/7 instead of sums/6) and the
 * UI's preset windows visibly disagreed with the same-window Custom
 * picker by 10–22% during cron-stale stretches. After clamping, both
 * paths agree per SKU and reflect "true average over complete data."
 *
 * The original requested rangeEnd is preserved in `requestedRangeEnd`
 * so the picker can render a hint like "computed through 2026-05-21
 * (request was 2026-05-22)" when clamping happened.
 */
export async function getVelocityForRange(opts: {
  location: Location;
  rangeStart: string; // YYYY-MM-DD inclusive
  rangeEnd: string; // YYYY-MM-DD inclusive
}): Promise<VelocityForRangeResult> {
  const { location } = opts;
  const [rangeStart, requestedRangeEnd] =
    opts.rangeStart <= opts.rangeEnd
      ? [opts.rangeStart, opts.rangeEnd]
      : [opts.rangeEnd, opts.rangeStart];

  // Per-location last complete sales day. Clamp the requested rangeEnd
  // to this when the caller's window extends past it. When the location
  // has no sales rows at all (rare — new warehouse, test fixture), the
  // max returns null and we skip clamping; the SQL window then returns
  // an empty result and unitsPerDay defaults sensibly.
  const [maxRow] = await db
    .select({ max: sql<string | null>`max(${dailySales.salesDate})` })
    .from(dailySales)
    .where(eq(dailySales.routedLocation, location));
  const lastCompleteDay = maxRow?.max ?? null;

  let rangeEnd = requestedRangeEnd;
  if (lastCompleteDay && lastCompleteDay < requestedRangeEnd) {
    rangeEnd = lastCompleteDay;
  }

  // Pathological case: caller asked for a window entirely past the last
  // complete day (e.g., rangeStart=2026-06-01 when latest sale is
  // 2026-05-21). Returning zero rows + rangeDays=0 keeps the math sane
  // (callers compute unitsSold/rangeDays in their own derived views;
  // we never divide here at the SQL level — `unitsPerDay` below uses
  // the clamped count, with a 1-min guard against div-by-zero).
  if (rangeEnd < rangeStart) {
    return {
      location,
      rangeStart,
      rangeEnd,
      requestedRangeEnd,
      rangeDays: 0,
      rows: [],
    };
  }

  const rangeDays = inclusiveDayCount(rangeStart, rangeEnd);

  const result = await db
    .select({
      sku: dailySales.sku,
      unitsSold: sql<number>`coalesce(sum(${dailySales.unitsSold}), 0)::int`,
    })
    .from(dailySales)
    .where(
      and(
        eq(dailySales.routedLocation, location),
        gte(dailySales.salesDate, rangeStart),
        lte(dailySales.salesDate, rangeEnd),
      ),
    )
    .groupBy(dailySales.sku);

  const rows: VelocityForRangeRow[] = result.map((r) => ({
    sku: r.sku,
    unitsSold: r.unitsSold,
    unitsPerDay: rangeDays > 0 ? r.unitsSold / rangeDays : 0,
  }));

  return { location, rangeStart, rangeEnd, requestedRangeEnd, rangeDays, rows };
}
