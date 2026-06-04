import { describe, expect, it } from "vitest";
import { detectCollapsedMonths } from "@/lib/sources/sheets";

const m = (...pairs: Array<[string, number]>) => new Map(pairs);

describe("detectCollapsedMonths", () => {
  it("flags a material month whose incoming total collapses below half", () => {
    const out = detectCollapsedMonths(m(["2026-05", 26_000]), m(["2026-05", 880_000]));
    expect(out).toEqual([{ month: "2026-05", existing: 880_000, incoming: 26_000 }]);
  });

  it("treats a missing incoming month as a collapse (incoming = 0)", () => {
    const out = detectCollapsedMonths(m(), m(["2026-05", 880_000]));
    expect(out).toEqual([{ month: "2026-05", existing: 880_000, incoming: 0 }]);
  });

  it("does NOT flag a healthy re-pull (incoming ~= existing)", () => {
    expect(detectCollapsedMonths(m(["2026-05", 870_000]), m(["2026-05", 880_000]))).toEqual([]);
  });

  it("does NOT flag an in-progress month that grew", () => {
    expect(detectCollapsedMonths(m(["2026-06", 120_000]), m(["2026-06", 80_000]))).toEqual([]);
  });

  it("does NOT flag a month below the material floor", () => {
    // existing $40k < $50k floor — ignored even though incoming cratered
    expect(detectCollapsedMonths(m(["2026-05", 1_000]), m(["2026-05", 40_000]))).toEqual([]);
  });

  it("does NOT flag on an empty/cold DB (no existing months)", () => {
    expect(detectCollapsedMonths(m(["2026-05", 880_000]), m())).toEqual([]);
  });

  it("treats exactly half as NOT collapsed (boundary)", () => {
    // 50_000 < 0.5 * 100_000 is false
    expect(detectCollapsedMonths(m(["2026-05", 50_000]), m(["2026-05", 100_000]))).toEqual([]);
  });

  it("flags multiple collapsed months", () => {
    const out = detectCollapsedMonths(
      m(["2026-04", 30_000], ["2026-05", 26_000]),
      m(["2026-04", 1_000_000], ["2026-05", 880_000]),
    );
    expect(out).toHaveLength(2);
    expect(out.map((c) => c.month).sort()).toEqual(["2026-04", "2026-05"]);
  });
});
