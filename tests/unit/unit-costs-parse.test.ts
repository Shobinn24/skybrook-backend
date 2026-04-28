import { describe, expect, it } from "vitest";
import { parseCostSheetRows } from "@/lib/jobs/unit-costs";

// Cost sheet layout (EVSKUmap, observed 2026-04-28):
//   row 1: date headers ("May'25" pair, "Apr'25" pair, ...)
//   row 2: "SKUs", "number", "quantity", "", "product", "pack", "5s", "3s",
//          "5 or 3", "US", "INTL", "US", "INTL", ...
//   rows 3+: SKU rows. Col A is SKU (mixed case + dash-form).
//
// Most recent costs are the LEFTMOST date pair. UNFORMATTED_VALUE returns
// numeric cells as numbers and formula errors as strings.
function makeGrid(): unknown[][] {
  // 4 cols of identifiers + 2 dates × 2 cols (US/INTL) = 8 cols.
  // Date row uses col 9 (=J) as first US col to match production layout.
  // Cols 0..8 are identifier prefix columns (matches sheet shape).
  const blank = (n: number) => Array.from({ length: n }, () => "" as unknown);
  const dateRow: unknown[] = [...blank(9), "May'25", "May'25", "Apr'25", "Apr'25"];
  const headerRow: unknown[] = [
    "SKUs", "number", "quantity", "", "product", "pack", "5s", "3s", "5 or 3",
    "US", "INTL", "US", "INTL",
  ];
  const grid: unknown[][] = [dateRow, headerRow];
  // SKU rows — col A = SKU, col J (idx 9) = US cost, col K (idx 10) = INTL cost.
  // Older Apr'25 is in cols L/M (idx 11/12). Parser should pick May'25.
  const r1 = [...blank(13)];
  r1[0] = "EV-OG-5-l";       r1[9] = 6.73;  r1[10] = 6.04;
  r1[11] = 6.7;              r1[12] = 6.0;
  const r2 = [...blank(13)];
  r2[0] = "ev-9055-hf-5-3xl"; r2[9] = 7.5;   r2[10] = 7.2;
  // Row with formula error in latest US column
  const r3 = [...blank(13)];
  r3[0] = "EV-broken-xs";    r3[9] = "#REF!"; r3[10] = "#REF!";
  // Row with empty SKU (skip)
  const r4 = [...blank(13)];
  r4[9] = 5.0;
  // Row with zero cost (skip)
  const r5 = [...blank(13)];
  r5[0] = "EV-zero-l";       r5[9] = 0;
  // Row with negative cost (skip)
  const r6 = [...blank(13)];
  r6[0] = "EV-neg-l";        r6[9] = -1;
  grid.push(r1, r2, r3, r4, r5, r6);
  return grid;
}

describe("parseCostSheetRows", () => {
  it("picks the leftmost (date, US) pair as the latest column", () => {
    const out = parseCostSheetRows(makeGrid());
    expect(out.latestColumn).toEqual({ dateLabel: "May'25", usCol: 9, intlCol: 10 });
  });

  it("canonicalizes mixed-case dash-form pack SKUs to lowercase x-form", () => {
    const out = parseCostSheetRows(makeGrid());
    const skus = out.rows.map((r) => r.sku);
    // EV-OG-5-l → ev-og-5x-l
    expect(skus).toContain("ev-og-5x-l");
    // ev-9055-hf-5-3xl → ev-9055-hf-5x-3xl (already lowercase, dash→x)
    expect(skus).toContain("ev-9055-hf-5x-3xl");
    // every emitted SKU is lowercase
    expect(skus.every((s) => s === s.toLowerCase())).toBe(true);
    // every emitted SKU has no dash-form 1/5 pack token
    expect(skus.every((s) => !/^ev-.+-(1|5)-/.test(s))).toBe(true);
  });

  it("skips rows whose latest US cell is non-numeric (formula error)", () => {
    const out = parseCostSheetRows(makeGrid());
    expect(out.rows.find((r) => r.sku.includes("broken"))).toBeUndefined();
    expect(out.errorRows).toBeGreaterThanOrEqual(1);
  });

  it("skips rows with zero or negative cost", () => {
    const out = parseCostSheetRows(makeGrid());
    expect(out.rows.find((r) => r.sku === "ev-zero-l")).toBeUndefined();
    expect(out.rows.find((r) => r.sku === "ev-neg-l")).toBeUndefined();
  });

  it("returns valid cost numbers for the canonical SKUs", () => {
    const out = parseCostSheetRows(makeGrid());
    const og = out.rows.find((r) => r.sku === "ev-og-5x-l");
    expect(og).toBeDefined();
    expect(og!.costUsd).toBeCloseTo(6.73);
  });

  it("returns empty result when no (date, US) header pair is present", () => {
    const grid: unknown[][] = [
      ["", "", "", "", "", "", "", "", ""], // no dates
      ["SKUs"], // no US/INTL labels
      ["EV-OG-5-l", "", "", "", "", "", "", "", "", 6.73, 6.04],
    ];
    const out = parseCostSheetRows(grid);
    expect(out.rows).toEqual([]);
    expect(out.latestColumn.usCol).toBe(-1);
  });

  it("ignores rows above the data block (idx 0 and 1)", () => {
    const out = parseCostSheetRows(makeGrid());
    expect(out.rows.find((r) => r.sku === "skus")).toBeUndefined();
    expect(out.rows.find((r) => /may.*25/i.test(r.sku))).toBeUndefined();
  });
});
