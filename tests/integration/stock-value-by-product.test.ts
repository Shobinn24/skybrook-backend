import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { db } from "@/lib/db";
import {
  incomingReceipts,
  incomingShipments,
  rawPulls,
  skus,
  stockSnapshots,
} from "@/lib/db/schema";
import { getStockValueByProduct } from "@/lib/queries/stock";
import { resetDb } from "@/tests/fixtures/seed";

/**
 * Per-product (garment-name) $ rollup powers /stock-value (Scott's #10
 * 2026-04-28: "split it up by product not main/sec"). Same shape as the
 * by-line rollup but bucketed on productName instead of productLine —
 * pin the contract so a future refactor of the underlying join can't
 * silently start grouping by SKU again.
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
  productName: string;
  unitCostUsd: string;
  location: "US" | "CN";
  onHand: number;
}): Promise<void> {
  const rawId = await insertRawPull();
  await db.insert(skus).values({
    sku: opts.sku,
    productName: opts.productName,
    productLine: null,
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

describe("getStockValueByProduct", () => {
  beforeAll(() => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set in test env");
  });

  beforeEach(async () => {
    await resetDb();
  });

  it("groups multiple SKUs that share a product name into one row", async () => {
    await seedSkuWithStock({
      sku: "ev-9055-5x-l",
      productName: "Style 9055",
      unitCostUsd: "6.73",
      location: "US",
      onHand: 100,
    });
    await seedSkuWithStock({
      sku: "ev-9055-5x-m",
      productName: "Style 9055",
      unitCostUsd: "6.73",
      location: "US",
      onHand: 50,
    });
    await seedSkuWithStock({
      sku: "ev-hw-5x-l",
      productName: "HW",
      unitCostUsd: "5.00",
      location: "US",
      onHand: 80,
    });

    const rows = await getStockValueByProduct({ location: "US" });
    expect(rows).toHaveLength(2);
    // Style 9055: (100 + 50) × 6.73 = 1009.5
    expect(rows[0]).toEqual({
      productName: "Style 9055",
      totalUsd: 1009.5,
      skuCount: 2,
      unitCount: 150,
      futureUnitCount: 0,
      futureValueUsd: 0,
    });
    expect(rows[1]).toEqual({
      productName: "HW",
      totalUsd: 400,
      skuCount: 1,
      unitCount: 80,
      futureUnitCount: 0,
      futureValueUsd: 0,
    });
  });

  it("sorts by totalUsd descending", async () => {
    await seedSkuWithStock({
      sku: "ev-cheap-1",
      productName: "Cheap",
      unitCostUsd: "1",
      location: "US",
      onHand: 100,
    });
    await seedSkuWithStock({
      sku: "ev-mid-1",
      productName: "Mid",
      unitCostUsd: "5",
      location: "US",
      onHand: 100,
    });
    await seedSkuWithStock({
      sku: "ev-pricey-1",
      productName: "Pricey",
      unitCostUsd: "20",
      location: "US",
      onHand: 100,
    });

    const rows = await getStockValueByProduct({ location: "US" });
    expect(rows.map((r) => r.productName)).toEqual(["Pricey", "Mid", "Cheap"]);
  });

  it("respects the location filter", async () => {
    await seedSkuWithStock({
      sku: "ev-a-l",
      productName: "Alpha",
      unitCostUsd: "5",
      location: "US",
      onHand: 100,
    });
    await seedSkuWithStock({
      sku: "ev-b-l",
      productName: "Alpha",
      unitCostUsd: "5",
      location: "CN",
      onHand: 200,
    });

    const us = await getStockValueByProduct({ location: "US" });
    expect(us).toHaveLength(1);
    expect(us[0]).toEqual({
      productName: "Alpha",
      totalUsd: 500,
      skuCount: 1,
      unitCount: 100,
      futureUnitCount: 0,
      futureValueUsd: 0,
    });

    const cn = await getStockValueByProduct({ location: "CN" });
    expect(cn).toHaveLength(1);
    expect(cn[0].totalUsd).toBe(1000);
  });

  it("falls back to SKU as the bucket key when productName equals the SKU", async () => {
    // getStockLevels defaults productName to sku for unmapped rows, so
    // unmapped SKUs land in their own per-SKU bucket — not collapsed
    // into a generic "Unnamed" sink that would hide capital.
    await seedSkuWithStock({
      sku: "ev-unmapped-l",
      productName: "ev-unmapped-l",
      unitCostUsd: "10",
      location: "US",
      onHand: 5,
    });
    await seedSkuWithStock({
      sku: "ev-other-unmapped-m",
      productName: "ev-other-unmapped-m",
      unitCostUsd: "10",
      location: "US",
      onHand: 5,
    });

    const rows = await getStockValueByProduct({ location: "US" });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.productName).sort()).toEqual([
      "ev-other-unmapped-m",
      "ev-unmapped-l",
    ]);
  });

  it("returns an empty array when nothing has stock at the location", async () => {
    const rows = await getStockValueByProduct({ location: "US" });
    expect(rows).toEqual([]);
  });

  it("computes futureUnitCount + futureValueUsd from pending incoming POs", async () => {
    // 100 on-hand at $5 + 200 inbound at $5 = current $500, future $1000.
    await seedSkuWithStock({
      sku: "ev-a-l",
      productName: "Alpha",
      unitCostUsd: "5",
      location: "US",
      onHand: 100,
    });
    const rawId = await insertRawPull();
    await db.insert(incomingShipments).values({
      sku: "ev-a-l",
      destination: "US",
      shipmentName: "PO-pending",
      quantity: 200,
      expectedArrival: "2026-06-01",
      status: "po",
      sourcePullId: rawId,
      sourceRowRef: "Incoming_new!D7",
    });

    const rows = await getStockValueByProduct({ location: "US" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      productName: "Alpha",
      totalUsd: 500,
      skuCount: 1,
      unitCount: 100,
      futureUnitCount: 200,
      futureValueUsd: 1000,
    });
  });

  it("excludes received POs from the future-value rollup", async () => {
    // Once Scott marks a PO received, those units are already counted in
    // stock_snapshots — the future column must not double-count them.
    await seedSkuWithStock({
      sku: "ev-a-l",
      productName: "Alpha",
      unitCostUsd: "5",
      location: "US",
      onHand: 100,
    });
    const rawId = await insertRawPull();
    await db.insert(incomingShipments).values([
      {
        sku: "ev-a-l",
        destination: "US",
        shipmentName: "PO-received",
        quantity: 100,
        expectedArrival: "2026-04-01",
        status: "po",
        sourcePullId: rawId,
        sourceRowRef: "Incoming_new!D7",
      },
      {
        sku: "ev-a-l",
        destination: "US",
        shipmentName: "PO-still-inbound",
        quantity: 50,
        expectedArrival: "2026-06-01",
        status: "po",
        sourcePullId: rawId,
        sourceRowRef: "Incoming_new!E7",
      },
    ]);
    await db.insert(incomingReceipts).values({
      shipmentName: "PO-received",
      destination: "US",
      expectedArrival: "2026-04-01",
    });

    const rows = await getStockValueByProduct({ location: "US" });
    expect(rows[0].futureUnitCount).toBe(50);
    expect(rows[0].futureValueUsd).toBe(250);
  });

  it("combines US + CN when location is omitted (All-warehouses view)", async () => {
    await seedSkuWithStock({
      sku: "ev-a-us",
      productName: "Alpha",
      unitCostUsd: "5",
      location: "US",
      onHand: 100,
    });
    await seedSkuWithStock({
      sku: "ev-a-cn",
      productName: "Alpha",
      unitCostUsd: "4",
      location: "CN",
      onHand: 200,
    });

    const all = await getStockValueByProduct(); // no location
    expect(all).toHaveLength(1);
    // US value (100×5 = 500) + CN value (200×4 = 800) = 1300
    expect(all[0].totalUsd).toBe(1300);
    expect(all[0].unitCount).toBe(300);
    expect(all[0].skuCount).toBe(2);
  });
});
