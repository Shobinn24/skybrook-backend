// New-product launch detector.
//
// The existing attribution guards (fb-prefix-check, fb-url-coverage-check)
// are COVERAGE checks: they fire when something fails to map. That leaves a
// blind spot for the opposite failure — a brand-new product that maps to
// something plausible but wrong, and so never trips a coverage alert.
//
// The case that motivated this (2026-08-04): "(Cotton Collection INTL)" ads
// started spending 07/27. `attributeFbPrefix` dispatches on the FIRST token,
// so "Cotton Collection" resolved to `cotton` -> Cotton 9055 — a clean
// "mapped" result. fb-prefix-check only fires on bucket=unmapped, so it
// stayed silent. The launch stayed invisible for eight days, until cumulative
// landing-URL spend crossed the $500 floor on the unrelated URL check. The
// same shape is why "Men Brief" and "Mens Boxer" each needed a hand-written
// two-word rule in attributeFbPrefix after the fact.
//
// So this is a NOVELTY detector, not a coverage one. It asks "has this been
// seen before?" rather than "does this map?", and reports the mapping as
// context so a silent absorption is visible on the page.
//
// The hard part is that raw prefix novelty is far too noisy to act on. On
// 2026-07-31 a "BC" campaign suffix appeared across 20 existing products in
// one day: 20 "new" prefixes, zero new products. So we split each prefix into
// a product HEAD and trailing CAMPAIGN tokens, and only treat a new head as a
// launch signal.
//
// The campaign-token vocabulary is DERIVED from the data, not hardcoded: a
// trailing token that appears behind many distinct product heads is campaign
// structure ("CC", "INTL", "US BAU", "BC"), while one that appears behind
// exactly one head is part of the product name ("Collection" behind "Cotton").
// Deriving it means a brand-new campaign suffix is classified correctly the
// day it lands, without a code change — the same self-maintaining posture as
// the coverage checks. Hardcoding the list would put us right back to editing
// code every time marketing invents a suffix.
//
// Known tradeoff: a variant token that spreads across enough products becomes
// campaign structure by the same rule ("HF", "Gifts"), so "9055 HF" strips to
// "9055". That means a new VARIANT of a known product is not an ad-side
// signal. That is the intended split — a new colorway or flow variant is an
// inventory event, and the SKU channel below plus runLaunchAutoPopulate
// already cover it. Only a genuinely new product NAME is an ad-side launch.
//
// Measured against full production history (270 prefixes, 2026-08-04): 32
// prefixes were new inside a 21-day window; 26 were suppressed as known heads
// (the "BC" wave), leaving 3 signals — the Cotton HW ad launch (07/24), Cotton
// Collection (07/27), and a "Home" -> "Homepage" rename. Two real launches and
// one benign rename that ages out of the window on its own.

