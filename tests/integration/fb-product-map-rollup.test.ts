import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import {
  dailySales,
  fbAdSpendDaily,
  fbAdUrlMap,
  fbGeoSpend,
  fbProductMap,
  rawPulls,
  skus,
} from "@/lib/db/schema";
import { getAllProductsRollup, type AllProductsRow } from "@/lib/queries/performance";
import "dotenv/config";

async function truncate() {
  await db.execute(
    sql`TRUNCATE TABLE raw_pulls, skus, daily_sales, fb_ad_spend_daily, fb_ad_url_map, fb_product_map, fb_geo_spend CASCADE`,
  );
}

async function seedPull(): Promise<string> {
  const [row] = await db
    .insert(rawPulls)
    .values({ source: "shopify_us", pullBatchId: randomUUID(), payload: {}, rowCount: 0, schemaFingerprint: "test-fp" })
    .returning({ id: rawPulls.id });
  return row.id;
}

const find = (rows: AllProductsRow[], product: string) => rows.find((r) => r.product === product);

describe("getAllProductsRollup — product map sheet", () => {
  beforeAll(() => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set");
  });
  beforeEach(truncate);

  it("attributes product + US/INTL from the sheet, falls back to ad-name + geo, buckets NA", async () => {
    const pull = await seedPull();
    const D = "2026-06-10";

    await db.insert(skus).values([
      { sku: "ev-9055-5x-m", productName: "Style 9055", productLine: "Main", firstSeenAt: D, active: true },
      { sku: "ev-bshort-5x-m", productName: "Boyshort", productLine: "Sec", firstSeenAt: D, active: true },
      { sku: "ev-hw-5x-m", productName: "HW", productLine: "Main", firstSeenAt: D, active: true },
    ]);
    await db.insert(dailySales).values([
      { channel: "shopify_us", routedLocation: "US", sku: "ev-9055-5x-m", salesDate: D, unitsSold: 1, netSalesUsd: "1000", productSalesUsd: "1000", ancillaryUsd: "0", sourcePullId: pull },
      { channel: "shopify_us", routedLocation: "US", sku: "ev-bshort-5x-m", salesDate: D, unitsSold: 1, netSalesUsd: "500", productSalesUsd: "500", ancillaryUsd: "0", sourcePullId: pull },
      { channel: "shopify_us", routedLocation: "US", sku: "ev-hw-5x-m", salesDate: D, unitsSold: 1, netSalesUsd: "200", productSalesUsd: "200", ancillaryUsd: "0", sourcePullId: pull },
    ]);

    // Daily FB spend, keyed by (ad_number, ad_prefix).
    await db.insert(fbAdSpendDaily).values([
      { adNumber: "1", adName: "x", adNameRaw: "(9055 CC) Ad 1 - x", adPrefix: "9055 CC", adLink: null, marketers: [], spendDate: D, costUsd: "300", sourcePullId: pull },
      { adNumber: "2", adName: "y", adNameRaw: "(BShort CC) Ad 2 - y", adPrefix: "BShort CC", adLink: null, marketers: [], spendDate: D, costUsd: "200", sourcePullId: pull },
      { adNumber: "3", adName: "z", adNameRaw: "(HW CC) Ad 3 - z", adPrefix: "HW CC", adLink: null, marketers: [], spendDate: D, costUsd: "100", sourcePullId: pull },
      { adNumber: "4", adName: "w", adNameRaw: "(9055 CC) Ad 4 - w", adPrefix: "9055 CC", adLink: null, marketers: [], spendDate: D, costUsd: "50", sourcePullId: pull },
    ]);

    // Ad -> dest_url. Ad 3's URL is intentionally NOT in the sheet (fallback).
    await db.insert(fbAdUrlMap).values([
      { adId: "a1", adName: "(9055 CC) Ad 1 - x", destUrl: "https://everdries.com/comfortplus", costUsd: "300", sourcePullId: pull },
      { adId: "a2", adName: "(BShort CC) Ad 2 - y", destUrl: "https://shop.everdries.com/boyshort", costUsd: "200", sourcePullId: pull },
      { adId: "a3", adName: "(HW CC) Ad 3 - z", destUrl: "https://everdries.com/not-in-sheet", costUsd: "100", sourcePullId: pull },
      { adId: "a4", adName: "(9055 CC) Ad 4 - w", destUrl: "https://everdries.com/lavender", costUsd: "50", sourcePullId: pull },
    ]);

    // The product map sheet (post-parse: normalized url + canonical label).
    await db.insert(fbProductMap).values([
      { normalizedUrl: "everdries.com/comfortplus", rawUrl: "https://everdries.com/comfortplus", region: "US", productLabel: "9055", sourcePullId: pull },
      { normalizedUrl: "shop.everdries.com/boyshort", rawUrl: "https://shop.everdries.com/boyshort", region: "INTL", productLabel: "Boyshort", sourcePullId: pull },
      { normalizedUrl: "everdries.com/lavender", rawUrl: "https://everdries.com/lavender", region: "US", productLabel: "Other (NA)", sourcePullId: pull },
    ]);

    // Geo for the unmapped Ad 3 -> 60% US fallback.
    await db.insert(fbGeoSpend).values([
      { adId: "a3", countryCode: "US", costUsd: "60", sourcePullId: pull },
      { adId: "a3", countryCode: "CA", costUsd: "40", sourcePullId: pull },
    ]);

    const res = await getAllProductsRollup({ today: "2026-06-25", rangeDays: 30 });

    // 9055: spend from sheet (Ad 1 comfortplus = 9055), all US.
    expect(find(res.rows, "9055")).toMatchObject({ kind: "product", revenueUsd: 1000, fbSpendUsd: 300, usSpendUsd: 300, nonUsSpendUsd: 0 });
    // Boyshort: sheet INTL -> all non-US.
    expect(find(res.rows, "Boyshort")).toMatchObject({ kind: "product", fbSpendUsd: 200, usSpendUsd: 0, nonUsSpendUsd: 200 });
    // HW: URL not in sheet -> ad-name fallback product + geo region (60/40).
    const hw = find(res.rows, "HW")!;
    expect(hw.fbSpendUsd).toBe(100);
    expect(hw.usSpendUsd).toBeCloseTo(60, 4);
    expect(hw.nonUsSpendUsd).toBeCloseTo(40, 4);
    // NA page -> Other (NA) spend-only bucket, US.
    expect(find(res.rows, "Other (NA)")).toMatchObject({ kind: "unmapped", fbSpendUsd: 50, usSpendUsd: 50 });

    // Totals reconcile: us + intl == total FB spend (650).
    expect(res.totalUsSpendUsd + res.totalNonUsSpendUsd).toBeCloseTo(650, 4);
    expect(res.totalUsSpendUsd).toBeCloseTo(410, 4);
    expect(res.totalNonUsSpendUsd).toBeCloseTo(240, 4);
  });
});
