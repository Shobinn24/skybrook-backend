import { describe, expect, it } from "vitest";
import {
  detectLikelyArrivedOverdue,
  LIKELY_ARRIVED_MIN_PCT,
  type OverdueShipmentLine,
  type SnapshotPoint,
} from "@/lib/domain/arrival-evidence";

const line = (
  shipmentName: string,
  sku: string,
  quantity: number,
  expectedArrival = "2026-05-10",
  destination: "US" | "CN" = "CN",
): OverdueShipmentLine => ({ shipmentName, destination, expectedArrival, sku, quantity });

const snap = (
  sku: string,
  snapshotDate: string,
  onHand: number,
  location: "US" | "CN" = "CN",
): SnapshotPoint => ({ sku, location, snapshotDate, onHand });

describe("detectLikelyArrivedOverdue", () => {
  it("flags a shipment whose stock jumps on/after the ETA above the threshold", () => {
    const overdue = [line("KAI Sec", "ev-a", 100), line("KAI Sec", "ev-b", 100)]; // PO 200
    // flat before ETA, then +180 across the two SKUs on 2026-05-12 (after ETA 05-10)
    const snapshots = [
      snap("ev-a", "2026-05-08", 10), snap("ev-b", "2026-05-08", 10),
      snap("ev-a", "2026-05-11", 10), snap("ev-b", "2026-05-11", 10),
      snap("ev-a", "2026-05-12", 100), snap("ev-b", "2026-05-12", 100),
    ];
    const [r] = detectLikelyArrivedOverdue({ overdue, snapshots });
    expect(r.shipmentName).toBe("KAI Sec");
    expect(r.observedJump).toBe(180);
    expect(r.jumpDate).toBe("2026-05-12");
    expect(r.poQuantity).toBe(200);
    expect(r.pctOfPo).toBeCloseTo(0.9);
    expect(r.trackedLines).toBe(2);
  });

  it("ignores a jump that happened BEFORE the ETA (attribution to an earlier restock)", () => {
    const overdue = [line("KAI Boyshort", "ev-c", 1000, "2026-05-20")];
    const snapshots = [
      snap("ev-c", "2026-05-08", 100),
      snap("ev-c", "2026-05-10", 1100), // +1000 pre-ETA = earlier shipment
      snap("ev-c", "2026-05-22", 900), // declining after ETA, no jump
      snap("ev-c", "2026-05-25", 850),
    ];
    expect(detectLikelyArrivedOverdue({ overdue, snapshots })).toEqual([]);
  });

  it("does not flag when there is no jump", () => {
    const overdue = [line("KAI Sec15", "ev-d", 3000, "2026-05-15")];
    const snapshots = [
      snap("ev-d", "2026-05-16", 500),
      snap("ev-d", "2026-05-18", 480),
      snap("ev-d", "2026-05-20", 460),
    ];
    expect(detectLikelyArrivedOverdue({ overdue, snapshots })).toEqual([]);
  });

  it("does not flag shipments whose SKUs are absent from snapshots (untracked)", () => {
    const overdue = [line("KAI 25", "ev-pp-hw-l", 1200)];
    const snapshots = [snap("ev-hw-l", "2026-05-12", 5000)]; // different SKU string
    const res = detectLikelyArrivedOverdue({ overdue, snapshots });
    expect(res).toEqual([]);
  });

  it("flags partial deliveries (>= 50% of PO) the conservative auto-receipt would miss", () => {
    const overdue = [line("KAI Mens", "ev-m", 1761, "2026-05-15")];
    const snapshots = [
      snap("ev-m", "2026-05-15", 0),
      snap("ev-m", "2026-05-17", 1001), // 57% of PO
    ];
    const [r] = detectLikelyArrivedOverdue({ overdue, snapshots });
    expect(r.observedJump).toBe(1001);
    expect(r.pctOfPo).toBeGreaterThan(LIKELY_ARRIVED_MIN_PCT);
  });

  it("sorts most-confident first", () => {
    const overdue = [
      line("Low", "ev-x", 200, "2026-05-10"),
      line("High", "ev-y", 200, "2026-05-10"),
    ];
    const snapshots = [
      snap("ev-x", "2026-05-09", 0), snap("ev-x", "2026-05-11", 120), // 60%
      snap("ev-y", "2026-05-09", 0), snap("ev-y", "2026-05-11", 200), // 100%
    ];
    const res = detectLikelyArrivedOverdue({ overdue, snapshots });
    expect(res.map((r) => r.shipmentName)).toEqual(["High", "Low"]);
  });

  // Behaviour shift 2026-05-28: cumulative-since-ETA + 25% threshold.

  it("flags a trickled arrival across multiple post-ETA snapshots", () => {
    // PO 1000, no single-day jump >= 50% (or even 25%) but cumulative
    // from pre-ETA baseline to post-ETA peak is 600 = 60% of PO.
    const overdue = [line("KAI Trickle", "ev-t", 1000, "2026-05-10")];
    const snapshots = [
      snap("ev-t", "2026-05-09", 0),
      snap("ev-t", "2026-05-12", 200),
      snap("ev-t", "2026-05-14", 400),
      snap("ev-t", "2026-05-17", 600),
    ];
    const [r] = detectLikelyArrivedOverdue({ overdue, snapshots });
    expect(r.observedJump).toBe(600);
    expect(r.jumpDate).toBe("2026-05-17"); // peak landed on the latest snapshot
    expect(r.pctOfPo).toBeCloseTo(0.6);
  });

  it("flags a 30% partial arrival now that threshold dropped to 25%", () => {
    // Previously LIKELY_ARRIVED_MIN_PCT was 0.5 and this would have been
    // ignored. Loosened 2026-05-28 because the KAI dominant pattern is
    // partial deliveries that span multiple snapshot dates.
    expect(LIKELY_ARRIVED_MIN_PCT).toBeLessThanOrEqual(0.25);
    const overdue = [line("KAI Partial", "ev-p", 1000, "2026-05-10")];
    const snapshots = [
      snap("ev-p", "2026-05-09", 100),
      snap("ev-p", "2026-05-12", 400), // +300 = 30% of PO
    ];
    const [r] = detectLikelyArrivedOverdue({ overdue, snapshots });
    expect(r.observedJump).toBe(300);
    expect(r.pctOfPo).toBeCloseTo(0.3);
  });

  it("clamps a post-ETA decline to 0 rather than reporting a negative arrival", () => {
    // Pre-ETA baseline higher than post-ETA peak (sales drawdown without
    // any restock). Cumulative arithmetic would go negative; we clamp at
    // 0 and the shipment never flags.
    const overdue = [line("KAI Decline", "ev-d", 1000, "2026-05-10")];
    const snapshots = [
      snap("ev-d", "2026-05-08", 500),
      snap("ev-d", "2026-05-11", 400),
      snap("ev-d", "2026-05-14", 300),
    ];
    expect(detectLikelyArrivedOverdue({ overdue, snapshots })).toEqual([]);
  });
});
