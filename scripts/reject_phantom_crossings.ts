// Phantom-crossing cleanup for the 2026-05-28 incident.
//
// On 2026-05-27 the FB 3-year history import (`f010b8e`) added 130k
// rows of 2023-2025 ad spend to `fb_ad_spend_daily`. The next cron run
// (09:04 UTC on 5/28) summed lifetime spend per ad, saw 14 ads
// suddenly exceeding tier1/tier2 thresholds, and created 14 `pending`
// `bonus_awards` rows totalling $13,500 on ads that had crossed those
// thresholds years ago (some last spent in 2024). Approving any of
// these would be a phantom or double payout.
//
// This script flips those rows to `status='rejected'` with an audit
// note. The detector's unique index on (ad_number, marketer, tier)
// means once rejected they will NOT be re-inserted by future cron
// runs, so this is a permanent fix even before the in-code detector
// patch lands (lookbackDays guard in `lib/jobs/bonus-crossings.ts`).
//
// Identification rule:
//   - status = 'pending'
//   - crossed_at = '2026-05-28' (the day of the phantom-creating run)
//   - the ad's most-recent spend in fb_ad_spend_daily is older than
//     the run by more than 14 days, OR the ad's pre-window lifetime
//     (everything before crossed_at - 14 days) was already past the
//     row's tier threshold.
//
// Same shape as `reconcile_historical_bonus_pending.ts`: dry-run by
// default, --apply to write.
//
// Run (prod):
//   DATABASE_URL=<public> pnpm tsx scripts/reject_phantom_crossings.ts [--apply]

import "dotenv/config";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { bonusAwards, fbAdSpendDaily } from "@/lib/db/schema";
import {
  BONUS_TIER_1_USD,
  BONUS_TIER_2_USD,
} from "@/lib/domain/bonus-tiers";

const RUN_DATE = "2026-05-28";
const LOOKBACK_DAYS = 14;
const AUDIT_NOTE =
  "Rejected as phantom crossing — threshold was already exceeded before " +
  `the ${LOOKBACK_DAYS}-day window opened on ${RUN_DATE}. Surfaced only ` +
  "because the 5/27 FB 3-yr history import landed older spend in the DB " +
  "for the first time. See lib/jobs/bonus-crossings.ts lookbackDays guard.";

async function main() {
  const apply = process.argv.includes("--apply");
  console.log(`mode: ${apply ? "APPLY" : "dry-run"}`);
  console.log(
    `DB: ${process.env.DATABASE_URL?.replace(/:\/\/[^@]*@/, "://***@")}`,
  );

  // All pending rows from the phantom run.
  const candidates = await db
    .select({
      id: bonusAwards.id,
      adNumber: bonusAwards.adNumber,
      marketer: bonusAwards.marketer,
      tier: bonusAwards.tier,
      amountUsd: bonusAwards.amountUsd,
    })
    .from(bonusAwards)
    .where(
      and(
        eq(bonusAwards.status, "pending"),
        eq(bonusAwards.crossedAt, RUN_DATE),
      ),
    );
  console.log(`pending rows with crossed_at=${RUN_DATE}: ${candidates.length}`);

  // For each candidate, compute pre-window lifetime spend. If it was
  // already past the row's threshold, this is a phantom.
  type PhantomVerdict = {
    id: string;
    adNumber: string;
    marketer: string;
    tier: "tier1" | "tier2";
    amountUsd: string;
    lifetimeBeforeUsd: number;
    lastSpendDate: string | null;
    isPhantom: boolean;
  };
  const verdicts: PhantomVerdict[] = [];
  for (const c of candidates) {
    const [agg] = await db
      .select({
        before: sql<string>`coalesce(sum(${fbAdSpendDaily.costUsd}) filter (where ${fbAdSpendDaily.spendDate} < ${sql.raw(`'${RUN_DATE}'::date - ${LOOKBACK_DAYS}::int`)}), 0)`,
        lastSpend: sql<string | null>`max(${fbAdSpendDaily.spendDate})::text`,
      })
      .from(fbAdSpendDaily)
      .where(eq(fbAdSpendDaily.adNumber, c.adNumber));
    const lifetimeBefore = Number(agg?.before ?? 0);
    const threshold =
      c.tier === "tier2" ? BONUS_TIER_2_USD : BONUS_TIER_1_USD;
    verdicts.push({
      id: c.id,
      adNumber: c.adNumber,
      marketer: c.marketer,
      tier: c.tier,
      amountUsd: c.amountUsd,
      lifetimeBeforeUsd: lifetimeBefore,
      lastSpendDate: agg?.lastSpend ?? null,
      isPhantom: lifetimeBefore >= threshold,
    });
  }

  const phantoms = verdicts.filter((v) => v.isPhantom);
  const legit = verdicts.filter((v) => !v.isPhantom);
  console.log(`\nphantoms (will reject): ${phantoms.length}`);
  for (const p of phantoms) {
    console.log(
      `  ad ${p.adNumber} ${p.marketer} ${p.tier} $${p.amountUsd} | ` +
        `pre-window $${p.lifetimeBeforeUsd.toFixed(0)} | last spend ${p.lastSpendDate}`,
    );
  }
  console.log(`\ngenuine in-window crossings (will KEEP pending): ${legit.length}`);
  for (const l of legit) {
    console.log(
      `  ad ${l.adNumber} ${l.marketer} ${l.tier} $${l.amountUsd} | ` +
        `pre-window $${l.lifetimeBeforeUsd.toFixed(0)} | last spend ${l.lastSpendDate}`,
    );
  }

  const totalRejectedDollars = phantoms.reduce(
    (s, p) => s + Number(p.amountUsd),
    0,
  );
  console.log(`\ntotal dollars to reject: $${totalRejectedDollars.toFixed(2)}`);

  if (!apply) {
    console.log(
      "\n[dry-run] no writes. Re-run with --apply to flip these to rejected.",
    );
    return;
  }

  let flipped = 0;
  for (const p of phantoms) {
    const res = await db
      .update(bonusAwards)
      .set({
        status: "rejected",
        approvedAt: new Date(),
        approvedBy: "system_phantom_cleanup",
        notes: AUDIT_NOTE,
      })
      .where(
        and(
          eq(bonusAwards.id, p.id),
          eq(bonusAwards.status, "pending"), // belt + suspenders
        ),
      )
      .returning({ id: bonusAwards.id });
    flipped += res.length;
  }
  console.log(
    `\n[applied] flipped ${flipped} pending -> rejected ($${totalRejectedDollars.toFixed(2)})`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
