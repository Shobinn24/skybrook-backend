import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { db } from "@/lib/db";
import {
  incomingReceipts,
  incomingShipments,
  rawPulls,
  skus,
} from "@/lib/db/schema";
import { getIncomingShipmentsView } from "@/lib/queries/incoming";
import { resetDb } from "@/tests/fixtures/seed";

/**
 * Incoming shipments view (SPEC §5.7 q3) is now driven by the
 * `incoming_receipts` table — receipts override the date-based status
 * decision so delivered-but-not-stocked POs stay visible until Scott
 * confirms them. These tests pin that contract.
 */

async function insertRawPull(): Promise<string> {
  const [r] = await db
    .insert(rawPulls)
    .values({
      source: "sheets_incoming",
      pullBatchId: randomUUID(),
      payload: {},
      rowCount: 0,
      schemaFingerprint: "fp",
    })
    .returning({ id: rawPulls.id });
  return r.id;
}

async function seedShipments(rows: Array<{
  sku: string;
  destination: "US" | "CN";
  shipmentName: string;
  quantity: number;
  expectedArrival: string;
  productName?: string;
  productLine?: string;
}>): Promise<void> {
  const rawId = await insertRawPull();
  const seenSkus = new Set<string>();
  for (const r of rows) {
    if (!seenSkus.has(r.sku)) {
      seenSkus.add(r.sku);
      await db.insert(skus).values({
        sku: r.sku,
        productName: r.productName ?? r.sku,
        productLine: r.productLine ?? "Core",
        unitCostUsd: "5",
        firstSeenAt: "2026-01-01",
        active: true,
      });
    }
    await db.insert(incomingShipments).values({
      sku: r.sku,
      destination: r.destination,
      shipmentName: r.shipmentName,
      quantity: r.quantity,
      expectedArrival: r.expectedArrival,
      status: "po", // parser now always writes 'po'
      sourcePullId: rawId,
      sourceRowRef: `${r.shipmentName}:${r.sku}`,
    });
  }
}

async function markReceived(input: {
  shipmentName: string;
  destination: "US" | "CN";
  expectedArrival: string;
}): Promise<void> {
  await db.insert(incomingReceipts).values(input);
}

