import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import {
  dailySales,
  incomingReceipts,
  incomingShipments,
  rawPulls,
  stockSnapshots,
} from "@/lib/db/schema";
import { runAutoReceiptBackfill } from "@/lib/jobs/auto-receipt-backfill";
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

describe("runAutoReceiptBackfill", () => {
  beforeAll(() => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set in test env");
  });

  beforeEach(async () => {
    await resetDb();
  });

  it("detects a historical delivery and stamps received_at = the day stock jumped", async () => {
    const pullId = await seedRawPull();
    // Snapshots: stock for ev-mens-l at US was 50 on 4/20, jumped to 250 on 4/21.
    await db.insert(stockSnapshots).values([
      { sku: "ev-mens-l", location: "US", snapshotDate: "2026-04-20", onHand: 50, sourcePullId: pullId },
      { sku: "ev-mens-l", location: "US", snapshotDate: "2026-04-21", onHand: 250, sourcePullId: pullId },
    ]);
    // PO 200u with ETA 4/19 (overdue by the time of the jump)
    await db.insert(incomingShipments).values([
      { sku: "ev-mens-l", destination: "US", shipmentName: "KAI Mens Apr1", quantity: 200, expectedArrival: "2026-04-19", status: "po", sourcePullId: pullId, sourceRowRef: "row-1" },
    ]);

    const result = await runAutoReceiptBackfill({ daysBack: 30 });
    expect(result.shipmentsMatched).toBe(1);
    expect(result.inserted).toBe(1);

    const receipts = await db.select().from(incomingReceipts);
    expect(receipts).toHaveLength(1);
    expect(receipts[0].shipmentName).toBe("KAI Mens Apr1");
    expect(receipts[0].destination).toBe("US");
    expect(receipts[0].expectedArrival).toBe("2026-04-19");
    // Stamped with the day stock jumped (4/21), not when the script ran.
    expect(receipts[0].receivedAt.toISOString().slice(0, 10)).toBe("2026-04-21");
    expect(receipts[0].note).toMatch(/Backfill auto-detected 2026-04-21/i);
  });

  it("is idempotent — re-running doesn't duplicate", async () => {
    const pullId = await seedRawPull();
    await db.insert(stockSnapshots).values([
      { sku: "ev-mens-l", location: "US", snapshotDate: "2026-04-20", onHand: 50, sourcePullId: pullId },
      { sku: "ev-mens-l", location: "US", snapshotDate: "2026-04-21", onHand: 250, sourcePullId: pullId },
    ]);
    await db.insert(incomingShipments).values([
      { sku: "ev-mens-l", destination: "US", shipmentName: "KAI Mens Apr1", quantity: 200, expectedArrival: "2026-04-19", status: "po", sourcePullId: pullId, sourceRowRef: "row-1" },
    ]);

    const first = await runAutoReceiptBackfill({ daysBack: 30 });
    const second = await runAutoReceiptBackfill({ daysBack: 30 });
    expect(first.inserted).toBe(1);
    expect(second.inserted).toBe(0); // already received, skipped

    const receipts = await db.select().from(incomingReceipts);
    expect(receipts).toHaveLength(1);
  });

  it("skips POs already manually received", async () => {
    const pullId = await seedRawPull();
    await db.insert(stockSnapshots).values([
      { sku: "ev-mens-l", location: "US", snapshotDate: "2026-04-20", onHand: 50, sourcePullId: pullId },
      { sku: "ev-mens-l", location: "US", snapshotDate: "2026-04-21", onHand: 250, sourcePullId: pullId },
    ]);
    await db.insert(incomingShipments).values([
      { sku: "ev-mens-l", destination: "US", shipmentName: "KAI Mens Apr1", quantity: 200, expectedArrival: "2026-04-19", status: "po", sourcePullId: pullId, sourceRowRef: "row-1" },
    ]);
    // Pre-existing manual receipt
    await db.insert(incomingReceipts).values({
      shipmentName: "KAI Mens Apr1",
      destination: "US",
      expectedArrival: "2026-04-19",
      note: "Manually marked by Scott",
    });

    const result = await runAutoReceiptBackfill({ daysBack: 30 });
    expect(result.inserted).toBe(0);

    const receipts = await db.select().from(incomingReceipts);
    expect(receipts).toHaveLength(1);
    expect(receipts[0].note).toBe("Manually marked by Scott");
  });

  it("returns gracefully when there's only one snapshot day in the window", async () => {
    const pullId = await seedRawPull();
    await db.insert(stockSnapshots).values([
      { sku: "ev-mens-l", location: "US", snapshotDate: "2026-04-21", onHand: 250, sourcePullId: pullId },
    ]);

    const result = await runAutoReceiptBackfill({ daysBack: 30 });
    expect(result.pairsScanned).toBe(0);
    expect(result.inserted).toBe(0);
  });

  it("walks multi-day history and matches the right day for the jump", async () => {
    const pullId = await seedRawPull();
    // Stock: 50 on 4/18, 50 on 4/19, 50 on 4/20, 250 on 4/21 (delivery day)
    await db.insert(stockSnapshots).values([
      { sku: "ev-mens-l", location: "US", snapshotDate: "2026-04-18", onHand: 50, sourcePullId: pullId },
      { sku: "ev-mens-l", location: "US", snapshotDate: "2026-04-19", onHand: 50, sourcePullId: pullId },
      { sku: "ev-mens-l", location: "US", snapshotDate: "2026-04-20", onHand: 50, sourcePullId: pullId },
      { sku: "ev-mens-l", location: "US", snapshotDate: "2026-04-21", onHand: 250, sourcePullId: pullId },
    ]);
    await db.insert(incomingShipments).values([
      { sku: "ev-mens-l", destination: "US", shipmentName: "KAI Mens Apr1", quantity: 200, expectedArrival: "2026-04-19", status: "po", sourcePullId: pullId, sourceRowRef: "row-1" },
    ]);

    const result = await runAutoReceiptBackfill({ daysBack: 30 });
    expect(result.pairsScanned).toBe(3); // 4/18→19, 4/19→20, 4/20→21
    expect(result.inserted).toBe(1);

    const receipts = await db.select().from(incomingReceipts);
    expect(receipts).toHaveLength(1);
    expect(receipts[0].receivedAt.toISOString().slice(0, 10)).toBe("2026-04-21");
  });

  it("netting same-day sales — partial-sold delivery still matches", async () => {
    const pullId = await seedRawPull();
    // Stock 50 → 220 (raw +170) but 30 sold same day → adjusted 200, matches 200-unit PO.
    await db.insert(stockSnapshots).values([
      { sku: "ev-mens-l", location: "US", snapshotDate: "2026-04-20", onHand: 50, sourcePullId: pullId },
      { sku: "ev-mens-l", location: "US", snapshotDate: "2026-04-21", onHand: 220, sourcePullId: pullId },
    ]);
    await db.insert(dailySales).values([
      {
        sku: "ev-mens-l",
        salesDate: "2026-04-21",
        channel: "shopify_us",
        routedLocation: "US",
        unitsSold: 30,
        netSalesUsd: "0",
        sourcePullId: pullId,
      },
    ]);
    await db.insert(incomingShipments).values([
      { sku: "ev-mens-l", destination: "US", shipmentName: "KAI Mens Apr1", quantity: 200, expectedArrival: "2026-04-19", status: "po", sourcePullId: pullId, sourceRowRef: "row-1" },
    ]);

    const result = await runAutoReceiptBackfill({ daysBack: 30 });
    expect(result.inserted).toBe(1);
  });
});
