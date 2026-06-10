import { describe, expect, it } from "vitest";
import { resolveUnitCost, unitCostForLocation } from "@/lib/domain/unit-cost";

describe("resolveUnitCost", () => {
  const costs = (us: string | number | null, intl: string | number | null) => ({
    unitCostUsd: us,
    unitCostIntlUsd: intl,
  });

  it("US always uses the US column, never the INTL fallback", () => {
    expect(resolveUnitCost("US", costs("4.50", "2.10"))).toEqual({ value: 4.5, source: "us" });
    expect(resolveUnitCost("US", costs(null, "2.10"))).toEqual({ value: 0, source: "none" });
  });

  it("CN uses INTL when priced", () => {
    expect(resolveUnitCost("CN", costs("4.50", "2.10"))).toEqual({ value: 2.1, source: "intl" });
  });

  it("CN falls back to US in default mode when INTL is missing or zero", () => {
    expect(resolveUnitCost("CN", costs("4.50", null))).toEqual({ value: 4.5, source: "us" });
    expect(resolveUnitCost("CN", costs("4.50", "0"))).toEqual({ value: 4.5, source: "us" });
  });

  it("CN strict mode never falls back to US (factory orders)", () => {
    expect(resolveUnitCost("CN", costs("4.50", null), { mode: "strict" })).toEqual({
      value: 0,
      source: "none",
    });
    expect(resolveUnitCost("CN", costs("4.50", "2.10"), { mode: "strict" })).toEqual({
      value: 2.1,
      source: "intl",
    });
  });

  it("treats unparseable and non-positive values as unpriced", () => {
    expect(resolveUnitCost("US", costs("abc", null))).toEqual({ value: 0, source: "none" });
    expect(resolveUnitCost("CN", costs("-1", "-2"))).toEqual({ value: 0, source: "none" });
  });
});

describe("unitCostForLocation (legacy row shape)", () => {
  it("matches resolveUnitCost fallback mode", () => {
    expect(
      unitCostForLocation({ location: "CN", unitCostUsd: "4.50", unitCostIntlUsd: null }),
    ).toBe(4.5);
    expect(
      unitCostForLocation({ location: "US", unitCostUsd: "4.50", unitCostIntlUsd: "2.10" }),
    ).toBe(4.5);
  });
});
