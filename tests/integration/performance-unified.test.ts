import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import {
  adSpendDaily,
  applovinAdSpendDaily,
  dailySales,
  fbAdSpendDaily,
  fbAdUrlMap,
  fbProductMap,
  rawPulls,
  skus,
} from "@/lib/db/schema";
import { getAllProductsRollup, getPerformanceRollup } from "@/lib/queries/performance";
import { toEstDate } from "@/lib/tz";
import { resetDb } from "@/tests/fixtures/seed";

// Unified performance math (owner direction 2026-07): the Focus areas cards
// and the All-products table must show IDENTICAL revenue / spend / ROAS for
// the same product line, BY CONSTRUCTION — both views consume one shared
// per-line computation. Revenue = net (product + the line's pro-rated
// shipping/tax share, i.e. sum of daily_sales.net_sales_usd). Spend =
// URL-first FB attribution + AppLovin (the All-products method); the
// Supermetrics name-tabs (ad_spend_daily) no longer feed Focus spend.

const D = "2026-06-10"; // inside the 30d window ending 2026-06-24
const TODAY = "2026-06-25";

async function seedPull(): Promise<string> {
  const [row] = await db
    .insert(rawPulls)
    .values({
      source: "shopify_us",
      pullBatchId: randomUUID(),
      payload: {},
      rowCount: 0,
      schemaFingerprint: "test-fp",
    })
    .returning({ id: rawPulls.id });
  return row.id;
}

/** Seed two full product lines (Mens, Shapewear) with revenue carrying a
 * pro-rated ancillary share, URL-mapped FB spend, and AppLovin spend. */
async function seedTwoLines(pull: string) {
  await db.insert(skus).values([
    { sku: "ev-mens-3x-m", productName: "Mens 3-Pack", productLine: "Sec", firstSeenAt: D, active: true },
    { sku: "ev-sw-5x-m", productName: "Shapewear", productLine: "Sec", firstSeenAt: D, active: true },
  ]);
  await db.insert(dailySales).values([
    // Mens: product $1000 + ancillary $120 = net $1120
    { channel: "shopify_us", routedLocation: "US", sku: "ev-mens-3x-m", salesDate: D, unitsSold: 10, netSalesUsd: "1120", productSalesUsd: "1000", ancillaryUsd: "120", sourcePullId: pull },
    // Shapewear: product $500 + ancillary $60 = net $560
    { channel: "shopify_us", routedLocation: "US", sku: "ev-sw-5x-m", salesDate: D, unitsSold: 5, netSalesUsd: "560", productSalesUsd: "500", ancillaryUsd: "60", sourcePullId: pull },
  ]);
  // FB spend: one URL-mapped Mens ad, one Shapewear ad via ad-name fallback.
  await db.insert(fbAdSpendDaily).values([
    { adNumber: "1", adName: "m", adNameRaw: "(Mens CC) Ad 1 - m", adPrefix: "Mens CC", adLink: null, marketers: [], spendDate: D, costUsd: "400", sourcePullId: pull },
    { adNumber: "2", adName: "s", adNameRaw: "(Shape CC) Ad 2 - s", adPrefix: "Shape CC", adLink: null, marketers: [], spendDate: D, costUsd: "200", sourcePullId: pull },
  ]);
  await db.insert(fbAdUrlMap).values([
    { adId: "a1", adName: "(Mens CC) Ad 1 - m", destUrl: "https://everdries.com/mens", costUsd: "400", sourcePullId: pull },
  ]);
  await db.insert(fbProductMap).values([
    { normalizedUrl: "everdries.com/mens", rawUrl: "https://everdries.com/mens", region: "US", productLabel: "Mens", sourcePullId: pull },
  ]);
  // AppLovin per line.
  await db.insert(applovinAdSpendDaily).values([
    { product: "Mens", countryCode: "US", spendDate: D, costUsd: "150", sourcePullId: pull },
    { product: "Shapewear", countryCode: "GB", spendDate: D, costUsd: "50", sourcePullId: pull },
  ]);
}

