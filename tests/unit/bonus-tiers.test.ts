import { describe, it, expect } from "vitest";
import {
  BONUS_MARKETERS,
  BONUS_TIER_1_USD,
  BONUS_TIER_2_USD,
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
