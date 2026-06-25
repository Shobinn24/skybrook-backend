// New-prefix coverage check (self-maintaining attribution guard).
//
// The All-products view attributes FB spend to a product family from the
// `(PREFIX)` at the start of `fb_ad_spend_daily.ad_name_raw` via
// `attributeFbAd`. That mapping is only as good as the ad-naming
// convention — a typo ("(Botshort)"), an unconfirmed abbreviation
// ("(LAV)"), or a brand-new product the map doesn't know yet all fall
// through to the "Unmapped" bucket. By DECISION (6/25) we deliberately do
// NOT auto-correct typos: the tool's correctness depends on correct ad
// naming, and that dependency must be VISIBLE, not silently papered over.
//
// So instead of guessing, we surface it. This check sums recent spend by
// raw `(...)` prefix and fires a p2 → #skybrook-digest for any prefix that
// (a) attributes to the Unmapped bucket AND (b) has accrued real money
// over the window. The digest line tells the marketer exactly which
// prefix to rename or which product to add to the map. It auto-resolves
// once the prefix stops accruing (renamed) or gets mapped (code change).
//
// Threshold is on cumulative spend, not row count — one big-budget
// mis-named ad matters more than ten $1 tests. Window is anchored on the
// latest spend_date present (not "today") so a stale feed — already
// covered by freshness — doesn't empty the window and mask a real gap.

import { max, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { fbAdSpendDaily } from "@/lib/db/schema";
import { attributeFbAd } from "@/lib/domain/fb-product-attribution";
import type { EvaluatedCheck } from "@/lib/jobs/freshness-check";

// Subtract `days` from a YYYY-MM-DD string. UTC math (plain calendar
// dates, DST-agnostic) — same helper shape as column-quality.
function isoDaysBefore(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

// Extract the leading "(...)" inner text from an ad name; null if absent.
function prefixOf(adNameRaw: string): string | null {
  const m = adNameRaw.match(/^\(([^)]+)\)/);
  return m ? m[1].trim() : null;
}

// Slack-safe, stable dedup slug for a prefix.
function slugify(prefix: string): string {
  return prefix.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

export async function evaluateFbPrefixCoverage(opts?: {
  // How many calendar days back from the latest fb spend_date to sum over.
  recentDays?: number;
  // Cumulative spend (USD) at/above which an unmapped prefix alerts.
  minSpendUsd?: number;
}): Promise<EvaluatedCheck[]> {
  const recentDays = opts?.recentDays ?? 14;
  const minSpendUsd = opts?.minSpendUsd ?? 500;

  const [maxRow] = await db
    .select({ max: max(fbAdSpendDaily.spendDate) })
    .from(fbAdSpendDaily);
  const maxDate = maxRow?.max ?? null;
  if (!maxDate) return [];

  const windowStart = isoDaysBefore(maxDate, recentDays - 1);
  const rows = await db
    .select({
      adNameRaw: fbAdSpendDaily.adNameRaw,
      adLink: fbAdSpendDaily.adLink,
      cost: sql<string>`SUM(${fbAdSpendDaily.costUsd})::text`,
    })
    .from(fbAdSpendDaily)
    .where(sql`${fbAdSpendDaily.spendDate} >= ${windowStart}`)
    .groupBy(fbAdSpendDaily.adNameRaw, fbAdSpendDaily.adLink);

  // Roll up by raw prefix; keep total spend + a representative sample ad.
  type Agg = { prefix: string; spendUsd: number; sampleAd: string; sampleLink: string | null };
  const byPrefix = new Map<string, Agg>();
  for (const r of rows) {
    if (attributeFbAd(r.adNameRaw).bucket !== "unmapped") continue;
    const prefix = prefixOf(r.adNameRaw);
    // No leading "(...)" at all → can't name it; skip (these are rare and
    // not actionable as a "rename this prefix" instruction).
    if (!prefix) continue;
    const cost = Number(r.cost ?? 0);
    const prev = byPrefix.get(prefix);
    if (prev) {
      prev.spendUsd += cost;
      // Deterministic, useful sample: prefer an ad that has a clickable
      // link (so the digest line is actionable), tie-broken by the
      // lexicographically smallest ad name (grouped-query order is not
      // stable, so we must pick explicitly).
      const better =
        (r.adLink !== null && prev.sampleLink === null) ||
        (((r.adLink === null) === (prev.sampleLink === null)) &&
          r.adNameRaw < prev.sampleAd);
      if (better) {
        prev.sampleAd = r.adNameRaw;
        prev.sampleLink = r.adLink ?? null;
      }
    } else {
      byPrefix.set(prefix, {
        prefix,
        spendUsd: cost,
        sampleAd: r.adNameRaw,
        sampleLink: r.adLink ?? null,
      });
    }
  }

  const checks: EvaluatedCheck[] = [];
  for (const agg of byPrefix.values()) {
    const spendUsd = Number(agg.spendUsd.toFixed(2));
    if (spendUsd < minSpendUsd) continue;
    checks.push({
      name: `fb_prefix.${slugify(agg.prefix)}`,
      status: "fail",
      maxDate,
      threshold: `< $${minSpendUsd} unmapped over last ${recentDays}d`,
      dedupKey: `fb_prefix:${slugify(agg.prefix)}`,
      title: `Unmapped FB ad prefix "(${agg.prefix})" — $${spendUsd.toLocaleString("en-US")} over ${recentDays}d, assign a product`,
      severity: "p2",
      detail: `prefix=(${agg.prefix}) spend=$${spendUsd} window>=${windowStart} sample=${agg.sampleAd}`,
      fields: {
        prefix: agg.prefix,
        spendUsd,
        windowStart,
        recentDays,
        sampleAd: agg.sampleAd,
        sampleLink: agg.sampleLink ?? "<none>",
      },
    });
  }

  // Stable, deterministic order: biggest unmapped spend first.
  checks.sort((a, b) => Number(b.fields.spendUsd) - Number(a.fields.spendUsd));
  return checks;
}
