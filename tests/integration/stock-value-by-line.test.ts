import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { db } from "@/lib/db";
import { rawPulls, skus, stockSnapshots } from "@/lib/db/schema";
import { getStockValueByProductLine } from "@/lib/queries/stock";
import { resetDb } from "@/tests/fixtures/seed";

/**
 * Per-product-line $ rollup powers the breakdown card on the inventory
 * page (SPEC §5.7 q2). These tests pin the contract: SKUs without a
 * product_line collapse into a single null bucket (rendered as
 * "Uncategorized" in the UI), and rows are sorted by totalUsd
 * descending so the biggest dollar bucket lands first.
 */

async function insertRawPull(): Promise<string> {
  const [r] = await db
    .insert(rawPulls)
    .values({
      source: "sheets_inventory",
      pullBatchId: randomUUID(),
      payload: {},
      rowCount: 0,
      schemaFingerprint: "fp",
    })
    .returning({ id: rawPulls.id });
  return r.id;
}

async function seedSkuWithStock(opts: {
  sku: string;
  productLine: string | null;
  unitCostUsd: string;
  location: "US" | "CN";
  onHand: number;
}): Promise<void> {
  const rawId = await insertRawPull();
  await db.insert(skus).values({
    sku: opts.sku,
    productName: opts.sku,
    productLine: opts.productLine,
    unitCostUsd: opts.unitCostUsd,
    firstSeenAt: "2026-01-01",
    active: true,
  });
  await db.insert(stockSnapshots).values({
    sku: opts.sku,
    location: opts.location,
    snapshotDate: "2026-04-25",
    onHand: opts.onHand,
    sourcePullId: rawId,
  });
}

describe("getStockValueByProductLine", () => {
  beforeAll(() => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set in test env");
  });

  beforeEach(async () => {
    await resetDb();
  });

  it("rolls up stock value per product line and sorts by totalUsd desc", async () => {
    await seedSkuWithStock({ sku: "EV-CP-1", productLine: "Comfort Plus", unitCostUsd: "5", location: "US", onHand: 200 });
    await seedSkuWithStock({ sku: "EV-CP-2", productLine: "Comfort Plus", unitCostUsd: "5", location: "US", onHand: 100 });
    await seedSkuWithStock({ sku: "EV-MS-1", productLine: "Men Shapewear", unitCostUsd: "8", location: "US", onHand: 50 });

    const rows = await getStockValueByProductLine({ location: "US" });
    expect(rows).toHaveLength(2);
    // Comfort Plus: (200 + 100) × 5 = 1500
    // Men Shapewear: 50 × 8 = 400
    expect(rows[0]).toEqual({
      productLine: "Comfort Plus",
      totalUsd: 1500,
      skuCount: 2,
      unitCount: 300,
    });
    expect(rows[1]).toEqual({
      productLine: "Men Shapewear",
      totalUsd: 400,
      skuCount: 1,
      unitCount: 50,
    });
  });

  it("collapses null-product_line SKUs into a single bucket", async () => {
    await seedSkuWithStock({ sku: "EV-X", productLine: null, unitCostUsd: "10", location: "US", onHand: 10 });
    await seedSkuWithStock({ sku: "EV-Y", productLine: null, unitCostUsd: "10", location: "US", onHand: 20 });
    await seedSkuWithStock({ sku: "EV-Z", productLine: "Core", unitCostUsd: "1", location: "US", onHand: 100 });

    const rows = await getStockValueByProductLine({ location: "US" });
    const nullBucket = rows.find((r) => r.productLine === null);
    expect(nullBucket).toBeDefined();
    expect(nullBucket?.skuCount).toBe(2);
    expect(nullBucket?.unitCount).toBe(30);
    expect(nullBucket?.totalUsd).toBe(300);
  });

  it("respects the location filter", async () => {
    await seedSkuWithStock({ sku: "EV-A", productLine: "Core", unitCostUsd: "5", location: "US", onHand: 100 });
    await seedSkuWithStock({ sku: "EV-B", productLine: "Core", unitCostUsd: "5", location: "CN", onHand: 200 });

    const us = await getStockValueByProductLine({ location: "US" });
    expect(us).toHaveLength(1);
    expect(us[0].totalUsd).toBe(500);

    const cn = await getStockValueByProductLine({ location: "CN" });
    expect(cn).toHaveLength(1);
    expect(cn[0].totalUsd).toBe(1000);
  });

  it("returns an empty array when nothing has stock at the location", async () => {
    const rows = await getStockValueByProductLine({ location: "US" });
    expect(rows).toEqual([]);
  });
});
