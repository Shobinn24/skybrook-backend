import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { db } from "@/lib/db";
import {
  dailySales,
  incomingShipments,
  rawPulls,
  skus,
  stockSnapshots,
} from "@/lib/db/schema";
import { getSustainabilityTimeline } from "@/lib/queries/sustainability-timeline";
import { resetDb } from "@/tests/fixtures/seed";

/**
 * The /sustainability page reads from this query — it walks every SKU
 * at the location through the upcoming shipment columns and projects
 * stock-left-at-ETA + run-out date. End-to-end shape pinned here so
 * the page contract can't drift silently.
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

async function seedSku(opts: {
  sku: string;
  productName: string;
  unitCostUsd?: string;
}): Promise<void> {
  await db.insert(skus).values({
    sku: opts.sku,
    productName: opts.productName,
    productLine: null,
    unitCostUsd: opts.unitCostUsd ?? "1.00",
    firstSeenAt: "2026-01-01",
    active: true,
  });
}

async function seedStock(opts: {
  sku: string;
  location: "US" | "CN";
  onHand: number;
  date: string;
}): Promise<void> {
  const rawId = await insertRawPull();
  await db.insert(stockSnapshots).values({
    sku: opts.sku,
    location: opts.location,
    snapshotDate: opts.date,
    onHand: opts.onHand,
    sourcePullId: rawId,
  });
}

async function seedSale(opts: {
  sku: string;
  channel: "shopify_us" | "shopify_intl";
  date: string;
  units: number;
  netSalesUsd?: string;
}): Promise<void> {
  const rawId = await insertRawPull();
  await db.insert(dailySales).values({
    sku: opts.sku,
    channel: opts.channel,
    salesDate: opts.date,
    unitsSold: opts.units,
    netSalesUsd: opts.netSalesUsd ?? "0",
    sourcePullId: rawId,
  });
}

async function seedShipment(opts: {
  sku: string;
  destination: "US" | "CN";
  shipmentName: string;
  eta: string;
  qty: number;
  status?: "po" | "dispatched" | "in_transit" | "arrived";
}): Promise<void> {
  const rawId = await insertRawPull();
  await db.insert(incomingShipments).values({
    sku: opts.sku,
    destination: opts.destination,
    shipmentName: opts.shipmentName,
    quantity: opts.qty,
    expectedArrival: opts.eta,
    status: opts.status ?? "po",
    sourcePullId: rawId,
    sourceRowRef: "test",
  });
}

describe("getSustainabilityTimeline (integration)", () => {
  beforeAll(() => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set in test env");
  });

  beforeEach(async () => {
    await resetDb();
  });

  it("aligns every SKU's projection to the GLOBAL shipment columns", async () => {
    // Two SKUs, one shipment includes both, the second includes only
    // SKU A. Both SKUs' projections should have entries for BOTH
    // shipment columns — SKU B gets a 0-qty row at the second column.
    await seedSku({ sku: "ev-a-l", productName: "Style A" });
    await seedSku({ sku: "ev-b-l", productName: "Style B" });
    await seedStock({ sku: "ev-a-l", location: "US", onHand: 100, date: "2026-04-28" });
    await seedStock({ sku: "ev-b-l", location: "US", onHand: 50, date: "2026-04-28" });
    await seedShipment({
      sku: "ev-a-l",
      destination: "US",
      shipmentName: "PO-1",
      eta: "2026-05-15",
      qty: 200,
    });
    await seedShipment({
      sku: "ev-b-l",
      destination: "US",
      shipmentName: "PO-1",
      eta: "2026-05-15",
      qty: 100,
    });
    await seedShipment({
      sku: "ev-a-l",
      destination: "US",
      shipmentName: "PO-2",
      eta: "2026-06-15",
      qty: 50,
    });

    const result = await getSustainabilityTimeline({
      location: "US",
      today: "2026-04-28",
      windowDays: 14,
    });

    // 2 real shipment columns + 1 synthetic +30d outlook column.
    expect(result.shipmentColumns).toHaveLength(3);
    expect(result.shipmentColumns.map((c) => c.shipmentName)).toEqual([
      "PO-1",
      "PO-2",
      "+30d outlook",
    ]);
    expect(result.shipmentColumns[2].kind).toBe("terminal");

    const a = result.rows.find((r) => r.sku === "ev-a-l");
    const b = result.rows.find((r) => r.sku === "ev-b-l");
    // 2 real projections + the trailing +30d outlook row.
    expect(a?.projections).toHaveLength(3);
    expect(b?.projections).toHaveLength(3);
    // SKU B gets a 0-qty projection at PO-2 (it isn't in that shipment).
    expect(b?.projections[1].shipmentQty).toBe(0);
    expect(b?.projections[1].shipmentName).toBe("PO-2");
  });

  it("excludes already-arrived shipments from the column list", async () => {
    await seedSku({ sku: "ev-a-l", productName: "Style A" });
    await seedStock({ sku: "ev-a-l", location: "US", onHand: 100, date: "2026-04-28" });
    await seedShipment({
      sku: "ev-a-l",
      destination: "US",
      shipmentName: "Past-PO",
      eta: "2026-04-01",
      qty: 50,
      status: "arrived",
    });
    await seedShipment({
      sku: "ev-a-l",
      destination: "US",
      shipmentName: "Future-PO",
      eta: "2026-05-15",
      qty: 100,
    });

    const result = await getSustainabilityTimeline({
      location: "US",
      today: "2026-04-28",
    });
    // Real shipment + +30d outlook terminal column.
    expect(result.shipmentColumns.map((c) => c.shipmentName)).toEqual([
      "Future-PO",
      "+30d outlook",
    ]);
  });

  it("computes prorated 30D and currentStock from sales + stock", async () => {
    await seedSku({ sku: "ev-a-l", productName: "Style A" });
    await seedStock({ sku: "ev-a-l", location: "US", onHand: 200, date: "2026-04-28" });
    // 14 sales over the window → prorated 30D = 30
    for (let i = 0; i < 14; i++) {
      await seedSale({
        sku: "ev-a-l",
        channel: "shopify_us",
        date: `2026-04-${15 + i < 10 ? "0" : ""}${15 + i}`,
        units: 1,
      });
    }
    await seedShipment({
      sku: "ev-a-l",
      destination: "US",
      shipmentName: "PO-1",
      eta: "2026-05-15",
      qty: 50,
    });

    const result = await getSustainabilityTimeline({
      location: "US",
      today: "2026-04-28",
      windowDays: 14,
    });
    const row = result.rows[0];
    expect(row.salesInWindow).toBe(14);
    expect(row.proratedThirtyD).toBe(30);
    expect(row.currentStock).toBe(200);
  });

  it("respects location filter for stock + sales + shipments", async () => {
    await seedSku({ sku: "ev-a-l", productName: "Style A" });
    await seedStock({ sku: "ev-a-l", location: "US", onHand: 100, date: "2026-04-28" });
    await seedStock({ sku: "ev-a-l", location: "CN", onHand: 50, date: "2026-04-28" });
    await seedSale({ sku: "ev-a-l", channel: "shopify_us", date: "2026-04-20", units: 7 });
    await seedSale({ sku: "ev-a-l", channel: "shopify_intl", date: "2026-04-20", units: 3 });
    await seedShipment({
      sku: "ev-a-l",
      destination: "US",
      shipmentName: "US-PO",
      eta: "2026-05-15",
      qty: 30,
    });
    await seedShipment({
      sku: "ev-a-l",
      destination: "CN",
      shipmentName: "CN-PO",
      eta: "2026-05-20",
      qty: 20,
    });

    const us = await getSustainabilityTimeline({
      location: "US",
      today: "2026-04-28",
      windowDays: 14,
    });
    expect(us.rows[0].currentStock).toBe(100);
    expect(us.rows[0].salesInWindow).toBe(7);
    expect(us.shipmentColumns.map((c) => c.shipmentName)).toEqual([
      "US-PO",
      "+30d outlook",
    ]);

    const cn = await getSustainabilityTimeline({
      location: "CN",
      today: "2026-04-28",
      windowDays: 14,
    });
    expect(cn.rows[0].currentStock).toBe(50);
    expect(cn.rows[0].salesInWindow).toBe(3);
    expect(cn.shipmentColumns.map((c) => c.shipmentName)).toEqual([
      "CN-PO",
      "+30d outlook",
    ]);
  });

  it("drops SKUs with no stock and no upcoming shipments", async () => {
    await seedSku({ sku: "ev-orphan", productName: "Orphan" });
    // Only sales — no stock, no shipments. Should not appear.
    await seedSale({
      sku: "ev-orphan",
      channel: "shopify_us",
      date: "2026-04-20",
      units: 5,
    });
    const result = await getSustainabilityTimeline({
      location: "US",
      today: "2026-04-28",
    });
    expect(result.rows).toEqual([]);
  });

  it("returns empty result when nothing exists at the location", async () => {
    const result = await getSustainabilityTimeline({
      location: "US",
      today: "2026-04-28",
    });
    expect(result.rows).toEqual([]);
    expect(result.shipmentColumns).toEqual([]);
    expect(result.windowStart).toBe("2026-04-15");
    expect(result.windowEnd).toBe("2026-04-28");
  });

  it("aggregates net sales $ per SKU over the same window as units", async () => {
    await seedSku({ sku: "ev-a-l", productName: "Style A" });
    await seedStock({ sku: "ev-a-l", location: "US", onHand: 100, date: "2026-04-28" });
    await seedSale({
      sku: "ev-a-l",
      channel: "shopify_us",
      date: "2026-04-20",
      units: 5,
      netSalesUsd: "150.00",
    });
    await seedSale({
      sku: "ev-a-l",
      channel: "shopify_us",
      date: "2026-04-22",
      units: 3,
      netSalesUsd: "90.00",
    });
    // Cross-channel sale is excluded (different warehouse).
    await seedSale({
      sku: "ev-a-l",
      channel: "shopify_intl",
      date: "2026-04-22",
      units: 99,
      netSalesUsd: "9999.00",
    });
    await seedShipment({
      sku: "ev-a-l",
      destination: "US",
      shipmentName: "PO-1",
      eta: "2026-05-15",
      qty: 50,
    });

    const result = await getSustainabilityTimeline({
      location: "US",
      today: "2026-04-28",
      windowDays: 14,
    });
    expect(result.rows[0].salesInWindow).toBe(8);
    expect(result.rows[0].salesDollarsInWindow).toBe(240);
  });

  it("appends a +30d outlook terminal column 30 days after the last shipment", async () => {
    await seedSku({ sku: "ev-a-l", productName: "Style A" });
    await seedStock({ sku: "ev-a-l", location: "US", onHand: 100, date: "2026-04-28" });
    await seedShipment({
      sku: "ev-a-l",
      destination: "US",
      shipmentName: "PO-1",
      eta: "2026-05-15",
      qty: 200,
    });

    const result = await getSustainabilityTimeline({
      location: "US",
      today: "2026-04-28",
    });
    expect(result.shipmentColumns).toHaveLength(2);
    const terminal = result.shipmentColumns[1];
    expect(terminal.kind).toBe("terminal");
    // 30 days after 2026-05-15 = 2026-06-14.
    expect(terminal.eta).toBe("2026-06-14");
    // The synthetic projection row at the terminal column has 0 qty
    // so afterReceiptStock equals stockLeftAtEta.
    const proj = result.rows[0].projections[1];
    expect(proj.shipmentQty).toBe(0);
    expect(proj.afterReceiptStock).toBe(proj.stockLeftAtEta);
  });

  it("includes overdue POs within the 14-day grace window with isOverdue flag", async () => {
    await seedSku({ sku: "ev-a-l", productName: "Style A" });
    await seedStock({ sku: "ev-a-l", location: "US", onHand: 100, date: "2026-04-28" });
    // 5 days late — within the 14-day grace
    await seedShipment({
      sku: "ev-a-l",
      destination: "US",
      shipmentName: "Late-PO",
      eta: "2026-04-23",
      qty: 50,
    });

    const result = await getSustainabilityTimeline({
      location: "US",
      today: "2026-04-28",
    });

    // Late-PO appears as the first column (sorted by ETA ASC), terminal +30d after.
    expect(result.shipmentColumns).toHaveLength(2);
    expect(result.shipmentColumns[0]).toMatchObject({
      shipmentName: "Late-PO",
      eta: "2026-04-23",
      isOverdue: true,
    });
    expect(result.shipmentColumns[0].daysFromToday).toBeLessThan(0);
    expect(result.excludedOverdue).toEqual({ count: 0, totalQuantity: 0 });
    // The qty still credits the projection — 50 units land at the overdue
    // column, walkProjection clamps past ETAs to today's window.
    expect(result.rows[0].projections[0].shipmentQty).toBe(50);
  });

  it("excludes overdue POs beyond grace and surfaces them in excludedOverdue", async () => {
    await seedSku({ sku: "ev-a-l", productName: "Style A" });
    await seedStock({ sku: "ev-a-l", location: "US", onHand: 100, date: "2026-04-28" });
    // 20 days late — past the 14-day grace cutoff
    await seedShipment({
      sku: "ev-a-l",
      destination: "US",
      shipmentName: "Stale-PO",
      eta: "2026-04-08",
      qty: 200,
    });

    const result = await getSustainabilityTimeline({
      location: "US",
      today: "2026-04-28",
    });

    // No projection columns (only stock, no in-grace shipments).
    expect(result.shipmentColumns).toHaveLength(0);
    expect(result.excludedOverdue).toEqual({ count: 1, totalQuantity: 200 });
  });
});
