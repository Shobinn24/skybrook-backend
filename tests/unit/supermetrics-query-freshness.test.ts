import { describe, expect, it } from "vitest";
import {
  evaluateSupermetricsQueryGrid,
  type MonitoredSupermetricsQuery,
} from "@/lib/jobs/supermetrics-query-freshness";

// Feeder-query freshness: reads the `updated` timestamp straight from a
// sheet's SupermetricsQueries metadata tab. Catches the silent-skip class
// of failure (2026-07-06: the FB Ad URL Map query stopped refreshing for
// 2 days because the two heavier queries ahead of it ate the trigger's
// execution budget — its own status still said "Refreshed successfully",
// the sheet's Drive modifiedTime kept moving from sibling tabs, and the
// tab has no date column, so every existing check stayed green).
const NOW = Date.UTC(2026, 6, 6, 12, 0, 0); // 2026-07-06T12:00Z

// Google Sheets serial (1899-12-30 epoch) for a UTC timestamp.
const serial = (iso: string) => (Date.parse(iso) - Date.UTC(1899, 11, 30)) / 86400000;

// Layout mirrors the real tab: preamble rows, a header row keyed by
// "paramsID", then one row per query. Only the columns we read matter.
function grid(rows: Array<{ tab: string; updated: number | string }>): unknown[][] {
  const header = ["paramsID", "qsToolsCheckboxes", "ssID", "sheetName", "rangeAddress", "", "created", "updated", "lastStatus"];
  return [
    ["Supermetrics Queries"],
    ["preamble", "text"],
    header,
    ...rows.map((r) => ["qid123", "false", "", r.tab, `'${r.tab}'!$A$1`, "", 46150, r.updated, "Refreshed successfully by trigger x"]),
  ];
}

const QUERIES: MonitoredSupermetricsQuery[] = [
  { label: "applovin_live.fb_ad_url_map", sheetIdEnv: "APPLOVIN_ADS_SHEET_ID", tabName: "FB Ad URL Map", maxAgeHours: 48 },
];

describe("evaluateSupermetricsQueryGrid", () => {
  it("passes a query refreshed within the age limit", () => {
    const g = grid([{ tab: "FB Ad URL Map", updated: serial("2026-07-06T04:42:00Z") }]);
    const [check] = evaluateSupermetricsQueryGrid(g, QUERIES, NOW);
    expect(check.status).toBe("pass");
    expect(check.name).toBe("supermetrics_query.applovin_live.fb_ad_url_map");
    expect(check.maxDate).toBe("2026-07-06");
  });

  it("fails a query older than maxAgeHours", () => {
    const g = grid([{ tab: "FB Ad URL Map", updated: serial("2026-07-04T04:42:00Z") }]);
    const [check] = evaluateSupermetricsQueryGrid(g, QUERIES, NOW);
    expect(check.status).toBe("fail");
    expect(check.severity).toBe("p2");
    expect(check.title).toMatch(/not refreshed/i);
  });

  it("normalizes the stray trailing apostrophe Supermetrics writes into sheetName", () => {
    const g = grid([{ tab: "FB Ad URL Map'", updated: serial("2026-07-06T04:42:00Z") }]);
    const [check] = evaluateSupermetricsQueryGrid(g, QUERIES, NOW);
    expect(check.status).toBe("pass");
  });

  it("fails when the monitored query row is missing entirely", () => {
    const g = grid([{ tab: "Some Other Tab", updated: serial("2026-07-06T04:00:00Z") }]);
    const [check] = evaluateSupermetricsQueryGrid(g, QUERIES, NOW);
    expect(check.status).toBe("fail");
    expect(check.title).toMatch(/no query found/i);
  });

  it("uses the newest row when several queries write the same tab", () => {
    const g = grid([
      { tab: "FB Ad URL Map", updated: serial("2026-07-01T04:00:00Z") },
      { tab: "FB Ad URL Map", updated: serial("2026-07-06T04:00:00Z") },
    ]);
    const [check] = evaluateSupermetricsQueryGrid(g, QUERIES, NOW);
    expect(check.status).toBe("pass");
  });

  it("fails all monitored queries when the header row cannot be located", () => {
    const [check] = evaluateSupermetricsQueryGrid([["nothing", "here"]], QUERIES, NOW);
    expect(check.status).toBe("fail");
    expect(check.title).toMatch(/unreadable/i);
  });
});
