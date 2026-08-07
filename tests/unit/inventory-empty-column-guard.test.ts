// Empty-rightmost-column guard (2026-08-07, from the 2026-07-30 EV Sec CN
// episode): a date header added BEFORE the counts were pasted made the
// ingest read an empty column and land a half-sized pull (666 rows). The
// fetch now considers the latest two date columns and uses the newest one
// WITH data; falling back keeps the older snapshotDate so the freshness
// check still catches genuine staleness.
import { describe, expect, it, vi } from "vitest";
import type { sheets_v4 } from "googleapis";
import { fetchInventorySnapshots } from "@/lib/sources/sheets/inventory";
import { pickLatestColumns } from "@/lib/sources/sheets/parse-helpers";

const TODAY = "2026-07-30";

// Stub of the sheets surface fetchInventorySnapshots touches: two
// values.batchGet calls (headers, then data columns). Keyed per range.
function stubSheets(rangeValues: Record<string, unknown[][]>): sheets_v4.Sheets {
  return {
    spreadsheets: {
      values: {
        batchGet: vi.fn(async (req: { ranges: string[] }) => ({
          data: {
            valueRanges: req.ranges.map((r) => ({ values: rangeValues[r] ?? [] })),
          },
        })),
      },
    },
  } as unknown as sheets_v4.Sheets;
}

// Only EV Sec CN gets a parseable header; the other five tabs resolve to
// "no parseable date column" and drop out, keeping fixtures small.
function fixtures(opts: {
  newestCol: unknown[][];
  prevCol: unknown[][];
  skus?: unknown[][];
}): Record<string, unknown[][]> {
  return {
    "'EV Sec CN'!1:1": [["sku", "28/Jul", "29/Jul", "30/Jul"]],
    "'EV Sec CN'!A2:A": opts.skus ?? [["ev-sec-a"], ["ev-sec-b"], ["ev-sec-c"], ["ev-sec-d"]],
    "'EV Sec CN'!D2:D": opts.newestCol, // 30/Jul
    "'EV Sec CN'!C2:C": opts.prevCol, // 29/Jul
  };
}

describe("pickLatestColumns", () => {
  const parsed = [
    { colIdx: 1, date: "2026-07-28" },
    { colIdx: 2, date: "2026-07-29" },
    { colIdx: 3, date: "2026-07-30" },
  ];
  it("returns newest-first distinct dates", () => {
    expect(pickLatestColumns(parsed, TODAY, 2)).toEqual([
      { colIdx: 3, date: "2026-07-30" },
      { colIdx: 2, date: "2026-07-29" },
    ]);
  });
  it("skips future dates and rightmost wins a duplicated date", () => {
    const withDup = [...parsed, { colIdx: 4, date: "2026-07-30" }, { colIdx: 5, date: "2026-08-01" }];
    expect(pickLatestColumns(withDup, TODAY, 2)[0]).toEqual({ colIdx: 4, date: "2026-07-30" });
  });
  it("empty input yields empty output", () => {
    expect(pickLatestColumns([], TODAY, 2)).toEqual([]);
  });
});

describe("fetchInventorySnapshots empty-column guard", () => {
  it("uses the newest column when it has data (no fallback)", async () => {
    const sheets = stubSheets(
      fixtures({
        newestCol: [["10"], ["11"], ["12"], ["13"]],
        prevCol: [["1"], ["2"], ["3"], ["4"]],
      })
    );
    const { snapshots, headerSummary } = await fetchInventorySnapshots({
      sheets,
      spreadsheetId: "sheet",
      todayYmd: TODAY,
    });
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].snapshotDate).toBe("2026-07-30");
    expect(snapshots[0].rows.map((r) => r.onHand)).toEqual([10, 11, 12, 13]);
    expect(headerSummary["EV Sec CN"]).toBe("2026-07-30 → col D");
  });

  it("falls back to the previous column when the newest is empty (the 07-30 episode)", async () => {
    const sheets = stubSheets(
      fixtures({
        newestCol: [], // header added, counts not pasted yet
        prevCol: [["1"], ["2"], ["3"], ["4"]],
      })
    );
    const { snapshots, headerSummary } = await fetchInventorySnapshots({
      sheets,
      spreadsheetId: "sheet",
      todayYmd: TODAY,
    });
    expect(snapshots[0].snapshotDate).toBe("2026-07-29");
    expect(snapshots[0].rows).toHaveLength(4);
    expect(headerSummary["EV Sec CN"]).toContain("fell back");
    expect(headerSummary["EV Sec CN"]).toContain("2026-07-29");
  });

  it("falls back when the newest column is only sparsely pasted (<25% of SKUs)", async () => {
    const sheets = stubSheets(
      fixtures({
        skus: [["a"], ["b"], ["c"], ["d"], ["e"], ["f"], ["g"], ["h"]],
        newestCol: [["7"]], // 1 of 8
        prevCol: [["1"], ["2"], ["3"], ["4"], ["5"], ["6"], ["7"], ["8"]],
      })
    );
    const { snapshots } = await fetchInventorySnapshots({
      sheets,
      spreadsheetId: "sheet",
      todayYmd: TODAY,
    });
    expect(snapshots[0].snapshotDate).toBe("2026-07-29");
    expect(snapshots[0].rows).toHaveLength(8);
  });

  it("keeps the newest empty column when the previous is empty too (no invented data)", async () => {
    const sheets = stubSheets(fixtures({ newestCol: [], prevCol: [] }));
    const { snapshots, headerSummary } = await fetchInventorySnapshots({
      sheets,
      spreadsheetId: "sheet",
      todayYmd: TODAY,
    });
    expect(snapshots[0].snapshotDate).toBe("2026-07-30");
    expect(snapshots[0].rows).toHaveLength(0);
    expect(headerSummary["EV Sec CN"]).toBe("2026-07-30 → col D");
  });

  it("zero counts are real data, not emptiness", async () => {
    // A tab legitimately at 0 stock everywhere must NOT trigger fallback.
    const sheets = stubSheets(
      fixtures({
        newestCol: [["0"], ["0"], ["0"], ["0"]],
        prevCol: [["5"], ["5"], ["5"], ["5"]],
      })
    );
    const { snapshots } = await fetchInventorySnapshots({
      sheets,
      spreadsheetId: "sheet",
      todayYmd: TODAY,
    });
    expect(snapshots[0].snapshotDate).toBe("2026-07-30");
    expect(snapshots[0].rows.every((r) => r.onHand === 0)).toBe(true);
  });
});
