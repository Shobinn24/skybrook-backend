/**
 * Composed view for /shipping-performance — reads the persisted stats
 * snapshot AND the persisted flag lists from `shipping_stats_daily`.
 * Both are computed once per nightly cron run (see runShippingSnapshot
 * in lib/jobs/shipping-snapshot.ts). No live Shopify fetch happens at
 * page load — that path was measured at ~6 minutes during the
 * 2026-05-29 audit and the page rendered as a permanent loading
 * spinner. Spec §1 ("Daily, Mon–Fri") + §5.1 ("refreshed daily").
 *
 * Spec: docs/shipping-checks-spec/ops-shipping-checks-spec.md
 */

import { and, desc, gte, lte } from "drizzle-orm";

import { db } from "@/lib/db";
import { shippingStatsDaily } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import {
  shiftStoreLocal,
  todayStoreLocal,
  type CarrierFlag,
  type FulfilmentFlag,
  type StatsWindowSummary,
} from "@/lib/domain/shipping-checks";

export type ShippingStatsDelta = {
  current: StatsWindowSummary;
  prior: StatsWindowSummary | null;
  // Percent change (current vs prior), positive = slower, negative = faster.
  // null if prior is missing.
  deltaPct: {
    fulfilmentHours: number | null;
    transitDays: number | null;
    totalDays: number | null;
  };
};

export type ShippingPerformanceView = {
  stats: ShippingStatsDelta;
  fulfilmentFlags: FulfilmentFlag[];
  carrierFlags: CarrierFlag[];
  // ISO instant the live fetch + flags were computed. Renders in the
  // "Last updated" line on the dashboard.
  computedAt: string;
};

function toStatsSummary(
  row: typeof shippingStatsDaily.$inferSelect,
  windowStart: string,
  windowEnd: string,
): StatsWindowSummary {
  return {
    windowStart,
    windowEnd,
    deliveredCount: row.deliveredCount,
    avgFulfilmentHours:
      row.avgFulfilmentHours !== null ? Number(row.avgFulfilmentHours) : null,
    avgTransitDays:
      row.avgTransitDays !== null ? Number(row.avgTransitDays) : null,
    avgTotalDays: row.avgTotalDays !== null ? Number(row.avgTotalDays) : null,
    transitHistogram: row.transitHistogram as Record<string, number>,
  };
}

function pctDelta(curr: number | null, prior: number | null): number | null {
  if (curr === null || prior === null || prior === 0) return null;
  return ((curr - prior) / prior) * 100;
}

/**
 * Read the persisted stats row whose snapshot_date is *closest to but
 * not after* the target. Lets the prior-30d comparison work even if
 * the cron skipped a day.
 */
async function readSnapshotNear(targetDate: string) {
  const rows = await db
    .select()
    .from(shippingStatsDaily)
    .where(
      and(
        // Cap at target date, within a 7-day backstop so we don't pick
        // a wildly stale row.
        gte(shippingStatsDaily.snapshotDate, shiftStoreLocal(targetDate, -7)),
        lte(shippingStatsDaily.snapshotDate, targetDate),
      ),
    )
    .orderBy(desc(shippingStatsDaily.snapshotDate))
    .limit(1);
  return rows[0] ?? null;
}

export async function getShippingPerformanceView(): Promise<ShippingPerformanceView> {
  const start = Date.now();
  const today = todayStoreLocal();
  const priorDate = shiftStoreLocal(today, -30);

  const [currentRow, priorRow] = await Promise.all([
    readSnapshotNear(today),
    readSnapshotNear(priorDate),
  ]);

  // The current window's stats: if today's snapshot doesn't exist yet
  // (cron hasn't run), fall back to an empty summary so the UI still
  // renders with "—" rather than blowing up. Same for prior.
  const currentWindowEnd = currentRow?.snapshotDate ?? today;
  const currentWindowStart = shiftStoreLocal(currentWindowEnd, -30);
  const priorWindowEnd = priorRow?.snapshotDate ?? priorDate;
  const priorWindowStart = shiftStoreLocal(priorWindowEnd, -30);

  const current: StatsWindowSummary = currentRow
    ? toStatsSummary(currentRow, currentWindowStart, currentWindowEnd)
    : {
        windowStart: currentWindowStart,
        windowEnd: currentWindowEnd,
        deliveredCount: 0,
        avgFulfilmentHours: null,
        avgTransitDays: null,
        avgTotalDays: null,
        transitHistogram: {},
      };
  const prior: StatsWindowSummary | null = priorRow
    ? toStatsSummary(priorRow, priorWindowStart, priorWindowEnd)
    : null;

  const stats: ShippingStatsDelta = {
    current,
    prior,
    deltaPct: {
      fulfilmentHours: pctDelta(
        current.avgFulfilmentHours,
        prior?.avgFulfilmentHours ?? null,
      ),
      transitDays: pctDelta(
        current.avgTransitDays,
        prior?.avgTransitDays ?? null,
      ),
      totalDays: pctDelta(current.avgTotalDays, prior?.avgTotalDays ?? null),
    },
  };

  // Read persisted flags from the same snapshot row whose stats we
  // already loaded above. No Shopify call here — the cron did that
  // work overnight. Defaults to empty arrays when the snapshot
  // pre-dates the 2026-05-29 flag-persistence migration.
  const fulfilmentFlags: FulfilmentFlag[] =
    ((currentRow?.fulfilmentFlags as FulfilmentFlag[] | null) ?? []) as FulfilmentFlag[];
  const carrierFlags: CarrierFlag[] =
    ((currentRow?.carrierFlags as CarrierFlag[] | null) ?? []) as CarrierFlag[];
  // Use the snapshot's flags_computed_at when present so the dashboard
  // "Last updated" line reflects when the flags were actually
  // produced, not when the user happened to load the page. Fall back
  // to the stats row's computedAt for legacy snapshots.
  const computedAt = (
    currentRow?.flagsComputedAt ??
    currentRow?.computedAt ??
    new Date()
  ).toISOString();

  logger.info("shipping.view.computed", {
    today,
    deliveredCount: stats.current.deliveredCount,
    fulfilmentFlagCount: fulfilmentFlags.length,
    carrierFlagCount: carrierFlags.length,
    snapshotDate: currentRow?.snapshotDate ?? null,
    ms: Date.now() - start,
  });

  return {
    stats,
    fulfilmentFlags,
    carrierFlags,
    computedAt,
  };
}
