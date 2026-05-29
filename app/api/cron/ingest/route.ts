import { NextResponse } from "next/server";
import { runArrivalEvidenceCheck } from "@/lib/jobs/arrival-evidence-check";
import { runAutoReceiptDetection } from "@/lib/jobs/auto-receipt";
import { detectAndInsertBonusCrossings } from "@/lib/jobs/bonus-crossings";
import { runFreshnessCheck } from "@/lib/jobs/freshness-check";
import { runIngest, type SourceKey, type SourceRunner } from "@/lib/jobs/ingest";
import { runLaunchAutoPopulate } from "@/lib/jobs/launches";
import { runOrphanSkuSweep } from "@/lib/jobs/orphan-sku-sweep";
import { syncProductNames } from "@/lib/jobs/product-names";
import { runPhase2 } from "@/lib/jobs/reconcile";
import { runShippingSnapshot } from "@/lib/jobs/shipping-snapshot";
import { syncUnitCosts } from "@/lib/jobs/unit-costs";
import { postAlert, resolveAlert } from "@/lib/notifications/slack";
import {
  sheetsAdSpendRunner,
  sheetsFbAdsRunner,
  sheetsIncomingRunner,
  sheetsInventoryRunner,
} from "@/lib/sources/sheets";
import { shopifyIntlRunner, shopifyUsRunner } from "@/lib/sources/shopify";
import { toEstDate } from "@/lib/tz";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const SOURCES: Partial<Record<SourceKey, SourceRunner>> = {
  sheets_inventory: sheetsInventoryRunner,
  sheets_incoming: sheetsIncomingRunner,
  sheets_ad_spend: sheetsAdSpendRunner,
  sheets_fb_ads: sheetsFbAdsRunner,
  shopify_us: shopifyUsRunner,
  shopify_intl: shopifyIntlRunner,
};

