// Missing-link coverage check (self-maintaining attribution guard).
//
// All-products FB attribution now reads product + region from the
// Jasper-maintained fb_product_map sheet, keyed by each ad's normalized
// destination URL (see normalizeFunnelUrl). Any live ad whose landing URL
// is NOT in the sheet falls back to ad-name attribution and an audience-geo
// region guess — workable, but it means a NEW funnel/landing page goes
// un-mapped until someone notices.
//
// So we surface it. This sums the FB URL-map snapshot cost by normalized URL
// for every URL that is NOT in the product map, and fires a p2 -> #skybrook
// digest for any that has accrued real spend. The digest line is the exact
// URL to paste into the sheet. It auto-resolves once the URL is added (or the
// ad stops spending). Threshold is on cumulative spend, not row count — one
// big-budget new funnel matters more than ten $1 tests. The same data backs
// the "Ad links not in the product sheet" section on /performance.

import { max, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { fbAdSpendDaily, fbAdUrlMap, fbProductMap } from "@/lib/db/schema";
import { normalizeFunnelUrl } from "@/lib/domain/fb-product-attribution";
import type { EvaluatedCheck } from "@/lib/jobs/freshness-check";

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

export type UnmappedUrl = { url: string; spendUsd: number };

/**
 * Sum FB URL-map snapshot spend by normalized URL for URLs absent from the
 * product map. Shared by the digest check and the /performance section.
 */
export async function unmappedFbUrlSpend(): Promise<UnmappedUrl[]> {
  const mapped = new Set(
    (await db.select({ url: fbProductMap.normalizedUrl }).from(fbProductMap)).map((r) => r.url),
  );
  const rows = await db
    .select({ destUrl: fbAdUrlMap.destUrl, cost: fbAdUrlMap.costUsd })
    .from(fbAdUrlMap);

  const byUrl = new Map<string, number>();
  for (const r of rows) {
    const norm = normalizeFunnelUrl(r.destUrl);
    if (!norm) continue; // social permalink / unparseable -> not a landing page
    if (mapped.has(norm)) continue; // already in the sheet
    byUrl.set(norm, (byUrl.get(norm) ?? 0) + (Number(r.cost) || 0));
  }

  return [...byUrl.entries()]
    .map(([url, spendUsd]) => ({ url, spendUsd: Number(spendUsd.toFixed(2)) }))
    .sort((a, b) => b.spendUsd - a.spendUsd);
}

export async function evaluateFbUrlCoverage(opts?: {
  minSpendUsd?: number;
}): Promise<EvaluatedCheck[]> {
  const minSpendUsd = opts?.minSpendUsd ?? 500;

  // Anchor display on the latest FB spend date (the snapshot itself is undated).
  const [maxRow] = await db.select({ max: max(fbAdSpendDaily.spendDate) }).from(fbAdSpendDaily);
  const maxDate = maxRow?.max ?? null;

  const unmapped = await unmappedFbUrlSpend();
  const checks: EvaluatedCheck[] = [];
  for (const u of unmapped) {
    if (u.spendUsd < minSpendUsd) continue;
    checks.push({
      name: `fb_url_unmapped.${slugify(u.url)}`,
      status: "fail",
      maxDate,
      threshold: `< $${minSpendUsd} unmapped FB landing-URL spend`,
      dedupKey: `fb_url_unmapped:${slugify(u.url)}`,
      title: `FB ad link not in product sheet "${u.url}" — $${u.spendUsd.toLocaleString("en-US")}, add it to the sheet`,
      severity: "p2",
      detail: `url=${u.url} spend=$${u.spendUsd}`,
      fields: { url: u.url, spendUsd: u.spendUsd },
    });
  }
  checks.sort((a, b) => Number(b.fields.spendUsd) - Number(a.fields.spendUsd));
  return checks;
}
