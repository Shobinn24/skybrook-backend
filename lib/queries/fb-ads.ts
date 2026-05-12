import { and, desc, gte, lte, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { fbAdSpendDaily } from "@/lib/db/schema";
import { FB_MARKETER_UNASSIGNED } from "@/lib/domain/fb-marketers";

export type FbAdRow = {
  rank: number;
  adNumber: string;
  adName: string;
  adNameRaw: string;
  adLink: string | null;
  marketers: string[];
  spendUsd: number;
};

export type FbAdsRollup = {
  rangeStart: string;
  rangeEnd: string;
  rows: FbAdRow[];
  totalSpendUsd: number;
};

/** Top-spending FB ads in [rangeStart, rangeEnd] inclusive, sorted by
 * spend desc. Spend is summed within the window (pivot-by-ad is already
 * baked into the table at ingest time).
 *
 * `marketers` filter is post-grouping: if provided, only ads whose
 * marketers array intersects with the filter are returned. Pass
 * "Unassigned" as one of the filter values to include ads whose
 * marketers array is empty. Empty / undefined filter = no filtering.
 */
export async function getFbAdsRollup(opts: {
  rangeStart: string; // YYYY-MM-DD
  rangeEnd: string; // YYYY-MM-DD
  marketers?: ReadonlyArray<string>;
}): Promise<FbAdsRollup> {
  const result = await db
    .select({
      adNumber: fbAdSpendDaily.adNumber,
      adName: sql<string>`max(${fbAdSpendDaily.adName})`,
      adNameRaw: sql<string>`max(${fbAdSpendDaily.adNameRaw})`,
      adLink: sql<string | null>`max(${fbAdSpendDaily.adLink})`,
      marketers: sql<string[]>`min(${fbAdSpendDaily.marketers})`,
      spendUsd: sql<string>`coalesce(sum(${fbAdSpendDaily.costUsd}), 0)`,
    })
    .from(fbAdSpendDaily)
    .where(
      and(
        gte(fbAdSpendDaily.spendDate, opts.rangeStart),
        lte(fbAdSpendDaily.spendDate, opts.rangeEnd),
      ),
    )
    .groupBy(fbAdSpendDaily.adNumber)
    .orderBy(desc(sql`sum(${fbAdSpendDaily.costUsd})`));

  const filterSet = opts.marketers && opts.marketers.length > 0
    ? new Set<string>(opts.marketers)
    : null;
  const wantUnassigned = filterSet?.has(FB_MARKETER_UNASSIGNED) ?? false;

  const filtered = filterSet
    ? result.filter((r) => {
        const marketers = r.marketers ?? [];
        if (marketers.length === 0) return wantUnassigned;
        return marketers.some((m) => filterSet.has(m));
      })
    : result;

  const rows: FbAdRow[] = filtered.map((r, i) => ({
    rank: i + 1,
    adNumber: r.adNumber,
    adName: r.adName,
    adNameRaw: r.adNameRaw,
    adLink: r.adLink,
    marketers: r.marketers ?? [],
    spendUsd: Number(r.spendUsd),
  }));
  const totalSpendUsd = rows.reduce((s, r) => s + r.spendUsd, 0);

  return {
    rangeStart: opts.rangeStart,
    rangeEnd: opts.rangeEnd,
    rows,
    totalSpendUsd,
  };
}
