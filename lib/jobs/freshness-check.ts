// Post-cron freshness sweep — catches silent emptiness that
// `ingest.source.failed` doesn't surface. Specifically:
//
// 1. Per-table max(date) staleness. If a source SAYS it succeeded but
//    its data lagged (Shopify GraphQL filter TZ bug, partial Supermetrics
//    refresh, etc.), `data_pulls.status = 'success'` won't trip the
//    ingest alert — but the max date will stagnate. We assert each table
//    has data through *at least* yesterday EST.
//
// 2. Cross-channel skew on daily_sales. The May-6 mixed-time-view
//    incident class: shopify_us pulls succeed, shopify_intl fails ⇒
//    /performance shows combined totals that never existed in Shopify.
//    Detect by comparing `max(sales_date)` per channel.
//
// 3. Factory-order data integrity (P2 → digest). Approved orders with
//    `sum(amount) = 0` (missing unit_costs surfaced post-approval) and
//    active SKUs lacking a unit_cost (would cause the NEXT approve to
//    also produce $0 lines). Both auto-resolve when Scott updates the
//    EVSKUmap landed-cost sheet — ingested by `syncUnitCosts` each cron.
//
// 4. End-of-run auto-resolve of any open `trpc.error:*` alerts. The
//    tRPC onError tap fires P1 on each unique procedure that throws,
//    deduped while the alert is open. Clearing those at cron-tick
//    bounds the noise to "at most one alert per procedure per ~24h"
//    while still re-paging if the same procedure errors again
//    tomorrow.
//
// Each check posts a P1 (P2 for data-integrity) when failing and
// auto-resolves when the underlying source recovers. Dedup keys are
// stable per-check so consecutive cron runs of the same stale state
// don't spam.

import { and, eq, inArray, isNull, like, max, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  adSpendDaily,
  alertEvents,
  applovinAdSpendDaily,
  dailySales,
  factoryOrderLines,
  factoryOrders,
  fbAdSpendDaily,
  shippingStatsDaily,
  skus,
  stockSnapshots,
} from "@/lib/db/schema";
import { affectedLabel } from "@/lib/jobs/lineage";
import { logger } from "@/lib/logger";
import { postAlert, resolveAlert } from "@/lib/notifications/slack";
import { getPullHistoryWithDriftForSource } from "@/lib/queries/pipeline";
import {
  AD_SPEND_TABS,
  AD_SPEND_TABS_STALE_EXEMPT_UNTIL_FIRST_DATA,
} from "@/lib/sources/sheets";
import { toEstDate } from "@/lib/tz";

export type FreshnessCheck = {
  name: string;
  status: "pass" | "fail";
  maxDate: string | null;
  threshold: string;
  detail?: string;
};

export type FreshnessCheckResult = {
  asOfDate: string;
  checks: FreshnessCheck[];
  alertsFired: number;
  alertsResolved: number;
};

// Tolerance: data must be present through at least yesterday EST. Today
// is too tight (the cron itself populates today's row, so a check before
// cron completion would false-alarm).
function yesterdayEst(now: Date): string {
  const d = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  return toEstDate(d);
}

// Number of days between two YYYY-MM-DD strings. Returns NaN if either
// is null. Used to detect channel skew on daily_sales.
function daysBetween(a: string | null, b: string | null): number {
  if (!a || !b) return NaN;
  const ms = new Date(`${a}T00:00:00Z`).getTime() - new Date(`${b}T00:00:00Z`).getTime();
  return ms / (24 * 60 * 60 * 1000);
}

// Read-only evaluation. No side effects — used by /api/health (which
// pollers hit frequently and must not amplify alert volume).
// `runFreshnessCheck` wraps this and adds the postAlert/resolveAlert
// side effects exactly once per cron tick.
export type EvaluatedCheck = FreshnessCheck & {
  dedupKey: string | null;
  title: string | null;
  // Defaults to "p1" when omitted to preserve the original P1-only
  // contract. Data-integrity checks (factory-order coverage) downshift
  // to "p2" so they route to #skybrook-digest instead of @mentioning
  // the on-call user for known data-gap states.
  severity?: "p1" | "p2";
  fields: Record<string, string | number | null | undefined>;
};

