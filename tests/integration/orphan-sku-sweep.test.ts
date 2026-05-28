import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  factoryOrderLines,
  factoryOrders,
  incomingShipments,
  rawPulls,
  skus,
  stockSnapshots,
} from "@/lib/db/schema";
import { runOrphanSkuSweep } from "@/lib/jobs/orphan-sku-sweep";
import { resetDb } from "@/tests/fixtures/seed";

async function seedRawPull(): Promise<string> {
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

/** Today minus N days, as YYYY-MM-DD (UTC). */
function ymdDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

describe("runOrphanSkuSweep", () => {
  beforeAll(() => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set in test env");
  });

  beforeEach(async () => {
    await resetDb();
  });

  it("deactivates a SKU that matches the orphan pattern (the May-28 regression)", async () => {
    // Mirrors the exact ev-pp-hw-* orphans cleaned up 2026-05-28:
    // active=true, no cost, no product_line, no activity anywhere,
    // first seen >30 days ago (older than the MIN_AGE_DAYS guard).
    await db.insert(skus).values({
      sku: "ev-pp-hw-l",
      productName: "HW",
      productLine: null,
      firstSeenAt: ymdDaysAgo(45),
      active: true,
      unitCostUsd: null,
    });

    const result = await runOrphanSkuSweep();

    expect(result.deactivated).toEqual(["ev-pp-hw-l"]);
    const [row] = await db.select().from(skus).where(eq(skus.sku, "ev-pp-hw-l"));
    expect(row.active).toBe(false);
  });

  it("does not touch a SKU that has stock_snapshots history", async () => {
    const rawId = await seedRawPull();
    await db.insert(skus).values({
      sku: "ev-hw-l",
      productName: "HW",
      productLine: null,
      firstSeenAt: ymdDaysAgo(45),
      active: true,
      unitCostUsd: null,
    });
    await db.insert(stockSnapshots).values({
      sku: "ev-hw-l",
      location: "US",
      snapshotDate: ymdDaysAgo(10),
      onHand: 100,
      sourcePullId: rawId,
    });

    const result = await runOrphanSkuSweep();

    expect(result.deactivated).toEqual([]);
    const [row] = await db.select().from(skus).where(eq(skus.sku, "ev-hw-l"));
    expect(row.active).toBe(true);
  });

  it("does not touch a SKU that currently has incoming_shipments references", async () => {
    const rawId = await seedRawPull();
    await db.insert(skus).values({
      sku: "ev-newline-l",
      productName: "ev-newline-l",
      productLine: null,
      firstSeenAt: ymdDaysAgo(45),
      active: true,
      unitCostUsd: null,
    });
    await db.insert(incomingShipments).values({
      sku: "ev-newline-l",
      destination: "US",
      shipmentName: "PO-test",
      quantity: 100,
      expectedArrival: ymdDaysAgo(-30), // future ETA
      status: "po",
      sourcePullId: rawId,
      sourceRowRef: "test-row",
    });

    const result = await runOrphanSkuSweep();

    expect(result.deactivated).toEqual([]);
    const [row] = await db.select().from(skus).where(eq(skus.sku, "ev-newline-l"));
    expect(row.active).toBe(true);
  });

  it("does not touch a SKU referenced by a factory_order_lines row", async () => {
    const [order] = await db
      .insert(factoryOrders)
      .values({ orderMonth: ymdDaysAgo(20).slice(0, 7) + "-01", status: "draft" })
      .returning({ id: factoryOrders.id });
    await db.insert(skus).values({
      sku: "ev-ordered-l",
      productName: "ev-ordered-l",
      productLine: null,
      firstSeenAt: ymdDaysAgo(45),
      active: true,
      unitCostUsd: null,
    });
    await db.insert(factoryOrderLines).values({
      orderId: order.id,
      sku: "ev-ordered-l",
      destination: "US",
      qty: 100,
      unitCost: "5.0000",
      amount: "500.00",
      productGroup: "Test",
    });

    const result = await runOrphanSkuSweep();

    expect(result.deactivated).toEqual([]);
    const [row] = await db.select().from(skus).where(eq(skus.sku, "ev-ordered-l"));
    expect(row.active).toBe(true);
  });

  it("does not touch a recently-added SKU (within MIN_AGE_DAYS) even if otherwise orphan-shaped", async () => {
    // Guards against deactivating a brand-new SKU that just landed on
    // the Incoming sheet but hasn't shipped yet (PO entered today, no
    // inventory row created yet because nothing has been received).
    await db.insert(skus).values({
      sku: "ev-fresh-l",
      productName: "ev-fresh-l",
      productLine: null,
      firstSeenAt: ymdDaysAgo(5),
      active: true,
      unitCostUsd: null,
    });

    const result = await runOrphanSkuSweep();

    expect(result.deactivated).toEqual([]);
    const [row] = await db.select().from(skus).where(eq(skus.sku, "ev-fresh-l"));
    expect(row.active).toBe(true);
  });

  it("does not touch a priced SKU (cost is the explicit non-orphan signal)", async () => {
    // A SKU that's been priced (Grace added the cost) is by definition
    // categorized as a real product, even if temporarily no stock/incoming.
    await db.insert(skus).values({
      sku: "ev-priced-l",
      productName: "ev-priced-l",
      productLine: null,
      firstSeenAt: ymdDaysAgo(45),
      active: true,
      unitCostUsd: "5.0000",
    });

    const result = await runOrphanSkuSweep();

    expect(result.deactivated).toEqual([]);
  });

  it("does not touch an already-inactive SKU (no-op on prior sweeps)", async () => {
    await db.insert(skus).values({
      sku: "ev-already-off-l",
      productName: "HW",
      productLine: null,
      firstSeenAt: ymdDaysAgo(45),
      active: false,
      unitCostUsd: null,
    });

    const result = await runOrphanSkuSweep();

    expect(result.deactivated).toEqual([]);
  });

  it("is idempotent — second consecutive run deactivates nothing new", async () => {
    await db.insert(skus).values({
      sku: "ev-pp-og-l",
      productName: "OG",
      productLine: null,
      firstSeenAt: ymdDaysAgo(45),
      active: true,
      unitCostUsd: null,
    });

    const first = await runOrphanSkuSweep();
    expect(first.deactivated).toEqual(["ev-pp-og-l"]);

    const second = await runOrphanSkuSweep();
    expect(second.deactivated).toEqual([]);
  });

  it("deactivates many orphans in a single sweep (the 13-row May-28 cleanup shape)", async () => {
    const orphanSkus = [
      "ev-pp-hw-3xl",
      "ev-pp-hw-4xl",
      "ev-pp-hw-l",
      "ev-pp-hw-m",
      "ev-pp-og-l",
      "ev-pp-og-m",
    ];
    for (const sku of orphanSkus) {
      await db.insert(skus).values({
        sku,
        productName: sku.startsWith("ev-pp-hw-") ? "HW" : "OG",
        productLine: null,
        firstSeenAt: ymdDaysAgo(45),
        active: true,
        unitCostUsd: null,
      });
    }

    const result = await runOrphanSkuSweep();
    expect(result.deactivated.sort()).toEqual(orphanSkus.sort());
  });

  it("treats an incoming-shipments-reactivated SKU as live (upsert reactivation path)", async () => {
    // Companion contract for the lib/sources/sheets.ts incoming upsert
    // change that flips active back to true via onConflictDoUpdate.
    // Once Grace re-adds the SKU to the Incoming sheet, an
    // incoming_shipments row exists and the sweep must not touch it.
    const rawId = await seedRawPull();
    await db.insert(skus).values({
      sku: "ev-reborn-l",
      productName: "ev-reborn-l",
      productLine: null,
      firstSeenAt: ymdDaysAgo(45),
      active: true,
      unitCostUsd: null,
    });
    await db.insert(incomingShipments).values({
      sku: "ev-reborn-l",
      destination: "US",
      shipmentName: "PO-reborn",
      quantity: 50,
      expectedArrival: ymdDaysAgo(-7),
      status: "po",
      sourcePullId: rawId,
      sourceRowRef: "row-reborn",
    });

    const result = await runOrphanSkuSweep();
    expect(result.deactivated).toEqual([]);
  });
});
