/**
 * Composed view for /shipping-performance — pulls the persisted stats
 * snapshot (cheap, ~2 rows from `shipping_stats_daily`), then hits
 * Shopify live to derive today's fulfilment + carrier flag lists.
 *
 * Flags are *not* persisted (spec §7.2) — they're freshly derived each
 * page load from current Shopify state. That's fine: the live fetch is
 * one paginated GraphQL query, ~30d of orders for the US store.
 *
 * Spec: docs/shipping-checks-spec/ops-shipping-checks-spec.md
 */

import { and, desc, eq, gte, lte } from "drizzle-orm";

import { db } from "@/lib/db";
import { shippingStatsDaily, stockSnapshots } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import {
  computeStatsWindow,
  detectCarrierTransitViolations,
  detectFulfilmentSlaViolations,
  shiftStoreLocal,
  storeLocalMidnight,
  todayStoreLocal,
  type CarrierFlag,
  type FulfilmentFlag,
  type InventoryAvailability,
  type StatsWindowSummary,
} from "@/lib/domain/shipping-checks";
import { fetchOrdersSince } from "@/lib/sources/shopify-fulfillments";

const US_STORE = "incontinencepanties.myshopify.com";
const ADMIN_LINK_BASE = `https://${US_STORE}`;

// Window we fetch live. 35d gives the SLA check + carrier check + a 5d
// buffer. (Bigger than the snapshot's 60-day window because we don't
// need delivered_at history that far back — only currently-flaggable
// orders.)
const LIVE_FETCH_BACK_DAYS = 35;

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

async function buildInventoryLookup(): Promise<InventoryAvailability> {
  const allUs = await db
    .select({
      sku: stockSnapshots.sku,
      onHand: stockSnapshots.onHand,
      snapshotDate: stockSnapshots.snapshotDate,
    })
    .from(stockSnapshots)
    .where(eq(stockSnapshots.location, "US"))
    .orderBy(desc(stockSnapshots.snapshotDate));
  const map = new Map<string, number>();
  for (const r of allUs) {
    if (!map.has(r.sku)) map.set(r.sku, Number(r.onHand));
  }
  return (sku: string) => map.get(sku);
}

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

  // Live fetch for flags. If Shopify is unavailable we still want the
  // stats panel to render — log and return empty flag lists.
  let fulfilmentFlags: FulfilmentFlag[] = [];
  let carrierFlags: CarrierFlag[] = [];

  try {
    const sinceLocal = shiftStoreLocal(today, -LIVE_FETCH_BACK_DAYS);
    const sinceIso = storeLocalMidnight(sinceLocal).toISOString();
    const inventoryAvailable = await buildInventoryLookup();
    const orders = await fetchOrdersSince({
      store: US_STORE,
      sinceIso,
    });

    fulfilmentFlags = detectFulfilmentSlaViolations({
      orders,
      inventoryAvailable,
      todayStoreLocal: today,
      adminLinkBase: ADMIN_LINK_BASE,
    });
    carrierFlags = detectCarrierTransitViolations({
      orders,
      inventoryAvailable,
      nowIso: new Date().toISOString(),
      adminLinkBase: ADMIN_LINK_BASE,
    });

    // Optional: also recompute the current-window stats from this same
    // fetch, so the UI shows fresher numbers than yesterday's
    // persisted snapshot. Only override if we got a valid sample.
    const liveStats = computeStatsWindow({
      orders,
      inventoryAvailable,
      windowStart: currentWindowStart,
      windowEnd: today,
    });
    if (liveStats.deliveredCount > 0) {
      stats.current = liveStats;
      stats.deltaPct = {
        fulfilmentHours: pctDelta(
          liveStats.avgFulfilmentHours,
          prior?.avgFulfilmentHours ?? null,
        ),
        transitDays: pctDelta(
          liveStats.avgTransitDays,
          prior?.avgTransitDays ?? null,
        ),
        totalDays: pctDelta(
          liveStats.avgTotalDays,
          prior?.avgTotalDays ?? null,
        ),
      };
    }
  } catch (e) {
    logger.warn("shipping.view.live_fetch_failed", {
      error: e instanceof Error ? e.message : String(e),
    });
  }

  logger.info("shipping.view.computed", {
    today,
    deliveredCount: stats.current.deliveredCount,
    fulfilmentFlagCount: fulfilmentFlags.length,
    carrierFlagCount: carrierFlags.length,
    ms: Date.now() - start,
  });

  return {
    stats,
    fulfilmentFlags,
    carrierFlags,
    computedAt: new Date().toISOString(),
  };
}
