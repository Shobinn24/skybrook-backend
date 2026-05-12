import { describe, it, expect } from "vitest";
import { extractMarketers, FB_MARKETERS } from "@/lib/domain/fb-marketers";

describe("extractMarketers", () => {
  it("returns empty for empty / whitespace input", () => {
    expect(extractMarketers("")).toEqual([]);
    expect(extractMarketers("   ")).toEqual([]);
  });

  it("matches single marketer name as a standalone word", () => {
    expect(extractMarketers("(Mens) Ad 2326 - RC - Craig Mens VID 2")).toEqual([
      "Craig",
    ]);
    expect(extractMarketers("(Boyshort CC) Ad 2420 - GA - Raul Vid 257"))
      .toEqual(["Raul"]);
    expect(extractMarketers("(9055 ASC) Ad 1818 - TOF -JM - Tyler Vid 62"))
      .toEqual(["Tyler"]);
  });

  it("matches the JW 2-letter code", () => {
    expect(extractMarketers("(Boyshort IASC) Ad 2315 - JW - JW - C1 - 3/9/26"))
      .toEqual(["JW"]);
    expect(extractMarketers("(Clear ICC) Ad 1436 - JW - J Weston EV Oct25"))
      .toEqual(["JW"]);
  });

  it("dedupes multiple occurrences of the same name", () => {
    expect(
      extractMarketers("(9055 PP ASC) Ad 1849 - RC - Raul Vid 104 Raul Variation"),
    ).toEqual(["Raul"]);
  });

  it("returns all matches when multiple distinct marketers appear", () => {
    // Hypothetical multi-marketer ad — Scott's spec says spend shows in
    // each marketer's filter view, so the row carries both names.
    expect(extractMarketers("Ad 9999 - Craig and Tyler co-edit"))
      .toEqual(["Craig", "Tyler"]);
  });

  it("preserves roster order regardless of input order", () => {
    expect(extractMarketers("Tyler then Craig"))
      .toEqual(["Craig", "Tyler"]);
  });

  it("is case-insensitive", () => {
    expect(extractMarketers("CRAIG made this")).toEqual(["Craig"]);
    expect(extractMarketers("craig made this")).toEqual(["Craig"]);
    expect(extractMarketers("jw - C1")).toEqual(["JW"]);
  });

  it("requires word boundaries (no false-positives inside longer words)", () => {
    // "Daniel" must not match "Dan" — different name on the team
    expect(extractMarketers("Daniel Greer Vid 7")).toEqual([]);
    // "Bandana" must not match "Dan"
    expect(extractMarketers("Ad 1000 - bandana style")).toEqual([]);
    // Standalone "Dan" still matches
    expect(extractMarketers("Ad 1979 - DN - Dan Navarra Postpartum")).toEqual([
      "Dan",
    ]);
  });

  it("returns empty when no roster name appears", () => {
    expect(extractMarketers("(OG ICC) Ad 1500 - GA - Elie Ad 29")).toEqual([]);
    expect(extractMarketers("(Boyshort) Ad 2445 - NL - someone-else"))
      .toEqual([]);
  });

  it("covers every roster name with the same regex shape", () => {
    for (const name of FB_MARKETERS) {
      expect(extractMarketers(`Ad 1 - ${name} test`)).toContain(name);
    }
  });
});
