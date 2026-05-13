import { describe, it, expect } from "vitest";
import {
  BONUS_MARKETERS,
  BONUS_TIER_1_USD,
  BONUS_TIER_2_USD,
  bonusAmountAtFullUsd,
  bonusAmountUsd,
  bonusCategory,
  bonusTier,
  isBonusMarketer,
} from "@/lib/domain/bonus-tiers";

describe("BONUS_MARKETERS roster", () => {
  it("contains the 6 bonus-eligible marketers", () => {
    expect(BONUS_MARKETERS).toEqual([
      "Craig",
      "Raul",
      "Tyler",
      "Jacob",
      "Dan",
      "JW",
    ]);
  });

  it("excludes Nate and Scotty", () => {
    expect(isBonusMarketer("Nate")).toBe(false);
    expect(isBonusMarketer("Scotty")).toBe(false);
  });

  it("includes Craig and JW", () => {
    expect(isBonusMarketer("Craig")).toBe(true);
    expect(isBonusMarketer("JW")).toBe(true);
  });
});

describe("bonusTier()", () => {
  it("returns 'none' below the tier-1 threshold", () => {
    expect(bonusTier(0)).toBe("none");
    expect(bonusTier(BONUS_TIER_1_USD - 0.01)).toBe("none");
  });

  it("returns 'tier1' at exactly the tier-1 threshold", () => {
    expect(bonusTier(BONUS_TIER_1_USD)).toBe("tier1");
  });

  it("returns 'tier1' between the two thresholds", () => {
    expect(bonusTier(50_000)).toBe("tier1");
    expect(bonusTier(BONUS_TIER_2_USD - 0.01)).toBe("tier1");
  });

  it("returns 'tier2' at exactly the tier-2 threshold", () => {
    expect(bonusTier(BONUS_TIER_2_USD)).toBe("tier2");
  });

  it("returns 'tier2' above the tier-2 threshold", () => {
    expect(bonusTier(100_000)).toBe("tier2");
  });
});

describe("bonusCategory()", () => {
  it("classifies Craig, Raul, Tyler as main", () => {
    expect(bonusCategory("Craig")).toBe("main");
    expect(bonusCategory("Raul")).toBe("main");
    expect(bonusCategory("Tyler")).toBe("main");
  });

  it("classifies Jacob, Dan, JW as secondary", () => {
    expect(bonusCategory("Jacob")).toBe("secondary");
    expect(bonusCategory("Dan")).toBe("secondary");
    expect(bonusCategory("JW")).toBe("secondary");
  });
});

describe("bonusAmountUsd()", () => {
  it("pays main marketers $500 at T1 / $3000 at T2 (full)", () => {
    expect(bonusAmountUsd({ marketer: "Craig", tier: "tier1", approval: "approved_full" })).toBe(500);
    expect(bonusAmountUsd({ marketer: "Craig", tier: "tier2", approval: "approved_full" })).toBe(3000);
    expect(bonusAmountUsd({ marketer: "Raul", tier: "tier2", approval: "approved_full" })).toBe(3000);
    expect(bonusAmountUsd({ marketer: "Tyler", tier: "tier1", approval: "approved_full" })).toBe(500);
  });

  it("pays secondary marketers $250 at T1 / $1500 at T2 (full)", () => {
    expect(bonusAmountUsd({ marketer: "Jacob", tier: "tier1", approval: "approved_full" })).toBe(250);
    expect(bonusAmountUsd({ marketer: "Jacob", tier: "tier2", approval: "approved_full" })).toBe(1500);
    expect(bonusAmountUsd({ marketer: "Dan", tier: "tier1", approval: "approved_full" })).toBe(250);
    expect(bonusAmountUsd({ marketer: "JW", tier: "tier2", approval: "approved_full" })).toBe(1500);
  });

  it("halves the amount for approved_half", () => {
    expect(bonusAmountUsd({ marketer: "Craig", tier: "tier2", approval: "approved_half" })).toBe(1500);
    expect(bonusAmountUsd({ marketer: "Raul", tier: "tier1", approval: "approved_half" })).toBe(250);
    expect(bonusAmountUsd({ marketer: "Jacob", tier: "tier2", approval: "approved_half" })).toBe(750);
  });

  it("matches Jasper's April example totals", () => {
    // Craig: 8x T1 + 2x T2 + 1x T2 half = 8*500 + 2*3000 + 1500 = 11500
    const craigTotal =
      8 * bonusAmountUsd({ marketer: "Craig", tier: "tier1", approval: "approved_full" }) +
      2 * bonusAmountUsd({ marketer: "Craig", tier: "tier2", approval: "approved_full" }) +
      1 * bonusAmountUsd({ marketer: "Craig", tier: "tier2", approval: "approved_half" });
    expect(craigTotal).toBe(11_500);

    // Raul: 3x T1 + 2x T2 = 3*500 + 2*3000 = 7500
    const raulTotal =
      3 * bonusAmountUsd({ marketer: "Raul", tier: "tier1", approval: "approved_full" }) +
      2 * bonusAmountUsd({ marketer: "Raul", tier: "tier2", approval: "approved_full" });
    expect(raulTotal).toBe(7_500);

    // Jacob: 1x T1 + 1x T2 = 250 + 1500 = 1750
    const jacobTotal =
      bonusAmountUsd({ marketer: "Jacob", tier: "tier1", approval: "approved_full" }) +
      bonusAmountUsd({ marketer: "Jacob", tier: "tier2", approval: "approved_full" });
    expect(jacobTotal).toBe(1_750);
  });
});

describe("bonusAmountAtFullUsd()", () => {
  it("returns the full rate for the pre-approval pending row default", () => {
    expect(bonusAmountAtFullUsd({ marketer: "Craig", tier: "tier1" })).toBe(500);
    expect(bonusAmountAtFullUsd({ marketer: "Jacob", tier: "tier2" })).toBe(1500);
  });
});
