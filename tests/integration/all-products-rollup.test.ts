import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { adSpendDaily, applovinAdSpendDaily, dailySales, fbAdSpendDaily, rawPulls, skus } from "@/lib/db/schema";
import { getAllProductsRollup, type AllProductsRow } from "@/lib/queries/performance";
import "dotenv/config";

async function truncate() {
  await db.execute(sql`TRUNCATE TABLE raw_pulls, skus, daily_sales, fb_ad_spend_daily CASCADE`);
}

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

const find = (rows: AllProductsRow[], product: string) =>
  rows.find((r) => r.product === product);

describe("getAllProductsRollup", () => {
  beforeAll(() => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set");
  });
  beforeEach(truncate);

  it("rolls up exact product revenue + FB-attributed spend, with buckets + ancillary", async () => {
    const pull = await seedPull();
    const D = "2026-06-10"; // inside the 30d window ending 2026-06-24

    await db.insert(skus).values([
      { sku: "ev-9055-5x-m", productName: "Style 9055", productLine: "Main", firstSeenAt: D, active: true },
      { sku: "ev-bshort-5x-m", productName: "Boyshort", productLine: "Sec", firstSeenAt: D, active: true },
      { sku: "ev-hw-5x-m", productName: "HW", productLine: "Main", firstSeenAt: D, active: true },
    ]);

    await db.insert(dailySales).values([
      { channel: "shopify_us", routedLocation: "US", sku: "ev-9055-5x-m", salesDate: D, unitsSold: 10, netSalesUsd: "1100", productSalesUsd: "1000", ancillaryUsd: "100", sourcePullId: pull },
      { channel: "shopify_us", routedLocation: "US", sku: "ev-bshort-5x-m", salesDate: D, unitsSold: 5, netSalesUsd: "550", productSalesUsd: "500", ancillaryUsd: "50", sourcePullId: pull },
      { channel: "shopify_us", routedLocation: "US", sku: "ev-hw-5x-m", salesDate: D, unitsSold: 2, netSalesUsd: "220", productSalesUsd: "200", ancillaryUsd: "20", sourcePullId: pull },
    ]);

    await db.insert(fbAdSpendDaily).values([
      { adNumber: "1", adName: "x", adNameRaw: "(9055 CC) Ad 1 - x", adPrefix: "9055 CC", adLink: null, marketers: [], spendDate: D, costUsd: "300", sourcePullId: pull },
      { adNumber: "2", adName: "y", adNameRaw: "(BShort CC) Ad 2 - y", adPrefix: "BShort CC", adLink: null, marketers: [], spendDate: D, costUsd: "200", sourcePullId: pull },
      { adNumber: "3", adName: "z", adNameRaw: "(HW CC) Ad 3 - z", adPrefix: "HW CC", adLink: null, marketers: [], spendDate: D, costUsd: "50", sourcePullId: pull },
      { adNumber: "4", adName: "w", adNameRaw: "(HOME US BAU) Ad 4 - w", adPrefix: "HOME US BAU", adLink: null, marketers: [], spendDate: D, costUsd: "80", sourcePullId: pull },
      { adNumber: "5", adName: "t", adNameRaw: "(Botshort CC) Ad 5 - typo", adPrefix: "Botshort CC", adLink: null, marketers: [], spendDate: D, costUsd: "5", sourcePullId: pull },
    ]);

    const res = await getAllProductsRollup({ today: "2026-06-25", rangeDays: 30 });

    // product rows: revenue + spend joined on family label
    expect(find(res.rows, "9055")).toMatchObject({ kind: "product", revenueUsd: 1000, spendUsd: 300 });
    expect(find(res.rows, "9055")!.roas).toBeCloseTo(1000 / 300, 4);
    expect(find(res.rows, "Boyshort")).toMatchObject({ kind: "product", revenueUsd: 500, spendUsd: 200 });
    expect(find(res.rows, "HW")).toMatchObject({ kind: "product", revenueUsd: 200, spendUsd: 50 });

    // spend-only buckets
    expect(find(res.rows, "Brand / Homepage")).toMatchObject({ kind: "brand", revenueUsd: 0, spendUsd: 80, roas: null });
    expect(find(res.rows, "Unmapped")).toMatchObject({ kind: "unmapped", revenueUsd: 0, spendUsd: 5 });

    // products are sorted by revenue desc and come before buckets
    const productRows = res.rows.filter((r) => r.kind === "product");
    expect(productRows.map((r) => r.product)).toEqual(["9055", "Boyshort", "HW"]);
    const firstBucketIdx = res.rows.findIndex((r) => r.kind !== "product");
    const lastProductIdx = res.rows.map((r) => r.kind).lastIndexOf("product");
    expect(lastProductIdx).toBeLessThan(firstBucketIdx);

    // ancillary + totals
    expect(res.ancillaryUsd).toBe(170);
    expect(res.totalProductRevenueUsd).toBe(1700);
    expect(res.totalRevenueUsd).toBe(1870);
    expect(res.totalSpendUsd).toBe(635);
    expect(res.rangeStart).toBe("2026-05-26");
    expect(res.rangeEnd).toBe("2026-06-24");
  });

  it("excludes sales/spend outside the window", async () => {
    const pull = await seedPull();
    await db.insert(skus).values([
      { sku: "ev-9055-5x-m", productName: "Style 9055", productLine: "Main", firstSeenAt: "2026-01-01", active: true },
    ]);
    await db.insert(dailySales).values([
      { channel: "shopify_us", routedLocation: "US", sku: "ev-9055-5x-m", salesDate: "2026-05-01", unitsSold: 1, netSalesUsd: "111", productSalesUsd: "100", ancillaryUsd: "11", sourcePullId: pull },
    ]);
    await db.insert(fbAdSpendDaily).values([
      { adNumber: "1", adName: "x", adNameRaw: "(9055) old", adPrefix: "9055", adLink: null, marketers: [], spendDate: "2026-05-01", costUsd: "999", sourcePullId: pull },
    ]);
    const res = await getAllProductsRollup({ today: "2026-06-25", rangeDays: 30 });
    expect(res.totalProductRevenueUsd).toBe(0);
    expect(res.totalSpendUsd).toBe(0);
    expect(res.rows).toEqual([]);
  });

  it("folds AppLovin from applovin_ad_spend_daily into combined spend; ignores ad_spend_daily tabs", async () => {
    const pull = await seedPull();
    const D = "2026-06-10";
    await db.insert(skus).values([
      { sku: "ev-mens-3x-m", productName: "Mens 3-Pack", productLine: "Sec", firstSeenAt: D, active: true },
    ]);
    await db.insert(dailySales).values([
      { channel: "shopify_us", routedLocation: "US", sku: "ev-mens-3x-m", salesDate: D, unitsSold: 10, netSalesUsd: "1100", productSalesUsd: "1000", ancillaryUsd: "100", sourcePullId: pull },
    ]);
    await db.insert(fbAdSpendDaily).values([
      { adNumber: "1", adName: "m", adNameRaw: "(Mens) Ad 1 - x", adPrefix: "Mens", adLink: null, marketers: [], spendDate: D, costUsd: "400", sourcePullId: pull },
    ]);
    // AppLovin comes from the dedicated feed, already attributed to a family.
    await db.insert(applovinAdSpendDaily).values([
      { product: "Mens", spendDate: D, costUsd: "150", sourcePullId: pull },
    ]);
    // ad_spend_daily tabs (FB "Men" + AppLovin AL "Men AL") are NOT read by
    // the rollup — must be ignored so we don't double-count.
    await db.insert(adSpendDaily).values([
      { product: "Men", spendDate: D, costUsd: "999", sourcePullId: pull },
      { product: "Men AL", spendDate: D, costUsd: "888", sourcePullId: pull },
    ]);

    const res = await getAllProductsRollup({ today: "2026-06-25", rangeDays: 30 });
    const mens = find(res.rows, "Mens")!;
    // FB $400 + AppLovin $150 = $550 combined; ad_spend_daily tabs excluded.
    expect(mens.fbSpendUsd).toBe(400);
    expect(mens.appLovinSpendUsd).toBe(150);
    expect(mens.spendUsd).toBe(550);
    expect(mens.roas).toBeCloseTo(1000 / 550, 4);
    expect(res.totalFbSpendUsd).toBe(400);
    expect(res.totalAppLovinSpendUsd).toBe(150);
    expect(res.totalSpendUsd).toBe(550);
  });

  it("lumps Boyshort + Boyshort HF into a single Boyshort row (spend + revenue)", async () => {
    const pull = await seedPull();
    const D = "2026-06-10";
    await db.insert(skus).values([
      { sku: "ev-bshort-5x-m", productName: "Boyshort", productLine: "Sec", firstSeenAt: D, active: true },
      { sku: "ev-bshort-hf-5x-m", productName: "Boyshort HF", productLine: "Sec", firstSeenAt: D, active: true },
    ]);
    await db.insert(dailySales).values([
      { channel: "shopify_us", routedLocation: "US", sku: "ev-bshort-5x-m", salesDate: D, unitsSold: 5, netSalesUsd: "550", productSalesUsd: "500", ancillaryUsd: "50", sourcePullId: pull },
      { channel: "shopify_us", routedLocation: "US", sku: "ev-bshort-hf-5x-m", salesDate: D, unitsSold: 3, netSalesUsd: "330", productSalesUsd: "300", ancillaryUsd: "30", sourcePullId: pull },
    ]);
    await db.insert(fbAdSpendDaily).values([
      { adNumber: "1", adName: "a", adNameRaw: "(Boyshort CC) Ad 1 - x", adPrefix: "Boyshort CC", adLink: null, marketers: [], spendDate: D, costUsd: "200", sourcePullId: pull },
      { adNumber: "2", adName: "b", adNameRaw: "(Boyshort HF ASC) Ad 2 - y", adPrefix: "Boyshort HF ASC", adLink: null, marketers: [], spendDate: D, costUsd: "120", sourcePullId: pull },
    ]);
    // AppLovin Boyshort HF spend also folds into the single Boyshort family.
    await db.insert(applovinAdSpendDaily).values([
      { product: "Boyshort HF", spendDate: D, costUsd: "30", sourcePullId: pull },
    ]);

    const res = await getAllProductsRollup({ today: "2026-06-25", rangeDays: 30 });
    // One Boyshort row, no separate "Boyshort HF" row.
    expect(res.rows.filter((r) => r.product === "Boyshort HF")).toEqual([]);
    const bs = find(res.rows, "Boyshort")!;
    expect(bs.kind).toBe("product");
    expect(bs.revenueUsd).toBe(800); // 500 + 300
    expect(bs.fbSpendUsd).toBe(320); // 200 + 120
    expect(bs.appLovinSpendUsd).toBe(30);
    expect(bs.spendUsd).toBe(350); // 320 + 30
    expect(bs.roas).toBeCloseTo(800 / 350, 4);
  });

  it("surfaces an AppLovin-only family (no FB, no revenue) as a spend bucket", async () => {
    const pull = await seedPull();
    const D = "2026-06-10";
    await db.insert(applovinAdSpendDaily).values([
      { product: "Clearance / Mixed", spendDate: D, costUsd: "320", sourcePullId: pull },
    ]);
    const res = await getAllProductsRollup({ today: "2026-06-25", rangeDays: 30 });
    const clr = find(res.rows, "Clearance / Mixed")!;
    expect(clr.kind).toBe("clearance");
    expect(clr.appLovinSpendUsd).toBe(320);
    expect(clr.fbSpendUsd).toBe(0);
    expect(clr.spendUsd).toBe(320);
    expect(res.totalAppLovinSpendUsd).toBe(320);
  });
});
