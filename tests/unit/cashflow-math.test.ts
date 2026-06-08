import { describe, it, expect } from "vitest";
import {
  projectRevenue, netProfit, cogs, cashflowFromStores, profitPayout,
  endingCash, variance, isVarianceSignificant, type CashflowAssumptions,
} from "@/lib/domain/cashflow-math";

const A: CashflowAssumptions = {
  ev: { revenueStart: 506294, weeklyGrowth: 1, netMargin: 0.2625 },
  jm: { revenueStart: 114389, weeklyGrowth: 1, netMargin: 0.27 },
  ewc: { revenueStart: 23418, weeklyGrowth: 1, netMargin: 0.21 },
  cogsPct: 0.15, profitPayoutPct: 0.9, varianceThresholdUsd: 30000,
};

describe("cashflow-math", () => {
  it("projects revenue with weekly growth", () => {
    expect(projectRevenue({ revenueStart: 100, weeklyGrowth: 1.1, netMargin: 0 }, 0)).toBeCloseTo(100, 6);
    expect(projectRevenue({ revenueStart: 100, weeklyGrowth: 1.1, netMargin: 0 }, 2)).toBeCloseTo(121, 6);
  });

  it("net profit = Σ revenue×margin across channels", () => {
    expect(netProfit(A, 0)).toBeCloseTo(168704.99, 1);
  });

  it("cogs = cogsPct × total revenue", () => {
    expect(cogs(A, 0)).toBeCloseTo((506294 + 114389 + 23418) * 0.15, 2);
  });

  it("cashflow from stores = net profit + cogs", () => {
    expect(cashflowFromStores(A, 0)).toBeCloseTo(netProfit(A, 0) + cogs(A, 0), 6);
  });

  it("profit payout = pct × net profit by default", () => {
    expect(profitPayout(169320, { payoutPct: 0.9 })).toBeCloseTo(152388, 2);
  });

  it("profit payout honors override and skip", () => {
    expect(profitPayout(169320, { payoutPct: 0.9, overrideUsd: 80000 })).toBe(80000);
    expect(profitPayout(169320, { payoutPct: 0.9, skipped: true })).toBe(0);
    expect(profitPayout(169320, { payoutPct: 0.9, overrideUsd: 80000, skipped: true })).toBe(0);
    expect(profitPayout(169320, { payoutPct: 0.9, overrideUsd: 0 })).toBe(0);
  });

  it("ending cash = beginning + in - out", () => {
    expect(endingCash(487200, 260211, 152388)).toBeCloseTo(595023, 0);
  });

  it("variance + threshold", () => {
    expect(variance(600000, 595000)).toBe(5000);
    expect(isVarianceSignificant(5000, 30000)).toBe(false);
    expect(isVarianceSignificant(35000, 30000)).toBe(true);
    expect(isVarianceSignificant(-35000, 30000)).toBe(true);
  });
});

import { weekStartEst, weekStartsForward } from "@/lib/domain/cashflow-weeks";

describe("cashflow-weeks", () => {
  it("weekStartEst returns the Monday (YYYY-MM-DD) of a date's week", () => {
    // 2026-06-03 is a Wednesday → week starts Mon 2026-06-01
    expect(weekStartEst("2026-06-03")).toBe("2026-06-01");
    expect(weekStartEst("2026-06-01")).toBe("2026-06-01");
    expect(weekStartEst("2026-06-07")).toBe("2026-06-01"); // Sunday → same week
    // All 7 days of the week of Mon 2026-06-01
    expect(weekStartEst("2026-06-01")).toBe("2026-06-01"); // Mon
    expect(weekStartEst("2026-06-02")).toBe("2026-06-01"); // Tue
    expect(weekStartEst("2026-06-03")).toBe("2026-06-01"); // Wed
    expect(weekStartEst("2026-06-04")).toBe("2026-06-01"); // Thu
    expect(weekStartEst("2026-06-05")).toBe("2026-06-01"); // Fri
    expect(weekStartEst("2026-06-06")).toBe("2026-06-01"); // Sat
    expect(weekStartEst("2026-06-07")).toBe("2026-06-01"); // Sun
  });

  it("weekStartsForward yields N consecutive Monday starts", () => {
    expect(weekStartsForward("2026-06-01", 3)).toEqual([
      "2026-06-01", "2026-06-08", "2026-06-15",
    ]);
    // edge cases: count=0 and count=1
    expect(weekStartsForward("2026-06-01", 0)).toEqual([]);
    expect(weekStartsForward("2026-06-01", 1)).toEqual(["2026-06-01"]);
  });
});
