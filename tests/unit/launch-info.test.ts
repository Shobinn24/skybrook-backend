import { describe, expect, it } from "vitest";
import { launchInfoKeyFor, normalizeLaunchInfoName } from "@/lib/domain/launch-info-mapping";
import { parseLaunchInfoSheet } from "@/lib/sources/sheets/launch-info";

const HEADER = ["Product", "External Name", "5-Pack Price", "Colours",
  "Main Composition", "Liner Composition", "China Photoshoot", "Image Tool"];

describe("parseLaunchInfoSheet", () => {
  it("parses rows, prices, and sparse trailing columns", () => {
    const { rows, skipped } = parseLaunchInfoSheet([
      HEADER,
      ["Cotton HW", "", "$69.95", "Rose, Beige", "95% Cotton, 5% Spandex",
        "95% Cotton, 5% Spandex", "https://drive.google.com/x"],
      ["Super HW FC ", "NEW: Leakproof HW Comfort Plus", "$59.95", "", "",
        "95% Viscose, 5% Spandex"],
    ]);
    expect(skipped).toEqual([]);
    expect(rows).toHaveLength(2);
    const [cotton, suphw] = rows;
    expect(cotton.product).toBe("Cotton HW");
    expect(cotton.packPriceUsd).toBe(69.95);
    expect(cotton.externalName).toBeNull();
    expect(cotton.chinaPhotoshootUrl).toBe("https://drive.google.com/x");
    expect(cotton.imageToolUrl).toBeNull();
    expect(suphw.product).toBe("Super HW FC"); // trimmed
    expect(suphw.mainComposition).toBeNull();
    expect(suphw.linerComposition).toBe("95% Viscose, 5% Spandex");
  });

  it("skips blank product rows and flags duplicates", () => {
    const { rows, skipped } = parseLaunchInfoSheet([
      HEADER,
      ["", "ghost"],
      ["Cotton HW", "", "$69.95"],
      ["cotton hw", "", "$1.00"],
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].packPriceUsd).toBe(69.95); // first row wins
    expect(skipped).toHaveLength(1);
  });

  it("rejects an unexpected header", () => {
    const { rows, skipped } = parseLaunchInfoSheet([["Totally", "Different"], ["x"]]);
    expect(rows).toEqual([]);
    expect(skipped[0].reason).toContain("unexpected header");
  });
});

describe("launchInfoKeyFor", () => {
  it("maps every prod launch name to its sheet product (2026-07-08 audit)", () => {
    const sheetProducts = ["Super HW FC", "Shapewear Black", "High Rise Short",
      "Cotton Hipster", "Men's Brief with Fly", "Cotton HW",
      "Men's Boxer Brief with Fly", "Men's Brief with Fly (Black)",
      "Men's Boxer Brief with Fly (Black)"].map(normalizeLaunchInfoName);
    const launches: Array<[string, string]> = [
      ["Cotton High Waisted 5-Pack", "cotton hw"],
      ["Boxer w/ Fly 3-Pack", "men's boxer brief with fly"],
      ["Cotton Hipster", "cotton hipster"],
      ["Mens Brief with Fly 3-Pack", "men's brief with fly"],
      ["High Rise Short", "high rise short"],
      ["Shapewear Black", "shapewear black"],
      ["Super High-Waist 5-Pack Multi Color", "super hw fc"],
      ["Mens Brief with Fly 3-Pack Black", "men's brief with fly (black)"],
      ["Boxer w/ Fly 3-Pack Black", "men's boxer brief with fly (black)"],
    ];
    for (const [launch, expected] of launches) {
      expect(launchInfoKeyFor(launch)).toBe(expected);
      expect(sheetProducts).toContain(expected);
    }
    // Known unmatched launch simply resolves to itself (blank display).
    expect(sheetProducts).not.toContain(launchInfoKeyFor("Mens 3-Pack"));
  });
});
