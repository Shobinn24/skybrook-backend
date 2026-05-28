// Afternoon FB + Google ad-spend refresh.
//
// The main /api/cron/ingest runs at 09:00 UTC (= 5 AM EDT). At that hour
// Supermetrics hasn't yet finalised "yesterday's" FB Ads numbers — its
// pull from Meta is partial, and what we land in fb_ad_spend_daily for
// the prior day is a fraction of the eventual total. Jasper hit this
// 2026-05-28: 7D rollup was undercounted because yesterday's spend was
// only ~$2.8k vs the actual ~$22k+ pattern.
//
// This endpoint re-runs ONLY the two ad-spend sources (sheets_ad_spend +
// sheets_fb_ads) later in the day so the rollups Jasper sees by lunch
// reflect Supermetrics' settled numbers. It also re-runs bonus crossing
// detection (the only consumer downstream that depends on these tables)
// and re-checks freshness signals for the two sources. Everything else
// is left alone — auto-receipt, phase2, Shopify, shipping, freshness for
// other sources, the long list. Surgical re-pull.
//
// Idempotent: re-running on top of the morning's pull just rewrites the
// same day's rows (sources truncate-and-reinsert in their own
// transactions). Bonus crossings idempotent via the (ad, marketer, tier)
// unique index. Safe to invoke ad-hoc as well as on schedule.
//
// Triggered by .github/workflows/cron-refresh-ad-spend.yml at 16:00 UTC
// (= 12 PM EDT / 12 AM next-day SGT). Manual invocation pattern:
//
//   curl -X POST https://<host>/api/cron/refresh-ad-spend \
//     -H "Authorization: Bearer $CRON_SECRET"

import { NextResponse } from "next/server";
import { detectAndInsertBonusCrossings } from "@/lib/jobs/bonus-crossings";
import { runFreshnessCheck } from "@/lib/jobs/freshness-check";
import { runIngest, type SourceKey, type SourceRunner } from "@/lib/jobs/ingest";
import { sheetsAdSpendRunner, sheetsFbAdsRunner } from "@/lib/sources/sheets";
import { toEstDate } from "@/lib/tz";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const maxDuration = 120;
export const dynamic = "force-dynamic";

const AD_SPEND_SOURCES: Partial<Record<SourceKey, SourceRunner>> = {
  sheets_ad_spend: sheetsAdSpendRunner,
  sheets_fb_ads: sheetsFbAdsRunner,
};

export async function POST(req: Request) {
  const auth = req.headers.get("authorization") ?? "";
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return NextResponse.json(
      { ok: false, error: "CRON_SECRET not configured" },
      { status: 500 },
    );
  }
  if (auth !== `Bearer ${expected}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  const asOfDate = toEstDate(new Date());

  // Re-pull ad-spend sheets only. runIngest writes a fresh batchId and
  // overwrites today's rows for these two sources; other tables are
  // untouched.
  const ingest = await runIngest({ sources: AD_SPEND_SOURCES });

  // Re-run bonus crossing detection. The morning pass already ran with
  // lookbackDays=14; this picks up any ads that crossed thresholds in
  // the freshly-landed late-day FB spend rows. Idempotent via the
  // (ad_number, marketer, tier) unique index.
  const bonusCrossings = await detectAndInsertBonusCrossings({
    asOfDate,
    lookbackDays: 14,
  });

  // Freshness sweep so the two source rows on /api/health reflect this
  // refresh (clears any "stale" lingering from the morning's partial
  // pull). Reference-tab sweep disabled here — those don't change with
  // a re-pull of the two ad-spend sources, and the morning cron already
  // covered them.
  const freshness = await runFreshnessCheck({ includeReferenceTabs: false });
  const checkSummary = {
    pass: freshness.checks.filter((c) => c.status === "pass").length,
    fail: freshness.checks.filter((c) => c.status === "fail").length,
    alertsFired: freshness.alertsFired,
    alertsResolved: freshness.alertsResolved,
  };

  const elapsedMs = Date.now() - startedAt;
  logger.info("cron.refresh-ad-spend.complete", {
    batchId: ingest.batchId,
    asOfDate,
    elapsedMs,
    bonusInserted: bonusCrossings.inserted,
    bonusPhantomSkipped: bonusCrossings.phantomSkipped,
    freshnessPass: checkSummary.pass,
    freshnessFail: checkSummary.fail,
  });

  return NextResponse.json({
    ok: true,
    asOfDate,
    elapsedMs,
    batchId: ingest.batchId,
    alertsFired: ingest.alertsFired,
    alertsResolved: ingest.alertsResolved,
    bonusCrossings,
    freshness: checkSummary,
  });
}
