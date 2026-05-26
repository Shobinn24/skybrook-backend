import { describe, expect, it } from "vitest";
import {
  colIndexToA1,
  dedupeAdSpendRows,
  extractArrivalDates,
  findIntlBoundary,
  parseAdSpendTab,
  parseDayMonth,
  parseFbAdsSheet,
  mergeFbAggregated,
  parseIncomingGrid,
  parseQty,
  pickArrivalDate,
  pickLatestColumn,
  trimFbAdDisplayName,
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

describe("extractArrivalDates", () => {
  it("extracts a single DD Mon YYYY date", () => {
    expect(extractArrivalDates("17 Mar 2026")).toEqual(["2026-03-17"]);
  });
  it("extracts multiple dates from compound cells", () => {
    expect(extractArrivalDates("9K - 17 Mar 2026\nRest - 24 Apr 2026")).toEqual([
      "2026-03-17",
      "2026-04-24",
    ]);
  });
  it("returns empty array when no full DD Mon YYYY pattern exists", () => {
    expect(extractArrivalDates("28 Feb, 5,13,17,17,18 Mar\n3,17 Apr")).toEqual([]);
    expect(extractArrivalDates("")).toEqual([]);
    expect(extractArrivalDates(null)).toEqual([]);
  });
  it("handles 4-letter month names (Sept)", () => {
    expect(extractArrivalDates("12 Sept 2026")).toEqual(["2026-09-12"]);
  });
  it("handles full month names (June, March, etc.) — Scott uses both forms", () => {
    expect(extractArrivalDates("3 June 2026")).toEqual(["2026-06-03"]);
    expect(extractArrivalDates("10 June 2026")).toEqual(["2026-06-10"]);
    expect(extractArrivalDates("15 March 2026")).toEqual(["2026-03-15"]);
    expect(extractArrivalDates("1 January 2027")).toEqual(["2027-01-01"]);
    expect(extractArrivalDates("31 December 2026")).toEqual(["2026-12-31"]);
  });
});

describe("pickArrivalDate", () => {
  it("picks the LATEST date as the pessimistic ETA", () => {
    expect(pickArrivalDate("9K - 17 Mar 2026\nRest - 24 Apr 2026")).toBe("2026-04-24");
  });
  it("returns the only date when there's just one", () => {
    expect(pickArrivalDate("17 Mar 2026")).toBe("2026-03-17");
  });
  it("returns null when no date is present", () => {
    expect(pickArrivalDate("")).toBeNull();
    expect(pickArrivalDate("28 Feb, 5,13 Mar")).toBeNull();
  });
});

describe("findIntlBoundary", () => {
  it("returns the column index of the INTL banner", () => {
    expect(findIntlBoundary(["", "", "", "", "", "US", "", "", "", "", "", "INTL"])).toBe(11);
  });
  it("accepts INTERNATIONAL as a synonym", () => {
    expect(findIntlBoundary(["US", "", "INTERNATIONAL"])).toBe(2);
  });
  it("is case-insensitive and tolerates whitespace", () => {
    expect(findIntlBoundary(["", " intl "])).toBe(1);
  });
  it("returns Infinity when no INTL banner — implies all US", () => {
    expect(findIntlBoundary(["", "US", ""])).toBe(Number.POSITIVE_INFINITY);
    expect(findIntlBoundary([])).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("parseIncomingGrid", () => {
  // Minimal Incoming_new fixture (legacy layout): banner row 1, label row 3,
  // arrival row 4, total row 5. Col C carries the row-header keywords that the
  // header-driven parser uses to find rows.
  function makeGrid(): unknown[][] {
    const grid: unknown[][] = Array.from({ length: 8 }, () => []);
    // row 1 banner — US at col 3, INTL at col 5 (legacy: separate banner row)
    grid[0][3] = "US";
    grid[0][5] = "INTL";
    // row 2 month grouping — not used by parser
    // row 3 PO labels
    grid[2][2] = "SHIPMENT NAME";
    grid[2][3] = "KAI Sec Mar26";
    grid[2][5] = "KAI Sec Apr26";
    // row 4 arrival dates
    grid[3][2] = "ESTIMATED ARRIVAL";
    grid[3][3] = "17 Mar 2026"; // past — parser writes status='po' regardless;
                                 // receipt-based reconciliation determines arrival
    grid[3][5] = "10 May 2026"; // future
    // row 5 totals
    grid[4][2] = "Total";
    // row 6 column headers — not used by parser
    // rows 7+ SKU data
    grid[6][2] = "ev-9055-5x-m";
    grid[6][3] = "2520";
    grid[6][5] = "1000";
    grid[7][2] = "ev-9055-5x-l";
    grid[7][3] = "0"; // skip — qty 0
    grid[7][5] = "500";
    return grid;
  }

  // 2026-04-28 layout: banner row gone; US/INTL is co-located with the Total
  // row. Header rows are: SHIPMENT NAME (idx 1), ESTIMATED ARRIVAL (idx 2),
  // Total (idx 3, also carrying "US"/"INTL"). First SKU at idx 5.
  function makeGridMergedBanner(): unknown[][] {
    const grid: unknown[][] = Array.from({ length: 7 }, () => []);
    // row 1: months — not used by parser
    grid[0][2] = "DATE PLACED";
    // row 2: shipment names
    grid[1][2] = "SHIPMENT NAME";
    grid[1][3] = "KAI Sec Mar26";
    grid[1][5] = "KAI Sec Apr26";
    // row 3: arrival dates
    grid[2][2] = "ESTIMATED ARRIVAL";
    grid[2][3] = "17 Mar 2026";
    grid[2][5] = "10 May 2026";
    // row 4: Total + warehouse banner co-located
    grid[3][2] = "Total";
    grid[3][3] = "US";
    grid[3][4] = "5,576"; // numeric qty interspersed — must not false-match INTL
    grid[3][5] = "INTL";
    // row 5: "Product" header in col A, totals in col D — col C empty, naturally skipped
    grid[4][0] = "Product";
    // rows 6+: SKU data
    grid[5][2] = "ev-9055-5x-m";
    grid[5][3] = "2520";
    grid[5][5] = "1000";
    grid[6][2] = "ev-9055-5x-l";
    grid[6][3] = "0";
    grid[6][5] = "500";
    return grid;
  }

  it("emits one row per (sku, PO with positive qty)", () => {
    const out = parseIncomingGrid(makeGrid(), "2026-04-23");
    expect(out.rows).toEqual([
      {
        sku: "ev-9055-5x-m",
        destination: "US",
        shipmentName: "KAI Sec Mar26",
        quantity: 2520,
        expectedArrival: "2026-03-17",
        status: "po",
        sourceRowRef: "Incoming_new!D7",
      },
      {
        sku: "ev-9055-5x-m",
        destination: "CN",
        shipmentName: "KAI Sec Apr26",
        quantity: 1000,
        expectedArrival: "2026-05-10",
        status: "po",
        sourceRowRef: "Incoming_new!F7",
      },
      {
        sku: "ev-9055-5x-l",
        destination: "CN",
        shipmentName: "KAI Sec Apr26",
        quantity: 500,
        expectedArrival: "2026-05-10",
        status: "po",
        sourceRowRef: "Incoming_new!F8",
      },
    ]);
  });

  it("skips PO columns with unparseable arrival dates and reports them", () => {
    const grid = makeGrid();
    grid[3][3] = "TBD"; // unparseable
    const out = parseIncomingGrid(grid, "2026-04-23");
    expect(out.skippedColumns).toEqual([
      { colIdx: 3, label: "KAI Sec Mar26", reason: expect.stringContaining("TBD") },
    ]);
    // Only the INTL/CN PO survives
    expect(out.rows.every((r) => r.destination === "CN")).toBe(true);
  });

  it("treats columns left of INTL boundary as US", () => {
    const grid = makeGrid();
    const out = parseIncomingGrid(grid, "2026-04-23");
    expect(out.poColumns).toEqual([
      { colIdx: 3, label: "KAI Sec Mar26", date: "2026-03-17", destination: "US" },
      { colIdx: 5, label: "KAI Sec Apr26", date: "2026-05-10", destination: "CN" },
    ]);
  });

  it("treats every column as US when no INTL banner present", () => {
    const grid = makeGrid();
    grid[0][5] = ""; // remove INTL banner
    const out = parseIncomingGrid(grid, "2026-04-23");
    expect(out.poColumns.map((p) => p.destination)).toEqual(["US", "US"]);
  });

  it("returns empty rows when no SKUs match", () => {
    const grid = makeGrid();
    grid[6][2] = ""; // blank SKU
    grid[7][2] = "";
    const out = parseIncomingGrid(grid, "2026-04-23");
    expect(out.rows).toEqual([]);
  });

  it("handles 2026-04-28 layout where US/INTL is merged into the Total row", () => {
    // Regression: prior parser hardcoded banner=row0, label=row2, arrival=row3.
    // After Scott reorganized the sheet, the banner row was removed and US/INTL
    // now lives on the same row as Total. Header-driven discovery must find the
    // rows by their col-C labels.
    const out = parseIncomingGrid(makeGridMergedBanner(), "2026-04-23");
    expect(out.poColumns).toEqual([
      { colIdx: 3, label: "KAI Sec Mar26", date: "2026-03-17", destination: "US" },
      { colIdx: 5, label: "KAI Sec Apr26", date: "2026-05-10", destination: "CN" },
    ]);
    expect(out.rows).toEqual([
      {
        sku: "ev-9055-5x-m",
        destination: "US",
        shipmentName: "KAI Sec Mar26",
        quantity: 2520,
        expectedArrival: "2026-03-17",
        status: "po",
        sourceRowRef: "Incoming_new!D6",
      },
      {
        sku: "ev-9055-5x-m",
        destination: "CN",
        shipmentName: "KAI Sec Apr26",
        quantity: 1000,
        expectedArrival: "2026-05-10",
        status: "po",
        sourceRowRef: "Incoming_new!F6",
      },
      {
        sku: "ev-9055-5x-l",
        destination: "CN",
        shipmentName: "KAI Sec Apr26",
        quantity: 500,
        expectedArrival: "2026-05-10",
        status: "po",
        sourceRowRef: "Incoming_new!F7",
      },
    ]);
    expect(out.skippedColumns).toEqual([]);
  });

  it("returns a layout-error diagnostic when col-C header rows are missing", () => {
    const grid = Array.from({ length: 8 }, () => []) as unknown[][];
    // No SHIPMENT NAME / ESTIMATED ARRIVAL / Total in col C — Scott deleted
    // the header row or renamed it. Parser must surface this, not silently
    // produce 0 rows.
    const out = parseIncomingGrid(grid, "2026-04-23");
    expect(out.rows).toEqual([]);
    expect(out.poColumns).toEqual([]);
    expect(out.skippedColumns).toHaveLength(1);
    expect(out.skippedColumns[0].colIdx).toBe(-1);
    expect(out.skippedColumns[0].label).toBe("(layout)");
    expect(out.skippedColumns[0].reason).toContain("missing header rows");
  });

  it("ignores qty cells on the Total/banner row when scanning for INTL", () => {
    // Numeric qty strings like "5,576" must not be confused with the INTL banner.
    const grid = makeGridMergedBanner();
    // Replace the INTL banner with a numeric qty — should fall back to Infinity.
    grid[3][5] = "12,345";
    const out = parseIncomingGrid(grid, "2026-04-23");
    expect(out.poColumns.map((p) => p.destination)).toEqual(["US", "US"]);
  });

  it("lowercases SKU values so they match Shopify daily_sales", () => {
    // Inventory sheet has SKUs like `EV-mixed-xxs` next to `ev-hw-xxs`.
    // Shopify ingest lowercases at parse since b89fbd6, so any uppercase SKU
    // here orphans against daily_sales. Parser must lowercase too.
    const grid = makeGrid();
    grid[6][2] = "EV-9055-5x-M"; // mixed case from a sloppy sheet entry
    grid[7][2] = "EV-9055-5X-L";
    const out = parseIncomingGrid(grid, "2026-04-23");
    const skus = out.rows.map((r) => r.sku);
    expect(skus).toContain("ev-9055-5x-m");
    expect(skus).toContain("ev-9055-5x-l");
    expect(skus.every((s) => s === s.toLowerCase())).toBe(true);
  });

  it("normalizes dash-form 1/5-pack SKUs to canonical x-form", () => {
    // Inventory + incoming sheets historically wrote `ev-9055-hf-5-3xl`
    // (no `x`). daily_sales is normalized to `-5x-` since 9641126 — parser
    // must produce the same canonical form so they match end-to-end.
    const grid = makeGrid();
    grid[6][2] = "ev-9055-hf-5-3xl"; // dash-form 5-pack
    grid[7][2] = "ev-foo-1-l"; // dash-form 1-pack
    const out = parseIncomingGrid(grid, "2026-04-23");
    const skus = out.rows.map((r) => r.sku);
    expect(skus).toContain("ev-9055-hf-5x-3xl");
    expect(skus).toContain("ev-foo-1x-l");
    expect(skus.every((s) => !/^ev-.+-(1|5)-/.test(s))).toBe(true);
  });

  it("never auto-flips status to 'arrived' based on ETA — receipt-driven", () => {
    // Pre-2026-05-05 the parser flipped status to 'arrived' as soon as ETA
    // dropped into the past. That hid POs from /incoming the day after their
    // ETA regardless of whether stock had actually been counted, which is
    // exactly the case Scott flagged on 2026-05-05 (two INTL POs annotated
    // "partial delivery" / "not yet reflected in invty but delivered" sat in
    // the sheet but were invisible). Receipts table now drives display
    // status; parser only writes 'po'.
    const grid = makeGrid();
    grid[3][3] = "1 Jan 2020"; // very past ETA
    grid[3][5] = "1 Jan 2099"; // very future ETA
    const out = parseIncomingGrid(grid, "2026-04-23");
    expect(out.rows.map((r) => r.status)).toEqual(["po", "po", "po"]);
  });

  it("does NOT decompose 10/15-pack SKUs at the inventory parser", () => {
    // Inventory is tracked at the 5-pack level (Scott 2026-04-28). A 10-pack
    // row in the inventory sheet would be misformatted source data; rather
    // than silently halve quantities by decomposing, leave it alone so it
    // surfaces as activeZeroSales for human investigation.
    const grid = makeGrid();
    grid[6][2] = "ev-foo-10-l";
    grid[7][2] = "ev-foo-15x-l";
    const out = parseIncomingGrid(grid, "2026-04-23");
    const skus = out.rows.map((r) => r.sku);
    expect(skus).toContain("ev-foo-10-l");
    expect(skus).toContain("ev-foo-15x-l");
    expect(skus).not.toContain("ev-foo-5x-l");
  });
});

describe("parseAdSpendTab", () => {
  it("parses ISO date + plain numeric cost rows", () => {
    const grid = [
      ["Date", "Cost"],
      ["2026-04-28", "2791.18"],
      ["2026-04-29", "3122.25"],
    ];
    const { rows, skipped } = parseAdSpendTab("Men", grid);
    expect(skipped).toEqual([]);
    expect(rows).toEqual([
      { product: "Men", spendDate: "2026-04-28", costUsd: 2791.18, sourceRowRef: "Men!A2" },
      { product: "Men", spendDate: "2026-04-29", costUsd: 3122.25, sourceRowRef: "Men!A3" },
    ]);
  });

  it("strips $ and commas from formatted currency", () => {
    const grid = [
      ["Date", "Cost"],
      ["2026-04-28", "$2,791.18"],
    ];
    const { rows } = parseAdSpendTab("Men", grid);
    expect(rows[0].costUsd).toBe(2791.18);
  });

  it("flags an unexpected header instead of silently emitting bad rows", () => {
    const grid = [
      ["When", "Amount"],
      ["2026-04-28", "100"],
    ];
    const { rows, skipped } = parseAdSpendTab("Men", grid);
    expect(rows).toEqual([]);
    expect(skipped[0].rowIdx).toBe(0);
    expect(skipped[0].reason).toContain("unexpected header");
  });

  it("skips fully-blank rows in the middle of the data", () => {
    const grid = [
      ["Date", "Cost"],
      ["2026-04-28", "100"],
      ["", ""],
      ["2026-04-30", "150"],
    ];
    const { rows, skipped } = parseAdSpendTab("Men", grid);
    expect(rows.map((r) => r.spendDate)).toEqual(["2026-04-28", "2026-04-30"]);
    expect(skipped).toEqual([]);
  });

  it("flags a non-ISO date so a Supermetrics format change fails loud", () => {
    const grid = [
      ["Date", "Cost"],
      ["4/28/2026", "100"],
    ];
    const { rows, skipped } = parseAdSpendTab("Men", grid);
    expect(rows).toEqual([]);
    expect(skipped[0].reason).toContain("unparseable date");
  });

  it("flags a non-numeric cost", () => {
    const grid = [
      ["Date", "Cost"],
      ["2026-04-28", "n/a"],
    ];
    const { rows, skipped } = parseAdSpendTab("Men", grid);
    expect(rows).toEqual([]);
    expect(skipped[0].reason).toContain("unparseable cost");
  });

  it("preserves the tab name in product field (caller maps platform suffix at query time)", () => {
    const grid = [
      ["Date", "Cost"],
      ["2026-04-28", "500"],
    ];
    const { rows } = parseAdSpendTab("Super HW AL", grid);
    expect(rows[0].product).toBe("Super HW AL");
  });

  it("accepts 'Spend' as the value-column header (AppLovin connector)", () => {
    // Supermetrics FB tabs use "Cost"; AppLovin tabs use "Spend".
    // Both are valid daily ad-cost feeds.
    const grid = [
      ["Date", "Spend"],
      ["2026-04-28", "88.11"],
      ["2026-04-29", "105.47"],
    ];
    const { rows, skipped } = parseAdSpendTab("Men AL", grid);
    expect(skipped).toEqual([]);
    expect(rows.map((r) => r.costUsd)).toEqual([88.11, 105.47]);
  });

  // The 2026-05-22 incident: Scott's Supermetrics license stopped
  // covering "Axon by AppLovin" on 2026-05-05, and the 3 AL tabs
  // started returning the error string below in row 1 instead of data.
  // Old behavior: the row failed the date regex and was silently
  // skipped → /performance showed AL=0 for 17 days. New behavior: the
  // row is captured as a sourceError and the ingest fires a Slack alert.
  const SUPERMETRICS_LICENSE_ERROR =
    "Error: Your license doesn't include the Axon by AppLovin data source " +
    "(user: scott@skybrookecommerce.com, team: Team skybrookecommerce, " +
    "team ID: ua6hqzZIJYcoyI0Tv4Eh). Learn more about your license at: " +
    "https://hub.supermetrics.com";

  it("captures a Supermetrics 'Error:' row as a sourceError, not a skipped row", () => {
    const grid = [
      ["Date", "Spend"],
      [SUPERMETRICS_LICENSE_ERROR, ""],
    ];
    const { rows, skipped, sourceErrors } = parseAdSpendTab("Super HW AL", grid);
    expect(rows).toEqual([]);
    expect(skipped).toEqual([]);
    expect(sourceErrors).toHaveLength(1);
    expect(sourceErrors[0].rowIdx).toBe(1);
    expect(sourceErrors[0].signature).toContain("Axon by AppLovin");
    // Parenthetical user/team IDs are stripped so the signature is
    // stable across accounts (Slack dedup key derives from it).
    expect(sourceErrors[0].signature).not.toContain("ua6hqzZIJYcoyI0Tv4Eh");
    expect(sourceErrors[0].signature).not.toContain("scott@skybrookecommerce.com");
  });

  it("still parses valid rows when an error row is interspersed", () => {
    // Defensive: if Supermetrics returns mostly-good data with one
    // error row in the middle, we want the good rows landed AND an
    // alert fired — not all-or-nothing.
    const grid = [
      ["Date", "Spend"],
      ["2026-04-28", "100"],
      [SUPERMETRICS_LICENSE_ERROR, ""],
      ["2026-04-30", "150"],
    ];
    const { rows, sourceErrors } = parseAdSpendTab("Men AL", grid);
    expect(rows.map((r) => r.spendDate)).toEqual(["2026-04-28", "2026-04-30"]);
    expect(sourceErrors).toHaveLength(1);
  });

  it("captures the 'quota exceeded' Supermetrics shape too (different prefix)", () => {
    // The license error starts with "Error:"; quota errors observed in
    // other Supermetrics deployments start with the resource name and
    // include "quota". The combined-text hint regex catches both.
    const grid = [
      ["Date", "Cost"],
      ["AppLovin daily quota exceeded for query 'Shapewear AL'", ""],
    ];
    const { rows, skipped, sourceErrors } = parseAdSpendTab("Shapewear AL", grid);
    expect(rows).toEqual([]);
    expect(skipped).toEqual([]);
    expect(sourceErrors).toHaveLength(1);
    expect(sourceErrors[0].signature).toContain("quota");
  });

  it("does not flag genuinely malformed-but-non-error rows as sourceErrors", () => {
    // "4/28/2026" is a date-format regression, not an upstream error
    // — keep the old skipped behavior so we don't muddy the alert path.
    const grid = [
      ["Date", "Cost"],
      ["4/28/2026", "100"],
    ];
    const { rows, skipped, sourceErrors } = parseAdSpendTab("Men", grid);
    expect(rows).toEqual([]);
    expect(skipped).toHaveLength(1);
    expect(sourceErrors).toEqual([]);
  });
});

describe("trimFbAdDisplayName", () => {
  it("extracts descriptive tail after 'Ad NNN - '", () => {
    expect(
      trimFbAdDisplayName("(OG Lav CC) Ad 537 - OG Lavender images"),
    ).toBe("OG Lavender images");
  });

  it("extracts descriptive tail after 'DCA NNN - '", () => {
    expect(trimFbAdDisplayName("(LAV ASC) DCA 537 - OG Lavender images")).toBe(
      "OG Lavender images",
    );
  });

  it("strips the date prefix before the marker too", () => {
    expect(
      trimFbAdDisplayName(
        "(HW ASC) 4 Jul25 - Ad 1026 - Elie Long Copy Static 1",
      ),
    ).toBe("Elie Long Copy Static 1");
  });

  it("falls back to raw name when no separator after marker", () => {
    expect(trimFbAdDisplayName("Ad 999")).toBe("Ad 999");
  });
});

describe("parseFbAdsSheet", () => {
  const header = [
    "Ad name",
    "Link to promoted post",
    "2026-01-01",
    "2026-01-02",
    "2026-01-03",
  ];

  it("flags unexpected header and returns nothing", () => {
    const { aggregated, skipped } = parseFbAdsSheet([["wat", "wut"]]);
    expect(aggregated).toEqual([]);
    expect(skipped[0]?.reason).toMatch(/unexpected header/);
  });

  it("parses a single ad row across date columns", () => {
    const grid = [
      header,
      ["(OG Lav CC) Ad 537 - OG Lavender images", "https://fb.com/1", "10", "20", "30"],
    ];
    const { aggregated, skipped } = parseFbAdsSheet(grid);
    expect(skipped).toEqual([]);
    expect(aggregated).toHaveLength(1);
    expect(aggregated[0]).toMatchObject({
      adNumber: "537",
      adName: "OG Lavender images",
      adNameRaw: "(OG Lav CC) Ad 537 - OG Lavender images",
      adLink: "https://fb.com/1",
    });
    expect(aggregated[0].dailySpend).toEqual([
      { spendDate: "2026-01-01", costUsd: 10 },
      { spendDate: "2026-01-02", costUsd: 20 },
      { spendDate: "2026-01-03", costUsd: 30 },
    ]);
  });

  it("pivots same ad number across multiple campaign variants", () => {
    const grid = [
      header,
      ["(OG Lav CC) Ad 537 - OG Lavender images", "https://fb.com/cc", "10", "20", ""],
      ["(LAV ASC) DCA 537 - OG Lavender images", "https://fb.com/asc", "", "5", "100"],
    ];
    const { aggregated } = parseFbAdsSheet(grid);
    expect(aggregated).toHaveLength(1);
    expect(aggregated[0].adNumber).toBe("537");
    expect(aggregated[0].dailySpend).toEqual([
      { spendDate: "2026-01-01", costUsd: 10 },
      { spendDate: "2026-01-02", costUsd: 25 },
      { spendDate: "2026-01-03", costUsd: 100 },
    ]);
    // Canonical link = highest-total-spend variant (ASC total 105 > CC 30)
    expect(aggregated[0].adLink).toBe("https://fb.com/asc");
  });

  it("skips lowercase 'ad' inside other tokens like 'AIad'", () => {
    const grid = [
      header,
      ["(Mens CC) Ad 2077 - AIad - SR - Craig Men's Product AI Ad", "https://fb.com/x", "5", "", ""],
    ];
    const { aggregated, skipped } = parseFbAdsSheet(grid);
    expect(skipped).toEqual([]);
    // Only ONE ad number — the legit "Ad 2077" — not "ad" inside "AIad"
    expect(aggregated).toHaveLength(1);
    expect(aggregated[0].adNumber).toBe("2077");
  });

  it("flags rows with no Ad/DCA number", () => {
    const grid = [
      header,
      ["A random name with no number", "https://fb.com/x", "5", "", ""],
    ];
    const { aggregated, skipped } = parseFbAdsSheet(grid);
    expect(aggregated).toEqual([]);
    expect(skipped[0]?.reason).toMatch(/no Ad\/DCA number/);
  });

  it("strips $ and commas from cost cells", () => {
    const grid = [
      header,
      ["(BS) Ad 100 - X", "https://fb.com/x", "$1,234.56", "", ""],
    ];
    const { aggregated } = parseFbAdsSheet(grid);
    expect(aggregated[0].dailySpend[0].costUsd).toBeCloseTo(1234.56);
  });

  it("skips empty and zero spend cells", () => {
    const grid = [
      header,
      ["(BS) Ad 100 - X", "https://fb.com/x", "", "0", "1.5"],
    ];
    const { aggregated } = parseFbAdsSheet(grid);
    expect(aggregated[0].dailySpend).toEqual([
      { spendDate: "2026-01-03", costUsd: 1.5 },
    ]);
  });

  it("ignores non-date columns in the header", () => {
    const weirdHeader = [
      "Ad name",
      "Link to promoted post",
      "2026-01-01",
      "garbage col",
      "2026-01-03",
    ];
    const grid = [
      weirdHeader,
      ["(BS) Ad 100 - X", "https://fb.com/x", "10", "999", "30"],
    ];
    const { aggregated } = parseFbAdsSheet(grid);
    expect(aggregated[0].dailySpend).toEqual([
      { spendDate: "2026-01-01", costUsd: 10 },
      { spendDate: "2026-01-03", costUsd: 30 },
    ]);
  });
});

describe("mergeFbAggregated", () => {
  const ad = (
    adNumber: string,
    adName: string,
    daily: Array<[string, number]>,
    adLink: string | null = null,
  ) => ({
    adNumber,
    adName,
    adNameRaw: `raw ${adName}`,
    adLink,
    dailySpend: daily.map(([spendDate, costUsd]) => ({ spendDate, costUsd })),
  });

  it("passes a single list through (live-only path unchanged)", () => {
    const live = [ad("100", "X", [["2026-01-02", 5], ["2026-01-01", 3]])];
    const out = mergeFbAggregated([live]);
    expect(out).toHaveLength(1);
    // dailySpend comes back sorted by date
    expect(out[0].dailySpend).toEqual([
      { spendDate: "2026-01-01", costUsd: 3 },
      { spendDate: "2026-01-02", costUsd: 5 },
    ]);
  });

  it("recombines one ad across tabs by adNumber, unioning non-overlapping dates", () => {
    const live = [ad("537", "OG Lavender", [["2026-01-01", 100]])];
    const hist2023 = [ad("537", "OG Lav old", [["2023-07-01", 40]])];
    const hist2024 = [ad("537", "OG Lav mid", [["2024-03-01", 60]])];
    const out = mergeFbAggregated([live, hist2023, hist2024]);
    expect(out).toHaveLength(1);
    expect(out[0].adNumber).toBe("537");
    expect(out[0].dailySpend).toEqual([
      { spendDate: "2023-07-01", costUsd: 40 },
      { spendDate: "2024-03-01", costUsd: 60 },
      { spendDate: "2026-01-01", costUsd: 100 },
    ]);
  });

  it("picks the canonical name/link from the highest-total-spend appearance", () => {
    const live = [ad("9", "small recent", [["2026-01-01", 10]], "live-link")];
    const hist = [ad("9", "big historical", [["2024-01-01", 5000]], "hist-link")];
    const [merged] = mergeFbAggregated([live, hist]);
    expect(merged.adName).toBe("big historical");
    expect(merged.adLink).toBe("hist-link");
  });

  it("breaks name ties in favor of the first (live) list", () => {
    const live = [ad("7", "live name", [["2026-01-01", 50]], "live")];
    const hist = [ad("7", "hist name", [["2024-01-01", 50]], "hist")];
    const [merged] = mergeFbAggregated([live, hist]);
    expect(merged.adName).toBe("live name");
  });

  it("sums spend if the same date somehow appears in two tabs (boundary guard)", () => {
    const a = [ad("3", "A", [["2025-12-31", 10]])];
    const b = [ad("3", "A", [["2025-12-31", 5]])];
    const [merged] = mergeFbAggregated([a, b]);
    expect(merged.dailySpend).toEqual([{ spendDate: "2025-12-31", costUsd: 15 }]);
  });

  it("keeps distinct ads separate", () => {
    const out = mergeFbAggregated([
      [ad("1", "A", [["2026-01-01", 1]])],
      [ad("2", "B", [["2024-01-01", 2]])],
    ]);
    expect(out.map((a) => a.adNumber).sort()).toEqual(["1", "2"]);
  });
});

describe("dedupeAdSpendRows", () => {
  // Regression test for the 2026-05-10 incident: Supermetrics duplicated
  // 2026-05-09 in the SuperHW tab. Without dedupe the second INSERT
  // collided on PK and the whole transaction rolled back, leaving
  // ad_spend_daily empty and breaking the Performance tab.
  it("collapses duplicate (product, spendDate) rows last-write-wins", () => {
    const { dedupedRows, dupesCollapsed } = dedupeAdSpendRows([
      { product: "SuperHW", spendDate: "2026-05-08", costUsd: 100, sourceRowRef: "SuperHW!A6" },
      { product: "SuperHW", spendDate: "2026-05-09", costUsd: 310.82, sourceRowRef: "SuperHW!A7" },
      { product: "SuperHW", spendDate: "2026-05-09", costUsd: 310.82, sourceRowRef: "SuperHW!A9" },
      { product: "Men", spendDate: "2026-05-09", costUsd: 50, sourceRowRef: "Men!A7" },
    ]);
    expect(dedupedRows).toHaveLength(3);
    expect(dedupedRows.find((r) => r.product === "SuperHW" && r.spendDate === "2026-05-09")!.sourceRowRef).toBe("SuperHW!A9");
    expect(dupesCollapsed).toEqual([
      {
        product: "SuperHW",
        spendDate: "2026-05-09",
        firstRowRef: "SuperHW!A7",
        secondRowRef: "SuperHW!A9",
      },
    ]);
  });

  it("returns input unchanged when no dupes", () => {
    const input = [
      { product: "Men", spendDate: "2026-05-08", costUsd: 1, sourceRowRef: "Men!A6" },
      { product: "Men", spendDate: "2026-05-09", costUsd: 2, sourceRowRef: "Men!A7" },
    ];
    const { dedupedRows, dupesCollapsed } = dedupeAdSpendRows(input);
    expect(dedupedRows).toEqual(input);
    expect(dupesCollapsed).toEqual([]);
  });
});
