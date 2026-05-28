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
import { parseDateCell } from "@/lib/domain/fb-tracker2-append";
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
//
// Dropped 2026-05-23:
//   - `fb_ads_tracker.sheet7` — orphaned tab. Grid was sized at 132 cols
//     so it filled by 2026-05-09 and stopped. Not populated by any
//     Supermetrics query (not in SupermetricsQueries metadata), not
//     hand-maintained going forward, no consumer reading from it. The
//     daily P1 was pure noise burying real alerts.
export const MONITORED_REFERENCE_TABS: ReadonlyArray<MonitoredReferenceTab> = [
  {
    label: "fb_ads_tracker_2.2026",
    sheetId: "1L-1NUuB46Vi4yzTCmzFG1f8MptEsr44ewKsVqlDfGOI",
    tabName: "2026",
    layout: "headerHasDates",
  },
  // Monitoring 30D Check alongside 2026 detects divergence: if 30D
  // has T-1 but 2026 doesn't, only the 2026 check fails — that's the
  // signal that the daily append (runFbTracker2Append in the afternoon
  // cron) stopped working while Supermetrics' upstream stays healthy.
  // 2026-05-28 root cause for the missed 5/27 column.
  {
    label: "fb_ads_tracker_2.30d_check",
    sheetId: "1L-1NUuB46Vi4yzTCmzFG1f8MptEsr44ewKsVqlDfGOI",
    tabName: "30D Check",
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

  // parseDateCell handles BOTH ISO strings AND Excel serial numbers.
  // The string-only regex this used to use silently dropped serials,
  // which is what made FB Ads Tracker 2's 2026-tab freshness check
  // miss the gap that left the 5/27 column unappended (2026-05-28).
  let maxDate: string | null = null;
  const considerCell = (cell: unknown) => {
    const iso = parseDateCell(cell);
    if (iso && (maxDate === null || iso > maxDate)) maxDate = iso;
  };
  if (tab.layout === "headerHasDates") {
    for (const c of values[0] ?? []) considerCell(c);
  } else {
    for (const row of values) considerCell(row?.[0]);
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
