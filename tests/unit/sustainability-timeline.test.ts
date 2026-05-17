import { describe, expect, it } from "vitest";
import {
  resolveMultiplier,
  walkProjection,
} from "@/lib/domain/sustainability-timeline";

describe("walkProjection", () => {
  it("matches Scott's screenshot for ev-bshort-5x-xxs row", () => {
    // From Sustainability Check US sheet 2026-04-28:
    //   Sales 11 over 14d → prorated 24/30 → daily rate 0.8
    //   PD Stock 160; Shipment 1 = 102 units at 2026-05-03 (6 days out);
    //   Shipment 2 = 0 units at 2026-05-20 (17 days after Shipment 1).
    //
    // Sheet shows:
    //   Ship1: Sales 5, Stock Left 155, Run out 2026-11-06, After 257.
    //   Ship2: Sales 15 (≈18 days × 0.8), Stock Left 242, Run out 2027-03-07, After 242.
    const out = walkProjection(160, 0.8, "2026-04-28", [
      { shipmentName: "KAI Feb", eta: "2026-05-03", quantity: 102 },
      { shipmentName: "KAI Feb 2", eta: "2026-05-20", quantity: 0 },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      shipmentName: "KAI Feb",
      eta: "2026-05-03",
      daysFromPrevious: 5,
      salesInWindow: 4,
      stockLeftAtEta: 156,
      // 160/0.8 = 200 days from 2026-04-28 → 2026-11-14. Scott's sheet
      // shows 2026-11-06 — the ~8-day drift is from his rate using a
      // slightly different prorating. Same intent, same shape.
      runOutDate: "2026-11-14",
      shipmentQty: 102,
      afterReceiptStock: 258,
    });
    // Sheet rounds aggressively in display (Sales 5, Stock Left 155);
    // we keep two-decimal precision, but the math is the same shape.
    expect(out[1].shipmentName).toBe("KAI Feb 2");
    expect(out[1].daysFromPrevious).toBe(17);
    expect(out[1].salesInWindow).toBeCloseTo(13.6, 1);
    expect(out[1].stockLeftAtEta).toBeCloseTo(244.4, 1);
    expect(out[1].runOutDate).not.toBeNull(); // far-future; won't run out before Ship2
    expect(out[1].afterReceiptStock).toBeCloseTo(244.4, 1);
  });

  it("emits a runOutDate when stock depletes before the shipment", () => {
    // Stock 30, rate 1/day, ship in 60 days. Will run out at day 30 → 30 May.
    const out = walkProjection(30, 1, "2026-04-30", [
      { shipmentName: "PO-1", eta: "2026-06-29", quantity: 50 },
    ]);
    expect(out[0].runOutDate).toBe("2026-05-30");
    expect(out[0].stockLeftAtEta).toBe(-30);
    // Shortfall preserved: afterReceipt = -30 + 50 = 20 (NOT floored to 50).
    expect(out[0].afterReceiptStock).toBe(20);
  });

  it("emits a runOutDate even when stock survives the window (informational)", () => {
    // Scott's sheet shows the projected run-out as a "without
    // further intervention" indicator, not a shortfall flag. So even
    // if the next shipment would save us, the date is surfaced so
    // the operator can read "if I do nothing more after this, when
    // do I hit zero?".
    const out = walkProjection(100, 1, "2026-04-30", [
      { shipmentName: "PO-1", eta: "2026-05-30", quantity: 50 },
    ]);
    expect(out[0].stockLeftAtEta).toBe(70);
    // 100 / 1 = 100 days from 2026-04-30 → 2026-08-08.
    expect(out[0].runOutDate).toBe("2026-08-08");
    expect(out[0].afterReceiptStock).toBe(120);
  });

  it("handles a zero-demand SKU (rate=0) without dividing by zero", () => {
    const out = walkProjection(50, 0, "2026-04-30", [
      { shipmentName: "PO-1", eta: "2026-05-30", quantity: 100 },
      { shipmentName: "PO-2", eta: "2026-06-30", quantity: 200 },
    ]);
    // Stock holds at 50, then 150, then 350. No run-out ever.
    expect(out[0]).toMatchObject({
      stockLeftAtEta: 50,
      runOutDate: null,
      afterReceiptStock: 150,
    });
    expect(out[1]).toMatchObject({
      stockLeftAtEta: 150,
      runOutDate: null,
      afterReceiptStock: 350,
    });
  });

  it("returns an empty array when there are no upcoming shipments", () => {
    expect(walkProjection(100, 1, "2026-04-30", [])).toEqual([]);
  });

  it("propagates a shortfall into the next window's starting stock", () => {
    // Stock 10, rate 1/day. Ship1 in 30 days brings 5 → carryover -15.
    // Ship2 30 more days later: starting from -15, deplete another 30 →
    // -45 stockLeft. Ship2 brings 100 → afterReceipt 55.
    const out = walkProjection(10, 1, "2026-04-30", [
      { shipmentName: "Ship1", eta: "2026-05-30", quantity: 5 },
      { shipmentName: "Ship2", eta: "2026-06-29", quantity: 100 },
    ]);
    expect(out[0].afterReceiptStock).toBe(-15);
    // The runOutDate for Ship2 row is also surfaced, since starting
    // stock is already negative — we round up days-to-zero to 0 and
    // emit "today" as the run-out (i.e. already-out).
    expect(out[1].stockLeftAtEta).toBe(-45);
    expect(out[1].afterReceiptStock).toBe(55);
  });

  it("treats today === eta as zero-day window (no depletion)", () => {
    // Edge case: shipment lands the same day. Don't deplete anything.
    // Run-out is still projected from today since rate > 0 and stock > 0.
    const out = walkProjection(100, 5, "2026-04-30", [
      { shipmentName: "Today", eta: "2026-04-30", quantity: 20 },
    ]);
    expect(out[0]).toMatchObject({
      daysFromPrevious: 0,
      salesInWindow: 0,
      stockLeftAtEta: 100,
      // 100/5 = 20 days from 2026-04-30 = 2026-05-20.
      runOutDate: "2026-05-20",
      afterReceiptStock: 120,
    });
  });

  it("scales sales when a per-day multiplier function is provided", () => {
    // Baseline 1 unit/day × 10 days = 10 units sold. With multiplier 1.5
    // throughout, 15 units sold. Stock 100 → 85 left.
    const multiplierAt = () => 1.5;
    const out = walkProjection(100, 1, "2026-05-01", [
      { shipmentName: "Ship", eta: "2026-05-11", quantity: 50 },
    ], { multiplierAt });
    expect(out[0].salesInWindow).toBe(15);
    expect(out[0].stockLeftAtEta).toBe(85);
    expect(out[0].afterReceiptStock).toBe(135);
  });

  it("multiplier function reduces sales when scaling factor < 1", () => {
    // 0.5x = 50% of baseline.
    const multiplierAt = () => 0.5;
    const out = walkProjection(100, 1, "2026-05-01", [
      { shipmentName: "Ship", eta: "2026-05-11", quantity: 50 },
    ], { multiplierAt });
    expect(out[0].salesInWindow).toBe(5);
    expect(out[0].stockLeftAtEta).toBe(95);
  });

  it("respects per-day multiplier when it varies across the window", () => {
    // 5 days at 1.0 + 5 days at 2.0 = 5 + 10 = 15 units sold.
    const multiplierAt = (ymd: string) =>
      ymd >= "2026-05-06" ? 2 : 1;
    const out = walkProjection(100, 1, "2026-05-01", [
      { shipmentName: "Ship", eta: "2026-05-11", quantity: 0 },
    ], { multiplierAt });
    expect(out[0].salesInWindow).toBe(15);
    expect(out[0].stockLeftAtEta).toBe(85);
  });

  it("constant-rate path is preserved when no multiplier provided (regression)", () => {
    // The pre-2026-05-05 walker had no options arg. New constant-rate
    // path must produce identical results — locks the contract.
    const out = walkProjection(100, 2, "2026-05-01", [
      { shipmentName: "Ship", eta: "2026-05-11", quantity: 30 },
    ]);
    expect(out[0].salesInWindow).toBe(20);
    expect(out[0].stockLeftAtEta).toBe(80);
    expect(out[0].afterReceiptStock).toBe(110);
    // 100/2 = 50 days from 2026-05-01 = 2026-06-20.
    expect(out[0].runOutDate).toBe("2026-06-20");
  });

  it("computes runOutDate from variable rate when stock crosses 0 mid-window", () => {
    // Stock 10, baseline 1 unit/day, but multiplier is 5x starting day 5.
    // Days 0-4: 1 unit/day → 5 sold. Day 5: 5 sold (cumulative 10).
    // Stock crosses 0 on day 5 → runOutDate = 2026-05-06.
    const multiplierAt = (ymd: string) =>
      ymd >= "2026-05-06" ? 5 : 1;
    const out = walkProjection(10, 1, "2026-05-01", [
      { shipmentName: "Ship", eta: "2026-05-30", quantity: 0 },
    ], { multiplierAt });
    expect(out[0].runOutDate).toBe("2026-05-06");
  });

  it("carries forward runOutDate into subsequent OOS windows (Scott 2026-05-15)", () => {
    // Stock 50, rate 10/day → runs out at day 5 = 2026-05-06.
    // Ship1 (Jun 1): 31 days × 10 = 310 sold, stockLeftAtEta = -260,
    // afterReceipt = -260 + 30 = -230. Subsequent shipments don't
    // recover. Without carry-forward, future shipment cells would
    // render "—". With it, the operator keeps seeing the actual
    // run-out date "2026-05-06" across every OOS column.
    const out = walkProjection(50, 10, "2026-05-01", [
      { shipmentName: "Ship1", eta: "2026-06-01", quantity: 30 },
      { shipmentName: "Ship2", eta: "2026-07-01", quantity: 50 },
      { shipmentName: "Ship3", eta: "2026-08-01", quantity: 50 },
    ]);
    expect(out[0].runOutDate).toBe("2026-05-06");
    expect(out[0].afterReceiptStock).toBe(-230);
    expect(out[1].stockLeftAtEta).toBeLessThan(0);
    expect(out[1].runOutDate).toBe("2026-05-06"); // carried forward
    expect(out[2].stockLeftAtEta).toBeLessThan(0);
    expect(out[2].runOutDate).toBe("2026-05-06"); // still carried
  });

  it("recovery (stock > 0 at next pivot) replaces the anchor with a fresh compute", () => {
    // Stock 10, rate 1/day → runs out 2026-05-11.
    // Ship1 (Jun 1): 31d × 1 = 31 sold, stockLeftAtEta = -21,
    // afterReceipt = -21 + 100 = 79. Pivot advances to 2026-06-01.
    // Ship2 (Jul 1) starts with stock 79 (recovery). Fresh compute
    // from new pivot: 79 / 1 = 79 days from 2026-06-01 = 2026-08-19.
    // Notably NOT "2026-05-11" — the recovery cleared the anchor.
    const out = walkProjection(10, 1, "2026-05-01", [
      { shipmentName: "Ship1", eta: "2026-06-01", quantity: 100 },
      { shipmentName: "Ship2", eta: "2026-07-01", quantity: 0 },
    ]);
    expect(out[0].runOutDate).toBe("2026-05-11");
    expect(out[0].afterReceiptStock).toBe(79);
    expect(out[1].stockLeftAtEta).toBe(49);
    expect(out[1].runOutDate).toBe("2026-08-19");
  });

  it("no anchor to carry when SKU was already OOS at today (currentStock = 0)", () => {
    // Stock 0, rate 1/day, never recovers (small shipments still leave
    // afterReceipt negative). Ship1 carries 0 → no anchor was ever set,
    // so subsequent OOS rows show "—" (null), not a stale phantom date.
    const out = walkProjection(0, 1, "2026-05-01", [
      { shipmentName: "Ship1", eta: "2026-06-01", quantity: 5 },
      { shipmentName: "Ship2", eta: "2026-07-01", quantity: 5 },
    ]);
    expect(out[0].runOutDate).toBeNull();
    expect(out[1].runOutDate).toBeNull();
  });

  it("two overdue shipments: pivot doesn't rewind, no phantom sales between them", () => {
    // Today = 2026-05-10. Both shipments have ETAs in the past.
    // The fix: pivot stays at "today" across past ETAs so we don't
    // invent sales for days that already happened.
    // Pre-fix bug: pivot would rewind to 2026-05-03 after the first
    // overdue, then invent 5 days × 2 = 10 phantom sales between the
    // two overdue shipments.
    const out = walkProjection(100, 2, "2026-05-10", [
      { shipmentName: "Late-A", eta: "2026-05-03", quantity: 50 },  // 7d late
      { shipmentName: "Late-B", eta: "2026-05-08", quantity: 30 },  // 2d late
      { shipmentName: "Future", eta: "2026-05-15", quantity: 20 },  // 5d future
    ]);
    // Both overdue rows: 0 sales-in-window, stock unchanged before adding qty.
    expect(out[0].salesInWindow).toBe(0);
    expect(out[0].stockLeftAtEta).toBe(100);
    expect(out[0].afterReceiptStock).toBe(150);
    expect(out[1].salesInWindow).toBe(0);             // would be 10 pre-fix
    expect(out[1].stockLeftAtEta).toBe(150);          // would be 140 pre-fix
    expect(out[1].afterReceiptStock).toBe(180);
    // Future row: 5 days × 2 = 10 sales between today and 2026-05-15.
    expect(out[2].salesInWindow).toBe(10);
    expect(out[2].stockLeftAtEta).toBe(170);
    expect(out[2].afterReceiptStock).toBe(190);
  });
});

