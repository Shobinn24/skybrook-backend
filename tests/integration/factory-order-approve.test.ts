import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  dailySales,
  factoryOrderLines,
  factoryOrders,
  rawPulls,
  skus,
  stockSnapshots,
} from "@/lib/db/schema";
import { resetDb } from "@/tests/fixtures/seed";
import { approveFactoryOrder } from "@/lib/jobs/factory-order-approve";
import {
  getOrCreateDraft,
  saveInputs,
} from "@/lib/queries/factory-order";
import { buildSheetBuffer } from "@/lib/jobs/factory-order-excel";

/**
 * End-to-end Phase-4 contract:
 *   (1) approve snapshots calculated lines and flips status → "approved"
 *   (2) re-approving overwrites the snapshot cleanly (no orphans)
 *   (3) buildSheetBuffer 409s on un-approved orders
 *   (4) buildSheetBuffer returns a non-empty XLSX buffer per side
 */
describe("factory-order Phase 4 — approve + excel", () => {
  beforeAll(() => {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL not set in test env");
    }
  });

  beforeEach(async () => {
    await resetDb();
  });

  async function seedFactoryFixture(orderMonth: string) {
    // Tiny self-contained catalog: one 9055 Main SKU with enough
    // sales + stock to produce a non-zero Order Qty.
    const [raw] = await db
      .insert(rawPulls)
      .values({
        source: "sheets_inventory",
        pullBatchId: crypto.randomUUID(),
        payload: {},
        rowCount: 0,
        schemaFingerprint: "fp",
      })
      .returning({ id: rawPulls.id });

    await db.insert(skus).values({
      sku: "ev-9055-5x-m",
      productName: "9055 Main",
      productLine: "Main",
      unitCostUsd: "6.41",
      unitCostIntlUsd: "5.90",
      firstSeenAt: "2026-04-01",
      active: true,
    });

    await db.insert(stockSnapshots).values({
      sku: "ev-9055-5x-m",
      location: "US",
      snapshotDate: "2026-04-30",
      onHand: 50,
      sourcePullId: raw.id,
    });

    // 30 days of US shopify sales = 100 units total (window for the
    // calc engine is asOf - 30d).
    const calcAsOf = `${orderMonth.slice(0, 7)}-01`;
    const baseDay = new Date(`${calcAsOf}T00:00:00Z`);
    baseDay.setUTCDate(baseDay.getUTCDate() - 30);
    const salesRows: Array<{
      channel: "shopify_us";
      routedLocation: "US";
      sku: string;
      salesDate: string;
      unitsSold: number;
      netSalesUsd: string;
      sourcePullId: string;
    }> = [];
    for (let i = 0; i < 25; i++) {
      const d = new Date(baseDay);
      d.setUTCDate(d.getUTCDate() + i);
      salesRows.push({
        channel: "shopify_us",
        routedLocation: "US",
        sku: "ev-9055-5x-m",
        salesDate: d.toISOString().slice(0, 10),
        unitsSold: 4,
        netSalesUsd: "100",
        sourcePullId: raw.id,
      });
    }
    await db.insert(dailySales).values(salesRows);

    const draft = await getOrCreateDraft(orderMonth);
    await saveInputs({
      orderId: draft.header.id,
      inputs: {
        ...draft.inputs,
        revenueUs: 100_000,
        revenueIntl: 0,
        revenueAmazon: 0,
        forecast: {
          us: [200_000, 200_000, 200_000, 200_000],
          intl: [0, 0, 0],
        },
      },
    });
    return draft.header.id;
  }

  it("approve writes the calculated lines and flips the header status", async () => {
    const orderId = await seedFactoryFixture("2026-05-01");

    const result = await approveFactoryOrder({
      orderId,
      approvedBy: "shobinn@localdev",
    });

    expect(result.status).toBe("approved");
    expect(result.lineCount).toBeGreaterThan(0);
    expect(result.usTotal).toBeGreaterThan(0);

    const header = (
      await db
        .select()
        .from(factoryOrders)
        .where(eq(factoryOrders.id, orderId))
    )[0];
    expect(header.status).toBe("approved");
    expect(header.approvedBy).toBe("shobinn@localdev");
    expect(header.approvedAt).not.toBeNull();

    const lines = await db
      .select()
      .from(factoryOrderLines)
      .where(eq(factoryOrderLines.orderId, orderId));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0].productGroup).toBe("9055 Main");
    expect(lines[0].destination).toBe("US");
    expect(lines[0].qty).toBeGreaterThan(0);
  });

  it("re-approving overwrites the snapshot instead of duplicating rows", async () => {
    const orderId = await seedFactoryFixture("2026-05-01");
    await approveFactoryOrder({ orderId, approvedBy: "a" });
    const firstCount = (
      await db
        .select()
        .from(factoryOrderLines)
        .where(eq(factoryOrderLines.orderId, orderId))
    ).length;

    await approveFactoryOrder({ orderId, approvedBy: "b" });
    const secondCount = (
      await db
        .select()
        .from(factoryOrderLines)
        .where(eq(factoryOrderLines.orderId, orderId))
    ).length;

    expect(secondCount).toBe(firstCount);
  });

  it("buildSheetBuffer refuses to render an un-approved order", async () => {
    const orderId = await seedFactoryFixture("2026-05-01");
    await expect(
      buildSheetBuffer({ orderId, side: "US" }),
    ).rejects.toThrow(/un-approved/);
  });

  it("buildSheetBuffer returns a non-empty .xlsx buffer with the right name", async () => {
    const orderId = await seedFactoryFixture("2026-05-01");
    await approveFactoryOrder({ orderId, approvedBy: "test" });

    const result = await buildSheetBuffer({ orderId, side: "US" });
    expect(result.buffer.byteLength).toBeGreaterThan(2000);
    expect(result.filename).toMatch(/^SB - KAI May 2026\.xlsx$/);

    // The .xlsx magic prefix is "PK" (ZIP archive).
    expect(result.buffer[0]).toBe(0x50);
    expect(result.buffer[1]).toBe(0x4b);
  });

  it("buildSheetBuffer succeeds for both sides", async () => {
    const orderId = await seedFactoryFixture("2026-05-01");
    await approveFactoryOrder({ orderId, approvedBy: "test" });

    const us = await buildSheetBuffer({ orderId, side: "US" });
    const intl = await buildSheetBuffer({ orderId, side: "INTL" });
    expect(us.filename).toMatch(/^SB -/);
    expect(intl.filename).toMatch(/^MV -/);
  });
});
