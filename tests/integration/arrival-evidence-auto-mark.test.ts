import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  incomingReceipts,
  incomingShipments,
  rawPulls,
  stockSnapshots,
} from "@/lib/db/schema";
import { runArrivalEvidenceCheck } from "@/lib/jobs/arrival-evidence-check";
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

async function seedShipment(opts: {
  name: string;
  destination: "US" | "CN";
  sku: string;
  qty: number;
  eta: string;
  rawId: string;
}) {
  await db.insert(incomingShipments).values({
    sku: opts.sku,
    destination: opts.destination,
    shipmentName: opts.name,
    quantity: opts.qty,
    expectedArrival: opts.eta,
    status: "po",
    sourcePullId: opts.rawId,
    sourceRowRef: `${opts.name}-${opts.sku}`,
  });
}

async function seedSnap(opts: {
  sku: string;
  location: "US" | "CN";
  date: string;
  onHand: number;
  rawId: string;
}) {
  await db.insert(stockSnapshots).values({
    sku: opts.sku,
    location: opts.location,
    snapshotDate: opts.date,
    onHand: opts.onHand,
    sourcePullId: opts.rawId,
  });
}

describe("runArrivalEvidenceCheck — auto-mark vs flag partitioning", () => {
  beforeAll(() => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set in test env");
  });

  beforeEach(async () => {
    await resetDb();
  });

  it("auto-marks an overdue PO with >=50% cumulative-since-ETA arrival AND no competing PO", async () => {
    // Mirrors the 2026-05-29 KAI 25 CN shape: single PO, single SKU,
    // stock jumped substantially after ETA, no other expected POs.
    const rawId = await seedRawPull();
    await seedShipment({
      name: "KAI Test",
      destination: "CN",
      sku: "ev-hw-l",
      qty: 1000,
      eta: "2026-05-10",
      rawId,
    });
    // baseline (pre-ETA): 100 on-hand
    await seedSnap({
      sku: "ev-hw-l",
      location: "CN",
      date: "2026-05-08",
      onHand: 100,
      rawId,
    });
    // post-ETA: 900 on-hand → +800 = 80% of 1000-unit PO
    await seedSnap({
      sku: "ev-hw-l",
      location: "CN",
      date: "2026-05-25",
      onHand: 900,
      rawId,
    });

    const result = await runArrivalEvidenceCheck({ asOfDate: "2026-05-29" });

    expect(result.autoMarked).toHaveLength(1);
    expect(result.autoMarked[0].shipmentName).toBe("KAI Test");
    expect(result.flagged).toHaveLength(0);

    // Receipt row was actually written.
    const receipts = await db
      .select()
      .from(incomingReceipts)
      .where(eq(incomingReceipts.shipmentName, "KAI Test"));
    expect(receipts).toHaveLength(1);
    expect(receipts[0].note).toMatch(/Auto-marked/);
    expect(receipts[0].note).toMatch(/80%/);
  });

  it("flags (does NOT auto-mark) a PO whose arrival is between 25% and 50%", async () => {
    const rawId = await seedRawPull();
    await seedShipment({
      name: "Partial KAI",
      destination: "CN",
      sku: "ev-hw-m",
      qty: 1000,
      eta: "2026-05-10",
      rawId,
    });
    await seedSnap({
      sku: "ev-hw-m",
      location: "CN",
      date: "2026-05-08",
      onHand: 0,
      rawId,
    });
    // +350 = 35% — above alert threshold (25%), below auto-mark (50%)
    await seedSnap({
      sku: "ev-hw-m",
      location: "CN",
      date: "2026-05-25",
      onHand: 350,
      rawId,
    });

    const result = await runArrivalEvidenceCheck({ asOfDate: "2026-05-29" });

    expect(result.flagged).toHaveLength(1);
    expect(result.flagged[0].shipmentName).toBe("Partial KAI");
    expect(result.autoMarked).toHaveLength(0);

    // No receipt row written.
    const receipts = await db
      .select()
      .from(incomingReceipts)
      .where(eq(incomingReceipts.shipmentName, "Partial KAI"));
    expect(receipts).toHaveLength(0);
  });

  it("does NOT auto-mark when a NEAR-TERM competing PO is expected (different name, ETA within 7d horizon)", async () => {
    // Real attribution risk: KAI 25 overdue, KAI 26 also expected
    // very soon — incoming stock could be either.
    const rawId = await seedRawPull();
    await seedShipment({
      name: "KAI 25",
      destination: "CN",
      sku: "ev-hw-xl",
      qty: 500,
      eta: "2026-05-10",
      rawId,
    });
    // Different name, ETA in 3 days = inside the 7-day competing
    // horizon. SHOULD block auto-mark.
    await seedShipment({
      name: "KAI 26",
      destination: "CN",
      sku: "ev-hw-xl",
      qty: 500,
      eta: "2026-06-01",
      rawId,
    });
    await seedSnap({
      sku: "ev-hw-xl",
      location: "CN",
      date: "2026-05-08",
      onHand: 0,
      rawId,
    });
    await seedSnap({
      sku: "ev-hw-xl",
      location: "CN",
      date: "2026-05-25",
      onHand: 500,
      rawId,
    });

    const result = await runArrivalEvidenceCheck({ asOfDate: "2026-05-29" });

    expect(result.autoMarked).toHaveLength(0);
    expect(result.flagged.find((e) => e.shipmentName === "KAI 25")).toBeDefined();
  });

  it("DOES auto-mark when the only competing PO is FAR-FUTURE (beyond 7d competing-horizon)", async () => {
    // The 2026-05-29 prod case: Grace added KAI 26 / KAI 27 weeks
    // out for the same SKUs that the overdue 5/10 + 5/15 KAIs were
    // expecting. Stock landed in May obviously belongs to the
    // overdue POs, not to a July restock. The window guard fixes
    // this — only ETAs within 7d of today count as competing.
    const rawId = await seedRawPull();
    await seedShipment({
      name: "KAI 25",
      destination: "CN",
      sku: "ev-hw-xl",
      qty: 500,
      eta: "2026-05-10",
      rawId,
    });
    // Different name, ETA in 6 WEEKS — irrelevant for May arrivals.
    // Should NOT block auto-mark on KAI 25.
    await seedShipment({
      name: "KAI 27",
      destination: "CN",
      sku: "ev-hw-xl",
      qty: 200,
      eta: "2026-07-11",
      rawId,
    });
    await seedSnap({
      sku: "ev-hw-xl",
      location: "CN",
      date: "2026-05-08",
      onHand: 0,
      rawId,
    });
    await seedSnap({
      sku: "ev-hw-xl",
      location: "CN",
      date: "2026-05-25",
      onHand: 500,
      rawId,
    });

    const result = await runArrivalEvidenceCheck({ asOfDate: "2026-05-29" });

    expect(result.autoMarked).toHaveLength(1);
    expect(result.autoMarked[0].shipmentName).toBe("KAI 25");
    expect(result.flagged).toHaveLength(0);
  });

  it("treats sub-shipments under the SAME shipmentName as non-competing (KAI Sec Mar26 split case)", async () => {
    // Real-world: KAI Sec Mar26 has two CN ETAs (5/10 + 5/15) for some
    // SKUs. Both should be auto-markable independently when arrival
    // evidence supports it — same logical PO, no attribution conflict.
    const rawId = await seedRawPull();
    await seedShipment({
      name: "KAI Sec Mar26",
      destination: "CN",
      sku: "ev-hrshort-5x-xl",
      qty: 500,
      eta: "2026-05-10",
      rawId,
    });
    await seedShipment({
      name: "KAI Sec Mar26",
      destination: "CN",
      sku: "ev-hrshort-5x-xl",
      qty: 250,
      eta: "2026-05-15",
      rawId,
    });
    await seedSnap({
      sku: "ev-hrshort-5x-xl",
      location: "CN",
      date: "2026-05-08",
      onHand: 0,
      rawId,
    });
    // +500 by 5/14 — would attribute fully to the 5/10 PO via the
    // pre-ETA-baseline rule.
    await seedSnap({
      sku: "ev-hrshort-5x-xl",
      location: "CN",
      date: "2026-05-14",
      onHand: 500,
      rawId,
    });
    // +250 more by 5/25 → both sub-POs should be auto-markable.
    await seedSnap({
      sku: "ev-hrshort-5x-xl",
      location: "CN",
      date: "2026-05-25",
      onHand: 750,
      rawId,
    });

    const result = await runArrivalEvidenceCheck({ asOfDate: "2026-05-29" });

    expect(result.autoMarked.length).toBeGreaterThanOrEqual(1);
    expect(result.autoMarked.map((e) => e.shipmentName)).toEqual(
      expect.arrayContaining(["KAI Sec Mar26"]),
    );
  });

  it("is a no-op when no overdue shipments exist", async () => {
    const result = await runArrivalEvidenceCheck({ asOfDate: "2026-05-29" });
    expect(result).toEqual({ flagged: [], autoMarked: [] });
  });

  it("skips shipments that are already marked received (no double-receipt)", async () => {
    const rawId = await seedRawPull();
    await seedShipment({
      name: "Already Received",
      destination: "CN",
      sku: "ev-hw-3xl",
      qty: 200,
      eta: "2026-05-10",
      rawId,
    });
    await seedSnap({
      sku: "ev-hw-3xl",
      location: "CN",
      date: "2026-05-08",
      onHand: 0,
      rawId,
    });
    await seedSnap({
      sku: "ev-hw-3xl",
      location: "CN",
      date: "2026-05-25",
      onHand: 200,
      rawId,
    });
    // Pre-existing manual receipt — should NOT show up in either list.
    await db.insert(incomingReceipts).values({
      shipmentName: "Already Received",
      destination: "CN",
      expectedArrival: "2026-05-10",
      note: "manual: pre-existing",
    });

    const result = await runArrivalEvidenceCheck({ asOfDate: "2026-05-29" });

    expect(result.autoMarked).toHaveLength(0);
    expect(result.flagged).toHaveLength(0);
  });
});
