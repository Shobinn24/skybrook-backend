import { describe, it, expect } from "vitest";
import { parseVelocitySheetRows } from "@/lib/jobs/product-names";

describe("parseVelocitySheetRows", () => {
  it("carries the sticky style label down through subsequent SKU rows", () => {
    const rows: unknown[][] = [
      ["DATE", "PRODUCT", "SKU"], // header — ignored
      ["", "Style 9055", "ev-9055-5x-xxs"],
      ["", "", "ev-9055-5x-xs"],
      ["", "", "ev-9055-5x-s"],
    ];
    const map = parseVelocitySheetRows(rows);
    expect(map.get("ev-9055-5x-xxs")).toBe("Style 9055");
    expect(map.get("ev-9055-5x-xs")).toBe("Style 9055");
    expect(map.get("ev-9055-5x-s")).toBe("Style 9055");
  });

  it("switches style label when a new sticky label appears", () => {
    const rows: unknown[][] = [
      ["", "Style 9055", "ev-9055-5x-l"],
      ["", "", "ev-9055-5x-xl"],
      ["", "OG Beige 1-Pack", "ev-og-1x-beige-l"],
      ["", "", "ev-og-1x-beige-m"],
    ];
    const map = parseVelocitySheetRows(rows);
    expect(map.get("ev-9055-5x-l")).toBe("Style 9055");
    expect(map.get("ev-9055-5x-xl")).toBe("Style 9055");
    expect(map.get("ev-og-1x-beige-l")).toBe("OG Beige 1-Pack");
    expect(map.get("ev-og-1x-beige-m")).toBe("OG Beige 1-Pack");
  });

  it("majority-vote resolves SKUs that appear under multiple labels", () => {
    // Same SKU labeled "Boyshort" 3× and "Boyshort Black" 1× — Boyshort wins.
    const rows: unknown[][] = [
      ["", "Boyshort", "ev-bshort-5x-l"],
      ["", "Boyshort", "ev-bshort-5x-l"],
      ["", "Boyshort", "ev-bshort-5x-l"],
      ["", "Boyshort Black", "ev-bshort-5x-l"],
    ];
    const map = parseVelocitySheetRows(rows);
    expect(map.get("ev-bshort-5x-l")).toBe("Boyshort");
  });

  it("ignores 'Date' / 'Product' header values that appear in column B", () => {
    const rows: unknown[][] = [
      ["DATE", "PRODUCT", "SKU"],
      ["", "Style 9055", "ev-9055-5x-l"],
      ["DATE", "Product", "SKU"], // re-header mid-sheet — must NOT clobber the label
      ["", "", "ev-9055-5x-xl"],
    ];
    const map = parseVelocitySheetRows(rows);
    expect(map.get("ev-9055-5x-xl")).toBe("Style 9055");
  });

  it("skips SKUs that appear before any style label", () => {
    const rows: unknown[][] = [
      ["", "", "ev-orphan-5x-l"], // no label seen yet
      ["", "Style 9055", "ev-9055-5x-l"],
    ];
    const map = parseVelocitySheetRows(rows);
    expect(map.has("ev-orphan-5x-l")).toBe(false);
    expect(map.get("ev-9055-5x-l")).toBe("Style 9055");
  });

  it("returns an empty map for empty input", () => {
    expect(parseVelocitySheetRows([])).toEqual(new Map());
  });
});
