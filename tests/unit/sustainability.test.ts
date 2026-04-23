import { describe, it, expect } from "vitest";
import { computeSustainabilityFlag, type IncomingPO } from "@/lib/domain/sustainability";

const po = (arrivalDate: string, quantity: number): IncomingPO => ({ arrivalDate, quantity });

describe("computeSustainabilityFlag — projection-based", () => {
  it("overstocked when DOS > 90 with no incoming", () => {
    const r = computeSustainabilityFlag({
      onHand: 1000, velocityPerDay: 1, incoming: [], today: "2026-04-23",
    });
    // DOS = 1000 > 90
    expect(r.flag).toBe("overstocked");
  });

  it("overstocked when velocity is 0 and stock is positive", () => {
    const r = computeSustainabilityFlag({
      onHand: 10, velocityPerDay: 0, incoming: [], today: "2026-04-23",
    });
    expect(r.flag).toBe("overstocked");
  });

  it("at_risk when DOS < 7 and no incoming to recover", () => {
    const r = computeSustainabilityFlag({
      onHand: 5, velocityPerDay: 1, incoming: [], today: "2026-04-23",
    });
    expect(r.flag).toBe("at_risk");
  });

  it("watch when DOS in 7-14 range with no incoming", () => {
    const r = computeSustainabilityFlag({
      onHand: 50, velocityPerDay: 5, incoming: [], today: "2026-04-23",
    });
    // DOS = 10 → watch
    expect(r.flag).toBe("watch");
  });

  it("healthy when DOS > 14 and no incoming", () => {
    const r = computeSustainabilityFlag({
      onHand: 100, velocityPerDay: 5, incoming: [], today: "2026-04-23",
    });
    // DOS = 20 → healthy
    expect(r.flag).toBe("healthy");
  });

  it("at_risk when projected to run out BEFORE the first incoming PO", () => {
    // on_hand 10, vel 5/day, runs out in 2 days. PO1 arrives in 10 days → at_risk
    const r = computeSustainabilityFlag({
      onHand: 10, velocityPerDay: 5,
      incoming: [po("2026-05-03", 100)],
      today: "2026-04-23",
    });
    expect(r.flag).toBe("at_risk");
    expect(r.runOutDate).toBe("2026-04-25");
  });

  it("watch when projected to run out BETWEEN PO1 and PO2", () => {
    // on_hand 30, vel 5/day.
    // Day 2: PO1 arrives (+10) → 30 - 10 + 10 = 30
    // Day 10: PO2 arrives. Between day 2 and day 10: 30 - 8*5 = -10, runs out at day 2+6 = day 8
    const r = computeSustainabilityFlag({
      onHand: 30, velocityPerDay: 5,
      incoming: [po("2026-04-25", 10), po("2026-05-03", 200)],
      today: "2026-04-23",
    });
    expect(r.flag).toBe("watch");
    expect(r.runOutDate).toBe("2026-05-01");
  });

  it("healthy when stock survives through 2 POs with plenty of runway after", () => {
    // on_hand 100, vel 5/day, PO1 +500 in 5 days, PO2 +500 in 15 days → very healthy
    const r = computeSustainabilityFlag({
      onHand: 100, velocityPerDay: 5,
      incoming: [po("2026-04-28", 500), po("2026-05-08", 500)],
      today: "2026-04-23",
    });
    expect(r.flag).toBe("healthy");
    expect(r.runOutDate).toBeNull();
  });

  it("reasoning string includes DOS", () => {
    const r = computeSustainabilityFlag({
      onHand: 10, velocityPerDay: 5, incoming: [], today: "2026-04-23",
    });
    expect(r.reasoning).toContain("2");
  });

  it("ignores PO arrivals in the past", () => {
    // on_hand 5, vel 1. PO already arrived 3 days ago — should be ignored.
    const r = computeSustainabilityFlag({
      onHand: 5, velocityPerDay: 1,
      incoming: [po("2026-04-20", 100)],
      today: "2026-04-23",
    });
    // Past PO ignored → pure DOS fallback → DOS=5 < 7 → at_risk
    expect(r.flag).toBe("at_risk");
  });
});
