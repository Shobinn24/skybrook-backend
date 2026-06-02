import { inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { bonusAwards, fbAdSpendDaily } from "@/lib/db/schema";
import {
  BONUS_MARKETERS,
  BONUS_TIER_1_USD,
  BONUS_TIER_2_USD,
  bonusAmountAtFullUsd,
  firstCrossingDate,
  isAboveBonusFloor,
  type BonusMarketer,
} from "@/lib/domain/bonus-tiers";
import { logger } from "@/lib/logger";
import { toEstDate } from "@/lib/tz";

export type BonusCrossingDetectResult = {
  scanned: number;        // ad_numbers considered (with at least one bonus marketer)
  inserted: number;       // new pending awards created
  alreadyExisted: number; // crossings that were already tracked
  phantomSkipped: number; // tiers dropped because already exceeded before lookback window
};

const BONUS_MARKETER_SET: ReadonlySet<string> = new Set(BONUS_MARKETERS);

/** YYYY-MM-DD minus n days, in UTC, as YYYY-MM-DD. */
function isoMinusDays(ymd: string, n: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

/**
 * Scan `fb_ad_spend_daily`, aggregate lifetime spend per (ad × marketer),
 * and insert a `pending` bonus_awards row for every (ad, marketer, tier)
 * crossing not already tracked.
 *
 * Multi-marketer ads attribute 100% of the ad's lifetime spend to each
 * marketer in the array — same convention as the lifetime view (Phase A)
 * + the FB Ads Tracker filter. So a $30k ad on (Craig, Raul) crosses
 * T1 for BOTH Craig and Raul.
 *
 * Idempotent via the (ad_number, marketer, tier) unique index — re-runs
 * skip rows that already exist regardless of status. If an operator
 * rejected an award, the detector won't try to re-insert it.
 *
 * `crossed_at` is each tier's REAL crossing date — the spend_date on which
 * the ad's cumulative spend first reached the threshold (via
 * `firstCrossingDate`), NOT the detection/run date. This drives the payout
 * month, so a crossing that happens late in a month but only settles in FB
 * the next month is still attributed to the month it actually occurred
 * (e.g. ad 1901 crossed $13k on 2026-05-30 but FB settled it 2026-06-02 —
 * it must pay as May, not June).
 *
 * `lookbackDays` (added 2026-05-28 after the FB 3-yr history import
 * phantom-crossing incident) gates "this is a genuinely new crossing"
 * against pre-window spend. The 5/27 import dropped 130k rows of
 * 2023-2025 spend into the table; the next cron summed lifetime spend
 * and saw 14 ads suddenly exceeding tier1/tier2 thresholds — but those
 * ads had crossed those thresholds years ago, the data just hadn't
 * been in the DB yet. With lookbackDays set, we require BOTH
 * `lifetimeNow >= threshold` AND `lifetimeBefore(crossedAt - N days)
 * < threshold` so the threshold must have been crossed during the
 * window, not before. Set in the cron call site; left undefined here
 * preserves prior behavior for tests that don't depend on the filter.
 */
export async function detectAndInsertBonusCrossings(opts?: {
  asOfDate?: string; // YYYY-MM-DD, defaults to today EST
  lookbackDays?: number; // if set, only fire when crossing happened in the last N days
}): Promise<BonusCrossingDetectResult> {
  const asOfDate = opts?.asOfDate ?? toEstDate(new Date());
  const lookbackDays = opts?.lookbackDays;
  // Crossings whose REAL crossing date is strictly before this cutoff are
  // pre-window "phantoms" (e.g. the 2026-05-28 FB 3-yr history import that
  // dropped years of spend into the table at once) and are skipped when
  // lookbackDays is set. Compared as a YYYY-MM-DD string (ISO dates sort
  // lexicographically).
  const beforeCutoff =
    lookbackDays != null ? isoMinusDays(asOfDate, lookbackDays) : null;

  // Lifetime spend per ad — group by ad_number, sum cost_usd, preserve
  // the marketers array (it's the same on every row for a given ad).
  const ads = await db
    .select({
      adNumber: fbAdSpendDaily.adNumber,
      marketers: sql<string[]>`min(${fbAdSpendDaily.marketers})`,
      lifetimeSpendUsd: sql<string>`coalesce(sum(${fbAdSpendDaily.costUsd}), 0)`,
    })
    .from(fbAdSpendDaily)
    .groupBy(fbAdSpendDaily.adNumber);

  // First pass: which ads hit a tier and so need a real crossing date?
  const hits: Array<{
    adNumber: string;
    marketers: BonusMarketer[];
    hitTier1: boolean;
    hitTier2: boolean;
  }> = [];
  for (const row of ads) {
    const spend = Number(row.lifetimeSpendUsd);
    const marketers = (row.marketers ?? []).filter((m) =>
      BONUS_MARKETER_SET.has(m),
    ) as BonusMarketer[];
    if (marketers.length === 0) continue;
    const hitTier2 = spend >= BONUS_TIER_2_USD;
    const hitTier1 = hitTier2 || spend >= BONUS_TIER_1_USD; // T2 implies T1
    if (!hitTier1) continue;
    hits.push({ adNumber: row.adNumber, marketers, hitTier1, hitTier2 });
  }

  // Pull the daily series ONLY for ads that hit a tier, so we can compute
  // each tier's true crossing date (the day cumulative spend first reached
  // the threshold). Scoping to hit ads keeps this cheap vs. pulling every
  // ad's full history every run.
  const hitAdNumbers = hits.map((h) => h.adNumber);
  const dailyRows = hitAdNumbers.length
    ? await db
        .select({
          adNumber: fbAdSpendDaily.adNumber,
          spendDate: fbAdSpendDaily.spendDate,
          costUsd: fbAdSpendDaily.costUsd,
        })
        .from(fbAdSpendDaily)
        .where(inArray(fbAdSpendDaily.adNumber, hitAdNumbers))
    : [];
  const dailyByAd = new Map<
    string,
    Array<{ spendDate: string; costUsd: number }>
  >();
  for (const r of dailyRows) {
    const arr = dailyByAd.get(r.adNumber) ?? [];
    arr.push({ spendDate: r.spendDate, costUsd: Number(r.costUsd) });
    dailyByAd.set(r.adNumber, arr);
  }

  let scanned = 0;
  let phantomSkipped = 0;
  const candidates: Array<{
    adNumber: string;
    marketer: BonusMarketer;
    tier: "tier1" | "tier2";
    amount: number;
    crossedAt: string;
  }> = [];

  for (const hit of hits) {
    const daily = dailyByAd.get(hit.adNumber) ?? [];
    const crossT1 = hit.hitTier1
      ? firstCrossingDate(daily, BONUS_TIER_1_USD)
      : null;
    const crossT2 = hit.hitTier2
      ? firstCrossingDate(daily, BONUS_TIER_2_USD)
      : null;

    let fireT1 = crossT1 != null;
    let fireT2 = crossT2 != null;

    // Phantom-crossing guard. When lookbackDays is set, drop any tier whose
    // REAL crossing date predates the window — that's historical data
    // surfacing, not a fresh crossing. Tracked separately for the run log.
    if (beforeCutoff != null) {
      if (fireT1 && crossT1! < beforeCutoff) {
        fireT1 = false;
        phantomSkipped++;
      }
      if (fireT2 && crossT2! < beforeCutoff) {
        fireT2 = false;
        phantomSkipped++;
      }
    }
    if (!fireT1 && !fireT2) continue;

    scanned++;
    for (const marketer of hit.marketers) {
      // Hard floor per marketer — silently skip below-floor ads so they
      // never enter the pending queue (Scott 2026-05-20).
      if (!isAboveBonusFloor(marketer, hit.adNumber)) continue;
      if (fireT1) {
        candidates.push({
          adNumber: hit.adNumber,
          marketer,
          tier: "tier1",
          amount: bonusAmountAtFullUsd({ marketer, tier: "tier1" }),
          crossedAt: crossT1!,
        });
      }
      if (fireT2) {
        candidates.push({
          adNumber: hit.adNumber,
          marketer,
          tier: "tier2",
          amount: bonusAmountAtFullUsd({ marketer, tier: "tier2" }),
          crossedAt: crossT2!,
        });
      }
    }
  }

  if (candidates.length === 0) {
    logger.info("bonus.crossings.detect", {
      scanned,
      inserted: 0,
      alreadyExisted: 0,
      phantomSkipped,
    });
    return { scanned, inserted: 0, alreadyExisted: 0, phantomSkipped };
  }

  // Bulk-insert with ON CONFLICT DO NOTHING — the (ad, marketer, tier)
  // unique index handles dedup. RETURNING tells us which rows actually
  // got inserted vs. were skipped.
  const inserted = await db
    .insert(bonusAwards)
    .values(
      candidates.map((c) => ({
        adNumber: c.adNumber,
        marketer: c.marketer,
        tier: c.tier,
        crossedAt: c.crossedAt,
        status: "pending" as const,
        amountUsd: c.amount.toFixed(2),
      })),
    )
    .onConflictDoNothing({
      target: [bonusAwards.adNumber, bonusAwards.marketer, bonusAwards.tier],
    })
    .returning({ id: bonusAwards.id });

  const result = {
    scanned,
    inserted: inserted.length,
    alreadyExisted: candidates.length - inserted.length,
    phantomSkipped,
  };
  logger.info("bonus.crossings.detect", result);
  return result;
}