describe("getIncomingShipmentsView", () => {
  beforeAll(() => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set in test env");
  });

  beforeEach(async () => {
    await resetDb();
  });

  it("returns rows sorted by expected arrival ascending", async () => {
    await seedShipments([
      { sku: "EV-A", destination: "US", shipmentName: "PO-3", quantity: 100, expectedArrival: "2026-06-01" },
      { sku: "EV-A", destination: "US", shipmentName: "PO-1", quantity: 100, expectedArrival: "2026-04-30" },
      { sku: "EV-A", destination: "US", shipmentName: "PO-2", quantity: 100, expectedArrival: "2026-05-15" },
    ]);

    const result = await getIncomingShipmentsView({ asOfDate: "2026-04-01" });
    expect(result.rows.map((r) => r.shipmentName)).toEqual(["PO-1", "PO-2", "PO-3"]);
    expect(result.summary.nextArrival).toBe("2026-04-30");
  });

  it("computes pending vs overdue from ETA against asOfDate", async () => {
    await seedShipments([
      { sku: "EV-A", destination: "US", shipmentName: "future", quantity: 100, expectedArrival: "2026-06-01" },
      { sku: "EV-A", destination: "US", shipmentName: "today", quantity: 100, expectedArrival: "2026-05-05" },
      { sku: "EV-A", destination: "US", shipmentName: "past", quantity: 100, expectedArrival: "2026-04-15" },
    ]);

    const result = await getIncomingShipmentsView({ asOfDate: "2026-05-05" });
    const byName = Object.fromEntries(result.rows.map((r) => [r.shipmentName, r.displayStatus]));
    expect(byName).toEqual({
      past: "overdue",
      today: "pending", // ETA == today → not yet past
      future: "pending",
    });
    expect(result.summary.overdueCount).toBe(1);
  });

  it("hides received shipments by default and includes them when requested", async () => {
    await seedShipments([
      { sku: "EV-A", destination: "US", shipmentName: "PO-pending", quantity: 100, expectedArrival: "2026-05-15" },
      { sku: "EV-A", destination: "US", shipmentName: "PO-confirmed-arrival", quantity: 50, expectedArrival: "2026-04-10" },
    ]);
    await markReceived({ shipmentName: "PO-confirmed-arrival", destination: "US", expectedArrival: "2026-04-10" });

    const def = await getIncomingShipmentsView({ asOfDate: "2026-05-05" });
    expect(def.rows.map((r) => r.shipmentName)).toEqual(["PO-pending"]);
    expect(def.summary.totalUnits).toBe(100);

    const all = await getIncomingShipmentsView({ asOfDate: "2026-05-05", includeReceived: true });
    expect(all.rows).toHaveLength(2);
    expect(all.summary.totalUnits).toBe(150);
    const received = all.rows.find((r) => r.shipmentName === "PO-confirmed-arrival");
    expect(received?.displayStatus).toBe("received");
    expect(received?.receivedAt).not.toBeNull();
  });

  it("keeps overdue (ETA-passed but not confirmed) shipments visible by default", async () => {
    // The exact bug Scott flagged 2026-05-05: two INTL POs with 17 Apr ETA had
    // arrived per schedule but stock hadn't been counted yet. Pre-fix the
    // parser auto-flipped status to 'arrived' once today >= ETA, hiding them.
    // Now they stay visible as 'overdue' until Scott explicitly marks received.
    await seedShipments([
      { sku: "EV-A", destination: "CN", shipmentName: "KAI Sec Jan26", quantity: 175, expectedArrival: "2026-04-17" },
      { sku: "EV-A", destination: "CN", shipmentName: "KAI Boyshort Feb26 revised", quantity: 2201, expectedArrival: "2026-04-17" },
    ]);

    const result = await getIncomingShipmentsView({ asOfDate: "2026-05-05" });
    expect(result.rows.map((r) => r.shipmentName).sort()).toEqual([
      "KAI Boyshort Feb26 revised",
      "KAI Sec Jan26",
    ]);
    expect(result.rows.every((r) => r.displayStatus === "overdue")).toBe(true);
    expect(result.summary.overdueCount).toBe(2);
  });

  it("filters by destination warehouse", async () => {
    await seedShipments([
      { sku: "EV-A", destination: "US", shipmentName: "PO-US", quantity: 100, expectedArrival: "2026-05-15" },
      { sku: "EV-A", destination: "CN", shipmentName: "PO-CN", quantity: 200, expectedArrival: "2026-06-01" },
    ]);

    const us = await getIncomingShipmentsView({ destination: "US", asOfDate: "2026-05-05" });
    expect(us.rows.map((r) => r.shipmentName)).toEqual(["PO-US"]);
    expect(us.summary.totalUnits).toBe(100);

    const cn = await getIncomingShipmentsView({ destination: "CN", asOfDate: "2026-05-05" });
    expect(cn.rows.map((r) => r.shipmentName)).toEqual(["PO-CN"]);
    expect(cn.summary.totalUnits).toBe(200);
  });

  it("summary tracks total units, shipment count, distinct SKU count, next arrival, overdue count", async () => {
    await seedShipments([
      { sku: "EV-A", destination: "US", shipmentName: "PO-1", quantity: 100, expectedArrival: "2026-05-15" },
      { sku: "EV-A", destination: "CN", shipmentName: "PO-2", quantity: 200, expectedArrival: "2026-06-01" },
      { sku: "EV-B", destination: "CN", shipmentName: "PO-3", quantity: 50, expectedArrival: "2026-04-20" }, // overdue
    ]);

    const result = await getIncomingShipmentsView({ asOfDate: "2026-05-05" });
    expect(result.summary.totalUnits).toBe(350);
    expect(result.summary.shipmentCount).toBe(3);
    expect(result.summary.skuCount).toBe(2);
    expect(result.summary.nextArrival).toBe("2026-04-20");
    expect(result.summary.overdueCount).toBe(1);
  });

  it("returns empty result with null nextArrival when no shipments exist", async () => {
    const result = await getIncomingShipmentsView();
    expect(result.rows).toEqual([]);
    expect(result.summary).toEqual({
      totalUnits: 0,
      shipmentCount: 0,
      skuCount: 0,
      nextArrival: null,
      overdueCount: 0,
    });
  });

  it("joins SKU info so the table can render product name + line without N+1 lookups", async () => {
    await seedShipments([
      {
        sku: "EV-A",
        destination: "US",
        shipmentName: "PO-1",
        quantity: 100,
        expectedArrival: "2026-05-15",
        productName: "Alpha Hi-Waist",
        productLine: "Comfort Plus",
      },
    ]);

    const result = await getIncomingShipmentsView({ asOfDate: "2026-05-05" });
    expect(result.rows[0].productName).toBe("Alpha Hi-Waist");
    expect(result.rows[0].productLine).toBe("Comfort Plus");
  });

  it("receipt match is keyed on (shipmentName, destination, expectedArrival)", async () => {
    // Two PO lines share a name but differ in ETA. Receiving one must NOT
    // hide the other.
    await seedShipments([
      { sku: "EV-A", destination: "US", shipmentName: "KAI Sec Feb26", quantity: 100, expectedArrival: "2026-05-03" },
      { sku: "EV-A", destination: "US", shipmentName: "KAI Sec Feb26", quantity: 200, expectedArrival: "2026-05-20" },
    ]);
    await markReceived({ shipmentName: "KAI Sec Feb26", destination: "US", expectedArrival: "2026-05-03" });

    const result = await getIncomingShipmentsView({ asOfDate: "2026-05-05" });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].expectedArrival).toBe("2026-05-20");
  });
});
