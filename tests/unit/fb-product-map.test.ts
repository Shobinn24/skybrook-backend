import { describe, it, expect } from "vitest";
import { parseFbProductMapSheet } from "@/lib/sources/sheets/fb-product-map";

const HEADER = ["URL", "US/INTL", "Product"];

describe("parseFbProductMapSheet", () => {
  it("parses rows -> normalized url + region + canonical product", () => {
    const grid = [
      HEADER,
      ["https://everdries.com/comfortplus", "US", "9055"],
      ["https://shop.everdries.com/superhw", "INTL", "Super HW"],
      ["https://everdries.com/", "US", "Home"],
    ];
    const { rows, skipped } = parseFbProductMapSheet(grid);
    expect(skipped).toEqual([]);
    expect(rows).toEqual([
      { normalizedUrl: "everdries.com/comfortplus", rawUrl: "https://everdries.com/comfortplus", region: "US", productLabel: "9055" },
      { normalizedUrl: "shop.everdries.com/superhw", rawUrl: "https://shop.everdries.com/superhw", region: "INTL", productLabel: "Super High-Waist" },
      { normalizedUrl: "everdries.com", rawUrl: "https://everdries.com/", region: "US", productLabel: "Brand / Homepage" },
    ]);
  });

  it("dedupes agreeing duplicate rows (no skip)", () => {
    const grid = [
      HEADER,
      ["https://everdries.com/boyshort", "US", "Boyshort"],
      ["http://www.everdries.com/boyshort", "US", "Boyshort"], // same normalized key, agrees
    ];
    const { rows, skipped } = parseFbProductMapSheet(grid);
    expect(rows).toHaveLength(1);
    expect(skipped).toEqual([]);
    expect(rows[0].normalizedUrl).toBe("everdries.com/boyshort");
  });

  it("keeps first + records skip on a conflicting duplicate", () => {
    const grid = [
      HEADER,
      ["https://everdries.com/x", "US", "9055"],
      ["https://everdries.com/x", "US", "Boyshort"], // same key, different product
    ];
    const { rows, skipped } = parseFbProductMapSheet(grid);
    expect(rows).toHaveLength(1);
    expect(rows[0].productLabel).toBe("9055");
    expect(skipped).toHaveLength(1);
    expect(skipped[0].reason).toMatch(/conflict/i);
  });

  it("NA product -> Other (NA); trailing spaces trimmed; region case-normalized", () => {
    const grid = [
      HEADER,
      ["https://everdries.com/lavender", "US", "NA"],
      ["https://everdries.com/gifts-og", "us", "OG "],
      ["https://shop.everdries.com/heavyflow-og", "intl", "9055 HF"],
    ];
    const { rows } = parseFbProductMapSheet(grid);
    expect(rows[0]).toMatchObject({ region: "US", productLabel: "Other (NA)" });
    expect(rows[1]).toMatchObject({ region: "US", productLabel: "OG" });
    expect(rows[2]).toMatchObject({ region: "INTL", productLabel: "9055 HF" });
  });

  it("skips blank / short / unparseable-url / bad-region rows", () => {
    const grid = [
      HEADER,
      ["", "", ""],
      ["https://everdries.com/ok", "US", "9055"],
      ["not-a-url", "US", "9055"], // normalize -> null
      ["https://www.facebook.com/reel/1", "US", "9055"], // social -> null
      ["https://everdries.com/badregion", "CA", "9055"], // region not US/INTL
    ];
    const { rows, skipped } = parseFbProductMapSheet(grid);
    expect(rows).toHaveLength(1);
    expect(rows[0].normalizedUrl).toBe("everdries.com/ok");
    expect(skipped.length).toBeGreaterThanOrEqual(3);
  });

  it("returns empty + skip on unexpected header", () => {
    const { rows, skipped } = parseFbProductMapSheet([["foo", "bar", "baz"], ["x", "US", "9055"]]);
    expect(rows).toEqual([]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].rowIdx).toBe(0);
  });
});
