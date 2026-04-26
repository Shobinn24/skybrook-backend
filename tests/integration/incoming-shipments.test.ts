import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { db } from "@/lib/db";
import { incomingShipments, rawPulls, skus } from "@/lib/db/schema";
import {
  getIncomingShipmentsView,
  PENDING_STATUSES,
} from "@/lib/queries/incoming";
import { resetDb } from "@/tests/fixtures/seed";

/**
 * Incoming shipments view (SPEC §5.7 q3) needs to surface pending POs
 * sorted by arrival date, hide already-arrived units by default, and
 * compute a useful KPI summary. These tests pin those contracts.
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
  status?: "po" | "dispatched" | "in_transit" | "arrived";
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
      status: r.status ?? "po",
      sourcePullId: rawId,
      sourceRowRef: `${r.shipmentName}:${r.sku}`,
    });
  }
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

    const result = await getIncomingShipmentsView();
    expect(result.rows.map((r) => r.shipmentName)).toEqual(["PO-1", "PO-2", "PO-3"]);
    expect(result.summary.nextArrival).toBe("2026-04-30");
  });

  it("hides arrived shipments by default and includes them when requested", async () => {
    await seedShipments([
      { sku: "EV-A", destination: "US", shipmentName: "PO-pending", quantity: 100, expectedArrival: "2026-05-01", status: "in_transit" },
      { sku: "EV-A", destination: "US", shipmentName: "PO-old", quantity: 50, expectedArrival: "2026-04-10", status: "arrived" },
    ]);

    const def = await getIncomingShipmentsView();
    expect(def.rows.map((r) => r.shipmentName)).toEqual(["PO-pending"]);
    expect(def.summary.totalUnits).toBe(100);

    const all = await getIncomingShipmentsView({ includeArrived: true });
    expect(all.rows).toHaveLength(2);
    expect(all.summary.totalUnits).toBe(150);
  });

  it("filters by destination warehouse", async () => {
    await seedShipments([
      { sku: "EV-A", destination: "US", shipmentName: "PO-US", quantity: 100, expectedArrival: "2026-05-01" },
      { sku: "EV-A", destination: "CN", shipmentName: "PO-CN", quantity: 200, expectedArrival: "2026-05-15" },
    ]);

    const us = await getIncomingShipmentsView({ destination: "US" });
    expect(us.rows.map((r) => r.shipmentName)).toEqual(["PO-US"]);
    expect(us.summary.totalUnits).toBe(100);

    const cn = await getIncomingShipmentsView({ destination: "CN" });
    expect(cn.rows.map((r) => r.shipmentName)).toEqual(["PO-CN"]);
    expect(cn.summary.totalUnits).toBe(200);
  });

  it("summary tracks total units, shipment count, distinct SKU count, and next arrival", async () => {
    await seedShipments([
      { sku: "EV-A", destination: "US", shipmentName: "PO-1", quantity: 100, expectedArrival: "2026-05-01" },
      { sku: "EV-A", destination: "CN", shipmentName: "PO-2", quantity: 200, expectedArrival: "2026-06-01" },
      { sku: "EV-B", destination: "CN", shipmentName: "PO-3", quantity: 50, expectedArrival: "2026-05-20" },
    ]);

    const result = await getIncomingShipmentsView();
    expect(result.summary.totalUnits).toBe(350);
    expect(result.summary.shipmentCount).toBe(3);
    expect(result.summary.skuCount).toBe(2);
    expect(result.summary.nextArrival).toBe("2026-05-01");
  });

  it("returns empty result with null nextArrival when no shipments exist", async () => {
    const result = await getIncomingShipmentsView();
    expect(result.rows).toEqual([]);
    expect(result.summary).toEqual({
      totalUnits: 0,
      shipmentCount: 0,
      skuCount: 0,
      nextArrival: null,
    });
  });

  it("joins SKU info so the table can render product name + line without N+1 lookups", async () => {
    await seedShipments([
      {
        sku: "EV-A",
        destination: "US",
        shipmentName: "PO-1",
        quantity: 100,
        expectedArrival: "2026-05-01",
        productName: "Alpha Hi-Waist",
        productLine: "Comfort Plus",
      },
    ]);

    const result = await getIncomingShipmentsView();
    expect(result.rows[0].productName).toBe("Alpha Hi-Waist");
    expect(result.rows[0].productLine).toBe("Comfort Plus");
  });

  it("exposes the canonical pending status set so the UI and query can't drift", () => {
    expect(PENDING_STATUSES).toEqual(["po", "dispatched", "in_transit"]);
  });
});
