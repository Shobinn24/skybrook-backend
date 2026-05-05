import { describe, expect, it } from "vitest";
import { detectAutoReceipts } from "@/lib/domain/auto-receipt";

const PO_BASE = {
  shipmentName: "KAI Mens Apr26",
  expectedArrival: "2026-04-30",
};

describe("detectAutoReceipts", () => {
  it("matches a single overdue PO when stock jumps by ~its quantity", () => {
    const out = detectAutoReceipts({
      todaySnapshots: [{ sku: "ev-mens-l", location: "US", onHand: 250 }],
      yesterdaySnapshots: [{ sku: "ev-mens-l", location: "US", onHand: 50 }],
      todaySales: [],
      overduePOs: [{ sku: "ev-mens-l", destination: "US", quantity: 200, ...PO_BASE }],
    });
    expect(out).toHaveLength(1);
    expect(out[0].shipmentName).toBe("KAI Mens Apr26");
    expect(out[0].detectedDelta).toBe(200);
    expect(out[0].poQuantity).toBe(200);
  });

  it("adds same-day sales back into delta so a partially-sold delivery still matches", () => {
    // Stock 50 → 220 looks like +170. But 30 sold today → adjusted = 200.
    // PO was 200 — should match.
    const out = detectAutoReceipts({
      todaySnapshots: [{ sku: "ev-mens-l", location: "US", onHand: 220 }],
      yesterdaySnapshots: [{ sku: "ev-mens-l", location: "US", onHand: 50 }],
      todaySales: [{ sku: "ev-mens-l", location: "US", units: 30 }],
      overduePOs: [{ sku: "ev-mens-l", destination: "US", quantity: 200, ...PO_BASE }],
    });
    expect(out).toHaveLength(1);
    expect(out[0].reasoning).toContain("+30 sold same day");
  });

  it("ignores stock decreases (sales-only days don't fire)", () => {
    const out = detectAutoReceipts({
      todaySnapshots: [{ sku: "ev-mens-l", location: "US", onHand: 30 }],
      yesterdaySnapshots: [{ sku: "ev-mens-l", location: "US", onHand: 50 }],
      todaySales: [],
      overduePOs: [{ sku: "ev-mens-l", destination: "US", quantity: 200, ...PO_BASE }],
    });
    expect(out).toEqual([]);
  });

  it("ignores tiny jumps (counting tweaks below MIN_ABSOLUTE_DELTA)", () => {
    const out = detectAutoReceipts({
      todaySnapshots: [{ sku: "ev-mens-l", location: "US", onHand: 55 }],
      yesterdaySnapshots: [{ sku: "ev-mens-l", location: "US", onHand: 50 }],
      todaySales: [],
      overduePOs: [{ sku: "ev-mens-l", destination: "US", quantity: 10, ...PO_BASE }],
    });
    expect(out).toEqual([]);
  });

  it("skips when no overdue PO matches the delta (likely manual correction)", () => {
    // Stock jumped 200 but the only overdue PO is for 1000 — way out of band.
    const out = detectAutoReceipts({
      todaySnapshots: [{ sku: "ev-mens-l", location: "US", onHand: 250 }],
      yesterdaySnapshots: [{ sku: "ev-mens-l", location: "US", onHand: 50 }],
      todaySales: [],
      overduePOs: [{ sku: "ev-mens-l", destination: "US", quantity: 1000, ...PO_BASE }],
    });
    expect(out).toEqual([]);
  });

  it("skips when multiple POs match (ambiguous — operator picks)", () => {
    const out = detectAutoReceipts({
      todaySnapshots: [{ sku: "ev-mens-l", location: "US", onHand: 250 }],
      yesterdaySnapshots: [{ sku: "ev-mens-l", location: "US", onHand: 50 }],
      todaySales: [],
      overduePOs: [
        { sku: "ev-mens-l", destination: "US", quantity: 200, shipmentName: "PO-A", expectedArrival: "2026-04-15" },
        { sku: "ev-mens-l", destination: "US", quantity: 180, shipmentName: "PO-B", expectedArrival: "2026-04-20" },
      ],
    });
    expect(out).toEqual([]);
  });

  it("skips when no yesterday snapshot exists for the SKU", () => {
    const out = detectAutoReceipts({
      todaySnapshots: [{ sku: "ev-mens-l", location: "US", onHand: 250 }],
      yesterdaySnapshots: [],
      todaySales: [],
      overduePOs: [{ sku: "ev-mens-l", destination: "US", quantity: 200, ...PO_BASE }],
    });
    expect(out).toEqual([]);
  });

  it("does not cross-match across destinations (US delta won't match a CN PO)", () => {
    const out = detectAutoReceipts({
      todaySnapshots: [{ sku: "ev-mens-l", location: "US", onHand: 250 }],
      yesterdaySnapshots: [{ sku: "ev-mens-l", location: "US", onHand: 50 }],
      todaySales: [],
      overduePOs: [{ sku: "ev-mens-l", destination: "CN", quantity: 200, ...PO_BASE }],
    });
    expect(out).toEqual([]);
  });

  it("respects upper tolerance — a 200 delta ignoring a 100-unit PO", () => {
    // 200 / 100 = 2.0, well above MAX_MULTIPLIER (1.3). No match.
    const out = detectAutoReceipts({
      todaySnapshots: [{ sku: "ev-mens-l", location: "US", onHand: 250 }],
      yesterdaySnapshots: [{ sku: "ev-mens-l", location: "US", onHand: 50 }],
      todaySales: [],
      overduePOs: [{ sku: "ev-mens-l", destination: "US", quantity: 100, ...PO_BASE }],
    });
    expect(out).toEqual([]);
  });

  it("respects lower tolerance — partial delivery half the PO size doesn't match", () => {
    // PO 200, only +80 stock change. 80/200 = 0.4, below MIN_MULTIPLIER (0.7).
    // Treat as partial / Scott confirms manually.
    const out = detectAutoReceipts({
      todaySnapshots: [{ sku: "ev-mens-l", location: "US", onHand: 130 }],
      yesterdaySnapshots: [{ sku: "ev-mens-l", location: "US", onHand: 50 }],
      todaySales: [],
      overduePOs: [{ sku: "ev-mens-l", destination: "US", quantity: 200, ...PO_BASE }],
    });
    expect(out).toEqual([]);
  });

  it("matches multiple SKUs of the same shipment as separate detection rows", () => {
    // A real shipment lands across many SKU rows; the detector emits
    // one match per SKU. The job-level de-duplication collapses them
    // to one receipt (covered by integration test).
    const out = detectAutoReceipts({
      todaySnapshots: [
        { sku: "ev-mens-s", location: "US", onHand: 100 },
        { sku: "ev-mens-m", location: "US", onHand: 150 },
      ],
      yesterdaySnapshots: [
        { sku: "ev-mens-s", location: "US", onHand: 0 },
        { sku: "ev-mens-m", location: "US", onHand: 50 },
      ],
      todaySales: [],
      overduePOs: [
        { sku: "ev-mens-s", destination: "US", quantity: 100, shipmentName: "KAI Mens Apr26", expectedArrival: "2026-04-30" },
        { sku: "ev-mens-m", destination: "US", quantity: 100, shipmentName: "KAI Mens Apr26", expectedArrival: "2026-04-30" },
      ],
    });
    expect(out).toHaveLength(2);
    expect(out.every((m) => m.shipmentName === "KAI Mens Apr26")).toBe(true);
  });
});
