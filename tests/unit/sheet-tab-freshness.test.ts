import { describe, expect, it, vi } from "vitest";
import { evaluateReferenceTabsFreshness, type MonitoredReferenceTab } from "@/lib/jobs/sheet-tab-freshness";
import type { google } from "googleapis";

const FIXED_NOW = new Date("2026-05-22T20:00:00Z");
const fixedNow = () => FIXED_NOW;
const YESTERDAY_EST = "2026-05-21";

type SheetsClient = ReturnType<typeof google.sheets>;

// Minimal stub of the googleapis sheets client surface we touch.
// We only call `spreadsheets.values.get`, so that's the only contract.
function stubClient(map: Record<string, { values?: unknown[][]; error?: Error }>): SheetsClient {
  return {
    spreadsheets: {
      values: {
        get: vi.fn(async (req: { spreadsheetId: string; range: string }) => {
          const key = `${req.spreadsheetId}::${req.range}`;
          const entry = map[key];
          if (!entry) throw new Error(`stub miss: ${key}`);
          if (entry.error) throw entry.error;
          return { data: { values: entry.values ?? [] } };
        }),
      },
    },
  } as unknown as SheetsClient;
}

const TAB_HEADER: MonitoredReferenceTab = {
  label: "test_tab.header",
  sheetId: "sheetA",
  tabName: "Sheet1",
  layout: "headerHasDates",
};
const TAB_COLUMN_A: MonitoredReferenceTab = {
  label: "test_tab.col_a",
  sheetId: "sheetB",
  tabName: "Daily",
  layout: "columnAHasDates",
};

describe("evaluateReferenceTabsFreshness", () => {
  it("passes a header-layout tab whose last date is yesterday EST", async () => {
    const client = stubClient({
      "sheetA::'Sheet1'!1:1": {
        values: [["Ad name", "Link", "2026-05-19", "2026-05-20", "2026-05-21"]],
      },
    });
    const checks = await evaluateReferenceTabsFreshness({
      now: fixedNow,
      client,
      tabs: [TAB_HEADER],
    });
    expect(checks).toHaveLength(1);
    expect(checks[0].status).toBe("pass");
    expect(checks[0].maxDate).toBe(YESTERDAY_EST);
    expect(checks[0].name).toBe("reference_tab.test_tab.header");
    expect(checks[0].dedupKey).toBe("freshness:reference_tab:test_tab.header");
  });

  it("fails a header-layout tab whose last date is older than yesterday EST (Sheet7 freeze case)", async () => {
    // Simulates Sheet7 on 2026-05-22: last date col is 2026-05-09 because
    // the sheet ran out of grid columns. New monitoring catches this.
    const client = stubClient({
      "sheetA::'Sheet1'!1:1": {
        values: [["Ad name", "Link", "2026-05-07", "2026-05-08", "2026-05-09"]],
      },
    });
    const checks = await evaluateReferenceTabsFreshness({
      now: fixedNow,
      client,
      tabs: [TAB_HEADER],
    });
    expect(checks[0].status).toBe("fail");
    expect(checks[0].maxDate).toBe("2026-05-09");
    expect(checks[0].title).toContain("is stale");
    expect(checks[0].title).toContain("2026-05-09");
  });

  it("fails a header-layout tab with no parseable date cells", async () => {
    const client = stubClient({
      "sheetA::'Sheet1'!1:1": {
        values: [["Ad name", "Link", "some-garbage", ""]],
      },
    });
    const checks = await evaluateReferenceTabsFreshness({
      now: fixedNow,
      client,
      tabs: [TAB_HEADER],
    });
    expect(checks[0].status).toBe("fail");
    expect(checks[0].maxDate).toBeNull();
  });

  it("passes a column-A-layout tab whose last date is yesterday EST", async () => {
    const client = stubClient({
      "sheetB::'Daily'!A:A": {
        values: [
          ["Date"],
          ["2026-05-19"],
          ["2026-05-20"],
          ["2026-05-21"],
        ],
      },
    });
    const checks = await evaluateReferenceTabsFreshness({
      now: fixedNow,
      client,
      tabs: [TAB_COLUMN_A],
    });
    expect(checks[0].status).toBe("pass");
    expect(checks[0].maxDate).toBe(YESTERDAY_EST);
  });

  it("emits a check entry (status=fail) when the Sheets API call throws", async () => {
    // One bad tab shouldn't crash the sweep — it surfaces as its own
    // failing check with the error in the fields so Slack carries the
    // exact reason.
    const client = stubClient({
      "sheetA::'Sheet1'!1:1": { error: new Error("Range exceeds grid limits") },
    });
    const checks = await evaluateReferenceTabsFreshness({
      now: fixedNow,
      client,
      tabs: [TAB_HEADER],
    });
    expect(checks[0].status).toBe("fail");
    expect(checks[0].title).toContain("unreadable");
    expect(checks[0].fields.error).toContain("Range exceeds grid limits");
  });

  it("parses Excel serial date headers (raw Supermetrics shape that hid the 5/27 gap on 2026-05-28)", async () => {
    // FB Ads Tracker 2's date headers come back as Excel serial numbers
    // (e.g. 46169 for 2026-05-27) when read via valueRenderOption=
    // UNFORMATTED_VALUE. The old string-only regex (/^\d{4}-\d{2}-\d{2}$/)
    // silently dropped them, leaving maxDate=null on a tab that
    // actually had a fresh date. parseDateCell fixes that.
    const client = stubClient({
      "sheetA::'Sheet1'!1:1": {
        values: [["Ad name", "Link", 46167, 46168, 46169]],
      },
    });
    const checks = await evaluateReferenceTabsFreshness({
      now: fixedNow,
      client,
      tabs: [TAB_HEADER],
    });
    expect(checks[0].status).toBe("pass");
    expect(checks[0].maxDate).toBe("2026-05-27");
  });

  it("evaluates each monitored tab independently", async () => {
    // One fresh, one stale, one error — all three surface as separate
    // checks so per-tab Slack dedup keys can fire/resolve independently.
    const client = stubClient({
      "sheetA::'Sheet1'!1:1": { values: [["Ad name", "", "2026-05-21"]] },
      "sheetB::'Daily'!A:A": { values: [["Date"], ["2026-05-09"]] },
    });
    const checks = await evaluateReferenceTabsFreshness({
      now: fixedNow,
      client,
      tabs: [TAB_HEADER, TAB_COLUMN_A],
    });
    expect(checks).toHaveLength(2);
    expect(checks[0].status).toBe("pass");
    expect(checks[1].status).toBe("fail");
    expect(checks[0].dedupKey).not.toBe(checks[1].dedupKey);
  });
});