describe("unified performance math — Focus areas === All products", () => {
  beforeAll(() => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set in test env");
  });
  beforeEach(async () => {
    await resetDb();
  });

  it("Focus card revenue/spend/roas EXACTLY equal the All-products line (Mens, Shapewear)", async () => {
    const pull = await seedPull();
    await seedTwoLines(pull);

    const focus = await getPerformanceRollup({ today: TODAY, rangeDays: 30 });
    const all = await getAllProductsRollup({ today: TODAY, rangeDays: 30 });

    const focusMens = focus.rows.find((r) => r.key === "men")!;
    const allMens = all.rows.find((r) => r.product === "Mens")!;
    // Net revenue = product + pro-rated ancillary = 1000 + 120.
    expect(focusMens.revenueUsd).toBe(1120);
    // FB $400 + AppLovin $150 — NOT the Supermetrics name-tabs.
    expect(focusMens.spendUsd).toBe(550);
    // Exact equality with the All-products line, not just closeness.
    expect(focusMens.revenueUsd).toBe(allMens.revenueUsd);
    expect(focusMens.spendUsd).toBe(allMens.spendUsd);
    expect(focusMens.roas).toBe(allMens.roas);
    expect(focusMens.roas).toBeCloseTo(1120 / 550, 10);

    const focusShape = focus.rows.find((r) => r.key === "shapewear")!;
    const allShape = all.rows.find((r) => r.product === "Shapewear")!;
    expect(focusShape.revenueUsd).toBe(560);
    expect(focusShape.spendUsd).toBe(250); // FB 200 (name fallback) + AL 50
    expect(focusShape.revenueUsd).toBe(allShape.revenueUsd);
    expect(focusShape.spendUsd).toBe(allShape.spendUsd);
    expect(focusShape.roas).toBe(allShape.roas);

    // The other two focus lines exist with zeroes (no data seeded).
    for (const key of ["suphw", "hrshort"] as const) {
      const row = focus.rows.find((r) => r.key === key)!;
      expect(row.revenueUsd).toBe(0);
      expect(row.spendUsd).toBe(0);
      expect(row.roas).toBeNull();
    }
  });

  it("Focus spend is URL-first: an ad NAMED for Shapewear whose URL maps to Mens lands on the Mens card", async () => {
    const pull = await seedPull();
    await db.insert(skus).values([
      { sku: "ev-mens-3x-m", productName: "Mens 3-Pack", productLine: "Sec", firstSeenAt: D, active: true },
      { sku: "ev-sw-5x-m", productName: "Shapewear", productLine: "Sec", firstSeenAt: D, active: true },
    ]);
    // Ad NAMED "(Shape CC)" but its destination URL is the Mens page.
    await db.insert(fbAdSpendDaily).values([
      { adNumber: "300", adName: "x", adNameRaw: "(Shape CC) Ad 300 - x", adPrefix: "Shape CC", adLink: null, marketers: [], spendDate: D, costUsd: "300", sourcePullId: pull },
    ]);
    await db.insert(fbAdUrlMap).values([
      { adId: "a300", adName: "(Shape CC) Ad 300 - x", destUrl: "https://everdries.com/mens", costUsd: "300", sourcePullId: pull },
    ]);
    await db.insert(fbProductMap).values([
      { normalizedUrl: "everdries.com/mens", rawUrl: "https://everdries.com/mens", region: "US", productLabel: "Mens", sourcePullId: pull },
    ]);

    const focus = await getPerformanceRollup({ today: TODAY, rangeDays: 30 });
    const mens = focus.rows.find((r) => r.key === "men")!;
    const shape = focus.rows.find((r) => r.key === "shapewear")!;
    expect(mens.spendUsd).toBe(300);
    expect(shape.spendUsd).toBe(0);
  });

  it("Focus spend ignores the Supermetrics name-tabs (ad_spend_daily) and exposes an FB/AL source breakdown", async () => {
    const pull = await seedPull();
    await seedTwoLines(pull);
    // Legacy name-tab rows must NOT be double-counted into focus spend.
    await db.insert(adSpendDaily).values([
      { product: "Men", spendDate: D, costUsd: "999", sourcePullId: pull },
      { product: "Men AL", spendDate: D, costUsd: "888", sourcePullId: pull },
    ]);

    const focus = await getPerformanceRollup({ today: TODAY, rangeDays: 30 });
    const mens = focus.rows.find((r) => r.key === "men")!;
    expect(mens.spendUsd).toBe(550); // 400 FB + 150 AL, tabs ignored
    expect(mens.spendBySource).toEqual([
      expect.objectContaining({ source: "FB", spendUsd: 400 }),
      expect.objectContaining({ source: "AL", spendUsd: 150 }),
    ]);
  });

  it("All-products rows are net (product + ancillary share); no separate ancillary bucket; grand total preserved", async () => {
    const pull = await seedPull();
    await seedTwoLines(pull);

    const all = await getAllProductsRollup({ today: TODAY, rangeDays: 30 });
    expect(all.rows.find((r) => r.product === "Mens")!.revenueUsd).toBe(1120);
    expect(all.rows.find((r) => r.product === "Shapewear")!.revenueUsd).toBe(560);
    // No ancillary bucket in the payload anymore — folded into each line.
    expect(all).not.toHaveProperty("ancillaryUsd");
    // Grand total unchanged vs the old products+ancillary split:
    // (1000 + 500) product + (120 + 60) ancillary = 1680.
    expect(all.totalRevenueUsd).toBe(1680);
    expect(all.totalRevenueUsd).toBe(
      all.rows.reduce((s, r) => s + r.revenueUsd, 0),
    );
  });

  it("channel filter applies to focus revenue but not spend", async () => {
    const pull = await seedPull();
    await seedTwoLines(pull);
    // Extra INTL Mens sale: net $220.
    await db.insert(dailySales).values([
      { channel: "shopify_intl", routedLocation: "CN", sku: "ev-mens-3x-m", salesDate: D, unitsSold: 2, netSalesUsd: "220", productSalesUsd: "200", ancillaryUsd: "20", sourcePullId: pull },
    ]);

    const intlOnly = await getPerformanceRollup({ today: TODAY, rangeDays: 30, channel: "shopify_intl" });
    const mens = intlOnly.rows.find((r) => r.key === "men")!;
    expect(mens.revenueUsd).toBe(220);
    expect(mens.spendUsd).toBe(550); // spend unaffected by channel
  });

  // --- Per-source staleness on the focus-card breakdown. The threshold is
  // REAL-WORLD yesterday-EST (wall clock, like the code under test), so all
  // expected values are computed relative to Date.now() the same way —
  // never against a fixed date, or the test would rot. ---
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const addDaysYmd = (ymd: string, days: number): string => {
    const [y, m, d] = ymd.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
  };
  const realYesterdayEst = () => toEstDate(new Date(Date.now() - MS_PER_DAY));

  it("flags a silently-frozen FB feed (>= 2 days behind) and a never-landed AppLovin feed on spendBySource", async () => {
    const pull = await seedPull();
    const staleDate = addDaysYmd(realYesterdayEst(), -3);
    // FB's max(spend_date) is 3 days behind real yesterday-EST; the
    // AppLovin table stays EMPTY (never landed any data).
    await db.insert(fbAdSpendDaily).values([
      { adNumber: "1", adName: "m", adNameRaw: "(Mens CC) Ad 1 - m", adPrefix: "Mens CC", adLink: null, marketers: [], spendDate: staleDate, costUsd: "400", sourcePullId: pull },
    ]);

    const res = await getPerformanceRollup({ today: TODAY, rangeDays: 30 });
    // Staleness is per-source (table-wide max date), identical on every card.
    for (const row of res.rows) {
      const fb = row.spendBySource.find((b) => b.source === "FB")!;
      expect(fb.staleness).toEqual({ latestDate: staleDate, daysBehind: 3 });
      const al = row.spendBySource.find((b) => b.source === "AL")!;
      // -1 encodes "never landed any data" (max date null).
      expect(al.staleness).toEqual({ latestDate: null, daysBehind: -1 });
    }
  });

  it("does not flag sources within normal cron lag (0–1 days behind)", async () => {
    const pull = await seedPull();
    const freshFb = realYesterdayEst(); // 0 days behind
    const lagAl = addDaysYmd(realYesterdayEst(), -1); // 1 day = normal lag
    await db.insert(fbAdSpendDaily).values([
      { adNumber: "1", adName: "m", adNameRaw: "(Mens CC) Ad 1 - m", adPrefix: "Mens CC", adLink: null, marketers: [], spendDate: freshFb, costUsd: "400", sourcePullId: pull },
    ]);
    await db.insert(applovinAdSpendDaily).values([
      { product: "Mens", spendDate: lagAl, costUsd: "150", sourcePullId: pull },
    ]);

    const res = await getPerformanceRollup({ today: TODAY, rangeDays: 30 });
    const mens = res.rows.find((r) => r.key === "men")!;
    expect(mens.spendBySource.find((b) => b.source === "FB")!.staleness).toBeUndefined();
    expect(mens.spendBySource.find((b) => b.source === "AL")!.staleness).toBeUndefined();
  });
});
