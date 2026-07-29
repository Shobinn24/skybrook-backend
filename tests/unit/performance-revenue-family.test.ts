import { describe, expect, it } from "vitest";
import { productNameForRevenue, revenueFamilyFromProductName } from "@/lib/queries/performance";

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
    // Acclaims brand carve-out: must NOT merge into the EV families
    ["Acclaims Style 9055 3-Pack", "Acclaims"],
    ["Acclaims Boyshort 3-Pack HF", "Acclaims"],
    ["HW 1-Pack", "HW"],
    ["Boyshort", "Boyshort"],
    ["Super High-Waist", "Super High-Waist"],
    ["High Rise Short", "High Rise Short"],
  ];
  it.each(cases)("%s -> %s", (name, family) => {
    expect(revenueFamilyFromProductName(name)).toBe(family);
  });
});

describe("productNameForRevenue (skus-join fallback, 2026-07-29)", () => {
  it("passes a joined product name straight through", () => {
    expect(productNameForRevenue("Boxer w/ Fly 3-Pack", "ev-flyboxer-3x-m")).toBe(
      "Boxer w/ Fly 3-Pack",
    );
  });

  it("derives the name from the SKU when the skus join missed", () => {
    // The real gap: flyboxer 6-pack + 3x-2XL variants sold on Shopify
    // before the inventory sheet (and therefore skus) knew them.
    expect(productNameForRevenue(null, "ev-flyboxer-6x-xl")).toBe(
      "Boxer w/ Fly 6-Pack",
    );
    expect(productNameForRevenue(null, "ev-flyboxer-3x-2xl")).toBe(
      "Boxer w/ Fly 3-Pack",
    );
  });

  it("derived names land in the right revenue family (the men's rollup)", () => {
    expect(
      revenueFamilyFromProductName(productNameForRevenue(null, "ev-flyboxer-6x-m")),
    ).toBe("Mens Boxer");
  });

  it("falls back to empty string (Other products) for unknown SKU shapes", () => {
    expect(productNameForRevenue(null, "totally-unknown")).toBe("");
    expect(revenueFamilyFromProductName("")).toBe("Other products");
  });
});
