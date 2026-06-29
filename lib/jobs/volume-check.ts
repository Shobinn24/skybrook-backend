// Volume pillar — the 4th data-observability pillar alongside Freshness,
// Schema (drift), and Distribution (anomaly). Freshness asks "did data
// arrive recently?"; schema drift asks "did the shape change?"; Volume
// asks "did roughly the RIGHT AMOUNT of data arrive?".
//
// A pull can report status='success' AND carry a current max(date) yet
// silently bring HALF its rows — the region-split trap caught by hand on
// 2026-06-22, where an inventory pull landed ~554 rows instead of the
// usual ~1108 because one region's tab block dropped out. Neither the
// success flag nor the freshness check saw it; only the row count did.
//
// This monitor compares each source's latest successful pull's
// `data_pulls.row_count` (already stored on every pull) against a robust
// baseline (median of the prior successful pulls) and fails when it
// falls below a per-source floor fraction of that median. Median (not
// mean) so a single fat/thin pull in the window doesn't move the
// baseline. DB-only and cheap, so it rides the same `evaluateFreshness`
// path that /api/health and both crons already call — no new wiring,
// no extra Sheets/Shopify round-trips.
//
// Severity is p2 (→ #skybrook-digest, not an @mention page): a volume
// dip is "look at this", and on first deploy it should prove quiet
// before it earns a page. Raise per-source to p1 once stable.

import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { dataPulls } from "@/lib/db/schema";
import type { EvaluatedCheck } from "@/lib/jobs/freshness-check";

type Source =
  | "sheets_inventory"
  | "sheets_incoming"
  | "sheets_ad_spend"
  | "sheets_fb_ads"
  | "sheets_applovin"
  | "sheets_fb_geo"
  | "sheets_fb_url_map"
  | "sheets_fb_product_map"
  | "shopify_us"
  | "shopify_intl";

export type VolumeMonitor = {
  source: Source;
  // Fail when latest row_count < floorFraction * median(baseline).
  // Tune per source by how stable its row count naturally is:
  //   - inventory: row_count ≈ SKU roster × regions, very stable → tight
  //   - incoming:  row_count ≈ open PO rows, moderately stable
  //   - ad_spend / fb_ads: row_count = ad×day rows, swings as ads start
  //     and stop → looser so normal churn doesn't page
  floorFraction: number;
  // Minimum prior successful pulls required before we'll judge a drop.
  // Below this we emit no check at all (a brand-new source has no track
  // record to compare against and must not page).
  minHistory: number;
};

// shopify_us / shopify_intl are deliberately EXCLUDED from v1: their
// row_count = orders / line-items in the pull window, which swings hard
// by day-of-week and promo cadence, so a static median floor would
// false-fire on a slow Sunday. They belong under the seasonality-aware
// threshold work (upgrade-research #4 item 3), not this static-floor v1.
// Documenting the exclusion here rather than silently omitting them.
export const VOLUME_MONITORS: ReadonlyArray<VolumeMonitor> = [
  { source: "sheets_inventory", floorFraction: 0.7, minHistory: 5 },
  { source: "sheets_incoming", floorFraction: 0.6, minHistory: 5 },
  { source: "sheets_ad_spend", floorFraction: 0.5, minHistory: 5 },
  { source: "sheets_fb_ads", floorFraction: 0.5, minHistory: 5 },
  // AppLovin: row_count = (product × day) aggregated rows; swings with how
  // many products run, so loose floor like the other ad feeds.
  { source: "sheets_applovin", floorFraction: 0.5, minHistory: 5 },
  // FB geo: row_count = (ad × country) rows in the 30d window snapshot;
  // FB URL map: row_count = ads in the window. Both swing with how many ads
  // are live, so a loose floor catches an empty/broken pull without paging on
  // normal churn. (These are full-replace snapshots, so an empty pull would
  // zero the table — the volume floor is the main guard since there's no date
  // column for a freshness check.)
  { source: "sheets_fb_geo", floorFraction: 0.5, minHistory: 5 },
  { source: "sheets_fb_url_map", floorFraction: 0.5, minHistory: 5 },
  // FB product map: row_count = mapped URLs in Jasper's sheet. Grows slowly as
  // funnels are added; loose floor catches an empty/broken pull (which would
  // zero the lookup table and drop all FB attribution to ad-name fallback).
  { source: "sheets_fb_product_map", floorFraction: 0.5, minHistory: 5 },
];

// How many prior successful pulls to fold into the baseline median.
// Big enough to be stable, small enough to track a genuine roster change
// within a couple of weeks (so a real +SKU growth re-baselines quickly).
const BASELINE_WINDOW = 10;

function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

// Read-only evaluation, mirroring `evaluateFreshness`: returns checks
// with stable dedup keys so the caller (runFreshnessCheck) fires/resolves
// alerts exactly once per cron tick and /api/health can surface them
// without side effects.
export async function evaluateVolume(opts?: {
  monitors?: ReadonlyArray<VolumeMonitor>;
}): Promise<EvaluatedCheck[]> {
  const monitors = opts?.monitors ?? VOLUME_MONITORS;
  const checks: EvaluatedCheck[] = [];

  for (const m of monitors) {
    // Latest + up to BASELINE_WINDOW prior successful pulls, newest first.
    // Failed/partial pulls are excluded so a half-written failure doesn't
    // poison the baseline or masquerade as "latest".
    const rows = await db
      .select({ rowCount: dataPulls.rowCount })
      .from(dataPulls)
      .where(and(eq(dataPulls.source, m.source), eq(dataPulls.status, "success")))
      .orderBy(desc(dataPulls.startedAt))
      .limit(BASELINE_WINDOW + 1);

    // Insufficient history → emit nothing (same posture as the freshness
    // new-tab exemption). Can't call a drop without a baseline.
    if (rows.length < m.minHistory + 1) continue;

    const latest = rows[0].rowCount;
    const baseline = rows.slice(1).map((r) => r.rowCount);
    const med = median(baseline);

    // A zero/degenerate baseline gives no meaningful ratio (source
    // legitimately pulls 0 rows, or only just started carrying data).
    if (!Number.isFinite(med) || med <= 0) continue;

    const floor = med * m.floorFraction;
    const dropped = latest < floor;
    const ratioPct = Math.round((latest / med) * 100);

    checks.push({
      name: `volume.${m.source}`,
      status: dropped ? "fail" : "pass",
      maxDate: null,
      threshold: `>= ${Math.round(floor)} rows (${Math.round(m.floorFraction * 100)}% of median ${med})`,
      dedupKey: `volume:${m.source}`,
      title: `Volume drop on ${m.source} — latest pull ${latest} rows is ${ratioPct}% of recent median ${med}`,
      severity: "p2",
      detail: dropped
        ? `latest=${latest} median=${med} floor=${Math.round(floor)} (${ratioPct}% of median)`
        : undefined,
      fields: {
        source: m.source,
        latestRowCount: latest,
        baselineMedian: med,
        floor: Math.round(floor),
        floorFraction: m.floorFraction,
        ratioPct,
        baselineSamples: baseline.length,
      },
    });
  }

  return checks;
}
