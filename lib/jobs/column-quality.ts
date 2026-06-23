// Column-quality pillar — targeted null/empty checks on the SPECIFIC
// columns that can silently degrade.
//
// Deliberately NARROW. The fact tables (ad_spend_daily, fb_ad_spend_daily,
// daily_sales, stock_snapshots) already enforce a composite PRIMARY KEY
// (so duplicate-grain rows are impossible — the DB-side answer to the Ad
// 2400 reissued-link double-count, which collapses on the stable
// adNumber+date key) AND NOT NULL on every value column (cost_usd,
// units_sold, net_sales_usd, on_hand). Generic null/uniqueness checks
// there can never fire, so we don't add dead checks that read as coverage
// without being any.
//
// Current check:
//   fb_ad_spend_daily.marketers (NOT NULL but defaults to []). An empty
//   array means the marketer-name parser matched none of the 8-marketer
//   roster. bonus-crossings SKIPS empty-marketer rows
//   (lib/jobs/bonus-crossings.ts), so a parser break — ad naming
//   convention changes, or a new marketer not on the roster — silently
//   drops that spend from bonus attribution and dumps it in the /fb-ads
//   "Unassigned" bucket. We alert on a high empty-RATE over a recent
//   window, never on a single untagged ad (a few are normal).
//
// REJECTED after investigation (2026-06-23): skus.product_line null on
// active SKUs. It looked like the unit_cost gap, but product_line is set
// ONLY when physical stock lands (the inventory Main/HF/Sec tabs); a SKU
// goes active with product_line=NULL the moment a PO hits the Incoming
// sheet. So null product_line on an active SKU is the NORMAL "ordered,
// not yet stocked" state (verified: all 49 such SKUs in prod had incoming
// shipments and zero stock), and orphan-sku-sweep already deactivates the
// genuinely-stuck ones. Flagging it would be permanent fluctuating digest
// noise with no actionable signal. unit_cost is different — it should be
// entered regardless of stock — so active_skus_missing_cost stays.
//
// p2 → #skybrook-digest, auto-resolving on recovery — same posture as the
// freshness data-integrity checks.

import { max, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { fbAdSpendDaily } from "@/lib/db/schema";
import type { EvaluatedCheck } from "@/lib/jobs/freshness-check";

// Subtract `days` from a YYYY-MM-DD string, returning YYYY-MM-DD. UTC math
// so it's DST-agnostic (these are plain calendar dates, not instants).
function isoDaysBefore(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export async function evaluateColumnQuality(opts?: {
  // How many calendar days back from the latest fb spend_date to measure
  // the marketer empty-rate over.
  recentDays?: number;
  // Don't judge the marketer rate below this many rows in the window — a
  // quiet week shouldn't look like a parser break.
  minRows?: number;
  // Empty-marketer fraction (0..1) at/above which we alert.
  emptyMarketerRateThreshold?: number;
}): Promise<EvaluatedCheck[]> {
  const recentDays = opts?.recentDays ?? 14;
  const minRows = opts?.minRows ?? 20;
  const rateThreshold = opts?.emptyMarketerRateThreshold ?? 0.5;
  const checks: EvaluatedCheck[] = [];

  // FB marketer-attribution empty-rate over the recent window. Anchor the
  // window on the latest spend_date present (not "today") so a stale feed
  // — already covered by freshness — doesn't empty the window and mask the
  // rate.
  const [maxRow] = await db
    .select({ max: max(fbAdSpendDaily.spendDate) })
    .from(fbAdSpendDaily);
  const maxDate = maxRow?.max ?? null;
  if (maxDate) {
    const windowStart = isoDaysBefore(maxDate, recentDays - 1);
    const [agg] = await db
      .select({
        total: sql<number>`COUNT(*)::int`,
        empty: sql<number>`COUNT(*) FILTER (WHERE cardinality(${fbAdSpendDaily.marketers}) = 0)::int`,
      })
      .from(fbAdSpendDaily)
      .where(sql`${fbAdSpendDaily.spendDate} >= ${windowStart}`);
    const total = agg?.total ?? 0;
    const empty = agg?.empty ?? 0;
    const ratePct = total > 0 ? Math.round((empty / total) * 100) : 0;
    // Only judge with enough volume; below minRows a high rate is noise.
    const fail = total >= minRows && empty / total >= rateThreshold;
    checks.push({
      name: "column_quality.fb_marketer_attribution",
      status: fail ? "fail" : "pass",
      maxDate,
      threshold: `< ${Math.round(rateThreshold * 100)}% empty over last ${recentDays}d (min ${minRows} rows)`,
      dedupKey: "column_quality:fb_marketer_attribution",
      title: `FB marketer attribution degraded — ${ratePct}% of recent ad rows have no matched marketer`,
      severity: "p2",
      detail: fail
        ? `empty=${empty}/${total} (${ratePct}%) window>=${windowStart}`
        : undefined,
      fields: {
        windowStart,
        total,
        empty,
        ratePct,
        thresholdPct: Math.round(rateThreshold * 100),
        minRows,
      },
    });
  }

  return checks;
}
