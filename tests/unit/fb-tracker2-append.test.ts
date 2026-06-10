import { describe, expect, it } from "vitest";
import {
  computeAppendOperations,
  parseDateCell,
  type Grid,
} from "@/lib/domain/fb-tracker2-append";

// Concise grid builder. Header row + ad rows; values can be numbers or
// empty strings. Matches the FB Ads Tracker 2 sheet shape:
//   col 0 = Ad name, col 1 = Link to promoted post, col 2+ = dates.
function makeGrid(
  dates: string[],
  ads: Array<{ name: string; link: string; spend: Array<number | "">; }>,
): Grid {
  return [
    ["Ad name", "Link to promoted post", ...dates],
    ...ads.map((a) => [a.name, a.link, ...a.spend]),
  ];
}

describe("parseDateCell", () => {
  it("parses ISO strings", () => {
    expect(parseDateCell("2026-05-27")).toBe("2026-05-27");
  });

  it("parses Excel serial numbers in the valid range", () => {
    // 2026-05-27 in Excel serial = 46169.
    expect(parseDateCell(46169)).toBe("2026-05-27");
  });

  it("rejects out-of-range numbers (so spend amounts aren't read as dates)", () => {
    expect(parseDateCell(4500)).toBeNull();
    expect(parseDateCell(100000)).toBeNull();
  });

  it("returns null for empty/non-date values", () => {
    expect(parseDateCell("")).toBeNull();
    expect(parseDateCell(null)).toBeNull();
    expect(parseDateCell("Ad name")).toBeNull();
  });

  it("parses native Date objects", () => {
    expect(parseDateCell(new Date(Date.UTC(2026, 4, 27)))).toBe("2026-05-27");
  });
});

