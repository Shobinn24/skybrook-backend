import { describe, expect, it } from "vitest";
import {
  direction,
  isMultiProduct,
  labelFromProductTitle,
  labelOf,
  mapStyle,
  normSize,
  sizeFromVariantTitle,
  SIZE_RANK,
} from "@/lib/sizing/mapper";

describe("normSize", () => {
  it("extracts end-anchored size with product prefix (spec step 5)", () => {
    expect(normSize("HW HF 3XL")).toBe("3XL");
    expect(normSize("OG XXL")).toBe("2XL");
  });
  it("canonicalizes XXL/XXXL, keeps XXS", () => {
    expect(normSize("XXL")).toBe("2XL");
    expect(normSize("XXXL")).toBe("3XL");
    expect(normSize("XXS")).toBe("XXS");
  });
  it("longer tokens win over their suffixes", () => {
    expect(normSize("2XL")).toBe("2XL"); // not XL
    expect(normSize("XS")).toBe("XS"); // not S
    expect(normSize("5XL")).toBe("5XL");
  });
  it("strips whitespace and case before matching (spec step 5)", () => {
    expect(normSize("  x l ")).toBe("XL"); // whitespace removed first, then matched
    expect(normSize("xl")).toBe("XL");
  });
  it("no match -> null", () => {
    expect(normSize("N/A")).toBeNull();
    expect(normSize("")).toBeNull();
    expect(normSize(null)).toBeNull();
  });
});

describe("mapStyle", () => {
  it("maps tokens, never substrings", () => {
    expect(mapStyle("BSHORT")).toEqual({ product: "Boyshort", heavy: false });
    // the S inside BSHORT must not create a false hit anywhere
    expect(mapStyle("BSHORT HF")).toEqual({ product: "Boyshort", heavy: true });
  });
  it("drops Seamless wherever SL appears as a token", () => {
    expect(mapStyle("SL HW HF")).toBeNull();
    expect(mapStyle("SL BIK")).toBeNull();
  });
  it("HF or HE means Heavy", () => {
    expect(mapStyle("HW HF")).toEqual({ product: "High Waisted", heavy: true });
    expect(mapStyle("CP HE")).toEqual({ product: "Comfort Plus", heavy: true });
    expect(mapStyle("CP")).toEqual({ product: "Comfort Plus", heavy: false });
  });
  it("maps the full token table", () => {
    expect(mapStyle("OG")?.product).toBe("Comfy & Discreet");
    expect(mapStyle("HIP")?.product).toBe("Hipster");
    expect(mapStyle("BIK")?.product).toBe("Bikini");
    expect(mapStyle("MENS")?.product).toBe("Men's");
    expect(mapStyle("SUPHW")?.product).toBe("Super HW");
    expect(mapStyle("SUPHFW")?.product).toBe("Super HW");
    expect(mapStyle("FRENCH")?.product).toBe("French");
    expect(mapStyle("FR")?.product).toBe("French");
    expect(mapStyle("SW")?.product).toBe("Shapewear");
  });
  it("unmappable -> null", () => {
    expect(mapStyle("SHINBO")).toBeNull();
    expect(mapStyle("")).toBeNull();
    expect(mapStyle(null)).toBeNull();
  });
  it("maps post-spec 2026 products and CS spelling variants", () => {
    expect(mapStyle("HRSHORT")).toEqual({ product: "Highrise Short", heavy: false });
    expect(mapStyle("HSHORT")).toEqual({ product: "Highrise Short", heavy: false });
    expect(mapStyle("COTTON")).toEqual({ product: "Cotton", heavy: false });
    expect(mapStyle("FC")?.product).toBe("French");
    expect(mapStyle("FC HF")).toEqual({ product: "French", heavy: true });
    expect(mapStyle("HC")?.product).toBe("French");
    expect(mapStyle("HIPSTER")?.product).toBe("Hipster");
    expect(mapStyle("SHAPEWEAR")?.product).toBe("Shapewear");
    expect(mapStyle("MEN")?.product).toBe("Men's");
  });
});

describe("labelOf", () => {
  it("splits Std/Heavy except for the three no-split products", () => {
    expect(labelOf({ product: "High Waisted", heavy: true })).toBe("High Waisted Heavy");
    expect(labelOf({ product: "High Waisted", heavy: false })).toBe("High Waisted Std");
    expect(labelOf({ product: "Men's", heavy: false })).toBe("Men's");
    expect(labelOf({ product: "Super HW", heavy: false })).toBe("Super HW");
    expect(labelOf({ product: "Shapewear", heavy: false })).toBe("Shapewear");
    expect(labelOf({ product: "Highrise Short", heavy: false })).toBe("Highrise Short");
    expect(labelOf({ product: "Cotton", heavy: false })).toBe("Cotton");
  });
});

