import { describe, expect, it } from "vitest";
import { revenueFamilyFromProductName } from "@/lib/queries/performance";

// Revenue-side family labels MUST match the spend-side labels emitted by
// attributeFbPrefix / canonicalProductLabel, or a product's revenue and
// spend land on different /performance rows.
describe("revenueFamilyFromProductName", () => {
  const cases: Array<[string, string]> = [
    // Intl launch 2026-07-10: cotton lines carve out BEFORE 9055/hipster/hw
    ["Cotton Hipster", "Cotton 9055"],
    ["Cotton 9055", "Cotton 9055"],
    ["Cotton Comfort Plus", "Cotton 9055"],
    ["Cotton High Waisted 5-Pack", "Cotton HW"],
    // Men's Brief carves out BEFORE the generic mens match
    ["Mens Brief with Fly 3-Pack", "Mens Brief"],
    // ...without disturbing the existing families
    ["Style 9055", "9055"],
    ["Style 9055 HF", "9055 HF"],
    ["Hipster", "Hipster"],
    ["Mens 5-Pack", "Mens"],
    // Intl launch 2026-07 wave 2: the boxer is its own line now
    ["Boxer w/ Fly 3-Pack", "Mens Boxer"],
    ["HW 1-Pack", "HW"],
    ["Boyshort", "Boyshort"],
    ["Super High-Waist", "Super High-Waist"],
    ["High Rise Short", "High Rise Short"],
  ];
  it.each(cases)("%s -> %s", (name, family) => {
    expect(revenueFamilyFromProductName(name)).toBe(family);
  });
});
