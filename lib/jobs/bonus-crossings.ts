import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { bonusAwards, fbAdSpendDaily } from "@/lib/db/schema";
import {
  BONUS_MARKETERS,
  BONUS_TIER_1_USD,
  BONUS_TIER_2_USD,
  bonusAmountAtFullUsd,
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
 * `crossed_at` is set to today (EST). The actual historical first-
 * crossing date isn't reconstructed because it doesn't affect the
 * payout — only the existence of the crossing matters for the monthly
 * notification.
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
  const crossedAt = opts?.asOfDate ?? toEstDate(new Date());
  const lookbackDays = opts?.lookbackDays;

  // Lifetime spend per ad — group by ad_number, sum cost_usd, preserve
  // the marketers array (it's the same on every row for a given ad).
  // When lookbackDays is set, also compute the "before-window" lifetime
  // (spend strictly before crossedAt - N days) so we can tell whether
  // the threshold was already exceeded before this window opened.
  // Quoted-literal interpolation here because sql.raw needs valid SQL —
  // `2026-05-28::date` is parsed as integer-arithmetic, only `'2026-05-28'::date`
  // is a date cast. `crossedAt` is internally generated (toEstDate / explicit opts)
  // so the literal interpolation is safe from injection.
  const beforeCutoff = lookbackDays != null
    ? `'${crossedAt}'::date - ${lookbackDays}::int`
    : null;
  const ads = await db
    .select({
      adNumber: fbAdSpendDaily.adNumber,
      marketers: sql<string[]>`min(${fbAdSpendDaily.marketers})`,
      lifetimeSpendUsd: sql<string>`coalesce(sum(${fbAdSpendDaily.costUsd}), 0)`,
      lifetimeBeforeUsd: beforeCutoff
        ? sql<string>`coalesce(sum(${fbAdSpendDaily.costUsd}) filter (where ${fbAdSpendDaily.spendDate} < ${sql.raw(beforeCutoff)}), 0)`
        : sql<string>`0`,
    })
    .from(fbAdSpendDaily)
    .groupBy(fbAdSpendDaily.adNumber);

  let scanned = 0;
  let phantomSkipped = 0;
  const candidates: Array<{
    adNumber: string;
    marketer: BonusMarketer;
    tier: "tier1" | "tier2";
    amount: number;
  }> = [];

  for (const row of ads) {
    const spend = Number(row.lifetimeSpendUsd);
    const spendBefore = Number(row.lifetimeBeforeUsd);
    const marketers = (row.marketers ?? []).filter((m) =>
      BONUS_MARKETER_SET.has(m),
    ) as BonusMarketer[];
    if (marketers.length === 0) continue;

    let hitTier1 = false;
    let hitTier2 = false;
    if (spend >= BONUS_TIER_2_USD) {
      hitTier1 = true; // T2 implies T1 — both rows get created
      hitTier2 = true;
    } else if (spend >= BONUS_TIER_1_USD) {
      hitTier1 = true;
    }
    if (!hitTier1 && !hitTier2) continue;

    // Phantom-crossing guard. When lookbackDays is set, drop any tier
    // whose threshold was already crossed before the window opened —
    // those aren't fresh crossings, they're historical data appearing
    // in the DB for the first time. Tracked separately for the run log.
    if (lookbackDays != null) {
      if (hitTier1 && spendBefore >= BONUS_TIER_1_USD) {
        hitTier1 = false;
        phantomSkipped++;
      }
      if (hitTier2 && spendBefore >= BONUS_TIER_2_USD) {
        hitTier2 = false;
        phantomSkipped++;
      }
      if (!hitTier1 && !hitTier2) continue;
    }

    scanned++;
    for (const marketer of marketers) {
      // Hard floor per marketer — silently skip below-floor ads so they
      // never enter the pending queue (Scott 2026-05-20).
      if (!isAboveBonusFloor(marketer, row.adNumber)) continue;
      if (hitTier1) {
        candidates.push({
          adNumber: row.adNumber,
          marketer,
          tier: "tier1",
          amount: bonusAmountAtFullUsd({ marketer, tier: "tier1" }),
        });
      }
      if (hitTier2) {
        candidates.push({
          adNumber: row.adNumber,
          marketer,
          tier: "tier2",
          amount: bonusAmountAtFullUsd({ marketer, tier: "tier2" }),
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
        crossedAt,
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