describe("direction (spec 4.1: XXS in the rank scale)", () => {
  it("basic up/down/same", () => {
    expect(direction("M", "L")).toBe("up");
    expect(direction("L", "M")).toBe("down");
    expect(direction("M", "M")).toBe("same");
  });
  it("XS -> XXS is DOWN, not unknown (the manual run's silent-drop bug)", () => {
    expect(direction("XS", "XXS")).toBe("down");
    expect(direction("XXS", "XS")).toBe("up");
  });
  it("unparseable either side -> unknown", () => {
    expect(direction(null, "M")).toBe("unknown");
    expect(direction("M", null)).toBe("unknown");
  });
  it("rank scale covers every size in the spec", () => {
    for (const s of ["XXXS", "XXS", "XS", "S", "M", "L", "XL", "2XL", "3XL", "4XL", "5XL", "6XL"]) {
      expect(SIZE_RANK[s]).toBeDefined();
    }
  });
});

describe("isMultiProduct", () => {
  it("flags comma/slash cells in Style AND Size Replaced", () => {
    expect(isMultiProduct("HW, OG")).toBe(true);
    expect(isMultiProduct("HW/OG")).toBe(true);
    expect(isMultiProduct("HW HF 3XL, OG HF 3XL")).toBe(true); // live-data case
    expect(isMultiProduct("HW HF 3XL")).toBe(false);
    expect(isMultiProduct(null)).toBe(false);
  });
});

describe("labelFromProductTitle (spec step 8 ordering)", () => {
  it("checks super high waisted before high waisted", () => {
    expect(labelFromProductTitle("Super High Waisted Shaper")).toBe("Super HW");
    expect(labelFromProductTitle("NEW: Leakproof High Waisted")).toBe("High Waisted Std");
    expect(labelFromProductTitle("Leakproof High Waisted Heavy Flow Version")).toBe(
      "High Waisted Heavy",
    );
  });
  it("excludes seamless and noise products", () => {
    expect(labelFromProductTitle("Seamless High Waisted")).toBeNull();
    expect(labelFromProductTitle("Leakproof Lace Brief")).toBeNull();
    expect(labelFromProductTitle("Mystery Gift")).toBeNull();
  });
  it("maps the rename and the rest of the table", () => {
    expect(labelFromProductTitle("Shaping Brief")).toBe("Shapewear");
    expect(labelFromProductTitle("Leakproof Shapewear")).toBe("Shapewear");
    expect(labelFromProductTitle("Men's Leakproof Underwear")).toBe("Men's");
    expect(labelFromProductTitle("High Cut Leakproof Underwear")).toBe("French Std");
    expect(labelFromProductTitle("Comfy & Discreet Leakproof Underwear")).toBe(
      "Comfy & Discreet Std",
    );
    expect(labelFromProductTitle("Cotton Leakproof Underwear")).toBe("Cotton");
  });
  it("Highrise Shorts and its Comfort Shorts alias map to one label", () => {
    expect(labelFromProductTitle("NEW: Leakproof Highrise Shorts (Bundles)")).toBe("Highrise Short");
    expect(labelFromProductTitle("Leakproof Comfort Shorts (5-Pack)")).toBe("Highrise Short");
    // the alias must not swallow Comfort Plus
    expect(labelFromProductTitle("NEW: Comfort Plus Leakproof Underwear")).toBe("Comfort Plus Std");
  });
});

describe("sizeFromVariantTitle", () => {
  it("takes the part before the slash (spec 1B)", () => {
    expect(sizeFromVariantTitle("XL / 5-Pack")).toBe("XL");
    expect(sizeFromVariantTitle("XXL / 10-Pack / Beige")).toBe("2XL");
    expect(sizeFromVariantTitle("M")).toBe("M");
    expect(sizeFromVariantTitle("Default Title")).toBeNull();
  });
});

describe("parseSheetDate (cs ingest)", () => {
  it("parses Sheets serial numbers, ISO, US formats; rejects junk", async () => {
    const { parseSheetDate } = await import("@/lib/jobs/cs-exchange-sync");
    expect(parseSheetDate("46023")).toBe("2026-01-01"); // serial
    expect(parseSheetDate("2026-07-15")).toBe("2026-07-15");
    expect(parseSheetDate("1/9/2026")).toBe("2026-01-09");
    expect(parseSheetDate("k")).toBeNull();
    expect(parseSheetDate("12")).toBeNull(); // tiny number is not a date
    expect(parseSheetDate("")).toBeNull();
  });
});