describe("computeAppendOperations", () => {
  it("returns no-op when 2026 has every date 30D Check has", () => {
    const dates = ["2026-05-25", "2026-05-26", "2026-05-27"];
    const check30 = makeGrid(dates, [
      { name: "Ad 100", link: "fb/100", spend: [10, 11, 12] },
    ]);
    const tab2026 = makeGrid(dates, [
      { name: "Ad 100", link: "fb/100", spend: [10, 11, 12] },
    ]);

    const ops = computeAppendOperations(check30, tab2026);

    expect(ops.summary.missingDates).toEqual([]);
    expect(ops.columns).toEqual([]);
    expect(ops.newRows).toEqual([]);
  });

  it("appends the single missing date (the May-28 gap shape)", () => {
    // 2026 is missing 5/27; 30D Check has it. Existing ad spans both.
    const check30 = makeGrid(
      ["2026-05-26", "2026-05-27"],
      [{ name: "Ad 100", link: "fb/100", spend: [50, 75] }],
    );
    const tab2026 = makeGrid(
      ["2026-05-26"],
      [{ name: "Ad 100", link: "fb/100", spend: [50] }],
    );

    const ops = computeAppendOperations(check30, tab2026);

    expect(ops.summary.missingDates).toEqual(["2026-05-27"]);
    expect(ops.summary.newAdsCount).toBe(0);
    expect(ops.summary.updatedCellsCount).toBe(1);
    expect(ops.columns).toHaveLength(1);
    expect(ops.columns[0].date).toBe("2026-05-27");
    expect(ops.columns[0].isNew).toBe(true);
    // 2026 grid has 3 columns currently (Ad name + Link + 1 date), so
    // the new column appends at index 3.
    expect(ops.columns[0].columnIndex).toBe(3);
    // Column values: header = date, row 1 = Ad 100's 5/27 spend = 75.
    expect(ops.columns[0].values).toEqual(["2026-05-27", 75]);
    expect(ops.newRows).toEqual([]);
  });

  it("appends multiple missing dates in chronological order", () => {
    const check30 = makeGrid(
      ["2026-05-25", "2026-05-26", "2026-05-27", "2026-05-28"],
      [{ name: "Ad 100", link: "fb/100", spend: [10, 20, 30, 40] }],
    );
    const tab2026 = makeGrid(
      ["2026-05-25", "2026-05-26"],
      [{ name: "Ad 100", link: "fb/100", spend: [10, 20] }],
    );

    const ops = computeAppendOperations(check30, tab2026);

    expect(ops.summary.missingDates).toEqual(["2026-05-27", "2026-05-28"]);
    expect(ops.columns.map((c) => c.date)).toEqual([
      "2026-05-27",
      "2026-05-28",
    ]);
    expect(ops.columns[0].columnIndex).toBe(4);
    expect(ops.columns[1].columnIndex).toBe(5);
    expect(ops.columns[0].values[1]).toBe(30);
    expect(ops.columns[1].values[1]).toBe(40);
  });

  it("appends new ads as new rows AND writes their spend in the new columns", () => {
    // 30D Check has a brand-new Ad 200 that 2026 doesn't have yet.
    const check30 = makeGrid(
      ["2026-05-26", "2026-05-27"],
      [
        { name: "Ad 100", link: "fb/100", spend: [50, 75] },
        { name: "Ad 200", link: "fb/200", spend: [0, 25] },
      ],
    );
    const tab2026 = makeGrid(
      ["2026-05-26"],
      [{ name: "Ad 100", link: "fb/100", spend: [50] }],
    );

    const ops = computeAppendOperations(check30, tab2026);

    expect(ops.summary.missingDates).toEqual(["2026-05-27"]);
    expect(ops.summary.newAdsCount).toBe(1);
    expect(ops.newRows).toHaveLength(1);

    // The new row: name + link + empty existing-column cells + spend
    // in the appended 5/27 column. baseColCount = 3 (name, link, 5/26).
    expect(ops.newRows[0].values).toEqual(["Ad 200", "fb/200", "", 25]);
    // baseRowCount on 2026 = 2 (header + Ad 100), so the new ad lands
    // at row index 2.
    expect(ops.newRows[0].rowIndex).toBe(2);

    // Column values include the new ad's spend at its appended row index.
    // values[0] = header "2026-05-27", values[1] = Ad 100 spend = 75,
    // values[2] = Ad 200 spend = 25.
    expect(ops.columns[0].values).toEqual(["2026-05-27", 75, 25]);
    expect(ops.summary.updatedCellsCount).toBe(2);
  });

  it("skips blank spend cells (doesn't write 0 for empty)", () => {
    const check30 = makeGrid(
      ["2026-05-26", "2026-05-27"],
      [{ name: "Ad 100", link: "fb/100", spend: [50, ""] }],
    );
    const tab2026 = makeGrid(
      ["2026-05-26"],
      [{ name: "Ad 100", link: "fb/100", spend: [50] }],
    );

    const ops = computeAppendOperations(check30, tab2026);

    expect(ops.summary.missingDates).toEqual(["2026-05-27"]);
    expect(ops.columns[0].values).toEqual(["2026-05-27", ""]);
    expect(ops.summary.updatedCellsCount).toBe(0);
  });

  it("ignores ads with blank names in either grid", () => {
    const check30: Grid = [
      ["Ad name", "Link to promoted post", "2026-05-27"],
      ["", "", 50],
      ["Ad 100", "fb/100", 75],
    ];
    const tab2026 = makeGrid(["2026-05-26"], []);

    const ops = computeAppendOperations(check30, tab2026);

    expect(ops.summary.missingDates).toEqual(["2026-05-27"]);
    expect(ops.summary.newAdsCount).toBe(1);
    expect(ops.newRows[0].values[0]).toBe("Ad 100");
  });

  it("handles Excel-serial date headers from raw Supermetrics output", () => {
    // 2026-05-27 serial = 46169.
    const check30: Grid = [
      ["Ad name", "Link to promoted post", 46169],
      ["Ad 100", "fb/100", 50],
    ];
    const tab2026 = makeGrid(["2026-05-26"], []);

    const ops = computeAppendOperations(check30, tab2026);
    expect(ops.summary.missingDates).toEqual(["2026-05-27"]);
  });

  it("is a true no-op when 30D Check is ahead by zero days (idempotent)", () => {
    const check30 = makeGrid(
      ["2026-05-26"],
      [{ name: "Ad 100", link: "fb/100", spend: [50] }],
    );
    const tab2026 = makeGrid(
      ["2026-05-26"],
      [{ name: "Ad 100", link: "fb/100", spend: [50] }],
    );

    const ops = computeAppendOperations(check30, tab2026);

    expect(ops).toEqual({
      columns: [],
      newRows: [],
      summary: {
        missingDates: [],
        restampedDates: [],
        newAdsCount: 0,
        updatedCellsCount: 0,
      },
    });
  });

  describe("restampDays", () => {
    it("refreshes changed values on shared dates from 30D Check", () => {
      // FB restated 5/26 upward after the day-one stamp.
      const check30 = makeGrid(
        ["2026-05-25", "2026-05-26"],
        [{ name: "Ad 100", link: "fb/100", spend: [40, 55] }],
      );
      const tab2026 = makeGrid(
        ["2026-05-25", "2026-05-26"],
        [{ name: "Ad 100", link: "fb/100", spend: [40, 50] }],
      );
      const ops = computeAppendOperations(check30, tab2026, { restampDays: 3 });
      expect(ops.summary.missingDates).toEqual([]);
      expect(ops.summary.restampedDates).toEqual(["2026-05-26"]);
      expect(ops.columns).toHaveLength(1);
      expect(ops.columns[0].isNew).toBe(false);
      // Row 1 = Ad 100 gets the restated 55.
      expect(ops.columns[0].values[1]).toBe(55);
    });

    it("preserves archived cells for ads missing from 30D Check (deleted ads)", () => {
      const check30 = makeGrid(
        ["2026-05-26"],
        [{ name: "Ad 100", link: "fb/100", spend: [55] }],
      );
      const tab2026 = makeGrid(
        ["2026-05-26"],
        [
          { name: "Ad 100", link: "fb/100", spend: [50] },
          { name: "Ad 200 (deleted in FB)", link: "fb/200", spend: [123] },
        ],
      );
      const ops = computeAppendOperations(check30, tab2026, { restampDays: 3 });
      expect(ops.summary.restampedDates).toEqual(["2026-05-26"]);
      const col = ops.columns[0];
      expect(col.values[1]).toBe(55); // restated
      expect(col.values[2]).toBe(123); // deleted ad's history preserved
    });

    it("emits nothing when shared values already match (idempotent)", () => {
      const check30 = makeGrid(
        ["2026-05-26"],
        [{ name: "Ad 100", link: "fb/100", spend: [50] }],
      );
      const tab2026 = makeGrid(
        ["2026-05-26"],
        [{ name: "Ad 100", link: "fb/100", spend: [50] }],
      );
      const ops = computeAppendOperations(check30, tab2026, { restampDays: 3 });
      expect(ops.columns).toEqual([]);
      expect(ops.newRows).toEqual([]);
    });

    it("restampDays: 0 keeps pure append semantics", () => {
      const check30 = makeGrid(
        ["2026-05-26"],
        [{ name: "Ad 100", link: "fb/100", spend: [55] }],
      );
      const tab2026 = makeGrid(
        ["2026-05-26"],
        [{ name: "Ad 100", link: "fb/100", spend: [50] }],
      );
      const ops = computeAppendOperations(check30, tab2026, { restampDays: 0 });
      expect(ops.columns).toEqual([]);
    });

    it("pairs duplicate-name twin rows positionally and preserves column totals", () => {
      // Two source rows share a name (relaunched twin); target has the
      // same two rows. Each pairs to its own row.
      const check30 = makeGrid(
        ["2026-05-26"],
        [
          { name: "Ad 300 - twin", link: "fb/300a", spend: [100] },
          { name: "Ad 300 - twin", link: "fb/300b", spend: [7] },
        ],
      );
      const tab2026 = makeGrid(
        ["2026-05-26"],
        [
          { name: "Ad 300 - twin", link: "fb/300a", spend: [90] },
          { name: "Ad 300 - twin", link: "fb/300b", spend: [5] },
        ],
      );
      const ops = computeAppendOperations(check30, tab2026, { restampDays: 3 });
      const col = ops.columns[0];
      expect(col.values[1]).toBe(100);
      expect(col.values[2]).toBe(7);
    });

    it("rolls surplus source twins into the last target row (total preserved)", () => {
      // Source has two rows for the name, target only one — the old
      // map-based matcher dropped one twin's spend entirely.
      const check30 = makeGrid(
        ["2026-05-26"],
        [
          { name: "Ad 301 - twin", link: "fb/301a", spend: [100] },
          { name: "Ad 301 - twin", link: "fb/301b", spend: [7] },
        ],
      );
      const tab2026 = makeGrid(
        ["2026-05-26"],
        [{ name: "Ad 301 - twin", link: "fb/301a", spend: [90] }],
      );
      const ops = computeAppendOperations(check30, tab2026, { restampDays: 3 });
      expect(ops.columns[0].values[1]).toBe(107);
    });

    it("only restamps the N most recent shared dates", () => {
      const check30 = makeGrid(
        ["2026-05-24", "2026-05-25", "2026-05-26"],
        [{ name: "Ad 100", link: "fb/100", spend: [99, 99, 99] }],
      );
      const tab2026 = makeGrid(
        ["2026-05-24", "2026-05-25", "2026-05-26"],
        [{ name: "Ad 100", link: "fb/100", spend: [1, 1, 1] }],
      );
      const ops = computeAppendOperations(check30, tab2026, { restampDays: 2 });
      expect(ops.summary.restampedDates).toEqual(["2026-05-25", "2026-05-26"]);
    });
  });

  it("backfills the actual May-28 gap shape: 2026 has 5/20-5/26, 30D has 5/21-5/27", () => {
    // Matches the live state observed in the FB Ads Tracker 2 sheet
    // on 2026-05-28: 2026 stopped at 5/26, 30D Check has 5/27.
    const tab2026Dates = [
      "2026-05-20",
      "2026-05-21",
      "2026-05-22",
      "2026-05-23",
      "2026-05-24",
      "2026-05-25",
      "2026-05-26",
    ];
    const check30Dates = [
      "2026-05-21",
      "2026-05-22",
      "2026-05-23",
      "2026-05-24",
      "2026-05-25",
      "2026-05-26",
      "2026-05-27",
    ];
    const check30 = makeGrid(check30Dates, [
      { name: "Ad 100", link: "fb/100", spend: [10, 20, 30, 40, 50, 60, 70] },
    ]);
    const tab2026 = makeGrid(tab2026Dates, [
      { name: "Ad 100", link: "fb/100", spend: [9, 10, 20, 30, 40, 50, 60] },
    ]);

    const ops = computeAppendOperations(check30, tab2026);

    expect(ops.summary.missingDates).toEqual(["2026-05-27"]);
    expect(ops.columns).toHaveLength(1);
    expect(ops.columns[0].date).toBe("2026-05-27");
    expect(ops.columns[0].values[1]).toBe(70);
  });

  it("handles an empty 2026 tab (header-only) by appending everything from 30D", () => {
    const check30 = makeGrid(
      ["2026-05-26", "2026-05-27"],
      [
        { name: "Ad 100", link: "fb/100", spend: [50, 75] },
        { name: "Ad 200", link: "fb/200", spend: [0, 25] },
      ],
    );
    const tab2026: Grid = [["Ad name", "Link to promoted post"]];

    const ops = computeAppendOperations(check30, tab2026);

    expect(ops.summary.missingDates).toEqual(["2026-05-26", "2026-05-27"]);
    expect(ops.summary.newAdsCount).toBe(2);
    expect(ops.newRows).toHaveLength(2);
  });
});