export async function evaluateFreshness(opts?: {
  now?: () => Date;
}): Promise<{ asOfDate: string; threshold: string; checks: EvaluatedCheck[] }> {
  const now = opts?.now ?? (() => new Date());
  const today = toEstDate(now());
  const threshold = yesterdayEst(now());

  const evalOne = (
    name: string,
    dedupKey: string,
    title: string,
    maxDate: string | null,
    fields: Record<string, string | number | null | undefined>,
  ): EvaluatedCheck => {
    const stale = maxDate === null || maxDate < threshold;
    return {
      name,
      status: stale ? "fail" : "pass",
      maxDate,
      threshold,
      dedupKey,
      title,
      fields: { ...fields, maxDate: maxDate ?? "<null>", threshold },
    };
  };

  const checks: EvaluatedCheck[] = [];

  // Per-product (== per-tab == per-platform) freshness check for ad
  // spend. FB tabs (Men, Shapewear, SuperHW) and AppLovin tabs (Men AL,
  // Shapewear AL, Super HW AL) share `ad_spend_daily`, so a table-wide
  // max(date) check passes as long as ANY tab is updating — the very
  // failure mode that hid the 2026-05-05 AppLovin license lapse for 17
  // days (FB stayed fresh, AL silently froze, /performance showed AL=0).
  // Per-product max(date) flags a partial freeze immediately. Each
  // product carries its own dedup key so a single dead source pages
  // once and resolves independently when it recovers.
  //
  // 2026-07-05: /performance no longer reads ad_spend_daily (unified on
  // URL-first FB + AppLovin). Ingest + freshness alerts kept deliberately
  // for reconciliation until the owner decides to retire the Supermetrics
  // per-product tabs — do not remove without that decision.
  const adSpendProductRows = await db
    .select({
      product: adSpendDaily.product,
      max: max(adSpendDaily.spendDate),
    })
    .from(adSpendDaily)
    .groupBy(adSpendDaily.product);
  const adSpendMaxByProduct = new Map<string, string | null>();
  for (const row of adSpendProductRows) {
    adSpendMaxByProduct.set(row.product, row.max);
  }
  for (const tab of AD_SPEND_TABS) {
    const maxDate = adSpendMaxByProduct.get(tab) ?? null;
    // A newly-wired tab with no data yet (null max date) would otherwise fail
    // every tick. Suppress the alert until its first dated row lands; once it
    // has data, normal staleness applies (a tab that froze after having data
    // is a real outage and still pages).
    if (maxDate === null && AD_SPEND_TABS_STALE_EXEMPT_UNTIL_FIRST_DATA.has(tab))
      continue;
    // Slugify for dedup key — Slack-safe (no spaces) and readable.
    const slug = tab.replace(/\s+/g, "_").toLowerCase();
    checks.push(
      evalOne(
        `ad_spend_daily.product.${slug}`,
        `freshness:ad_spend_daily:product:${slug}`,
        `ad_spend_daily (${tab}) is stale`,
        maxDate,
        { table: "ad_spend_daily", product: tab },
      ),
    );
  }

  const [fbAdSpendRow] = await db
    .select({ max: max(fbAdSpendDaily.spendDate) })
    .from(fbAdSpendDaily);
  checks.push(
    evalOne(
      "fb_ad_spend_daily",
      "freshness:fb_ad_spend_daily",
      "fb_ad_spend_daily is stale",
      fbAdSpendRow?.max ?? null,
      { table: "fb_ad_spend_daily" },
    ),
  );

  // AppLovin feed (dedicated "AppLovin Live" Supermetrics sheet). p2 →
  // #skybrook-digest, not a page: the daily scheduled refresh is newly set
  // up, so surface staleness without paging until it's proven steady. Raise
  // to p1 once the refresh has run reliably for a week.
  const [applovinRow] = await db
    .select({ max: max(applovinAdSpendDaily.spendDate) })
    .from(applovinAdSpendDaily);
  {
    const maxDate = applovinRow?.max ?? null;
    const stale = maxDate === null || maxDate < threshold;
    checks.push({
      name: "applovin_ad_spend_daily",
      status: stale ? "fail" : "pass",
      maxDate,
      threshold,
      dedupKey: "freshness:applovin_ad_spend_daily",
      title: "applovin_ad_spend_daily is stale",
      severity: "p2",
      fields: { table: "applovin_ad_spend_daily", maxDate: maxDate ?? "<null>", threshold },
    });
  }

  const [stockRow] = await db
    .select({ max: max(stockSnapshots.snapshotDate) })
    .from(stockSnapshots);
  checks.push(
    evalOne(
      "stock_snapshots",
      "freshness:stock_snapshots",
      "stock_snapshots is stale",
      stockRow?.max ?? null,
      { table: "stock_snapshots" },
    ),
  );

  const channelRows = await db
    .select({
      channel: dailySales.channel,
      max: max(dailySales.salesDate),
    })
    .from(dailySales)
    .groupBy(dailySales.channel);

  const channelMaxes: Record<string, string | null> = {
    shopify_us: null,
    shopify_intl: null,
  };
  for (const row of channelRows) {
    channelMaxes[row.channel] = row.max;
  }

  checks.push(
    evalOne(
      "daily_sales.shopify_us",
      "freshness:daily_sales:shopify_us",
      "daily_sales (shopify_us) is stale",
      channelMaxes.shopify_us,
      { channel: "shopify_us" },
    ),
  );
  checks.push(
    evalOne(
      "daily_sales.shopify_intl",
      "freshness:daily_sales:shopify_intl",
      "daily_sales (shopify_intl) is stale",
      channelMaxes.shopify_intl,
      { channel: "shopify_intl" },
    ),
  );

  const skewDays = Math.abs(daysBetween(channelMaxes.shopify_us, channelMaxes.shopify_intl));
  checks.push({
    name: "daily_sales.cross_channel_skew",
    status: Number.isFinite(skewDays) && skewDays > 1 ? "fail" : "pass",
    maxDate: null,
    threshold,
    detail: `us=${channelMaxes.shopify_us ?? "<null>"} intl=${channelMaxes.shopify_intl ?? "<null>"} skewDays=${Number.isFinite(skewDays) ? skewDays : "n/a"}`,
    dedupKey: "freshness:daily_sales:channel_skew",
    title: "daily_sales channel skew (>1 day between shopify_us and shopify_intl)",
    fields: {
      shopify_us_max: channelMaxes.shopify_us ?? "<null>",
      shopify_intl_max: channelMaxes.shopify_intl ?? "<null>",
      skewDays: Number.isFinite(skewDays) ? skewDays : "n/a",
    },
  });

  // --- Shipping snapshot freshness (P1). Same shape as the per-table
  // checks: the cron writes one row per day into shipping_stats_daily,
  // and the /shipping-performance UI overlays today vs today-30d. If
  // the daily write silently stops landing (Shopify auth expired,
  // fetchOrdersSince broke), the UI starts comparing stale data.
  const [shipStatsRow] = await db
    .select({ max: max(shippingStatsDaily.snapshotDate) })
    .from(shippingStatsDaily);
  checks.push(
    evalOne(
      "shipping_stats_daily",
      "freshness:shipping_stats_daily",
      "shipping_stats_daily is stale",
      shipStatsRow?.max ?? null,
      { table: "shipping_stats_daily" },
    ),
  );

  // --- Factory-order data integrity (P2 → #skybrook-digest).
  //
  // (a) Approved orders whose lines sum to 0. The 2026-05-18 approval
  // of the May order surfaced this class: HRS + Cotton Hipster
  // custom-only product groups have NULL unit_cost_usd in `skus`, so
  // the approve flow writes lines with unit_cost = 0 → amount = 0.
  // The order LOOKS approved but is useless until costs land. We
  // bound the lookback so historical approved-then-fixed orders
  // don't keep the alert open.
  const factoryOrderZeroLookbackDays = 90;
  const lookbackThreshold = new Date(
    Date.UTC(
      now().getUTCFullYear(),
      now().getUTCMonth(),
      now().getUTCDate() - factoryOrderZeroLookbackDays,
    ),
  )
    .toISOString()
    .slice(0, 10);
  // Two-step: pull approved orders, then aggregate their line totals.
  // Number of approved orders in a 90-day window is small (monthly
  // cadence), so N+1 isn't a concern and the explicit shape avoids
  // the GROUP BY + HAVING + leftJoin interpolation gotchas of a
  // single-query formulation.
  const approvedOrders = await db
    .select({
      id: factoryOrders.id,
      orderMonth: factoryOrders.orderMonth,
    })
    .from(factoryOrders)
    .where(
      and(
        eq(factoryOrders.status, "approved"),
        sql`${factoryOrders.orderMonth} >= ${lookbackThreshold}`,
      ),
    );
  let zeroLineOrders: Array<{ orderMonth: string }> = [];
  if (approvedOrders.length > 0) {
    const totals = await db
      .select({
        orderId: factoryOrderLines.orderId,
        total: sql<string>`SUM(${factoryOrderLines.amount})::text`,
      })
      .from(factoryOrderLines)
      .where(
        inArray(
          factoryOrderLines.orderId,
          approvedOrders.map((o) => o.id),
        ),
      )
      .groupBy(factoryOrderLines.orderId);
    const totalsByOrderId = new Map(
      totals.map((t) => [t.orderId, Number(t.total)]),
    );
    zeroLineOrders = approvedOrders
      .filter((o) => (totalsByOrderId.get(o.id) ?? 0) === 0)
      .map((o) => ({ orderMonth: o.orderMonth }));
  }
  checks.push({
    name: "factory_orders.approved_zero_lines",
    status: zeroLineOrders.length > 0 ? "fail" : "pass",
    maxDate: null,
    threshold: `lookback_days=${factoryOrderZeroLookbackDays}`,
    detail: `count=${zeroLineOrders.length}${zeroLineOrders.length > 0 ? ` months=${zeroLineOrders.map((o) => o.orderMonth).join(",")}` : ""}`,
    dedupKey: "factory_orders:approved_zero_lines",
    title: "Approved factory order(s) with $0 in line totals",
    severity: "p2",
    fields: {
      count: zeroLineOrders.length,
      orderMonths: zeroLineOrders.map((o) => o.orderMonth).join(",") || "<none>",
      lookbackDays: factoryOrderZeroLookbackDays,
    },
  });

  // (b) Active SKUs with NULL unit_cost_usd. This is the upstream
  // cause of approved_zero_lines — the EVSKUmap landed-cost sheet
  // doesn't yet carry rows for these SKUs. `syncUnitCosts` runs each
  // cron and would clear this once Scott adds them. Auto-resolves on
  // recovery.
  const [missingCostRow] = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(skus)
    .where(and(eq(skus.active, true), isNull(skus.unitCostUsd)));
  const missingCostCount = missingCostRow?.count ?? 0;
  checks.push({
    name: "factory_orders.active_skus_missing_cost",
    status: missingCostCount > 0 ? "fail" : "pass",
    maxDate: null,
    threshold: "unit_cost_usd not null",
    detail: `count=${missingCostCount}`,
    dedupKey: "factory_orders:active_skus_missing_cost",
    title: "Active SKUs without unit_cost_usd (blocks factory-order approve totals)",
    severity: "p2",
    fields: {
      count: missingCostCount,
      table: "skus",
    },
  });

  // (c) Schema-drift detection. Each pull stores a `schema_fingerprint`
  // computed from the upstream COLUMN/TAB shape (not row counts — the
  // runners deliberately exclude volume so daily growth doesn't look
  // like drift). When the latest successful pull's fingerprint differs
  // from the prior successful pull's, the source changed shape: a
  // renamed column, a dropped/renamed tab, a Shopify API-version bump.
  // That silently corrupts ingest (null fields, dropped rows) WITHOUT
  // tripping the success/failure alert. Alert-only (no halt): the
  // delete-replace writes are idempotent and a genuine change
  // auto-re-baselines on the next pull, so halting would risk a
  // self-inflicted outage on a one-time legit change.
  //
  // sheets_incoming and sheets_inventory are intentionally excluded: their
  // fingerprints still fold in VOLUME/position, so they'd false-fire daily.
  //   - incoming: hashes PO-column count (changes when a PO is added)
  //   - inventory: hashes headerSummary = "<latest date> -> col X" per tab,
  //     and the latest date column advances every day
  // Make both fingerprints schema-only (hash tab/column STRUCTURE, not the
  // moving date pointer or counts) before adding them here. ad_spend and
  // fb_ads were just fixed to schema-only; shopify is stable by design.
  const DRIFT_SOURCES = [
    "sheets_ad_spend",
    "sheets_fb_ads",
    "shopify_us",
    "shopify_intl",
  ] as const;
  const driftResults = await Promise.all(
    DRIFT_SOURCES.map(async (source) => {
      const hist = await getPullHistoryWithDriftForSource(source, 5);
      const latest = hist.find(
        (r) => r.status === "success" && r.fingerprint !== null,
      );
      return { source, latest };
    }),
  );
  for (const { source, latest } of driftResults) {
    const drifted = latest?.schemaDrifted === true;
    checks.push({
      name: `schema_drift.${source}`,
      status: drifted ? "fail" : "pass",
      maxDate: null,
      threshold: "schema_fingerprint == prior successful pull",
      dedupKey: `schema_drift:${source}`,
      title: `Schema drift on ${source} — upstream column/tab shape changed`,
      // p2 → #skybrook-digest, not an @mention page. Schema drift is
      // "look at this", and on the first deploy that changes a
      // fingerprint format it fires once then auto-resolves next tick.
      // Raise to p1 once it's proven quiet in production.
      severity: "p2",
      detail: drifted
        ? `fingerprint ${latest?.priorFingerprint} -> ${latest?.fingerprint}`
        : undefined,
      fields: {
        source,
        currentFingerprint: latest?.fingerprint ?? null,
        priorFingerprint: latest?.priorFingerprint ?? null,
      },
    });
  }

  // --- Volume pillar (row-count drop detection). DB-only, so it rides
  // this same evaluateFreshness path that /api/health and both crons
  // already call — no extra wiring. Catches the region-split trap where
  // a pull succeeds with a current max(date) but lands a fraction of its
  // usual rows. See lib/jobs/volume-check.ts for the baseline model.
  const { evaluateVolume } = await import("./volume-check");
  checks.push(...(await evaluateVolume()));

  // --- Column-quality pillar (null/empty on the columns the schema
  // doesn't constrain). DB-only, rides this same path. See
  // lib/jobs/column-quality.ts for why it's deliberately narrow.
  const { evaluateColumnQuality } = await import("./column-quality");
  checks.push(...(await evaluateColumnQuality()));

  // --- FB ad-prefix coverage (self-maintaining attribution guard).
  // DB-only, rides this same path. Surfaces unmapped (typo'd / new /
  // unconfirmed) ad-name prefixes that accrue real spend so the
  // All-products attribution stays correct without silent auto-correct.
  // See lib/jobs/fb-prefix-check.ts.
  const { evaluateFbPrefixCoverage } = await import("./fb-prefix-check");
  checks.push(...(await evaluateFbPrefixCoverage()));

  // --- FB landing-URL coverage (product-map self-maintaining guard).
  // DB-only, rides this same path. Surfaces live ad URLs that aren't in the
  // Jasper product-map sheet yet (so attribution falls back to ad-name + geo)
  // so the sheet can be kept complete. See lib/jobs/fb-url-coverage-check.ts.
  const { evaluateFbUrlCoverage } = await import("./fb-url-coverage-check");
  checks.push(...(await evaluateFbUrlCoverage()));

  return { asOfDate: today, threshold, checks };
}