export async function POST(req: Request) {
  const auth = req.headers.get("authorization") ?? "";
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return NextResponse.json({ ok: false, error: "CRON_SECRET not configured" }, { status: 500 });
  }
  if (auth !== `Bearer ${expected}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const asOfDate = toEstDate(new Date());
  const ingest = await runIngest({ sources: SOURCES });
  const batchId = ingest.batchId;
  const productNames = await syncProductNames();
  const unitCosts = await syncUnitCosts();
  // Auto-receipt detection runs after ingest (today's stock snapshot
  // is fresh) and before phase2 (so derived metrics see the updated
  // receipt state, e.g. incoming projections drop the auto-marked POs).
  const autoReceipts = await runAutoReceiptDetection({ asOfDate });
  // Safety net for the conservative auto-receipt detector: flag overdue
  // shipments whose stock actually jumped on/after their ETA (i.e. they
  // arrived but weren't confidently auto-matched — partial / spread /
  // post-gap deliveries). Read-only; surfaces a P2 confirm-prompt so
  // these can't sit overdue unnoticed (the 2026-05-27 KAI miss). Never
  // block the cron on it.
  let arrivalEvidence: Awaited<ReturnType<typeof runArrivalEvidenceCheck>> = {
    flagged: [],
    autoMarked: [],
  };
  try {
    arrivalEvidence = await runArrivalEvidenceCheck({ asOfDate });
    // High-confidence arrivals were auto-marked received inside the
    // function. They're closed-loop; no alert needed. The P2 alert is
    // only for `flagged` — lower-confidence or competing-PO blocked.
    if (arrivalEvidence.flagged.length > 0) {
      await postAlert({
        severity: "p2",
        title: `${arrivalEvidence.flagged.length} overdue shipment(s) look received — confirm in /incoming`,
        dedupKey: "incoming.likely_arrived",
        fields: Object.fromEntries(
          arrivalEvidence.flagged.slice(0, 10).map((e) => [
            `${e.shipmentName} · ${e.destination} · ETA ${e.expectedArrival}`,
            `+${e.observedJump.toLocaleString()} on-hand (${Math.round(e.pctOfPo * 100)}% of ${e.poQuantity.toLocaleString()}-unit PO)`,
          ]),
        ),
      });
    } else {
      await resolveAlert("incoming.likely_arrived");
    }
  } catch (e) {
    logger.error("arrival-evidence.check.failed", {
      error: e instanceof Error ? e.message : String(e),
    });
  }
  // Auto-populate launches runs after syncProductNames (so productNames
  // are current) but is independent of phase2 — failures shouldn't
  // block downstream metrics.
  const autoLaunches = await runLaunchAutoPopulate();
  // Orphan-SKU sweep runs after launches (so launch creation can't
  // accidentally pick up a SKU we're about to deactivate) and before
  // phase2 / freshness so missing-cost counts reflect post-sweep
  // state. Catches the failure mode that left 13 ev-pp-hw-* /
  // ev-pp-og-* rows masking the real missing-cost count on
  // 2026-05-28 (see lib/jobs/orphan-sku-sweep.ts header).
  const orphanSweep = await runOrphanSkuSweep();
  const phase2 = await runPhase2({ asOfDate, pullBatchId: batchId });
  // Bonus crossing detection runs after the FB ads sheet ingest has
  // landed today's spend rows. New (ad × marketer × tier) crossings
  // become `pending` rows in bonus_awards for Jasper to triage.
  // Idempotent — won't double-insert if cron re-runs.
  //
  // `lookbackDays: 14` is the phantom-crossing guard added 2026-05-28
  // after the FB 3-yr history import created 14 fake pending awards
  // worth $13.5k on old ads. With this set, a tier only fires if it
  // was actually crossed during the last 14 days — pre-window spend
  // alone doesn't trigger a row. Tunable here if cron cadence ever
  // widens. See lib/jobs/bonus-crossings.ts header for the full rationale.
  const bonusCrossings = await detectAndInsertBonusCrossings({
    asOfDate,
    lookbackDays: 14,
  });
  // Shipping Performance snapshot (Spec: docs/shipping-checks-spec).
  // Pulls last 60d of US-store orders + computes 30d-trailing stats.
  // Best-effort for the cron response: a Shopify hiccup shouldn't block
  // the rest of the pipeline. But we DO want to know — fire P1 on
  // failure, auto-resolve on next successful run. The freshness check
  // for `shipping_stats_daily` would eventually catch the gap too, but
  // the failure alert tells us WHY (auth expired / Shopify outage / etc.)
  // a day sooner than the staleness check can.
  let shippingSnapshot: Awaited<ReturnType<typeof runShippingSnapshot>> | null =
    null;
  try {
    shippingSnapshot = await runShippingSnapshot({ asOfDate });
    await resolveAlert("shipping.snapshot.failed");
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : String(e);
    logger.error("shipping.snapshot.failed", { error: errorMessage });
    await postAlert({
      severity: "p1",
      title: "Shipping Performance snapshot failed",
      dedupKey: "shipping.snapshot.failed",
      fields: {
        asOfDate,
        error: errorMessage.slice(0, 240),
      },
    });
  }
  // Freshness sweep runs LAST so its checks see the post-phase2 state of
  // every table. Catches silent emptiness that per-source ingest alerts
  // miss (e.g. May-6 cross-channel skew, partial sheet refreshes).
  // Failures here never block the cron response — postAlert is internal.
  const freshness = await runFreshnessCheck();

  // Dead-man ping to healthchecks.io — confirms the cron itself ran, no
  // matter what the freshness sweep found. Substantive failures
  // (per-source / per-table / skew) fire their own Slack alerts above.
  // HC's role is purely "did the heartbeat arrive on schedule?" — when
  // it doesn't, HC pings #skybrook-alerts directly via its native Slack
  // integration. Fire-and-forget; never block the cron response.
  const hcPing = process.env.HEALTHCHECK_PING_URL;
  if (hcPing) {
    void fetch(hcPing).catch((e) => {
      logger.warn("healthcheck.ping.failed", {
        error: e instanceof Error ? e.message : String(e),
      });
    });
  }

  logger.info("cron.ingest.done", {
    batchId,
    asOfDate,
    productNames,
    unitCosts,
    autoReceipts,
    likelyArrivedOverdueFlagged: arrivalEvidence.flagged.length,
    likelyArrivedOverdueAutoMarked: arrivalEvidence.autoMarked.length,
    autoLaunches,
    orphanSkusDeactivated: orphanSweep.deactivated.length,
    bonusCrossings,
    shippingSnapshot,
    ...phase2,
    ingestAlertsFired: ingest.alertsFired,
    ingestAlertsResolved: ingest.alertsResolved,
    freshnessFails: freshness.checks.filter((c) => c.status === "fail").length,
    freshnessAlertsFired: freshness.alertsFired,
    freshnessAlertsResolved: freshness.alertsResolved,
  });
  return NextResponse.json({
    ok: true,
    batchId,
    asOfDate,
    productNames,
    unitCosts,
    autoReceipts,
    autoLaunches,
    orphanSweep,
    bonusCrossings,
    shippingSnapshot,
    phase2,
    freshness,
  });
}

// Support GET for Railway Cron's default HTTP GET invocation.
export async function GET(req: Request) {
  return POST(req);
}
