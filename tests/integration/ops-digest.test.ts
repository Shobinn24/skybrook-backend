import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { incomingReceipts, incomingShipments, rawPulls } from "@/lib/db/schema";
import { formatDigest, gatherOpsDigest, type DigestItem } from "@/lib/jobs/ops-digest";

describe("formatDigest", () => {
  it("headline counts attention items and lines carry the right marker", () => {
    const items: DigestItem[] = [
      { label: "A", ok: true, detail: "fine" },
      { label: "B", ok: false, detail: "broken" },
      { label: "C", ok: false, detail: "also broken" },
    ];
    const text = formatDigest("2026-07-14", items);
    expect(text).toContain("2 items need attention");
    expect(text).toContain("✅ *A*: fine");
    expect(text).toContain("⚠️ *B*: broken");
  });

  it("all green headline", () => {
    const text = formatDigest("2026-07-14", [{ label: "A", ok: true, detail: "fine" }]);
    expect(text).toContain("all checks green");
  });
});

describe("gatherOpsDigest", () => {
  it("runs every check against the test DB without throwing", async () => {
    const items = await gatherOpsDigest(new Date("2026-07-14T09:00:00Z"));
    const labels = items.map((i) => i.label);
    expect(labels).toEqual([
      "Phantom bonus crossings",
      "SKUs missing unit cost",
      "Schema drift",
      "Data pulls",
      "FB history frozen",
      "Bonus awards",
      "Launches SKU leak",
      "New CS style codes",
      "Unreceipted arrivals",
      "Receipt ETA drift",
      "Open alerts",
      "Supermetrics queries",
    ]);
    // Every check produced a detail string; "check errored" means a query
    // is broken against the live schema, which is exactly what this guards.
    for (const i of items) {
      expect(i.detail.length).toBeGreaterThan(0);
      expect(i.detail).not.toContain("check errored");
    }
  });
});

describe("Receipt ETA drift check (N)", () => {
  it("flags an orphaned receipt beside an unreceived same-shipment wave, ignores matched receipts", async () => {
    await db.execute(sql`TRUNCATE TABLE raw_pulls, incoming_shipments, incoming_receipts CASCADE`);
    const [pull] = await db
      .insert(rawPulls)
      .values({
        source: "sheets_incoming",
        pullBatchId: randomUUID(),
        payload: {},
        rowCount: 0,
        schemaFingerprint: "test-fp",
      })
      .returning({ id: rawPulls.id });
    await db.insert(incomingShipments).values([
      // Drift case: sheet now says 07-15; the receipt below sits at the
      // pre-edit ETA 07-12, which no longer exists on the sheet.
      { sku: "ev-x-s", destination: "CN", shipmentName: "KAI TEST A", quantity: 100, expectedArrival: "2026-07-15", status: "po", sourcePullId: pull.id, sourceRowRef: "t1" },
      // Healthy multi-wave case: both waves on the sheet, one received at
      // its own matching ETA — must NOT flag.
      { sku: "ev-y-s", destination: "US", shipmentName: "KAI TEST B", quantity: 50, expectedArrival: "2026-07-10", status: "po", sourcePullId: pull.id, sourceRowRef: "t2" },
      { sku: "ev-y-m", destination: "US", shipmentName: "KAI TEST B", quantity: 60, expectedArrival: "2026-07-18", status: "po", sourcePullId: pull.id, sourceRowRef: "t3" },
    ]);
    await db.insert(incomingReceipts).values([
      { shipmentName: "KAI TEST A", destination: "CN", expectedArrival: "2026-07-12" },
      { shipmentName: "KAI TEST B", destination: "US", expectedArrival: "2026-07-10" },
    ]);

    const items = await gatherOpsDigest(new Date("2026-07-22T09:00:00Z"));
    const drift = items.find((i) => i.label === "Receipt ETA drift");
    expect(drift).toBeDefined();
    expect(drift!.ok).toBe(false);
    expect(drift!.detail).toContain("KAI TEST A CN");
    expect(drift!.detail).toContain("07/12");
    expect(drift!.detail).toContain("07/15");
    expect(drift!.detail).not.toContain("KAI TEST B");
  });
});
