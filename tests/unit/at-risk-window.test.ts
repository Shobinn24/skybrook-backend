import { describe, expect, it } from "vitest";
import {
  AT_RISK_HORIZON_DAYS,
  applyAtRiskWindow,
  isAtRiskWithin,
  transformedDisplayFlag,
} from "@/lib/domain/at-risk-window";

const today = "2026-05-06";

describe("at-risk-window — Scott's 45-day inventory rule", () => {
  it("uses runOutDate when set (in-window → at-risk)", () => {
    expect(
      isAtRiskWithin({ runOutDate: "2026-05-30", daysOfStock: null, flag: "watch" }, today),
    ).toBe(true); // 24 days out
  });

  it("uses runOutDate when set (out-of-window → not at-risk)", () => {
    expect(
      isAtRiskWithin({ runOutDate: "2026-08-30", daysOfStock: null, flag: "watch" }, today),
    ).toBe(false); // ~120 days out
  });

  it("falls back to daysOfStock when runOutDate is null (in-window)", () => {
    expect(
      isAtRiskWithin({ runOutDate: null, daysOfStock: 30, flag: "at_risk" }, today),
    ).toBe(true);
  });

  it("falls back to daysOfStock when runOutDate is null (out-of-window)", () => {
    expect(
      isAtRiskWithin({ runOutDate: null, daysOfStock: 80, flag: "watch" }, today),
    ).toBe(false);
  });

  it("never flags overstocked rows as at-risk", () => {
    expect(
      isAtRiskWithin({ runOutDate: "2026-05-15", daysOfStock: null, flag: "overstocked" }, today),
    ).toBe(false);
  });

  it("returns false for rows with infinite or null DOS and no runOutDate", () => {
    expect(
      isAtRiskWithin({ runOutDate: null, daysOfStock: Infinity, flag: "healthy" }, today),
    ).toBe(false);
    expect(
      isAtRiskWithin({ runOutDate: null, daysOfStock: null, flag: null }, today),
    ).toBe(false);
  });

  it("transforms a 'watch' projection to 'at_risk' when within horizon", () => {
    const result = transformedDisplayFlag(
      { runOutDate: "2026-06-15", daysOfStock: null, flag: "watch" },
      today,
    );
    expect(result).toBe("at_risk"); // 40 days out
  });

  it("softens an 'at_risk' projection to 'watch' when beyond horizon", () => {
    // Edge case: the underlying projection said at_risk (runs out before
    // PO1) but PO1 is far enough away that 45-day window doesn't hit.
    const result = transformedDisplayFlag(
      { runOutDate: "2026-09-01", daysOfStock: null, flag: "at_risk" },
      today,
    );
    expect(result).toBe("watch");
  });

  it("preserves overstocked flag through the transformer", () => {
    expect(
      transformedDisplayFlag(
        { runOutDate: null, daysOfStock: 200, flag: "overstocked" },
        today,
      ),
    ).toBe("overstocked");
  });

  it("preserves healthy flag when run-out is far away", () => {
    expect(
      transformedDisplayFlag(
        { runOutDate: null, daysOfStock: 100, flag: "healthy" },
        today,
      ),
    ).toBe("healthy");
  });

  it("DOS = 5 with no projection date → at_risk in display", () => {
    expect(
      transformedDisplayFlag(
        { runOutDate: null, daysOfStock: 5, flag: "at_risk" },
        today,
      ),
    ).toBe("at_risk");
  });

  it("applies to a list of rows (preserves all other fields)", () => {
    const rows = [
      { sku: "ev-a-l", runOutDate: "2026-05-30", daysOfStock: null, flag: "watch" as const, onHand: 100 },
      { sku: "ev-b-l", runOutDate: "2026-09-01", daysOfStock: null, flag: "at_risk" as const, onHand: 50 },
      { sku: "ev-c-l", runOutDate: null, daysOfStock: 200, flag: "overstocked" as const, onHand: 5000 },
    ];
    const out = applyAtRiskWindow(rows, today);
    expect(out[0].flag).toBe("at_risk");
    expect(out[1].flag).toBe("watch");
    expect(out[2].flag).toBe("overstocked");
    // sku, onHand, runOutDate, daysOfStock all preserved
    expect(out[0].sku).toBe("ev-a-l");
    expect(out[0].onHand).toBe(100);
    expect(out[1].onHand).toBe(50);
    expect(out[2].onHand).toBe(5000);
  });

  it("respects custom horizonDays", () => {
    const row = { runOutDate: "2026-05-30", daysOfStock: null, flag: "watch" as const };
    expect(isAtRiskWithin(row, today, 14)).toBe(false); // 24d > 14d
    expect(isAtRiskWithin(row, today, 30)).toBe(true);  // 24d ≤ 30d
  });

  it("default horizon is 45 days", () => {
    expect(AT_RISK_HORIZON_DAYS).toBe(45);
  });
});
