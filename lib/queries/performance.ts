import { and, desc, eq, gte, ilike, inArray, lte, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { adSpendDaily, applovinAdSpendDaily, dailySales, fbAdSpendDaily, fbAdUrlMap, fbGeoSpend, rawPulls, skus } from "@/lib/db/schema";
import {
  attributeFbPrefix,
  attributeUrlProduct,
  extractFbPrefix,
  type FbBucket,
} from "@/lib/domain/fb-product-attribution";
import { AD_SPEND_TABS_STALE_EXEMPT_UNTIL_FIRST_DATA } from "@/lib/sources/sheets";
import { toEstDate } from "@/lib/tz";

export type SalesChannel = "shopify_us" | "shopify_intl";

/** Canonical products surfaced on /performance. Each one rolls up:
 *   - Spend across one or more sheet tabs (Facebook + AppLovin etc.)
 *   - Revenue across the SKUs whose productName matches any of the
 *     configured patterns.
 *
 * Source for the product names is Scott's manual daily reports
 * (2026-05-05): Men's, Shapewear, SupHW. The "Super HW AL" tab is
 * AppLovin spend on Super HW; rolling FB + AL into one canonical
 * product matches how Scott reads the numbers.
 */
const PRODUCT_CONFIG = {
  men: {
    label: "Men's",
    spendTabs: ["Men", "Men AL"],
    productNamePatterns: ["Mens%"],
  },
  shapewear: {
    label: "Shapewear",
    spendTabs: ["Shapewear", "Shapewear AL"],
    productNamePatterns: ["Shapewear%"],
  },
  suphw: {
    label: "SupHW",
    spendTabs: ["SuperHW", "Super HW AL"],
    productNamePatterns: ["Super High-Waist%"],
  },
  hrshort: {
    label: "High Rise Short",
    // HRS launched EV INTL 2026-05-22 and began FB spend 2026-06-02. The
    // "HRS" tab in the AD_SPEND sheet (Supermetrics query: FB CS6, metric
    // Amount spent, split by Date, filter Ad name CONTAINS HRS) feeds this
    // card; "HRS" is also registered in AD_SPEND_TABS so the runner
    // ingests it. "HRS AL" (AppLovin) was wired 2026-06-03 so spend imports
    // the day it starts even though AppLovin HRS spend is $0 today; it is
    // exempt from the per-tab stale badge until its first dated row (see
    // AD_SPEND_TABS_STALE_EXEMPT_UNTIL_FIRST_DATA).
    spendTabs: ["HRS", "HRS AL"],
    productNamePatterns: ["High Rise Short%"],
  },
} as const;

type ProductKey = keyof typeof PRODUCT_CONFIG;

/** Upstream error detected in the latest sheets_ad_spend pull for a
 * specific tab. Sourced from rawPulls.payload.sourceErrors which is
 * populated by parseAdSpendTab when Supermetrics returns an inline
 * error string instead of data (license expired, quota exceeded,
 * connector deauthorized). The page uses this to surface a per-tab
 * badge so $0 spend caused by an upstream outage is visually
 * distinguishable from a real $0 spend day. */
export type AdSpendSourceErrorSummary = {
  /** Stable dedup-friendly text — used to render a one-line reason. */
  signature: string;
  /** Approx human reason, derived from signature (license / quota / auth / unknown). */
  reason: "license" | "quota" | "auth" | "unknown";
};

/** Per-tab summary for a tab whose data hasn't refreshed in N+ days.
 * Catches the failure mode where Supermetrics silently fails to write
 * (no error row appears in the tab) — e.g. when the upstream license
 * fails before a query writes anything, the sheet keeps stale data
 * from prior runs and there's nothing for `sourceErrors` to flag.
 * Render an amber badge so a quietly-broken feed surfaces visually
 * the same way a loud-broken one does. */
export type AdSpendStalenessSummary = {
  /** Latest spend_date present in our DB for this tab, or null when
   * the tab has never landed any data. */
  latestDate: string | null;
  /** Days behind yesterday-EST. >= 2 when surfaced (1-day lag is
   * normal cron timing and not flagged). */
  daysBehind: number;
};

export type PerformanceRow = {
  key: ProductKey;
  label: string;
  revenueUsd: number;
  spendUsd: number;
  /** ROAS = revenue / spend. Null when spend is 0 (avoid divide-by-zero). */
  roas: number | null;
  spendByTab: Array<{
    tab: string;
    spendUsd: number;
    /** When set, the LATEST upstream pull returned an error for this
     * tab. Spend value above is from prior successful pulls; future
     * dates won't fill until the upstream issue is fixed. */
    sourceError?: AdSpendSourceErrorSummary;
    /** When set, this tab's data is more than 1 day behind. Distinct
     * from `sourceError` — staleness can happen WITHOUT an explicit
     * error row (silent upstream failure that doesn't even write an
     * error string). Both may be set if the feed both errored AND is
     * stale. */
    staleness?: AdSpendStalenessSummary;
  }>;
};

export type PerformanceResult = {
  rangeDays: number;
  rangeStart: string;
  rangeEnd: string;
  rows: PerformanceRow[];
  /** True when a non-trivial subset of canonical products has zero
   * spend and zero revenue, suggesting either (a) the ad spend sheet
   * hasn't refreshed yet today or (b) the product mapping is wrong.
   * Page can show a hint. */
  warnEmpty: boolean;
  /** Distinct tabs with an upstream error in the latest pull. Drives
   * the red page-level banner. */
  sourceErrors: Array<{ tab: string; signature: string; reason: AdSpendSourceErrorSummary["reason"] }>;
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function ymdToUtcMs(ymd: string): number {
  const [y, m, d] = ymd.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

function addDays(ymd: string, days: number): string {
  return new Date(ymdToUtcMs(ymd) + days * MS_PER_DAY).toISOString().slice(0, 10);
}

/** Pulls the most-recent sheets_ad_spend rawPull and extracts a map of
 * tab → error signature for any upstream-error rows the parser saw. A
 * tab appears here when Supermetrics returned an inline error string
 * (license expired, quota, auth) in place of data on that ingest.
 *
 * Cheap: one indexed lookup + JSON access on a single payload. Called
 * once per /performance render so the page can render per-tab badges
 * + a top-level banner. Returns an empty map when (a) no sourceErrors
 * field exists (pre-monitoring-2026-05-23 pulls), (b) the field is
 * empty, or (c) the table has no rows. */
function classifyReason(signature: string): AdSpendSourceErrorSummary["reason"] {
  const s = signature.toLowerCase();
  if (s.includes("license")) return "license";
  if (s.includes("quota")) return "quota";
  if (s.includes("auth") || s.includes("token") || s.includes("permission")) return "auth";
  return "unknown";
}

export async function getLatestAdSpendSourceErrors(): Promise<
  Map<string, AdSpendSourceErrorSummary>
> {
  const [row] = await db
    .select({ payload: rawPulls.payload })
    .from(rawPulls)
    .where(eq(rawPulls.source, "sheets_ad_spend"))
    .orderBy(desc(rawPulls.pulledAt))
    .limit(1);
  const errs = (row?.payload as { sourceErrors?: Array<{ tab: string; signature: string }> } | null)?.sourceErrors;
  const out = new Map<string, AdSpendSourceErrorSummary>();
  if (!errs?.length) return out;
  // Multiple rows per tab possible (rare — same tab returning two
  // error variants). Last write wins, signature stays deterministic.
  for (const e of errs) {
    out.set(e.tab, { signature: e.signature, reason: classifyReason(e.signature) });
  }
  return out;
}

/** Per-tab max(spend_date) in ad_spend_daily. Used to surface silent
 * staleness — the case where Supermetrics fails to refresh but doesn't
 * write an error row to the sheet either (license dropped mid-batch,
 * connector deauth in such a way the query never executes). In that
 * case `getLatestAdSpendSourceErrors` returns nothing for the tab, but
 * its max(spend_date) keeps drifting back from yesterday — that's the
 * signal this query exposes. One indexed groupBy, no joins. */
export async function getAdSpendMaxDateByTab(): Promise<Map<string, string>> {
  const rows = await db
    .select({
      product: adSpendDaily.product,
      max: sql<string | null>`max(${adSpendDaily.spendDate})`,
    })
    .from(adSpendDaily)
    .groupBy(adSpendDaily.product);
  const out = new Map<string, string>();
  for (const r of rows) {
    if (r.max) out.set(r.product, r.max);
  }
  return out;
}

// Compute how many whole days `maxDate` (YYYY-MM-DD) lags behind
// `threshold` (also YYYY-MM-DD). Positive number = stale; <=0 = fresh.
// `maxDate=null` returns Infinity (never landed, maximally stale).
function daysBehind(maxDate: string | null, threshold: string): number {
  if (!maxDate) return Infinity;
  return Math.round((ymdToUtcMs(threshold) - ymdToUtcMs(maxDate)) / MS_PER_DAY);
}

/** Returns per-product revenue + spend totals for the trailing N days
 * ending `today`. `rangeDays === 1` is "yesterday" — the single most
 * recent fully-complete day, which is what Scott's daily report shows.
 */
export async function getPerformanceRollup(opts: {
  today: string; // YYYY-MM-DD anchor (treated as "today, not yet complete")
  rangeDays: number; // 1 (yesterday) | 7 | 14 | 30
  /** Optional channel filter on the revenue side. Spend is unaffected
   * because ad-spend tabs aren't channel-tagged uniformly (e.g., the
   * "SuperHW" tab is FB INTL by convention; "Super HW AL" is AppLovin
   * across regions). When set, revenue rolls up only the matching
   * Shopify store — used to reconcile against partial reports
   * (e.g., the daily-report agency's "SupHW INTL Daily Report"). */
  channel?: SalesChannel;
}): Promise<PerformanceResult> {
  // Range is [today - rangeDays, today - 1] inclusive. Excludes today
  // itself because the day's sales are still accumulating.
  const rangeEnd = addDays(opts.today, -1);
  const rangeStart = addDays(opts.today, -opts.rangeDays);

  // 1. Spend: sum cost_usd per tab in [rangeStart, rangeEnd].
  const spendRows = await db
    .select({
      product: adSpendDaily.product,
      total: sql<string>`coalesce(sum(${adSpendDaily.costUsd}), 0)`,
    })
    .from(adSpendDaily)
    .where(
      and(
        gte(adSpendDaily.spendDate, rangeStart),
        lte(adSpendDaily.spendDate, rangeEnd),
      ),
    )
    .groupBy(adSpendDaily.product);
  const spendByTab = new Map<string, number>();
  for (const r of spendRows) {
    spendByTab.set(r.product, Number(r.total));
  }

  // 1b. Upstream-error map from the latest sheets_ad_spend pull. When
  // a tab is here, its spend value above reflects ONLY prior successful
  // pulls — future dates won't fill until the upstream issue is fixed.
  // UI surfaces this via per-tab badge + page-level banner so $0 caused
  // by a broken feed is visually distinct from a real $0 spend day.
  const errorByTab = await getLatestAdSpendSourceErrors();

  // 1c. Per-tab max(spend_date) — used to detect SILENT staleness, the
  // case where Supermetrics never wrote an error row to the sheet so
  // errorByTab is empty, but the data hasn't refreshed in days either
  // (e.g., upstream license failed before the query could execute). A
  // tab is "stale" when its max is >= 2 days behind real-world
  // yesterday-EST; 1 day behind is normal cron lag and not flagged.
  //
  // Threshold is REAL-WORLD yesterday (server clock), not the user's
  // selected end-date — staleness is about whether the pipeline is
  // healthy now, not whether the user's historical window has data.
  // (A user looking at 5/15 still wants to know "the feed has been
  // broken for 3 days" so they don't trust today's report either.)
  const maxDateByTab = await getAdSpendMaxDateByTab();
  const realYesterdayEst = toEstDate(new Date(Date.now() - MS_PER_DAY));
  const STALE_DAYS = 2;

  // 2. Revenue: for each canonical product, find matching SKUs by
  // productName pattern, then sum daily_sales.netSalesUsd in the
  // window across all channels.
  const rows: PerformanceRow[] = [];
  for (const key of Object.keys(PRODUCT_CONFIG) as ProductKey[]) {
    const cfg = PRODUCT_CONFIG[key];

    // Resolve SKUs whose productName matches any pattern.
    const skuMatchClauses = cfg.productNamePatterns.map((p) =>
      ilike(skus.productName, p),
    );
    const skuRows = skuMatchClauses.length > 0
      ? await db
          .select({ sku: skus.sku })
          .from(skus)
          .where(or(...skuMatchClauses))
      : [];
    const matchedSkus = skuRows.map((r) => r.sku);

    let revenueUsd = 0;
    if (matchedSkus.length > 0) {
      const baseConditions = [
        inArray(dailySales.sku, matchedSkus),
        gte(dailySales.salesDate, rangeStart),
        lte(dailySales.salesDate, rangeEnd),
      ];
      const conditions = opts.channel
        ? [...baseConditions, eq(dailySales.channel, opts.channel)]
        : baseConditions;
      const [rev] = await db
        .select({
          total: sql<string>`coalesce(sum(${dailySales.netSalesUsd}), 0)`,
        })
        .from(dailySales)
        .where(and(...conditions));
      revenueUsd = Number(rev?.total ?? 0);
    }

    const spendBreakdown = cfg.spendTabs.map((tab) => {
      const spendUsdForTab = spendByTab.get(tab) ?? 0;
      const sourceError = errorByTab.get(tab);
      const latestDate = maxDateByTab.get(tab) ?? null;
      const behind = daysBehind(latestDate, realYesterdayEst);
      // A newly-wired tab with no data yet (null latestDate) is exempt from
      // the stale badge until its first dated row — don't flag HRS AppLovin
      // as stale just because it hasn't spent its first dollar.
      const exemptEmpty =
        latestDate === null &&
        AD_SPEND_TABS_STALE_EXEMPT_UNTIL_FIRST_DATA.has(tab);
      const staleness =
        behind >= STALE_DAYS && !exemptEmpty
          ? { latestDate, daysBehind: behind === Infinity ? -1 : behind }
          : undefined;
      const entry: PerformanceRow["spendByTab"][number] = { tab, spendUsd: spendUsdForTab };
      if (sourceError) entry.sourceError = sourceError;
      if (staleness) entry.staleness = staleness;
      return entry;
    });
    const spendUsd = spendBreakdown.reduce((s, b) => s + b.spendUsd, 0);
    const roas = spendUsd > 0 ? revenueUsd / spendUsd : null;

    rows.push({
      key,
      label: cfg.label,
      revenueUsd,
      spendUsd,
      roas,
      spendByTab: spendBreakdown,
    });
  }

  const productsWithoutData = rows.filter(
    (r) => r.revenueUsd === 0 && r.spendUsd === 0,
  ).length;
  const warnEmpty = productsWithoutData >= rows.length / 2;

  const sourceErrors = Array.from(errorByTab.entries()).map(([tab, sum]) => ({
    tab,
    signature: sum.signature,
    reason: sum.reason,
  }));

  return {
    rangeDays: opts.rangeDays,
    rangeStart,
    rangeEnd,
    rows,
    warnEmpty,
    sourceErrors,
  };
}

/** Returns the most-recent date present in each of the two tables that
 * back /performance. The page uses these to (a) default the end-date
 * picker to a date where both revenue AND spend data exist, and (b)
 * warn the operator when they manually pick an end date past which
 * ad spend hasn't been ingested yet (otherwise the page silently
 * shows $X revenue + $0 spend = infinite ROAS — see Jasper 2026-05-14).
 *
 * Cheap query — two max() scans, no joins.
 */
export type PerformanceDataFreshness = {
  /** Latest day with revenue data across any Shopify channel. */
  revenueMaxDate: string | null;
  /** Latest day with ad-spend data from Supermetrics. */
  adSpendMaxDate: string | null;
};

export async function getPerformanceDataFreshness(): Promise<PerformanceDataFreshness> {
  const [revRow] = await db
    .select({ max: sql<string | null>`max(${dailySales.salesDate})` })
    .from(dailySales);
  const [spRow] = await db
    .select({ max: sql<string | null>`max(${adSpendDaily.spendDate})` })
    .from(adSpendDaily);
  return {
    revenueMaxDate: revRow?.max ?? null,
    adSpendMaxDate: spRow?.max ?? null,
  };
}

// ============================================================================
// All-products rollup (the /performance "All products" toggle)
// ============================================================================
// Unlike the focus view (4 hand-configured products), this rolls up EVERY
// product: revenue grouped by product family (from skus.product_name) using the
// EXACT product revenue column. Spend that isn't a product (HOME / Clearance /
// Unmapped) surfaces as its own buckets; shipping/tax/tips (ancillary) is a
// single separate line so product revenue ties to Shopify's by-product figure.
//
// Spend = combined FB + AppLovin per family. FB is attributed URL-FIRST
// (2026-06-27): the fb_ad_url_map snapshot maps each ad's destination URL ->
// product (Jasper's funnel rules; validated 100% per-ad vs the client's FB
// report), with the ad-name prefix as fallback — applied onto the date-flexible
// daily fb_ad_spend_daily via the (ad_number, ad_prefix) key. The fb_geo_spend
// snapshot adds a per-ad US-vs-non-US fraction (FB only — AppLovin has no geo
// feed). AppLovin comes from its dedicated feed, attributed at ingest. Rows
// expose fbSpendUsd/appLovinSpendUsd + fbUs/fbNonUs for the expand-to-see UI.

/** Map a skus.product_name to a canonical product family. MUST emit the same
 * labels as `attributeFbAd` so the revenue and spend sides join. HF split. */
export function revenueFamilyFromProductName(name: string): string {
  const n = (name ?? "").toLowerCase();
  const hf = /\bhf\b/.test(n);
  if (n.includes("9055")) return hf ? "9055 HF" : "9055";
  // Boyshort lumps regular + HF into one family (2026-06-26): the landing URL
  // offers both as purchase options, so spend/revenue can't be split by name.
  // Mirror the spend-side rule in attributeFbPrefix (Boyshort ignores HF).
  if (n.includes("boyshort")) return "Boyshort";
  if (n.includes("mens")) return "Mens";
  if (n.includes("super high-waist") || n.includes("suphw")) return "Super High-Waist";
  if (n.includes("shapewear")) return hf ? "Shapewear HF" : "Shapewear";
  if (n.startsWith("hw")) return hf ? "HW HF" : "HW";
  if (n.includes("og ") || n.startsWith("og")) return hf ? "OG HF" : "OG";
  if (n.includes("high rise short")) return "High Rise Short";
  if (n.includes("hipster")) return hf ? "Hipster HF" : "Hipster";
  if (n.includes("french")) return hf ? "French HF" : "French";
  if (n.includes("bikini")) return "Bikini";
  if (n.includes("seamless")) return "Seamless";
  if (n.includes("jacquard")) return "Jacquard";
  if (n.includes("cb ")) return "CB";
  return "Other products";
}

// Collapse a stored (already-attributed) family label onto its current
// canonical family. Used for AppLovin spend, whose label is fixed at ingest;
// keeps historical rows consistent with read-time attribution rule changes.
// Currently the only lump is Boyshort HF -> Boyshort (2026-06-26).
function normalizeStoredFamily(label: string): string {
  return label === "Boyshort HF" ? "Boyshort" : label;
}

export type AllProductsRow = {
  product: string;
  /** "product" rows have revenue; brand/clearance/unmapped are spend-only. */
  kind: FbBucket;
  revenueUsd: number;
  /** Combined ad spend = FB + AppLovin. */
  spendUsd: number;
  /** The split behind `spendUsd`, for the expand-to-see-split UI. */
  fbSpendUsd: number;
  appLovinSpendUsd: number;
  /** US vs non-US split of the FB spend only. AppLovin has no geo feed, so its
   * region is unknown and excluded from this split (fbUs + fbNonUs = fbSpend). */
  fbUsSpendUsd: number;
  fbNonUsSpendUsd: number;
  /** revenue / combined spend. */
  roas: number | null;
};

export type AllProductsResult = {
  rangeDays: number;
  rangeStart: string;
  rangeEnd: string;
  /** Product families (revenue desc) first, then spend-only buckets (spend desc). */
  rows: AllProductsRow[];
  /** Shipping + tax + tips total — its own line so product revenue stays exact. */
  ancillaryUsd: number;
  totalProductRevenueUsd: number;
  /** product revenue + ancillary = full Shopify revenue. */
  totalRevenueUsd: number;
  /** Combined FB + AppLovin. */
  totalSpendUsd: number;
  totalFbSpendUsd: number;
  totalAppLovinSpendUsd: number;
  /** US vs non-US split of total FB spend (AppLovin excluded — no geo feed). */
  totalFbUsSpendUsd: number;
  totalFbNonUsSpendUsd: number;
};

const round4 = (n: number): number => Number(n.toFixed(4));

export async function getAllProductsRollup(opts: {
  today: string;
  rangeDays: number;
  channel?: SalesChannel;
}): Promise<AllProductsResult> {
  const rangeEnd = addDays(opts.today, -1);
  const rangeStart = addDays(opts.today, -opts.rangeDays);

  // --- Revenue: exact product revenue + ancillary, grouped by product_name ---
  const revConds = [
    gte(dailySales.salesDate, rangeStart),
    lte(dailySales.salesDate, rangeEnd),
  ];
  if (opts.channel) revConds.push(eq(dailySales.channel, opts.channel));
  const revRows = await db
    .select({
      productName: skus.productName,
      prod: sql<string>`coalesce(sum(${dailySales.productSalesUsd}), 0)`,
      anc: sql<string>`coalesce(sum(${dailySales.ancillaryUsd}), 0)`,
    })
    .from(dailySales)
    .leftJoin(skus, eq(skus.sku, dailySales.sku))
    .where(and(...revConds))
    .groupBy(skus.productName);

  const revByFamily = new Map<string, number>();
  let ancillaryUsd = 0;
  for (const r of revRows) {
    const fam = revenueFamilyFromProductName(r.productName ?? "");
    revByFamily.set(fam, (revByFamily.get(fam) ?? 0) + Number(r.prod));
    ancillaryUsd += Number(r.anc);
  }

  // --- URL-first attribution overlay (from the 30-day snapshot feeds) ---
  // fb_ad_url_map maps each ad's destination URL -> product; fb_geo_spend gives
  // its US-vs-non-US split. Both are keyed by Meta Ad ID, but the daily spend
  // (fb_ad_spend_daily) is keyed by (ad_number, ad_prefix), so we collapse the
  // snapshot to that grain via the ad name. An ad's URL/product is stable, so
  // applying the current snapshot to historical daily spend is correct (matches
  // Jasper's "current funnels" intent). URL names a product -> use it; else
  // fall back to the ad-name prefix (attributeFbPrefix), validated 100% per-ad
  // against the client's FB report (2026-06-27).
  const AD_NUMBER_RE = /\b(?:Ad|DCA)\s+(\d+)\b/;
  const keyOf = (num: string, prefix: string) => `${num}${prefix}`;

  const urlMapRows = await db
    .select({
      adId: fbAdUrlMap.adId,
      adName: fbAdUrlMap.adName,
      destUrl: fbAdUrlMap.destUrl,
      cost: fbAdUrlMap.costUsd,
    })
    .from(fbAdUrlMap);
  // (ad_number, ad_prefix) -> product label -> weighting cost (dominant wins
  // when one key spans >1 ad_id, ~0.16% of spend). Ad ID -> key so geo can roll up.
  const urlProductVotes = new Map<string, Map<string, number>>();
  const adIdToKey = new Map<string, string>();
  for (const r of urlMapRows) {
    const name = r.adName ?? "";
    const m = name.match(AD_NUMBER_RE);
    if (!m) continue;
    const key = keyOf(m[1], extractFbPrefix(name));
    adIdToKey.set(r.adId, key);
    const a = attributeUrlProduct(r.destUrl);
    if (!a) continue; // URL names no product -> no vote; key falls back to ad name
    const votes = urlProductVotes.get(key) ?? new Map<string, number>();
    votes.set(a.product, (votes.get(a.product) ?? 0) + (Number(r.cost) || 0));
    urlProductVotes.set(key, votes);
  }
  const urlProductByKey = new Map<string, string>();
  for (const [key, votes] of urlProductVotes) {
    let best = "";
    let bestCost = -1;
    for (const [prod, c] of votes) {
      if (c > bestCost) {
        best = prod;
        bestCost = c;
      }
    }
    urlProductByKey.set(key, best);
  }

  // Geo -> per-key US fraction (+ a global fallback for daily spend whose ad is
  // not in the URL-map snapshot, e.g. ads outside the 30-day window).
  const geoRows = await db
    .select({ adId: fbGeoSpend.adId, country: fbGeoSpend.countryCode, cost: fbGeoSpend.costUsd })
    .from(fbGeoSpend);
  const usByKey = new Map<string, number>();
  const totByKey = new Map<string, number>();
  let geoUs = 0;
  let geoTot = 0;
  for (const r of geoRows) {
    const c = Number(r.cost) || 0;
    geoTot += c;
    if (r.country === "US") geoUs += c;
    const key = adIdToKey.get(r.adId);
    if (!key) continue;
    totByKey.set(key, (totByKey.get(key) ?? 0) + c);
    if (r.country === "US") usByKey.set(key, (usByKey.get(key) ?? 0) + c);
  }
  const globalUsFraction = geoTot > 0 ? geoUs / geoTot : 0;
  const usFractionForKey = (key: string): number => {
    const tot = totByKey.get(key);
    if (!tot || tot <= 0) return globalUsFraction;
    return (usByKey.get(key) ?? 0) / tot;
  };

  // --- Spend: FB, grouped by (ad_number, ad_prefix) so the variant grain (the
  // HOME-undercount fix) survives, attributed URL-first with ad-name fallback,
  // and split US/non-US by the per-ad geo fraction. ---
  const spendRows = await db
    .select({
      adNumber: fbAdSpendDaily.adNumber,
      adPrefix: fbAdSpendDaily.adPrefix,
      spend: sql<string>`coalesce(sum(${fbAdSpendDaily.costUsd}), 0)`,
    })
    .from(fbAdSpendDaily)
    .where(
      and(
        gte(fbAdSpendDaily.spendDate, rangeStart),
        lte(fbAdSpendDaily.spendDate, rangeEnd),
      ),
    )
    .groupBy(fbAdSpendDaily.adNumber, fbAdSpendDaily.adPrefix);

  const fbSpendByFamily = new Map<string, number>();
  const fbUsByFamily = new Map<string, number>();
  const fbNonUsByFamily = new Map<string, number>();
  for (const r of spendRows) {
    const prefix = r.adPrefix ?? "";
    const key = keyOf(r.adNumber, prefix);
    const product = urlProductByKey.get(key) ?? attributeFbPrefix(prefix).product;
    const spend = Number(r.spend);
    const usFrac = usFractionForKey(key);
    fbSpendByFamily.set(product, (fbSpendByFamily.get(product) ?? 0) + spend);
    fbUsByFamily.set(product, (fbUsByFamily.get(product) ?? 0) + spend * usFrac);
    fbNonUsByFamily.set(product, (fbNonUsByFamily.get(product) ?? 0) + spend * (1 - usFrac));
  }

  // --- Spend: AppLovin, from the dedicated feed (applovin_ad_spend_daily is
  // already attributed to a product family at ingest, so just sum by
  // product). Combined with FB per family below; the UI shows the combined
  // number with an expand-to-see-the-split. ---
  const alRows = await db
    .select({
      product: applovinAdSpendDaily.product,
      spend: sql<string>`coalesce(sum(${applovinAdSpendDaily.costUsd}), 0)`,
    })
    .from(applovinAdSpendDaily)
    .where(
      and(
        gte(applovinAdSpendDaily.spendDate, rangeStart),
        lte(applovinAdSpendDaily.spendDate, rangeEnd),
      ),
    )
    .groupBy(applovinAdSpendDaily.product);
  const appLovinSpendByFamily = new Map<string, number>();
  for (const r of alRows) {
    // AppLovin spend is attributed to a family at INGEST (unlike FB, which is
    // attributed at read time from ad_prefix). Rows ingested before a
    // family-lump rule change keep the old label, so normalize the stored
    // label here to match current attribution (Boyshort HF -> Boyshort).
    const fam = normalizeStoredFamily(r.product);
    appLovinSpendByFamily.set(fam, (appLovinSpendByFamily.get(fam) ?? 0) + Number(r.spend));
  }

  // --- Merge on family label (FB + AppLovin) ---
  const families = new Set<string>([
    ...revByFamily.keys(),
    ...fbSpendByFamily.keys(),
    ...appLovinSpendByFamily.keys(),
  ]);
  const rows: AllProductsRow[] = [];
  for (const fam of families) {
    const revenueUsd = round4(revByFamily.get(fam) ?? 0);
    const fbSpendUsd = round4(fbSpendByFamily.get(fam) ?? 0);
    const appLovinSpendUsd = round4(appLovinSpendByFamily.get(fam) ?? 0);
    const spendUsd = round4(fbSpendUsd + appLovinSpendUsd);
    // A family with revenue is a product; otherwise it's the spend bucket's kind.
    const kind: FbBucket = revByFamily.has(fam)
      ? "product"
      : bucketForFamilyLabel(fam);
    rows.push({
      product: fam,
      kind,
      revenueUsd,
      spendUsd,
      fbSpendUsd,
      appLovinSpendUsd,
      fbUsSpendUsd: round4(fbUsByFamily.get(fam) ?? 0),
      fbNonUsSpendUsd: round4(fbNonUsByFamily.get(fam) ?? 0),
      // ROAS only meaningful for product rows; spend-only buckets
      // (brand/clearance/unmapped) have no attributed revenue by design.
      roas: kind === "product" && spendUsd > 0 ? revenueUsd / spendUsd : null,
    });
  }
  // Products (revenue desc) first, then spend-only buckets (spend desc).
  rows.sort((a, b) => {
    const aProd = a.kind === "product";
    const bProd = b.kind === "product";
    if (aProd !== bProd) return aProd ? -1 : 1;
    return aProd ? b.revenueUsd - a.revenueUsd : b.spendUsd - a.spendUsd;
  });

  const totalProductRevenueUsd = round4(
    [...revByFamily.values()].reduce((s, v) => s + v, 0),
  );
  ancillaryUsd = round4(ancillaryUsd);
  const totalFbSpendUsd = round4(
    [...fbSpendByFamily.values()].reduce((s, v) => s + v, 0),
  );
  const totalAppLovinSpendUsd = round4(
    [...appLovinSpendByFamily.values()].reduce((s, v) => s + v, 0),
  );
  const totalSpendUsd = round4(totalFbSpendUsd + totalAppLovinSpendUsd);
  const totalFbUsSpendUsd = round4(
    [...fbUsByFamily.values()].reduce((s, v) => s + v, 0),
  );
  const totalFbNonUsSpendUsd = round4(
    [...fbNonUsByFamily.values()].reduce((s, v) => s + v, 0),
  );

  return {
    rangeDays: opts.rangeDays,
    rangeStart,
    rangeEnd,
    rows,
    ancillaryUsd,
    totalProductRevenueUsd,
    totalRevenueUsd: round4(totalProductRevenueUsd + ancillaryUsd),
    totalSpendUsd,
    totalFbSpendUsd,
    totalAppLovinSpendUsd,
    totalFbUsSpendUsd,
    totalFbNonUsSpendUsd,
  };
}

// A spend-only family's bucket, derived from its canonical label. (Product
// families come from revenue presence; these are the non-product buckets
// that can appear in spend with no revenue.)
function bucketForFamilyLabel(fam: string): FbBucket {
  if (fam === "Brand / Homepage") return "brand";
  if (fam === "Clearance / Mixed") return "clearance";
  if (fam === "Unmapped") return "unmapped";
  return "product";
}
