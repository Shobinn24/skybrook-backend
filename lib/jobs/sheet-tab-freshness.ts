// Reference-tab freshness check — catches stale sheet tabs that Scott
// looks at directly but Skybrook does NOT ingest. Adds Slack alerts
// for the silent-freeze class of bug (Sheet7 ran out of columns on
// 2026-05-09 and froze for 13 days unnoticed; FB Ads Tracker 2's
// `2026` tab is appended daily by an Apps Script that can silently
// stop firing).
//
// Two-tier monitoring:
//   1. evaluateFreshness (DB-only, fast) — covers tables we ingest
//   2. evaluateReferenceTabsFreshness (sheets API, slower) — covers
//      tabs we don't ingest but Scott uses as a reference. Only the
//      cron path pays the sheets API cost; /api/health stays DB-only.
//
// Each monitored tab declares either `headerHasDates` (last date in
// row 1, like Sheet6 + Sheet7 + `2026` per-ad layout) or `columnAHasDates`
// (one date per row in col A, like Supermetrics single-tab Date/Cost).
import { google } from "googleapis";
import { buildSheetsClient } from "@/lib/sources/sheets";
import { toEstDate } from "@/lib/tz";
import type { EvaluatedCheck } from "@/lib/jobs/freshness-check";

type SheetsClient = ReturnType<typeof google.sheets>;

export type MonitoredReferenceTab = {
  /** Slack-readable label for the alert title + dedup key suffix. */
  label: string;
  sheetId: string;
  tabName: string;
  /** Where dates live in this tab's layout. */
  layout: "headerHasDates" | "columnAHasDates";
};

// Add a tab here when Scott (or anyone) starts using a new sheet view
// as their daily reference. Format: stable slug as `label` — it becomes
// the alert dedup key, so don't rename casually.
export const MONITORED_REFERENCE_TABS: ReadonlyArray<MonitoredReferenceTab> = [
  {
    label: "fb_ads_tracker.sheet7",
    sheetId: "1lya_-S-r57Xt60biwU3adOsbnDZatP_AoERB2hjMzJo",
    tabName: "Sheet7",
    layout: "headerHasDates",
  },
  {
    label: "fb_ads_tracker_2.2026",
    sheetId: "1L-1NUuB46Vi4yzTCmzFG1f8MptEsr44ewKsVqlDfGOI",
    tabName: "2026",
    layout: "headerHasDates",
  },
];

// Tolerance: same as evaluateFreshness — must have a date >= yesterday EST.
function yesterdayEst(now: Date): string {
  const d = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  return toEstDate(d);
}

// Pull either row 1 (date headers) or column A (date column) and return
// the max ISO-formatted date found, or null when none parse. Defensive
// against partial Sheets API failures (one bad tab shouldn't break the
// whole sweep — surface the failure as its own check entry).
async function maxDateInTab(
  client: SheetsClient,
  tab: MonitoredReferenceTab,
): Promise<{ maxDate: string | null; error?: string }> {
  // Header layout: pull row 1 only (cheap; one cell metadata round-trip).
  // Column-A layout: pull A:A (entire column; small for date-per-row tabs).
  // Avoid hardcoded column ranges (Sheet7 exceeds 132 cols failure mode
  // proves overflow guesses bite back). Use Sheets-API "row 1" syntax.
  const range = tab.layout === "headerHasDates" ? `'${tab.tabName}'!1:1` : `'${tab.tabName}'!A:A`;
  let values: unknown[][];
  try {
    const resp = await client.spreadsheets.values.get({
      spreadsheetId: tab.sheetId,
      range,
    });
    values = (resp.data.values ?? []) as unknown[][];
  } catch (e) {
    return { maxDate: null, error: e instanceof Error ? e.message.slice(0, 200) : String(e) };
  }

  let maxDate: string | null = null;
  if (tab.layout === "headerHasDates") {
    const header = values[0] ?? [];
    for (const c of header) {
      const s = String(c ?? "").trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(s) && (maxDate === null || s > maxDate)) {
        maxDate = s;
      }
    }
  } else {
    for (const row of values) {
      const s = String(row?.[0] ?? "").trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(s) && (maxDate === null || s > maxDate)) {
        maxDate = s;
      }
    }
  }
  return { maxDate };
}

export async function evaluateReferenceTabsFreshness(opts?: {
  now?: () => Date;
  client?: SheetsClient;
  tabs?: ReadonlyArray<MonitoredReferenceTab>;
}): Promise<EvaluatedCheck[]> {
  const now = opts?.now ?? (() => new Date());
  const threshold = yesterdayEst(now());
  const tabs = opts?.tabs ?? MONITORED_REFERENCE_TABS;
  const client = opts?.client ?? buildSheetsClient();

  const checks: EvaluatedCheck[] = [];
  // Sequential to keep within Sheets API per-second quota and to make
  // a transient 429 affect ONE tab's check, not all of them.
  for (const tab of tabs) {
    const { maxDate, error } = await maxDateInTab(client, tab);
    const stale = error !== undefined || maxDate === null || maxDate < threshold;
    checks.push({
      name: `reference_tab.${tab.label}`,
      status: stale ? "fail" : "pass",
      maxDate,
      threshold,
      dedupKey: `freshness:reference_tab:${tab.label}`,
      title: error
        ? `reference tab ${tab.label} unreadable: ${error}`
        : `reference tab ${tab.label} is stale (max ${maxDate ?? "<none>"} < ${threshold})`,
      fields: {
        label: tab.label,
        sheetId: tab.sheetId,
        tabName: tab.tabName,
        layout: tab.layout,
        maxDate: maxDate ?? "<null>",
        threshold,
        ...(error ? { error } : {}),
      },
    });
  }
  return checks;
}
