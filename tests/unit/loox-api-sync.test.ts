import { describe, expect, it } from "vitest";
import {
  displayNameForProduct,
  lineForProduct,
  looxDedupKey,
} from "@/lib/jobs/loox-api-sync";
import { handleFromProductUrl, type LooxApiReview } from "@/lib/sources/loox/api";

const review = (over: Partial<LooxApiReview>): LooxApiReview => ({
  id: "abc123",
  rating: 5,
  body: "Great product",
  date: "2026-07-11T11:37:46.869Z",
  createdAt: "2026-07-11T11:37:46.869Z",
  verified: false,
  status: "published",
  orderId: null,
  reviewer: { name: "Jane Doe", firstName: "Jane", lastName: "Doe", nickname: "Jane D.", email: "jane@example.com" },
  product: { id: "1", name: "P", url: "http://everdries.com/products/p" },
  ...over,
});

describe("looxDedupKey", () => {
  it("keys on lowercased email + exact date, ignoring the store-specific id", () => {
    const main = review({ id: "mainId" });
    const intlCopy = review({ id: "intlId", reviewer: { ...main.reviewer, email: "JANE@example.com" } });
    expect(looxDedupKey(main)).toBe(looxDedupKey(intlCopy));
    expect(looxDedupKey(main)).toBe("jane@example.com|2026-07-11T11:37:46.869Z");
  });

  it("falls back to name+date+body hash when email is missing", () => {
    const a = review({ reviewer: { name: "Jane Doe", firstName: null, lastName: null, nickname: null, email: null } });
    const b = review({ reviewer: { name: "Jane Doe", firstName: null, lastName: null, nickname: null, email: null }, body: "Different text" });
    expect(looxDedupKey(a)).not.toBe(looxDedupKey(b));
    expect(looxDedupKey(a)).toContain("jane doe|2026-07-11");
  });
});

describe("displayNameForProduct", () => {
  it("folds listing variants into the base product", () => {
    expect(displayNameForProduct("NEW: Leakproof High Waisted (Bundles)")).toBe("Leakproof High Waisted");
    expect(displayNameForProduct("Leakproof High Waisted (Heavy Absorbency Bundles)")).toBe("Leakproof High Waisted");
    expect(displayNameForProduct("Comfy & Discreet Leakproof Underwear (5-Pack😊)")).toBe("Comfy & Discreet Leakproof Underwear");
    expect(displayNameForProduct("Leakproof Boyshorts")).toBe("Leakproof Boyshorts");
  });

  it("folds bare pack-size suffixes too (Scott 2026-07-14)", () => {
    expect(displayNameForProduct("Comfort Plus Leakproof Underwear 10-Pack")).toBe(
      "Comfort Plus Leakproof Underwear",
    );
    expect(displayNameForProduct("Comfort Plus Leakproof Underwear 5 Pack")).toBe(
      "Comfort Plus Leakproof Underwear",
    );
    // sheet-style dedup suffix after the pack ("10-Pack-1")
    expect(displayNameForProduct("Leakproof High Waisted Comfort Plus 10-Pack-1")).toBe(
      "Leakproof High Waisted Comfort Plus",
    );
    // a number that is part of the product name must survive
    expect(displayNameForProduct("Style 9055")).toBe("Style 9055");
  });

  it("never returns an empty name", () => {
    expect(displayNameForProduct("(Bundles)")).toBe("(Bundles)");
  });
});

describe("lineForProduct", () => {
  it("classifies heavy from name or handle, std otherwise", () => {
    expect(lineForProduct("Leakproof High Waisted (Heavy Absorbency Bundles)", null)).toBe("heavy");
    expect(lineForProduct("Leakproof High Waisted", "hw-heavy-bundles")).toBe("heavy");
    expect(lineForProduct("Leakproof High Waisted", "leakproof-high-waisted")).toBe("std");
  });
});

describe("handleFromProductUrl", () => {
  it("extracts the Shopify handle from any store url", () => {
    expect(handleFromProductUrl("http://everdries.com/products/new-leakproof-super-high-waisted-bundles")).toBe(
      "new-leakproof-super-high-waisted-bundles",
    );
    expect(handleFromProductUrl("http://shop.everdries.com/products/cotton?utm=x")).toBe("cotton");
    expect(handleFromProductUrl(null)).toBeNull();
    expect(handleFromProductUrl("http://everdries.com/pages/about")).toBeNull();
  });
});
