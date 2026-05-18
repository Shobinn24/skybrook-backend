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
  dailySales,
  factoryOrderLines,
  factoryOrders,
  fbAdSpendDaily,
  shippingStatsDaily,
  skus,
  stockSnapshots,
} from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { postAlert, resolveAlert } from "@/lib/notifications/slack";
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

  const [adSpendRow] = await db
    .select({ max: max(adSpendDaily.spendDate) })
    .from(adSpendDaily);
  checks.push(
    evalOne(
      "ad_spend_daily",
      "freshness:ad_spend_daily",
      "ad_spend_daily is stale",
      adSpendRow?.max ?? null,
      { table: "ad_spend_daily" },
    ),
  );

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

  return { asOfDate: today, threshold, checks };
}

export async function runFreshnessCheck(opts?: {
  now?: () => Date;
}): Promise<FreshnessCheckResult> {
  const { asOfDate: today, checks: evaluated } = await evaluateFreshness(opts);
  let alertsFired = 0;
  let alertsResolved = 0;

  for (const c of evaluated) {
    if (!c.dedupKey || !c.title) continue;
    if (c.status === "fail") {
      const r = await postAlert({
        severity: c.severity ?? "p1",
        title: c.title,
        dedupKey: c.dedupKey,
        fields: c.fields,
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