export async function runFreshnessCheck(opts?: {
  now?: () => Date;
  // Caller can disable the sheets-API portion when running from
  // /api/health (DB-only, fast) vs the cron (full sweep including
  // reference tabs). Defaults to enabled — explicit `false` opts out.
  includeReferenceTabs?: boolean;
}): Promise<FreshnessCheckResult> {
  const { asOfDate: today, checks: evaluatedBase } = await evaluateFreshness(opts);

  // Reference-tab sweep — alerts when a sheet tab Scott looks at
  // directly (Sheet7, FB Ads Tracker 2's `2026`) silently stops
  // updating. Sheets API calls are sequential + best-effort; one bad
  // tab surfaces its own check entry rather than failing the sweep.
  let evaluatedRefTabs: EvaluatedCheck[] = [];
  if (opts?.includeReferenceTabs !== false) {
    try {
      const { evaluateReferenceTabsFreshness } = await import("./sheet-tab-freshness");
      evaluatedRefTabs = await evaluateReferenceTabsFreshness({ now: opts?.now });
    } catch (err) {
      logger.warn("freshness.reference_tabs.skipped", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // FB Ads Live date-column integrity (Sheets API, so it rides this
    // reference-tab gate — never the DB-only /api/health path). Best-effort
    // internally; wrap anyway so a future change can't fail the sweep.
    try {
      const { evaluateFbSheetShape } = await import("./fb-sheet-shape-check");
      evaluatedRefTabs = [...evaluatedRefTabs, ...(await evaluateFbSheetShape())];
    } catch (err) {
      logger.warn("freshness.fb_sheet_shape.skipped", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const evaluated = [...evaluatedBase, ...evaluatedRefTabs];
  let alertsFired = 0;
  let alertsResolved = 0;

  for (const c of evaluated) {
    if (!c.dedupKey || !c.title) continue;
    if (c.status === "fail") {
      // Lineage enrichment: name the downstream dashboards this break
      // affects so a triager knows where to look (or what to warn Scott
      // off) without tracing the dependency by hand.
      const affected = affectedLabel(c.name);
      const r = await postAlert({
        severity: c.severity ?? "p1",
        title: c.title,
        dedupKey: c.dedupKey,
        fields: { ...c.fields, affectedDashboards: affected },
      });
      if (r.fired) alertsFired++;
    } else {
      const r = await resolveAlert(c.dedupKey);
      alertsResolved += r.resolved;
    }
  }

  // Auto-resolve any open `trpc.error:*` alerts at end of cron tick.
  // The tRPC onError tap fires once per (procedure, while-open-alert)
  // — without this drain, a single one-time crash would stay pinned in
  // the open-alert set forever. Resolving each tick bounds noise to
  // "at most one alert per procedure per cron cycle (~24h)" while
  // still re-firing on the next genuine crash.
  const openTrpcErrors = await db
    .select({ dedupKey: alertEvents.dedupKey })
    .from(alertEvents)
    .where(
      and(
        like(alertEvents.dedupKey, "trpc.error:%"),
        isNull(alertEvents.resolvedAt),
      ),
    );
  for (const row of openTrpcErrors) {
    const r = await resolveAlert(row.dedupKey, {
      resolveMessage: `Auto-clearing tRPC error alert at cron tick: ${row.dedupKey}`,
    });
    alertsResolved += r.resolved;
  }

  const checks: FreshnessCheck[] = evaluated.map((c) => ({
    name: c.name,
    status: c.status,
    maxDate: c.maxDate,
    threshold: c.threshold,
    detail: c.detail,
  }));

  logger.info("freshness.check.done", {
    asOfDate: today,
    checks: checks.map((c) => ({ name: c.name, status: c.status, maxDate: c.maxDate })),
    alertsFired,
    alertsResolved,
    trpcErrorsResolved: openTrpcErrors.length,
  });

  return { asOfDate: today, checks, alertsFired, alertsResolved };
}