describe("resolveMultiplier", () => {
  it("returns 1.0 when no overrides match the day", () => {
    expect(resolveMultiplier("2026-05-05", "Mens", [])).toBe(1.0);
    expect(
      resolveMultiplier("2026-05-05", "Mens", [
        { productName: null, startDate: "2026-06-01", endDate: "2026-06-30", multiplier: 1.2 },
      ]),
    ).toBe(1.0);
  });

  it("returns the matching multiplier when day falls inside a brand-level override range", () => {
    expect(
      resolveMultiplier("2026-05-15", "Mens", [
        { productName: null, startDate: "2026-05-01", endDate: "2026-05-31", multiplier: 1.2 },
      ]),
    ).toBe(1.2);
  });

  it("includes both endpoints (inclusive range)", () => {
    const overrides = [
      { productName: null, startDate: "2026-05-01", endDate: "2026-05-31", multiplier: 1.5 },
    ];
    expect(resolveMultiplier("2026-05-01", "Mens", overrides)).toBe(1.5);
    expect(resolveMultiplier("2026-05-31", "Mens", overrides)).toBe(1.5);
    expect(resolveMultiplier("2026-04-30", "Mens", overrides)).toBe(1.0);
    expect(resolveMultiplier("2026-06-01", "Mens", overrides)).toBe(1.0);
  });

  it("first-match wins when brand-level ranges overlap (caller controls ordering)", () => {
    const overrides = [
      { productName: null, startDate: "2026-05-01", endDate: "2026-05-31", multiplier: 1.2 },
      { productName: null, startDate: "2026-05-15", endDate: "2026-05-20", multiplier: 2.0 },
    ];
    // 2026-05-17 falls inside both — first wins.
    expect(resolveMultiplier("2026-05-17", "Mens", overrides)).toBe(1.2);
  });

  it("product-specific overrides win over brand-level for the same day", () => {
    // Brand-level "+10%" layered with "+30% Mens". Mens gets 1.3 inside
    // the overlap; other products fall back to brand-level 1.1.
    const overrides = [
      { productName: null, startDate: "2026-05-01", endDate: "2026-05-31", multiplier: 1.1 },
      { productName: "Mens 3-Pack", startDate: "2026-05-01", endDate: "2026-05-31", multiplier: 1.3 },
    ];
    expect(resolveMultiplier("2026-05-15", "Mens 3-Pack", overrides)).toBe(1.3);
    expect(resolveMultiplier("2026-05-15", "Shapewear", overrides)).toBe(1.1);
  });

  it("product-specific override only applies when productName matches exactly", () => {
    const overrides = [
      { productName: "Mens 3-Pack", startDate: "2026-05-01", endDate: "2026-05-31", multiplier: 1.5 },
    ];
    expect(resolveMultiplier("2026-05-15", "Mens 3-Pack", overrides)).toBe(1.5);
    // Different product → no match → default 1.0 since there's no
    // brand-level fallback.
    expect(resolveMultiplier("2026-05-15", "Boyshort", overrides)).toBe(1.0);
  });
});
