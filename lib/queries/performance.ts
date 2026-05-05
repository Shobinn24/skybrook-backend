import { and, eq, gte, ilike, inArray, lte, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { adSpendDaily, dailySales, skus } from "@/lib/db/schema";

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
} as const;

type ProductKey = keyof typeof PRODUCT_CONFIG;

export type PerformanceRow = {
  key: ProductKey;
  label: string;
  revenueUsd: number;
  spendUsd: number;
  /** ROAS = revenue / spend. Null when spend is 0 (avoid divide-by-zero). */
  roas: number | null;
  spendByTab: Array<{ tab: string; spendUsd: number }>;
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
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function ymdToUtcMs(ymd: string): number {
  const [y, m, d] = ymd.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

function addDays(ymd: string, days: number): string {
  return new Date(ymdToUtcMs(ymd) + days * MS_PER_DAY).toISOString().slice(0, 10);
}

/** Returns per-product revenue + spend totals for the trailing N days
 * ending `today`. `rangeDays === 1` is "yesterday" — the single most
 * recent fully-complete day, which is what Scott's daily report shows.
 */
export async function getPerformanceRollup(opts: {
  today: string; // YYYY-MM-DD anchor (treated as "today, not yet complete")
  rangeDays: number; // 1 (yesterday) | 7 | 14 | 30
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
      const [rev] = await db
        .select({
          total: sql<string>`coalesce(sum(${dailySales.netSalesUsd}), 0)`,
        })
        .from(dailySales)
        .where(
          and(
            inArray(dailySales.sku, matchedSkus),
            gte(dailySales.salesDate, rangeStart),
            lte(dailySales.salesDate, rangeEnd),
          ),
        );
      revenueUsd = Number(rev?.total ?? 0);
    }

    const spendBreakdown = cfg.spendTabs.map((tab) => ({
      tab,
      spendUsd: spendByTab.get(tab) ?? 0,
    }));
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

  return {
    rangeDays: opts.rangeDays,
    rangeStart,
    rangeEnd,
    rows,
    warnEmpty,
  };
}
