// Regression: bonus_notification_batches.totalsJson has two real-world
// shapes — the canonical Array (regular notification batches) AND the
// historical-backfill Object keyed by marketer (the 2026-05-27
// system_backfill row). On 2026-05-28 the array-only reduce crashed
// the /bonus-tracker page with INTERNAL_SERVER_ERROR. grandTotalFromTotalsJson
// must absorb both shapes plus malformed input.
import { describe, it, expect } from "vitest";
import { grandTotalFromTotalsJson } from "@/lib/queries/bonus-tracker";

describe("grandTotalFromTotalsJson", () => {
  it("sums totalUsd across array-shape (regular notification batches)", () => {
    const totals = [
      { marketer: "Craig", totalUsd: 1500 },
      { marketer: "Raul", totalUsd: 750 },
    ];
    expect(grandTotalFromTotalsJson(totals)).toBe(2250);
  });

  it("sums usd across object-shape (historical backfill batches)", () => {
    const totals = {
      Craig: { count: 80, usd: 92500 },
      Raul: { count: 37, usd: 48500 },
      Jacob: { count: 3, usd: 2000 },
      Dan: { count: 1, usd: 250 },
    };
    expect(grandTotalFromTotalsJson(totals)).toBe(143250);
  });

  it("returns 0 for null", () => {
    expect(grandTotalFromTotalsJson(null)).toBe(0);
  });

  it("returns 0 for undefined", () => {
    expect(grandTotalFromTotalsJson(undefined)).toBe(0);
  });

  it("returns 0 for primitive (defensive against schema drift)", () => {
    expect(grandTotalFromTotalsJson("oops")).toBe(0);
    expect(grandTotalFromTotalsJson(42)).toBe(0);
  });

  it("treats missing totalUsd / usd as 0 (mixed-quality rows)", () => {
    expect(grandTotalFromTotalsJson([{ totalUsd: 100 }, {} as any, { totalUsd: 50 }])).toBe(150);
    expect(grandTotalFromTotalsJson({ A: { usd: 25 }, B: {} as any, C: { usd: 75 } })).toBe(100);
  });

  it("ignores non-numeric totalUsd / usd values", () => {
    expect(grandTotalFromTotalsJson([{ totalUsd: "1500" as any }, { totalUsd: 500 }])).toBe(500);
    expect(grandTotalFromTotalsJson({ A: { usd: null as any }, B: { usd: 200 } })).toBe(200);
  });
});