import { max, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { fbAdSpendDaily, fbAdUrlMap, fbProductMap, skus } from "@/lib/db/schema";
import {
  attributeFbPrefix,
  extractFbPrefix,
  normalizeFunnelUrl,
} from "@/lib/domain/fb-product-attribution";

/** How far back a first-appearance counts as "new". */
export const LAUNCH_WINDOW_DAYS = 21;

/** Spend floor for reporting a new head. Deliberately LOW — the whole point
 *  is to beat the $500 coverage floors, which is what let Cotton Collection
 *  run eight days unseen. This only suppresses sub-coffee noise. */
export const MIN_PREFIX_SPEND_USD = 25;

/** A trailing token behind at least this many distinct heads is campaign
 *  structure rather than part of a product name. 3 is comfortably below the
 *  ~20 heads a real campaign suffix shows and above the 1 that a genuine
 *  multi-word product name ("Cotton Collection") produces. */
export const MIN_HEADS_FOR_CAMPAIGN_TOKEN = 3;

export function tokenizePrefix(prefix: string): string[] {
  return (prefix ?? "").trim().split(/\s+/).filter(Boolean);
}

/**
 * Derive the campaign-suffix vocabulary from every prefix ever seen.
 *
 * Computed over ALL history including the current window, deliberately: a new
 * suffix rolled out across many products at once (the 07/31 "BC" wave) must be
 * recognised as campaign structure immediately, and it cannot be if the
 * vocabulary only knows about pre-window data.
 *
 * The first token is never eligible — a prefix always keeps a head.
 */
export function deriveCampaignTokens(prefixes: string[]): Set<string> {
  const leadsByToken = new Map<string, Set<string>>();
  for (const p of prefixes) {
    const tokens = tokenizePrefix(p);
    for (let i = 1; i < tokens.length; i++) {
      const token = tokens[i].toLowerCase();
      const lead = tokens.slice(0, i).join(" ").toLowerCase();
      let leads = leadsByToken.get(token);
      if (!leads) leadsByToken.set(token, (leads = new Set()));
      leads.add(lead);
    }
  }
  const campaign = new Set<string>();
  for (const [token, leads] of leadsByToken) {
    if (leads.size >= MIN_HEADS_FOR_CAMPAIGN_TOKEN) campaign.add(token);
  }
  return campaign;
}

/**
 * Strip trailing campaign tokens to leave the product head.
 * "Cotton Collection INTL" -> "Cotton Collection"; "HRS BC" -> "HRS".
 * Never strips to empty: a single-token prefix is its own head.
 */
export function stripCampaignTokens(prefix: string, campaign: Set<string>): string {
  const tokens = tokenizePrefix(prefix);
  let end = tokens.length;
  while (end > 1 && campaign.has(tokens[end - 1].toLowerCase())) end--;
  return tokens.slice(0, end).join(" ");
}

/** Subtract days from a YYYY-MM-DD string (UTC calendar math, DST-agnostic). */
function isoDaysBefore(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export type LandingUrl = {
  url: string;
  mapped: boolean;
  /** Product label from the map sheet, when mapped. */
  productLabel: string | null;
  spendUsd: number;
};

export type NewAdHead = {
  /** Product head, campaign suffixes stripped. */
  head: string;
  /** Full prefixes sharing this head, e.g. ["Cotton Collection INTL"]. */
  prefixes: string[];
  firstSeen: string;
  spendUsd: number;
  /** What attribution currently resolves this to. */
  attributedTo: string;
  /** True when it lands in a real product line rather than the Unmapped
   *  bucket — i.e. the silent-absorption case the coverage checks miss. */
  absorbed: boolean;
  landingUrls: LandingUrl[];
};

export type NewSku = {
  sku: string;
  productName: string;
  productLine: string | null;
  firstSeen: string;
  hasCost: boolean;
};

export type LaunchSignals = {
  asOfDate: string | null;
  windowStart: string | null;
  windowDays: number;
  newAdHeads: NewAdHead[];
  newSkus: NewSku[];
};

/**
 * Detect launch signals across the advertising side (new prefix heads and
 * their landing URLs) and the inventory side (new SKUs).
 *
 * Scope boundary, deliberate: a genuinely new LANDING URL with no new prefix
 * is not detected here. `fb_ad_spend_daily.ad_link` holds Facebook social
 * permalinks, not landing pages, and the only landing-URL source
 * (`fb_ad_url_map`) is an undated snapshot with no first-seen state to
 * compare against. Persisting that state would need a migration; until then
 * that case stays covered by evaluateFbUrlCoverage's $500 floor. What we CAN
 * do without new state is report each new head's landing URLs and whether
 * they are in the product map, which is the mapped-vs-missing readout.
 */
export async function detectLaunchSignals(opts?: {
  windowDays?: number;
  minSpendUsd?: number;
}): Promise<LaunchSignals> {
  const windowDays = opts?.windowDays ?? LAUNCH_WINDOW_DAYS;
  const minSpendUsd = opts?.minSpendUsd ?? MIN_PREFIX_SPEND_USD;

  // Anchor on the latest spend date present, not "today", so a stale feed
  // (already covered by freshness) empties the window instead of masking a
  // real launch behind a date nobody has data for.
  const [maxRow] = await db.select({ max: max(fbAdSpendDaily.spendDate) }).from(fbAdSpendDaily);
  const asOfDate = maxRow?.max ?? null;
  if (!asOfDate) {
    return { asOfDate: null, windowStart: null, windowDays, newAdHeads: [], newSkus: [] };
  }
  const windowStart = isoDaysBefore(asOfDate, windowDays - 1);

  // Per-prefix lifetime facts. One grouped scan; the novelty test is entirely
  // min(spend_date), so no separate historical query is needed.
  const prefixRows = await db
    .select({
      prefix: fbAdSpendDaily.adPrefix,
      firstSeen: sql<string>`MIN(${fbAdSpendDaily.spendDate})::text`,
      spend: sql<string>`SUM(${fbAdSpendDaily.costUsd})::text`,
      recentSpend: sql<string>`SUM(${fbAdSpendDaily.costUsd}) FILTER (WHERE ${fbAdSpendDaily.spendDate} >= ${windowStart})::text`,
    })
    .from(fbAdSpendDaily)
    .groupBy(fbAdSpendDaily.adPrefix);

  const withPrefix = prefixRows.filter((r) => (r.prefix ?? "").trim() !== "");
  const campaign = deriveCampaignTokens(withPrefix.map((r) => r.prefix));

  // Heads that existed BEFORE the window are known; everything else is new.
  const knownHeads = new Set<string>();
  for (const r of withPrefix) {
    if (r.firstSeen < windowStart) {
      knownHeads.add(stripCampaignTokens(r.prefix, campaign).toLowerCase());
    }
  }

  type HeadAgg = {
    head: string;
    prefixes: Set<string>;
    firstSeen: string;
    spendUsd: number;
  };
  const byHead = new Map<string, HeadAgg>();
  for (const r of withPrefix) {
    if (r.firstSeen < windowStart) continue;
    const head = stripCampaignTokens(r.prefix, campaign);
    const key = head.toLowerCase();
    // A new prefix under an ALREADY KNOWN head is campaign restructuring,
    // not a launch. This is what suppresses the 20-prefix "BC" wave.
    if (knownHeads.has(key)) continue;
    const spend = Number(r.recentSpend ?? r.spend ?? 0);
    const prev = byHead.get(key);
    if (prev) {
      prev.prefixes.add(r.prefix);
      prev.spendUsd += spend;
      if (r.firstSeen < prev.firstSeen) prev.firstSeen = r.firstSeen;
    } else {
      byHead.set(key, {
        head,
        prefixes: new Set([r.prefix]),
        firstSeen: r.firstSeen,
        spendUsd: spend,
      });
    }
  }

  // Landing URLs per head, from the URL-map snapshot. The snapshot's ad_name
  // carries the same "(PREFIX) ..." convention, so it keys by head directly
  // with no join back to the spend table.
  const mapped = new Map(
    (
      await db
        .select({ url: fbProductMap.normalizedUrl, label: fbProductMap.productLabel })
        .from(fbProductMap)
    ).map((r) => [r.url, r.label]),
  );
  const urlRows = await db
    .select({ adName: fbAdUrlMap.adName, destUrl: fbAdUrlMap.destUrl, cost: fbAdUrlMap.costUsd })
    .from(fbAdUrlMap);

  const urlsByHead = new Map<string, Map<string, number>>();
  for (const r of urlRows) {
    const prefix = extractFbPrefix(r.adName ?? "");
    if (!prefix) continue;
    const key = stripCampaignTokens(prefix, campaign).toLowerCase();
    if (!byHead.has(key)) continue;
    const norm = normalizeFunnelUrl(r.destUrl ?? "");
    if (!norm) continue; // social permalink, not a landing page
    let urls = urlsByHead.get(key);
    if (!urls) urlsByHead.set(key, (urls = new Map()));
    urls.set(norm, (urls.get(norm) ?? 0) + (Number(r.cost) || 0));
  }

  const newAdHeads: NewAdHead[] = [];
  for (const [key, agg] of byHead) {
    const spendUsd = Number(agg.spendUsd.toFixed(2));
    if (spendUsd < minSpendUsd) continue;
    // Deterministic representative: grouped-query order is not stable.
    const prefixes = [...agg.prefixes].sort();
    const attribution = attributeFbPrefix(prefixes[0]);
    const landingUrls: LandingUrl[] = [...(urlsByHead.get(key) ?? new Map())]
      .map(([url, spend]) => ({
        url,
        mapped: mapped.has(url),
        productLabel: mapped.get(url) ?? null,
        spendUsd: Number(spend.toFixed(2)),
      }))
      .sort((a, b) => b.spendUsd - a.spendUsd);
    newAdHeads.push({
      head: agg.head,
      prefixes,
      firstSeen: agg.firstSeen,
      spendUsd,
      attributedTo: attribution.product,
      absorbed: attribution.bucket !== "unmapped",
      landingUrls,
    });
  }
  newAdHeads.sort((a, b) => b.spendUsd - a.spendUsd || a.head.localeCompare(b.head));

  // Inventory side. Deliberately raw (no launch-row correlation): runLaunchAutoPopulate
  // already owns the Launches tab, so this is here to show the ad side and the
  // stock side of the same launch in one place, not to second-guess it.
  const skuRows = await db
    .select({
      sku: skus.sku,
      productName: skus.productName,
      productLine: skus.productLine,
      firstSeen: sql<string>`${skus.firstSeenAt}::text`,
      unitCost: skus.unitCostUsd,
    })
    .from(skus)
    .where(sql`${skus.active} and ${skus.firstSeenAt} >= ${windowStart}`)
    .orderBy(skus.firstSeenAt, skus.sku);

  const newSkus: NewSku[] = skuRows.map((r) => ({
    sku: r.sku,
    productName: r.productName,
    productLine: r.productLine ?? null,
    firstSeen: r.firstSeen,
    hasCost: r.unitCost !== null,
  }));

  return { asOfDate, windowStart, windowDays, newAdHeads, newSkus };
}

/**
 * One-line digest summary.
 *
 * `ok` means "nothing here needs a human to do anything", NOT "nothing is
 * new" — during an active launch period something is new most days, and a
 * permanently-amber line trains people to ignore it. So a launch whose ad
 * prefix, landing URL and SKU costs are all resolved reports green while
 * still describing itself. Amber is reserved for a concrete gap: an unmapped
 * prefix, a landing URL missing from the product-map sheet, or a SKU with no
 * unit cost.
 */
export function formatLaunchSignals(signals: LaunchSignals): { ok: boolean; detail: string } {
  const { newAdHeads, newSkus, windowDays } = signals;
  if (newAdHeads.length === 0 && newSkus.length === 0) {
    return { ok: true, detail: `no new ad prefixes or SKUs in ${windowDays}d` };
  }

  let needsAction = false;
  const parts: string[] = [];

  for (const h of newAdHeads) {
    const missing = h.landingUrls.filter((u) => !u.mapped);
    let urlNote: string;
    if (h.landingUrls.length === 0) {
      urlNote = "no landing URL in snapshot";
    } else if (missing.length > 0) {
      needsAction = true;
      urlNote = `URL not in product sheet: ${missing.map((u) => u.url).join(", ")}`;
    } else {
      urlNote = `URL mapped to ${h.landingUrls[0].productLabel}`;
    }
    if (!h.absorbed) needsAction = true;
    const absorbNote = h.absorbed ? `counted as ${h.attributedTo}` : "UNMAPPED prefix";
    // Show the full prefixes so the reader can find them in the ad tool.
    const prefixList = h.prefixes.map((p) => `(${p})`).join(" ");
    parts.push(
      `"${h.head}" ${prefixList} since ${h.firstSeen}, $${h.spendUsd.toLocaleString("en-US")}, ${absorbNote}, ${urlNote}`,
    );
  }

  if (newSkus.length > 0) {
    // Group by product name, not SKU. A supplier bundle lands as ~26 size
    // variants of 3 products; listing every SKU buries the ad-side lines
    // under noise that says nothing extra.
    const byFamily = new Map<string, { count: number; noCost: number }>();
    for (const s of newSkus) {
      const f = byFamily.get(s.productName) ?? { count: 0, noCost: 0 };
      f.count += 1;
      if (!s.hasCost) f.noCost += 1;
      byFamily.set(s.productName, f);
    }
    const noCostTotal = newSkus.filter((s) => !s.hasCost).length;
    if (noCostTotal > 0) needsAction = true;
    const families = [...byFamily.entries()]
      .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
      .map(([name, f]) => `${name} (${f.count}${f.noCost > 0 ? `, ${f.noCost} no cost` : ""})`);
    parts.push(
      `${newSkus.length} new SKU${newSkus.length === 1 ? "" : "s"} in ${byFamily.size} famil${byFamily.size === 1 ? "y" : "ies"}: ${families.join(", ")}`,
    );
  }

  return { ok: !needsAction, detail: parts.join(" · ") };
}
