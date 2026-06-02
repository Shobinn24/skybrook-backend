import { describe, it, expect } from "vitest";
import {
  BONUS_AD_FLOOR,
  BONUS_MARKETERS,
  BONUS_TIER_1_USD,
  BONUS_TIER_2_USD,
  bonusAmountAtFullUsd,
  bonusAmountUsd,
  bonusCategory,
  bonusTier,
  firstCrossingDate,
  isAboveBonusFloor,
  isBonusMarketer,
  payoutMonthFromLabel,
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

describe("BONUS_AD_FLOOR", () => {
  it("sets Jacob floor at 1896, Dan at 1944, JW at 1907 (Scott 2026-05-20)", () => {
    expect(BONUS_AD_FLOOR.Jacob).toBe(1896);
    expect(BONUS_AD_FLOOR.Dan).toBe(1944);
    expect(BONUS_AD_FLOOR.JW).toBe(1907);
  });

  it("keeps Craig, Raul, Tyler at floor 0 (no exclusion)", () => {
    expect(BONUS_AD_FLOOR.Craig).toBe(0);
    expect(BONUS_AD_FLOOR.Raul).toBe(0);
    expect(BONUS_AD_FLOOR.Tyler).toBe(0);
  });
});

describe("isAboveBonusFloor()", () => {
  it("excludes Jacob ads strictly below 1896", () => {
    expect(isAboveBonusFloor("Jacob", "1")).toBe(false);
    expect(isAboveBonusFloor("Jacob", "1895")).toBe(false);
  });

  it("includes Jacob ads at or above 1896", () => {
    expect(isAboveBonusFloor("Jacob", "1896")).toBe(true);
    expect(isAboveBonusFloor("Jacob", "9999")).toBe(true);
  });

  it("excludes JW ads strictly below 1907", () => {
    expect(isAboveBonusFloor("JW", "1906")).toBe(false);
  });

  it("includes JW ads at or above 1907", () => {
    expect(isAboveBonusFloor("JW", "1907")).toBe(true);
  });

  it("excludes Dan ads strictly below 1944", () => {
    expect(isAboveBonusFloor("Dan", "1943")).toBe(false);
  });

  it("includes Dan ads at or above 1944", () => {
    expect(isAboveBonusFloor("Dan", "1944")).toBe(true);
  });

  it("always includes Craig/Raul/Tyler ads (floor is 0)", () => {
    expect(isAboveBonusFloor("Craig", "1")).toBe(true);
    expect(isAboveBonusFloor("Raul", "1")).toBe(true);
    expect(isAboveBonusFloor("Tyler", "1")).toBe(true);
    expect(isAboveBonusFloor("Craig", "0")).toBe(true);
  });

  it("excludes non-numeric ad numbers safely (NaN guard)", () => {
    expect(isAboveBonusFloor("Jacob", "abc")).toBe(false);
    expect(isAboveBonusFloor("Jacob", "")).toBe(false);
    expect(isAboveBonusFloor("Craig", "x")).toBe(false);
  });
});

describe("firstCrossingDate()", () => {
  it("returns the spend_date where cumulative first reaches the threshold", () => {
    // Cumulative: 05-29=12971.38, 05-30=13007.23 → crosses $13k on 05-30.
    const daily = [
      { spendDate: "2026-05-28", costUsd: 12_931.23 - 12_895.12 }, // +36.11
      { spendDate: "2026-05-27", costUsd: 12_895.12 }, // baseline lump
      { spendDate: "2026-05-29", costUsd: 40.15 },
      { spendDate: "2026-05-30", costUsd: 35.85 },
      { spendDate: "2026-05-31", costUsd: 35.18 },
    ];
    expect(firstCrossingDate(daily, BONUS_TIER_1_USD)).toBe("2026-05-30");
  });

  it("returns null when cumulative never reaches the threshold", () => {
    const daily = [
      { spendDate: "2026-05-01", costUsd: 5_000 },
      { spendDate: "2026-05-02", costUsd: 4_000 },
    ];
    expect(firstCrossingDate(daily, BONUS_TIER_1_USD)).toBeNull();
  });

  it("sorts by date internally (does not assume input is ordered)", () => {
    // Deliberately unordered. Sorted cumulative: 05-01=7000, 05-02=13500 (crosses),
    // 05-03=16500. Crossing is the MIDDLE date, so a naive unsorted scan would miss it.
    const daily = [
      { spendDate: "2026-05-01", costUsd: 7_000 },
      { spendDate: "2026-05-03", costUsd: 3_000 },
      { spendDate: "2026-05-02", costUsd: 6_500 },
    ];
    expect(firstCrossingDate(daily, BONUS_TIER_1_USD)).toBe("2026-05-02");
  });

  it("treats an exact-threshold cumulative as crossed (>=)", () => {
    const daily = [
      { spendDate: "2026-05-01", costUsd: 7_000 },
      { spendDate: "2026-05-02", costUsd: 6_000 }, // cum exactly 13000
    ];
    expect(firstCrossingDate(daily, BONUS_TIER_1_USD)).toBe("2026-05-02");
  });

  it("returns null for an empty series", () => {
    expect(firstCrossingDate([], BONUS_TIER_1_USD)).toBeNull();
  });
});

describe("payoutMonthFromLabel()", () => {
  it("parses a 'Month YYYY' payout label to YYYY-MM", () => {
    expect(payoutMonthFromLabel("May 2026")).toBe("2026-05");
    expect(payoutMonthFromLabel("April 2026")).toBe("2026-04");
    expect(payoutMonthFromLabel("December 2026")).toBe("2026-12");
    expect(payoutMonthFromLabel("January 2027")).toBe("2027-01");
  });

  it("is case-insensitive and tolerates surrounding whitespace", () => {
    expect(payoutMonthFromLabel("  may 2026 ")).toBe("2026-05");
    expect(payoutMonthFromLabel("OCTOBER 2026")).toBe("2026-10");
  });

  it("returns null for labels that aren't a clean 'Month YYYY'", () => {
    // The historical-backfill batch label must NOT parse — it falls back
    // to sent_at month in the summary.
    expect(payoutMonthFromLabel("Historical backfill 2026-05-21")).toBeNull();
    expect(payoutMonthFromLabel("test")).toBeNull();
    expect(payoutMonthFromLabel("May")).toBeNull();
    expect(payoutMonthFromLabel("2026-05")).toBeNull();
    expect(payoutMonthFromLabel("")).toBeNull();
    expect(payoutMonthFromLabel("Maybe 2026")).toBeNull(); // not a real month
  });
});
