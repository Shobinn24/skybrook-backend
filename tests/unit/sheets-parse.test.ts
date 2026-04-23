import { describe, expect, it } from "vitest";
import {
  colIndexToA1,
  parseDayMonth,
  parseQty,
  pickLatestColumn,
  walkDateHeaders,
} from "@/lib/sources/sheets";

describe("colIndexToA1", () => {
  it("handles single-letter columns", () => {
    expect(colIndexToA1(0)).toBe("A");
    expect(colIndexToA1(25)).toBe("Z");
  });
  it("handles two-letter columns", () => {
    expect(colIndexToA1(26)).toBe("AA");
    expect(colIndexToA1(51)).toBe("AZ");
    expect(colIndexToA1(52)).toBe("BA");
    expect(colIndexToA1(701)).toBe("ZZ");
  });
  it("handles three-letter columns (needed for tabs >702 cols wide)", () => {
    expect(colIndexToA1(702)).toBe("AAA");
    expect(colIndexToA1(1124)).toBe("AQG");
  });
  it("rejects negative or non-integer indexes", () => {
    expect(() => colIndexToA1(-1)).toThrow();
    expect(() => colIndexToA1(1.5)).toThrow();
  });
});

describe("parseDayMonth", () => {
  it("parses standard /-separated headers", () => {
    expect(parseDayMonth("21/Apr")).toEqual({ day: 21, month: 4 });
    expect(parseDayMonth("3/Jun")).toEqual({ day: 3, month: 6 });
    expect(parseDayMonth("31/Dec")).toEqual({ day: 31, month: 12 });
  });
  it("accepts space and dash separators", () => {
    expect(parseDayMonth("21 Apr")).toEqual({ day: 21, month: 4 });
    expect(parseDayMonth("21-Apr")).toEqual({ day: 21, month: 4 });
  });
  it("is case-insensitive on month name", () => {
    expect(parseDayMonth("5/JUN")).toEqual({ day: 5, month: 6 });
    expect(parseDayMonth("5/jun")).toEqual({ day: 5, month: 6 });
  });
  it("treats Sept as September", () => {
    expect(parseDayMonth("12/Sept")).toEqual({ day: 12, month: 9 });
  });
  it("returns null for non-date headers and invalid days", () => {
    expect(parseDayMonth("")).toBeNull();
    expect(parseDayMonth("sku's")).toBeNull();
    expect(parseDayMonth("32/Jan")).toBeNull();
    expect(parseDayMonth("0/Jan")).toBeNull();
    expect(parseDayMonth("21/Foo")).toBeNull();
  });
});

describe("walkDateHeaders", () => {
  it("anchors rightmost cell to today's year when month/day ≤ today", () => {
    const out = walkDateHeaders(["sku's", "21/Apr", "22/Apr", "23/Apr"], "2026-04-23");
    expect(out).toEqual([
      { colIdx: 1, date: "2026-04-21" },
      { colIdx: 2, date: "2026-04-22" },
      { colIdx: 3, date: "2026-04-23" },
    ]);
  });
  it("anchors rightmost to prior year when month/day is past today", () => {
    // Today is Apr 23. If rightmost is Dec 31, it can't be this year — must be last year.
    const out = walkDateHeaders(["29/Dec", "30/Dec", "31/Dec"], "2026-04-23");
    expect(out.map((p) => p.date)).toEqual([
      "2025-12-29",
      "2025-12-30",
      "2025-12-31",
    ]);
  });
  it("walks leftward decrementing year on month INCREASE (year boundary)", () => {
    // Months left→right: Nov, Dec, Jan, Feb. Rightmost = Feb 2 → 2026.
    // Walking back: Feb→Jan stays 2026; Jan→Dec is an INCREASE (12>1) so year drops to 2025.
    const out = walkDateHeaders(["28/Nov", "30/Dec", "1/Jan", "2/Feb"], "2026-04-23");
    expect(out.map((p) => p.date)).toEqual([
      "2025-11-28",
      "2025-12-30",
      "2026-01-01",
      "2026-02-02",
    ]);
  });
  it("skips non-date headers and tolerates gaps in dates", () => {
    const out = walkDateHeaders(["sku's", "8/Jun", "", "10/Jun"], "2026-06-15");
    expect(out).toEqual([
      { colIdx: 1, date: "2026-06-08" },
      { colIdx: 3, date: "2026-06-10" },
    ]);
  });
  it("handles a 3-year run anchored to today", () => {
    // Today: Apr 23 2026. Rightmost = Apr 23 → 2026.
    // Walking back: Apr→Dec is INCREASE → 2025; Dec→Apr stays 2025; Apr→Dec INCREASE → 2024.
    const out = walkDateHeaders(["1/Apr", "1/Dec", "1/Apr", "1/Dec", "23/Apr"], "2026-04-23");
    expect(out.map((p) => p.date)).toEqual([
      "2024-04-01",
      "2024-12-01",
      "2025-04-01",
      "2025-12-01",
      "2026-04-23",
    ]);
  });
  it("returns empty when no cells parse", () => {
    expect(walkDateHeaders(["sku's", "", "foo"], "2026-04-23")).toEqual([]);
  });
});

describe("pickLatestColumn", () => {
  const parsed = [
    { colIdx: 1, date: "2026-04-21" },
    { colIdx: 2, date: "2026-04-22" },
    { colIdx: 3, date: "2026-04-23" },
    { colIdx: 4, date: "2026-04-24" },
  ];
  it("returns the rightmost date ≤ today", () => {
    expect(pickLatestColumn(parsed, "2026-04-23")).toEqual({ colIdx: 3, date: "2026-04-23" });
  });
  it("falls back to the most recent past date when today's column is missing", () => {
    expect(pickLatestColumn(parsed.slice(0, 2), "2026-04-23")).toEqual({
      colIdx: 2,
      date: "2026-04-22",
    });
  });
  it("ignores future-dated columns (Scott pre-filling tomorrow)", () => {
    expect(pickLatestColumn(parsed, "2026-04-23")?.colIdx).toBe(3);
  });
  it("returns null when no column is on or before today", () => {
    expect(pickLatestColumn(parsed, "2025-01-01")).toBeNull();
  });
  it("returns null on empty input", () => {
    expect(pickLatestColumn([], "2026-04-23")).toBeNull();
  });
});

describe("parseQty", () => {
  it("parses integers and floats (truncating)", () => {
    expect(parseQty(42)).toBe(42);
    expect(parseQty("42")).toBe(42);
    expect(parseQty(42.7)).toBe(42);
  });
  it("strips thousand separators", () => {
    expect(parseQty("1,877")).toBe(1877);
    expect(parseQty("12,345")).toBe(12345);
  });
  it("returns null for blanks, dashes, NaN", () => {
    expect(parseQty("")).toBeNull();
    expect(parseQty(null)).toBeNull();
    expect(parseQty(undefined)).toBeNull();
    expect(parseQty("-")).toBeNull();
    expect(parseQty("foo")).toBeNull();
    expect(parseQty(Number.NaN)).toBeNull();
  });
  it("preserves negative values (data error in sheet, surface upstream)", () => {
    expect(parseQty(-5)).toBe(-5);
    expect(parseQty("-12")).toBe(-12);
  });
});
