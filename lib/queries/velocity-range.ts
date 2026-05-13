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
  rangeEnd: string;
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
 */
export async function getVelocityForRange(opts: {
  location: Location;
  rangeStart: string; // YYYY-MM-DD inclusive
  rangeEnd: string; // YYYY-MM-DD inclusive
}): Promise<VelocityForRangeResult> {
  const { location } = opts;
  const [rangeStart, rangeEnd] =
    opts.rangeStart <= opts.rangeEnd
      ? [opts.rangeStart, opts.rangeEnd]
      : [opts.rangeEnd, opts.rangeStart];

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
    unitsPerDay: r.unitsSold / rangeDays,
  }));

  return { location, rangeStart, rangeEnd, rangeDays, rows };
}
