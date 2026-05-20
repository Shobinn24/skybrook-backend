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
 */
export async function detectAndInsertBonusCrossings(opts?: {
  asOfDate?: string; // YYYY-MM-DD, defaults to today EST
}): Promise<BonusCrossingDetectResult> {
  const crossedAt = opts?.asOfDate ?? toEstDate(new Date());

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

  let scanned = 0;
  const candidates: Array<{
    adNumber: string;
    marketer: BonusMarketer;
    tier: "tier1" | "tier2";
    amount: number;
  }> = [];

  for (const row of ads) {
    const spend = Number(row.lifetimeSpendUsd);
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
    logger.info("bonus.crossings.detect", { scanned, inserted: 0, alreadyExisted: 0 });
    return { scanned, inserted: 0, alreadyExisted: 0 };
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
  };
  logger.info("bonus.crossings.detect", result);
  return result;
}
