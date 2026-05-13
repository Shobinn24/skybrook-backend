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
// Each check posts a P1 to #skybrook-alerts when failing and
// auto-resolves when the underlying source recovers. Dedup keys are
// stable per-check so consecutive cron runs of the same stale state
// don't spam.

import { max } from "drizzle-orm";
import { db } from "@/lib/db";
import { adSpendDaily, dailySales, fbAdSpendDaily, stockSnapshots } from "@/lib/db/schema";
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
        severity: "p1",
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
  });

  return { asOfDate: today, checks, alertsFired, alertsResolved };
}