// --- Scheduled-append tabs (2026-08-06): before the append hour, T-2 is
// the healthy state; the threshold only tightens to T-1 afterwards.
describe("appendedByUtcHour pre-append window", () => {
  const TAB_APPENDED: MonitoredReferenceTab = {
    label: "test_tab.appended",
    sheetId: "sheetC",
    tabName: "2026",
    layout: "headerHasDates",
    appendedByUtcHour: 17,
  };
  // 09:14 UTC = the 5:14 EDT morning sweep that used to page daily.
  const MORNING = () => new Date("2026-05-22T09:14:00Z");
  const AFTERNOON = () => new Date("2026-05-22T20:00:00Z");
  const T2 = "2026-05-20";

  it("passes with only T-2 during the pre-append window (the 5am sweep)", async () => {
    const client = stubClient({
      "sheetC::'2026'!1:1": { values: [["Ad name", "2026-05-19", T2]] },
    });
    const checks = await evaluateReferenceTabsFreshness({
      now: MORNING,
      client,
      tabs: [TAB_APPENDED],
    });
    expect(checks[0].status).toBe("pass");
    expect(checks[0].threshold).toBe(T2);
    expect(String(checks[0].fields.note ?? "")).toContain("pre-append window");
  });

  it("fails with only T-2 after the append hour (append actually broken)", async () => {
    const client = stubClient({
      "sheetC::'2026'!1:1": { values: [["Ad name", "2026-05-19", T2]] },
    });
    const checks = await evaluateReferenceTabsFreshness({
      now: AFTERNOON,
      client,
      tabs: [TAB_APPENDED],
    });
    expect(checks[0].status).toBe("fail");
    expect(checks[0].threshold).toBe("2026-05-21");
    expect(checks[0].fields.note).toBeUndefined();
  });

  it("still fails during the pre-append window when even T-2 is missing", async () => {
    const client = stubClient({
      "sheetC::'2026'!1:1": { values: [["Ad name", "2026-05-18", "2026-05-19"]] },
    });
    const checks = await evaluateReferenceTabsFreshness({
      now: MORNING,
      client,
      tabs: [TAB_APPENDED],
    });
    expect(checks[0].status).toBe("fail");
  });

  it("tabs without appendedByUtcHour keep the tight T-1 threshold in the morning", async () => {
    const client = stubClient({
      "sheetA::'Sheet1'!1:1": { values: [["Ad name", T2]] },
    });
    const checks = await evaluateReferenceTabsFreshness({
      now: MORNING,
      client,
      tabs: [TAB_HEADER],
    });
    expect(checks[0].status).toBe("fail");
    expect(checks[0].threshold).toBe("2026-05-21");
  });
});
