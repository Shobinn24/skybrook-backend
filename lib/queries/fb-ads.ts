import { and, desc, gte, lte, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { fbAdSpendDaily } from "@/lib/db/schema";

export type FbAdRow = {
  rank: number;
  adNumber: string;
  adName: string;
  adNameRaw: string;
  adLink: string | null;
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
 * baked into the table at ingest time). */
export async function getFbAdsRollup(opts: {
  rangeStart: string; // YYYY-MM-DD
  rangeEnd: string; // YYYY-MM-DD
}): Promise<FbAdsRollup> {
  const result = await db
    .select({
      adNumber: fbAdSpendDaily.adNumber,
      adName: sql<string>`max(${fbAdSpendDaily.adName})`,
      adNameRaw: sql<string>`max(${fbAdSpendDaily.adNameRaw})`,
      adLink: sql<string | null>`max(${fbAdSpendDaily.adLink})`,
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

  const rows: FbAdRow[] = result.map((r, i) => ({
    rank: i + 1,
    adNumber: r.adNumber,
    adName: r.adName,
    adNameRaw: r.adNameRaw,
    adLink: r.adLink,
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
