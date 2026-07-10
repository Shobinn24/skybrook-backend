import { and, eq, gte, ilike, lte, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { applovinAdSpendDaily, dailySales, fbAdSpendDaily, fbAdUrlMap, fbGeoSpend, fbProductMap, skus } from "@/lib/db/schema";
import {
  attributeFbPrefix,
  extractFbPrefix,
  normalizeFunnelUrl,
  type FbBucket,
} from "@/lib/domain/fb-product-attribution";
import { toEstDate } from "@/lib/tz";

export type SalesChannel = "shopify_us" | "shopify_intl";

/** Canonical focus products surfaced on the /performance "Focus areas"
 * cards. Each card is a VIEW of one product line from the shared
 * per-line computation (`computeProductLineStats`) — the same row the
 * All-products table shows, so revenue / spend / ROAS are identical in
 * both views BY CONSTRUCTION (owner direction 2026-07).
 *
 * `line` is the canonical family label emitted by
 * `revenueFamilyFromProductName` / `attributeFbPrefix`. */
const PRODUCT_CONFIG = {
  men: { label: "Men's", line: "Mens" },
  shapewear: { label: "Shapewear", line: "Shapewear" },
  suphw: { label: "SupHW", line: "Super High-Waist" },
  hrshort: { label: "High Rise Short", line: "High Rise Short" },
  // Intl launch 2026-07-10 (owner request): Cotton 9055 = ev-cottonhip
  // "Cotton Hipster" revenue + "(Cotton ...)" FB ads; Men's Brief =
  // ev-flybrief "Mens Brief with Fly" revenue + "(Men Brief ...)" FB ads.
  cotton9055: { label: "Cotton 9055", line: "Cotton 9055" },
  mensbrief: { label: "Men's Brief", line: "Mens Brief" },
} as const;

type ProductKey = keyof typeof PRODUCT_CONFIG;

/** Per-source summary for a spend feed whose data hasn't refreshed in
 * N+ days. Catches the silent-failure mode where the upstream sheet
 * stops refreshing without any loud error: max(spend_date) keeps
 * drifting back from yesterday. Rendered as an amber badge on the
 * focus-card FB / AppLovin breakdown lines. */
export type AdSpendStalenessSummary = {
  /** Latest spend_date present in our DB for this source, or null when
   * the source has never landed any data. */
  latestDate: string | null;
  /** Days behind yesterday-EST. >= 2 when surfaced (1-day lag is
   * normal cron timing and not flagged). -1 = never landed any data. */
  daysBehind: number;
};

/** The two spend feeds behind every product line: the FB ads sheet
 * (fb_ad_spend_daily, URL-first attribution) and the AppLovin sheet
 * (applovin_ad_spend_daily, attributed at ingest). */
export type SpendSource = "FB" | "AL";

export type PerformanceRow = {
  key: ProductKey;
  label: string;
  /** Net revenue = product revenue + the line's pro-rated shipping/tax
   * share (sum of daily_sales.net_sales_usd over the line's SKUs). */
  revenueUsd: number;
  spendUsd: number;
  /** ROAS = revenue / spend. Null when spend is 0 (avoid divide-by-zero). */
  roas: number | null;
  /** Per-platform split of `spendUsd` (FB URL-first + AppLovin), with
   * per-source staleness so a quietly-frozen feed surfaces visually. */
  spendBySource: Array<{
    source: SpendSource;
    spendUsd: number;
    /** When set, this source's data is more than 1 day behind — the
     * spend above reflects only what has landed so far. */
    staleness?: AdSpendStalenessSummary;
  }>;
};

export type PerformanceResult = {
  rangeDays: number;
  rangeStart: string;
  rangeEnd: string;
  rows: PerformanceRow[];
  /** True when a non-trivial subset of canonical products has zero
   * spend and zero revenue, suggesting either (a) the spend feeds
   * haven't refreshed yet today or (b) the product mapping is wrong.
   * Page can show a hint. */
  warnEmpty: boolean;
  /** Owner request 2026-07-03: spend-only box for ads with "infotainment"
   * in the name. FB only (AppLovin carries no ad names). No revenue can be
   * attributed to these ads, so the box exposes spend without revenue/ROAS. */
  infotainment: { spendUsd: number };
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function ymdToUtcMs(ymd: string): number {
  const [y, m, d] = ymd.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

function addDays(ymd: string, days: number): string {
  return new Date(ymdToUtcMs(ymd) + days * MS_PER_DAY).toISOString().slice(0, 10);
}

// Compute how many whole days `maxDate` (YYYY-MM-DD) lags behind
// `threshold` (also YYYY-MM-DD). Positive number = stale; <=0 = fresh.
// `maxDate=null` returns Infinity (never landed, maximally stale).
function daysBehind(maxDate: string | null, threshold: string): number {
  if (!maxDate) return Infinity;
  return Math.round((ymdToUtcMs(threshold) - ymdToUtcMs(maxDate)) / MS_PER_DAY);
}

/** Per-source max(spend_date) for the two spend feeds behind every
 * product line. Used to surface SILENT staleness — the case where a
 * sheet stops refreshing without any loud error: the max keeps
 * drifting back from yesterday. Two indexed max() scans, no joins. */
async function getSpendSourceMaxDates(): Promise<Record<SpendSource, string | null>> {
  const [fbRow] = await db
    .select({ max: sql<string | null>`max(${fbAdSpendDaily.spendDate})` })
    .from(fbAdSpendDaily);
  const [alRow] = await db
    .select({ max: sql<string | null>`max(${applovinAdSpendDaily.spendDate})` })
    .from(applovinAdSpendDaily);
  return { FB: fbRow?.max ?? null, AL: alRow?.max ?? null };
}

/** Returns per-focus-product revenue + spend totals for the trailing N
 * days ending `today`. `rangeDays === 1` is "yesterday" — the single
 * most recent fully-complete day, which is what Scott's daily report
 * shows.
 *
 * Each row is a VIEW of the shared per-line computation
 * (`computeProductLineStats`) — the exact numbers the All-products
 * table shows for the same line. Revenue is net (product + pro-rated
 * shipping/tax); spend is URL-first FB attribution + AppLovin. The
 * Supermetrics name-tabs (ad_spend_daily) are NOT read here anymore.
 */
export async function getPerformanceRollup(opts: {
  today: string; // YYYY-MM-DD anchor (treated as "today, not yet complete")
  rangeDays: number; // 1 (yesterday) | 7 | 14 | 30
  /** Optional channel filter on the revenue side. Spend is unaffected
   * (ad spend isn't channel-tagged; the US/INTL split is a separate
   * dimension). When set, revenue rolls up only the matching Shopify
   * store — used to reconcile against partial reports (e.g., the
   * daily-report agency's "SupHW INTL Daily Report"). */
  channel?: SalesChannel;
}): Promise<PerformanceResult> {
  const { rangeStart, rangeEnd, lines } = await computeProductLineStats(opts);
  const statsByLine = new Map(lines.map((l) => [l.line, l]));

  // Per-source staleness: a source is "stale" when its max(spend_date)
  // is >= 2 days behind real-world yesterday-EST; 1 day behind is
  // normal cron lag and not flagged.
  //
  // Threshold is REAL-WORLD yesterday (server clock), not the user's
  // selected end-date — staleness is about whether the pipeline is
  // healthy now, not whether the user's historical window has data.
  // (A user looking at 5/15 still wants to know "the feed has been
  // broken for 3 days" so they don't trust today's report either.)
  const maxBySource = await getSpendSourceMaxDates();
  const realYesterdayEst = toEstDate(new Date(Date.now() - MS_PER_DAY));
  const STALE_DAYS = 2;
  const stalenessFor = (source: SpendSource): AdSpendStalenessSummary | undefined => {
    const latestDate = maxBySource[source];
    const behind = daysBehind(latestDate, realYesterdayEst);
    return behind >= STALE_DAYS
      ? { latestDate, daysBehind: behind === Infinity ? -1 : behind }
      : undefined;
  };
  const staleness: Record<SpendSource, AdSpendStalenessSummary | undefined> = {
    FB: stalenessFor("FB"),
    AL: stalenessFor("AL"),
  };

  const rows: PerformanceRow[] = (Object.keys(PRODUCT_CONFIG) as ProductKey[]).map(
    (key) => {
      const cfg = PRODUCT_CONFIG[key];
      const stats = statsByLine.get(cfg.line);
      const spendBySource = (["FB", "AL"] as const).map((source) => {
        const entry: PerformanceRow["spendBySource"][number] = {
          source,
          spendUsd: source === "FB" ? stats?.fbSpendUsd ?? 0 : stats?.alSpendUsd ?? 0,
        };
        if (staleness[source]) entry.staleness = staleness[source];
        return entry;
      });
      return {
        key,
        label: cfg.label,
        revenueUsd: stats?.revenueNetUsd ?? 0,
        spendUsd: stats?.spendUsd ?? 0,
        roas: stats?.roas ?? null,
        spendBySource,
      };
    },
  );

  const productsWithoutData = rows.filter(
    (r) => r.revenueUsd === 0 && r.spendUsd === 0,
  ).length;
  const warnEmpty = productsWithoutData >= rows.length / 2;

  // Infotainment spend-only box (owner request 2026-07-03): sum every FB ad
  // with "infotainment" anywhere in its raw name over the same window. FB
  // only — AppLovin rows carry no ad names, so nothing to match there.
  const [info] = await db
    .select({ total: sql<string>`coalesce(sum(${fbAdSpendDaily.costUsd}), 0)` })
    .from(fbAdSpendDaily)
    .where(
      and(
        ilike(fbAdSpendDaily.adNameRaw, "%infotainment%"),
        gte(fbAdSpendDaily.spendDate, rangeStart),
        lte(fbAdSpendDaily.spendDate, rangeEnd),
      ),
    );

  return {
    rangeDays: opts.rangeDays,
    rangeStart,
    rangeEnd,
    rows,
    warnEmpty,
    infotainment: { spendUsd: Number(info?.total ?? 0) },
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
  /** Latest day with FB ad-spend data (fb_ad_spend_daily — the primary
   * spend feed behind both /performance views since the unified-math
   * change; the Supermetrics name-tabs are no longer read). AppLovin is
   * deliberately excluded from the picker default: it's the secondary
   * feed and a quiet AL day shouldn't drag the whole page back — its
   * staleness surfaces on the per-card breakdown instead. */
  adSpendMaxDate: string | null;
};

export async function getPerformanceDataFreshness(): Promise<PerformanceDataFreshness> {
  const [revRow] = await db
    .select({ max: sql<string | null>`max(${dailySales.salesDate})` })
    .from(dailySales);
  const [spRow] = await db
    .select({ max: sql<string | null>`max(${fbAdSpendDaily.spendDate})` })
    .from(fbAdSpendDaily);
  return {
    revenueMaxDate: revRow?.max ?? null,
    adSpendMaxDate: spRow?.max ?? null,
  };
}

// ============================================================================
// Shared per-product-line computation (feeds BOTH /performance views)
// ============================================================================
// One computation, two views: `computeProductLineStats` rolls up EVERY product
// line's revenue + spend; the All-products table shows all lines (+ non-product
// spend buckets) and the Focus cards are a filter down to their 4 lines. The
// two views can't drift because neither runs its own revenue/spend SQL.
//
// Revenue per line is NET: product revenue + the line's pro-rated shipping/
// tax/tips share. daily_sales rows already carry a per-SKU ancillary_usd
// pro-rated at ingest, so per-line net = sum(net_sales_usd) over the line's
// SKUs — exact, no read-time pro-ration, and the page grand total equals the
// old "products + one ancillary bucket" total.
//
// Spend = combined FB + AppLovin per family. FB is attributed URL-FIRST
// (2026-06-27): the fb_ad_url_map snapshot maps each ad's destination URL ->
// product (Jasper's funnel rules; validated 100% per-ad vs the client's FB
// report), with the ad-name prefix as fallback — applied onto the date-flexible
// daily fb_ad_spend_daily via the (ad_number, ad_prefix) key. The fb_geo_spend
// snapshot adds a per-ad US-vs-non-US fraction for FB; AppLovin contributes its
// own country column (2026-06-27), so the US/non-US split now covers all ad
// spend. AppLovin comes from its dedicated feed, attributed at ingest. Rows
// expose fbSpendUsd/appLovinSpendUsd (platform) + usSpendUsd/nonUsSpendUsd
// (region) for the expand-to-see UI.

/** Map a skus.product_name to a canonical product family. MUST emit the same
 * labels as `attributeFbAd` so the revenue and spend sides join. HF split. */
export function revenueFamilyFromProductName(name: string): string {
  const n = (name ?? "").toLowerCase();
  const hf = /\bhf\b/.test(n);
  // Intl launch 2026-07-10: the cotton lines are their own families and must
  // be carved out BEFORE the generic 9055/hipster/hw matches below. "Cotton
  // Hipster" (ev-cottonhip) IS the Cotton 9055 line — that's the owner's name
  // for it, mirrored on the spend side by the "(Cotton ...)" ad prefix.
  if (n.includes("cotton")) {
    if (n.includes("9055") || n.includes("hipster") || n.includes("comfort")) return "Cotton 9055";
    if (n.includes("high waisted") || /\bhw\b/.test(n)) return "Cotton HW";
  }
  // Men's Brief with Fly (ev-flybrief) is its own line — carved out before
  // the generic "mens" match so it doesn't lump into Mens. Boxer w/ Fly
  // (ev-flyboxer, no "brief" in its name) is not affected.
  if (n.includes("brief")) return "Mens Brief";
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

/** One product line (or non-product spend bucket) from the shared
 * computation. Focus cards and All-products rows are both views of
 * exactly these numbers. */
export type ProductLineStats = {
  /** Canonical family label, e.g. "Mens", "Super High-Waist". */
  line: string;
  /** "product" lines have revenue; brand/clearance/unmapped are spend-only. */
  kind: FbBucket;
  /** Net revenue = product revenue + the line's pro-rated shipping/tax
   * share (sum of daily_sales.net_sales_usd over the line's SKUs). */
  revenueNetUsd: number;
  /** URL-first attributed Facebook spend. */
  fbSpendUsd: number;
  /** AppLovin spend (attributed at ingest). */
  alSpendUsd: number;
  /** fb + al. */
  spendUsd: number;
  /** US vs non-US split of total ad spend (FB geo fraction + AppLovin country).
   * us + nonUs = spendUsd. */
  usSpendUsd: number;
  nonUsSpendUsd: number;
  /** revenueNetUsd / spendUsd; null when spend is 0 (product lines only). */
  roas: number | null;
};

export type AllProductsRow = {
  product: string;
  /** "product" rows have revenue; brand/clearance/unmapped are spend-only. */
  kind: FbBucket;
  /** Net revenue (product + pro-rated shipping/tax share). */
  revenueUsd: number;
  /** Combined ad spend = FB + AppLovin. */
  spendUsd: number;
  /** The split behind `spendUsd`, for the expand-to-see-split UI. */
  fbSpendUsd: number;
  appLovinSpendUsd: number;
  /** US vs non-US split of total ad spend (FB geo fraction + AppLovin country).
   * us + nonUs = spendUsd. */
  usSpendUsd: number;
  nonUsSpendUsd: number;
  /** revenue / combined spend. */
  roas: number | null;
};

export type AllProductsResult = {
  rangeDays: number;
  rangeStart: string;
  rangeEnd: string;
  /** Product families (revenue desc) first, then spend-only buckets (spend desc). */
  rows: AllProductsRow[];
  /** Sum of per-line net revenue = full Shopify revenue (products +
   * their pro-rated shipping/tax shares — no separate ancillary line). */
  totalRevenueUsd: number;
  /** Combined FB + AppLovin. */
  totalSpendUsd: number;
  totalFbSpendUsd: number;
  totalAppLovinSpendUsd: number;
  /** US vs non-US split of total ad spend (FB + AppLovin). us + nonUs = totalSpend. */
  totalUsSpendUsd: number;
  totalNonUsSpendUsd: number;
};

const round4 = (n: number): number => Number(n.toFixed(4));

/** THE shared computation. Returns every product line's net revenue +
 * attributed spend (plus the non-product spend buckets) for the
 * trailing `rangeDays` ending the day before `today`. Both
 * `getPerformanceRollup` (Focus areas) and `getAllProductsRollup`
 * (All products) consume this — neither runs its own revenue/spend
 * SQL, so the two /performance views agree by construction. */
export async function computeProductLineStats(opts: {
  today: string;
  rangeDays: number;
  /** Optional channel filter on the REVENUE side only (ad spend isn't
   * channel-tagged; US/INTL is a separate spend dimension). */
  channel?: SalesChannel;
}): Promise<{ rangeStart: string; rangeEnd: string; lines: ProductLineStats[] }> {
  const rangeEnd = addDays(opts.today, -1);
  const rangeStart = addDays(opts.today, -opts.rangeDays);

  // --- Revenue: NET per product_name (product + pro-rated ancillary,
  // already summed per-row at ingest into net_sales_usd) ---
  const revConds = [
    gte(dailySales.salesDate, rangeStart),
    lte(dailySales.salesDate, rangeEnd),
  ];
  if (opts.channel) revConds.push(eq(dailySales.channel, opts.channel));
  const revRows = await db
    .select({
      productName: skus.productName,
      net: sql<string>`coalesce(sum(${dailySales.netSalesUsd}), 0)`,
    })
    .from(dailySales)
    .leftJoin(skus, eq(skus.sku, dailySales.sku))
    .where(and(...revConds))
    .groupBy(skus.productName);

  const revByFamily = new Map<string, number>();
  for (const r of revRows) {
    const fam = revenueFamilyFromProductName(r.productName ?? "");
    revByFamily.set(fam, (revByFamily.get(fam) ?? 0) + Number(r.net));
  }

  // --- Product + region overlay from the Jasper-maintained fb_product_map sheet.
  // fb_ad_url_map gives each ad's coalesced dest_url; we normalize it and look it
  // up in the sheet for BOTH product family and funnel region (US = everdries.com,
  // INTL = shop.everdries.com). The daily spend (fb_ad_spend_daily) is keyed by
  // (ad_number, ad_prefix), so we collapse the snapshot to that grain via the ad
  // name with a cost-weighted dominant vote. An ad's URL/product is stable, so
  // applying the current sheet to historical daily spend is correct (Jasper's
  // "current funnels" intent). A URL not in the sheet casts no vote -> the key
  // falls back to the ad-name prefix (product) + geo fraction (region), and is
  // surfaced by the fb-url-coverage check so Jasper knows to add it.
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
  // Jasper-maintained product/region map, keyed by normalized landing URL.
  const mapByUrl = new Map<string, { region: string; label: string }>();
  {
    const productMapRows = await db
      .select({
        url: fbProductMap.normalizedUrl,
        region: fbProductMap.region,
        label: fbProductMap.productLabel,
      })
      .from(fbProductMap);
    for (const r of productMapRows) mapByUrl.set(r.url, { region: r.region, label: r.label });
  }
  // (ad_number, ad_prefix) -> cost-weighted votes for product label and region.
  // adId -> key so geo can roll up to the same grain for the unmapped fallback.
  const productVotes = new Map<string, Map<string, number>>();
  const regionVotes = new Map<string, Map<string, number>>();
  const adIdToKey = new Map<string, string>();
  for (const r of urlMapRows) {
    const name = r.adName ?? "";
    const m = name.match(AD_NUMBER_RE);
    if (!m) continue;
    const key = keyOf(m[1], extractFbPrefix(name));
    adIdToKey.set(r.adId, key);
    const hit = mapByUrl.get(normalizeFunnelUrl(r.destUrl) ?? "");
    if (!hit) continue; // URL not in sheet -> no vote; key falls back to ad name + geo
    const cost = Number(r.cost) || 0;
    const pv = productVotes.get(key) ?? new Map<string, number>();
    pv.set(hit.label, (pv.get(hit.label) ?? 0) + cost);
    productVotes.set(key, pv);
    const rv = regionVotes.get(key) ?? new Map<string, number>();
    rv.set(hit.region, (rv.get(hit.region) ?? 0) + cost);
    regionVotes.set(key, rv);
  }
  const dominant = (votes: Map<string, number> | undefined): string | undefined => {
    if (!votes) return undefined;
    let best: string | undefined;
    let bestCost = -1;
    for (const [k, c] of votes) {
      if (c > bestCost) {
        best = k;
        bestCost = c;
      }
    }
    return best;
  };
  const urlProductByKey = new Map<string, string>();
  for (const [key, votes] of productVotes) urlProductByKey.set(key, dominant(votes)!);
  const regionByKey = new Map<string, string>();
  for (const [key, votes] of regionVotes) regionByKey.set(key, dominant(votes)!);

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
  // HOME-undercount fix) survives, attributed by the product map (URL) with
  // ad-name fallback, and split US/INTL by the sheet's funnel region (geo
  // fraction only as the fallback for URL-unmapped keys). ---
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

  // US/non-US split spans BOTH FB (here, via the geo fraction) and AppLovin
  // (below, from its own country column) — usByFamily/nonUsByFamily accumulate
  // both so the row's split covers all ad spend, not just FB.
  const fbSpendByFamily = new Map<string, number>();
  const usByFamily = new Map<string, number>();
  const nonUsByFamily = new Map<string, number>();
  for (const r of spendRows) {
    const prefix = r.adPrefix ?? "";
    const key = keyOf(r.adNumber, prefix);
    const product = urlProductByKey.get(key) ?? attributeFbPrefix(prefix).product;
    const spend = Number(r.spend);
    // Region: the sheet's funnel region wins (binary per ad); a URL-unmapped key
    // falls back to the geo audience-country fraction.
    const mappedRegion = regionByKey.get(key);
    const usFrac =
      mappedRegion === "US" ? 1 : mappedRegion === "INTL" ? 0 : usFractionForKey(key);
    fbSpendByFamily.set(product, (fbSpendByFamily.get(product) ?? 0) + spend);
    usByFamily.set(product, (usByFamily.get(product) ?? 0) + spend * usFrac);
    nonUsByFamily.set(product, (nonUsByFamily.get(product) ?? 0) + spend * (1 - usFrac));
  }

  // --- Spend: AppLovin, from the dedicated feed (already attributed to a
  // product family at ingest). Grouped by (product, country) so it folds into
  // both the combined per-family total AND the US/non-US split. The UI shows
  // the combined number with an expand-to-see-the-split. ---
  const alRows = await db
    .select({
      product: applovinAdSpendDaily.product,
      country: applovinAdSpendDaily.countryCode,
      spend: sql<string>`coalesce(sum(${applovinAdSpendDaily.costUsd}), 0)`,
    })
    .from(applovinAdSpendDaily)
    .where(
      and(
        gte(applovinAdSpendDaily.spendDate, rangeStart),
        lte(applovinAdSpendDaily.spendDate, rangeEnd),
      ),
    )
    .groupBy(applovinAdSpendDaily.product, applovinAdSpendDaily.countryCode);
  const appLovinSpendByFamily = new Map<string, number>();
  for (const r of alRows) {
    // AppLovin spend is attributed to a family at INGEST (unlike FB, which is
    // attributed at read time from ad_prefix). Rows ingested before a
    // family-lump rule change keep the old label, so normalize the stored
    // label here to match current attribution (Boyshort HF -> Boyshort).
    const fam = normalizeStoredFamily(r.product);
    const spend = Number(r.spend);
    appLovinSpendByFamily.set(fam, (appLovinSpendByFamily.get(fam) ?? 0) + spend);
    // country "" (legacy rows pulled before the Country column) counts as
    // non-US; self-heals as the live window re-ingests with real countries.
    if (r.country === "US") usByFamily.set(fam, (usByFamily.get(fam) ?? 0) + spend);
    else nonUsByFamily.set(fam, (nonUsByFamily.get(fam) ?? 0) + spend);
  }

  // --- Merge on family label (FB + AppLovin) ---
  const families = new Set<string>([
    ...revByFamily.keys(),
    ...fbSpendByFamily.keys(),
    ...appLovinSpendByFamily.keys(),
  ]);
  const lines: ProductLineStats[] = [];
  for (const fam of families) {
    const revenueNetUsd = round4(revByFamily.get(fam) ?? 0);
    const fbSpendUsd = round4(fbSpendByFamily.get(fam) ?? 0);
    const alSpendUsd = round4(appLovinSpendByFamily.get(fam) ?? 0);
    const spendUsd = round4(fbSpendUsd + alSpendUsd);
    // A family with revenue is a product; otherwise it's the spend bucket's kind.
    const kind: FbBucket = revByFamily.has(fam)
      ? "product"
      : bucketForFamilyLabel(fam);
    lines.push({
      line: fam,
      kind,
      revenueNetUsd,
      spendUsd,
      fbSpendUsd,
      alSpendUsd,
      usSpendUsd: round4(usByFamily.get(fam) ?? 0),
      nonUsSpendUsd: round4(nonUsByFamily.get(fam) ?? 0),
      // ROAS only meaningful for product lines; spend-only buckets
      // (brand/clearance/unmapped) have no attributed revenue by design.
      roas: kind === "product" && spendUsd > 0 ? revenueNetUsd / spendUsd : null,
    });
  }

  return { rangeStart, rangeEnd, lines };
}

export async function getAllProductsRollup(opts: {
  today: string;
  rangeDays: number;
  channel?: SalesChannel;
}): Promise<AllProductsResult> {
  const { rangeStart, rangeEnd, lines } = await computeProductLineStats(opts);

  const rows: AllProductsRow[] = lines.map((l) => ({
    product: l.line,
    kind: l.kind,
    revenueUsd: l.revenueNetUsd,
    spendUsd: l.spendUsd,
    fbSpendUsd: l.fbSpendUsd,
    appLovinSpendUsd: l.alSpendUsd,
    usSpendUsd: l.usSpendUsd,
    nonUsSpendUsd: l.nonUsSpendUsd,
    roas: l.roas,
  }));
  // Products (revenue desc) first, then spend-only buckets (spend desc).
  rows.sort((a, b) => {
    const aProd = a.kind === "product";
    const bProd = b.kind === "product";
    if (aProd !== bProd) return aProd ? -1 : 1;
    return aProd ? b.revenueUsd - a.revenueUsd : b.spendUsd - a.spendUsd;
  });

  const totalRevenueUsd = round4(rows.reduce((s, r) => s + r.revenueUsd, 0));
  const totalFbSpendUsd = round4(rows.reduce((s, r) => s + r.fbSpendUsd, 0));
  const totalAppLovinSpendUsd = round4(
    rows.reduce((s, r) => s + r.appLovinSpendUsd, 0),
  );
  const totalSpendUsd = round4(totalFbSpendUsd + totalAppLovinSpendUsd);
  const totalUsSpendUsd = round4(rows.reduce((s, r) => s + r.usSpendUsd, 0));
  const totalNonUsSpendUsd = round4(
    rows.reduce((s, r) => s + r.nonUsSpendUsd, 0),
  );

  return {
    rangeDays: opts.rangeDays,
    rangeStart,
    rangeEnd,
    rows,
    totalRevenueUsd,
    totalSpendUsd,
    totalFbSpendUsd,
    totalAppLovinSpendUsd,
    totalUsSpendUsd,
    totalNonUsSpendUsd,
  };
}

// A spend-only family's bucket, derived from its canonical label. (Product
// families come from revenue presence; these are the non-product buckets
// that can appear in spend with no revenue.)
function bucketForFamilyLabel(fam: string): FbBucket {
  if (fam === "Brand / Homepage") return "brand";
  if (fam === "Clearance / Mixed") return "clearance";
  if (fam === "Unmapped" || fam === "Other (NA)") return "unmapped";
  return "product";
}
