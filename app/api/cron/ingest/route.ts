import { NextResponse } from "next/server";
import { runArrivalEvidenceCheck } from "@/lib/jobs/arrival-evidence-check";
import { runAutoReceiptDetection } from "@/lib/jobs/auto-receipt";
import { runCashflowGenerators } from "@/lib/jobs/cashflow-forecast";
import {
  detectAndInsertBonusCrossings,
  detectAndInsertVideoEditorCrossings,
} from "@/lib/jobs/bonus-crossings";
import { runFreshnessCheck } from "@/lib/jobs/freshness-check";
import { runLooxAnalysis } from "@/lib/jobs/loox-analysis";
import { runLooxIngest } from "@/lib/jobs/loox-ingest";
import { runIngest, type SourceKey, type SourceRunner } from "@/lib/jobs/ingest";
import { runLaunchAutoPopulate } from "@/lib/jobs/launches";
import { runOrphanSkuSweep } from "@/lib/jobs/orphan-sku-sweep";
import { syncProductNames } from "@/lib/jobs/product-names";
import { runPhase2 } from "@/lib/jobs/reconcile";
import { runShippingSnapshot } from "@/lib/jobs/shipping-snapshot";
import { syncUnitCosts } from "@/lib/jobs/unit-costs";
import { postAlert, resolveAlert } from "@/lib/notifications/slack";
import {
  buildIncomingSkippedAlert,
  sheetsAdSpendRunner,
  sheetsApplovinRunner,
  sheetsFbAdsRunner,
  sheetsFbCampaignsRunner,
  sheetsFbGeoRunner,
  sheetsFbProductMapRunner,
  sheetsFbUrlMapRunner,
  sheetsIncomingRunner,
  sheetsInventoryRunner,
  sheetsLaunchInfoRunner,
} from "@/lib/sources/sheets";
import { shopifyIntlRunner, shopifyUsRunner } from "@/lib/sources/shopify";
import { toEstDate } from "@/lib/tz";
import { logger } from "@/lib/logger";
import { db } from "@/lib/db";
import { rawPulls } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const SOURCES: Partial<Record<SourceKey, SourceRunner>> = {
  sheets_inventory: sheetsInventoryRunner,
  sheets_incoming: sheetsIncomingRunner,
  sheets_ad_spend: sheetsAdSpendRunner,
  sheets_fb_ads: sheetsFbAdsRunner,
  sheets_fb_campaigns: sheetsFbCampaignsRunner,
  sheets_applovin: sheetsApplovinRunner,
  sheets_fb_geo: sheetsFbGeoRunner,
  sheets_fb_url_map: sheetsFbUrlMapRunner,
  sheets_fb_product_map: sheetsFbProductMapRunner,
  sheets_launch_info: sheetsLaunchInfoRunner,
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
  // Another ingest holds the advisory lock (overlapping trigger). Bail
  // before the derived stages — the in-flight run owns them, and running
  // phase2 against tables it is mid-rewrite would derive from torn data.
  if (ingest.skipped) {
    logger.info("cron.ingest.skipped_concurrent", { batchId });
    return NextResponse.json({ ok: true, skipped: true, batchId });
  }

  // Per-stage isolation: every derived stage below is independent enough
  // that one failing must not abort the rest. Pre-fix, a syncUnitCosts
  // throw meant phase2 never ran — sales/stock were already updated but
  // velocity/DOS/sustainability stayed at yesterday's values, displayed
  // against today's stock: the exact May-6 "combined view that never
  // existed" failure class. Each stage fires a dedup'd P1 on failure and
  // auto-resolves on the next success; the freshness sweep + dead-man
  // ping at the bottom run regardless.
  const stage = async <T>(name: string, fn: () => Promise<T>): Promise<T | null> => {
    try {
      const result = await fn();
      await resolveAlert(`cron.stage.failed:${name}`);
      return result;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      logger.error("cron.stage.failed", { stage: name, batchId, error: message });
      await postAlert({
        severity: "p1",
        title: `Cron stage failed: ${name} — downstream numbers may be stale`,
        dedupKey: `cron.stage.failed:${name}`,
        fields: { stage: name, asOfDate, batchId, error: message.slice(0, 240) },
      });
      return null;
    }
  };
  // Surface any PO column the incoming sheet ingest had to skip (shipment name
  // present but an arrival date the parser can't read, e.g. typed without a
  // year). Without this the PO silently vanishes from /incoming — the same
  // failure class as the read-range cap that hid a PO in 2026-06-09.
  // Best-effort; never block the cron.
  try {
    const [incomingPull] = await db
      .select({ payload: rawPulls.payload })
      .from(rawPulls)
      .where(and(eq(rawPulls.source, "sheets_incoming"), eq(rawPulls.pullBatchId, batchId)))
      .limit(1);
    const skipped =
      (incomingPull?.payload as
        | { skippedColumns?: Array<{ colIdx: number; label: string; reason: string }> }
        | undefined)?.skippedColumns ?? [];
    const skippedAlert = buildIncomingSkippedAlert(skipped);
    if (skippedAlert) {
      await postAlert({
        severity: "p2",
        title: skippedAlert.title,
        dedupKey: "incoming.skipped_columns",
        fields: skippedAlert.fields,
      });
    } else {
      await resolveAlert("incoming.skipped_columns");
    }
  } catch (e) {
    logger.error("incoming.skipped_columns.check_failed", {
      error: e instanceof Error ? e.message : String(e),
    });
  }
  const productNames = await stage("product_names", () => syncProductNames());
  const unitCosts = await stage("unit_costs", () => syncUnitCosts());
  // Auto-receipt detection runs after ingest (today's stock snapshot
  // is fresh) and before phase2 (so derived metrics see the updated
  // receipt state, e.g. incoming projections drop the auto-marked POs).
  const autoReceipts = await stage("auto_receipts", () =>
    runAutoReceiptDetection({ asOfDate }),
  );
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
  const autoLaunches = await stage("launch_auto_populate", () =>
    runLaunchAutoPopulate(),
  );
  // Orphan-SKU sweep runs after launches (so launch creation can't
  // accidentally pick up a SKU we're about to deactivate) and before
  // phase2 / freshness so missing-cost counts reflect post-sweep
  // state. Catches the failure mode that left 13 ev-pp-hw-* /
  // ev-pp-og-* rows masking the real missing-cost count on
  // 2026-05-28 (see lib/jobs/orphan-sku-sweep.ts header).
  const orphanSweep = await stage("orphan_sku_sweep", () => runOrphanSkuSweep());
  const phase2 = await stage("phase2", () =>
    runPhase2({ asOfDate, pullBatchId: batchId }),
  );
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
  const bonusCrossings = await stage("bonus_crossings", () =>
    detectAndInsertBonusCrossings({
      asOfDate,
      lookbackDays: 14,
    }),
  );
  // Video-editor pass (client 2026-07-02): AIAD ads with a known editor
  // tag earn a second, parallel pending award. No lookback here — the
  // client wants historical AIAD crossings surfaced too; see the
  // detector's header for where a date cutoff would go if reintroduced.
  const videoEditorCrossings = await stage("video_editor_crossings", () =>
    detectAndInsertVideoEditorCrossings(),
  );
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
  // Cashflow: roll the revenue/COGS forecast forward to the current week and
  // refresh the bulk-order pull, so /cashflow stays current without a manual
  // run. Best-effort — never block the cron (the bulk pull hits a live sheet).
  let cashflow: Awaited<ReturnType<typeof runCashflowGenerators>> | null = null;
  try {
    cashflow = await runCashflowGenerators(asOfDate);
  } catch (e) {
    logger.error("cashflow.generators.failed", {
      error: e instanceof Error ? e.message : String(e),
    });
  }

  // Freshness sweep runs LAST so its checks see the post-phase2 state of
  // every table. Catches silent emptiness that per-source ingest alerts
  // miss (e.g. May-6 cross-channel skew, partial sheet refreshes).
  // Stage-guarded like everything above, so it ALWAYS executes even when
  // an earlier stage failed — staleness detection is most valuable on
  // exactly those runs.
  //
  // EXCEPT on poller-triggered runs (?freshness=skip): the sheet poller
  // fires this route at arbitrary hours for near-real-time DATA sync, and
  // the freshness thresholds assume post-morning-cron timing. First night
  // the poller worked (2026-07-13 ~02:00 EST) it fired 14 false P1s to
  // Slack before the day's spend data could possibly exist. Alerting
  // stays with the scheduled crons, which never pass the skip flag.
  const skipFreshness = new URL(req.url).searchParams.get("freshness") === "skip";
  const freshness = skipFreshness
    ? null
    : await stage("freshness_check", () => runFreshnessCheck());

  // Loox reviews: poll the forwarding inbox + re-analyze anything new.
  // Dormant until LOOX_IMAP_* is set; best-effort — a Gmail hiccup must
  // never fail the data cron.
  let loox: { configured: boolean; inserted: number } | null = null;
  try {
    const looxIngest = await runLooxIngest();
    if (looxIngest.configured) await runLooxAnalysis();
    loox = { configured: looxIngest.configured, inserted: looxIngest.inserted };
  } catch (e) {
    logger.error("loox.cron.failed", { error: e instanceof Error ? e.message : String(e) });
  }

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
    orphanSkusDeactivated: orphanSweep ? orphanSweep.deactivated.length : null,
    bonusCrossings,
    videoEditorCrossings,
    shippingSnapshot,
    ...(phase2 ?? { phase2: "stage_failed" }),
    ingestAlertsFired: ingest.alertsFired,
    ingestAlertsResolved: ingest.alertsResolved,
    freshnessFails: freshness
      ? freshness.checks.filter((c) => c.status === "fail").length
      : null,
    freshnessAlertsFired: freshness?.alertsFired ?? null,
    freshnessAlertsResolved: freshness?.alertsResolved ?? null,
    looxInserted: loox?.configured ? loox.inserted : null,
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
    videoEditorCrossings,
    shippingSnapshot,
    cashflow,
    phase2,
    freshness,
  });
}

// Support GET for Railway Cron's default HTTP GET invocation.
export async function GET(req: Request) {
  return POST(req);
}
