// FB Ads Live date-column integrity check (recurring-bug guard).
//
// The "FB Ads Live" tab periodically ends up with date-header columns that
// are EMPTY or OUT OF CHRONOLOGICAL ORDER. Cause: Supermetrics writes a
// fixed output range (e.g. A1:T...) but the rolling window only fills the
// left N columns, so when the window slides it leaves stale orphan
// columns to the right (6/25: Jun 7-10 were empty orphan cols Q-T after
// the window slid to Jun 11-24), and a re-run can re-pad them.
//
// Our ingest is ROBUST to this — parseFbAdsSheet keys by header date and
// skips blank cells, and replaceFbAdSpendLiveWindow deletes to the
// earliest date-WITH-data — so it has never corrupted the DB. But it's a
// symptom of upstream instability that could eventually strand a
// *populated* day, and it confuses any order-dependent human reader of the
// sheet. So we surface it automatically instead of finding it by eye.
//
// Two failure shapes, both flagged:
//   (a) date headers not strictly ascending left-to-right (out of order)
//   (b) a date-header column with no numeric data anywhere below it
//       (orphan / empty)
//
// p2 → #skybrook-digest, static dedup key → auto-resolves the moment the
// sheet owner removes the orphan columns. Reads the Sheets API, so this is
// wired into runFreshnessCheck's reference-tab sweep (gated by
// includeReferenceTabs), NOT the DB-only evaluateFreshness path that
// /api/health hits.

import { logger } from "@/lib/logger";
import type { EvaluatedCheck } from "@/lib/jobs/freshness-check";
import { buildSheetsClient } from "@/lib/sources/sheets/client";

const FB_ADS_DEFAULT_TAB = "Sheet7";
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

type DateCol = { colIdx: number; date: string };

// 0 → "A", 16 → "Q", 26 → "AA". For readable digest output.
function colLetter(idx: number): string {
  let n = idx;
  let s = "";
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

/**
 * Pure detector. Given the raw sheet grid, find date-header columns that
 * are out of chronological order or present-but-empty. No I/O.
 */
export function detectFbSheetShapeIssues(
  grid: ReadonlyArray<ReadonlyArray<unknown>>,
): { outOfOrder: DateCol[]; emptyCols: DateCol[] } {
  const header = (grid[0] ?? []).map((c) => String(c ?? "").trim());
  const dateCols: DateCol[] = [];
  for (let c = 0; c < header.length; c++) {
    if (ISO_DATE.test(header[c])) dateCols.push({ colIdx: c, date: header[c] });
  }

  // (a) Out of order: each date header must be strictly greater than the
  // one to its left. Flag the offending (right-hand) column.
  const outOfOrder: DateCol[] = [];
  for (let i = 1; i < dateCols.length; i++) {
    if (dateCols[i].date <= dateCols[i - 1].date) outOfOrder.push(dateCols[i]);
  }

  // (b) Empty/orphan: a date column with no finite, non-zero numeric cell
  // anywhere below the header. (Mirrors parseFbAdsSheet, which treats
  // blank and 0 cells as no-spend.)
  const emptyCols: DateCol[] = [];
  for (const dc of dateCols) {
    let hasData = false;
    for (let r = 1; r < grid.length; r++) {
      const cell = String((grid[r] ?? [])[dc.colIdx] ?? "").trim();
      if (!cell) continue;
      const n = Number(cell.replace(/[$,]/g, ""));
      if (Number.isFinite(n) && n !== 0) {
        hasData = true;
        break;
      }
    }
    if (!hasData) emptyCols.push(dc);
  }

  return { outOfOrder, emptyCols };
}

/**
 * Evaluate the FB Ads Live tab's date-column integrity. Returns a single
 * EvaluatedCheck (pass or fail) when a grid is available, or [] when it
 * can't be read (missing env / fetch error / explicit null) — best-effort
 * so a Sheets hiccup never fails the freshness sweep.
 *
 * `opts.grid` injects a grid for tests (pass `null` to simulate "no grid").
 */
export async function evaluateFbSheetShape(opts?: {
  grid?: ReadonlyArray<ReadonlyArray<unknown>> | null;
}): Promise<EvaluatedCheck[]> {
  let grid: ReadonlyArray<ReadonlyArray<unknown>> | null;

  if (opts && "grid" in opts) {
    grid = opts.grid ?? null;
  } else {
    grid = await fetchFbAdsGrid();
  }
  if (!grid || grid.length === 0) return [];

  const { outOfOrder, emptyCols } = detectFbSheetShapeIssues(grid);
  const fail = outOfOrder.length > 0 || emptyCols.length > 0;

  const fmt = (cols: DateCol[]) =>
    cols.map((c) => `${colLetter(c.colIdx)}=${c.date}`).join(", ") || "<none>";

  return [
    {
      name: "fb_sheet_shape",
      status: fail ? "fail" : "pass",
      maxDate: null,
      threshold: "date headers strictly ascending + every date column has data",
      dedupKey: "fb_sheet_shape",
      title:
        "FB Ads Live has empty/out-of-order date columns (Supermetrics orphan columns)",
      severity: "p2",
      detail: fail
        ? `outOfOrder=[${fmt(outOfOrder)}] empty=[${fmt(emptyCols)}]`
        : undefined,
      fields: {
        outOfOrderCols: fmt(outOfOrder),
        emptyCols: fmt(emptyCols),
        action:
          "Delete the orphan date columns on the FB Ads Live tab (or shrink the Supermetrics output range). Harmless to the DB; cleans up the sheet.",
      },
    },
  ];
}

// Read the FB Ads Live grid via the Sheets API. Best-effort: any failure
// (missing env, API error) returns null so the caller skips the check
// rather than failing the whole sweep.
async function fetchFbAdsGrid(): Promise<unknown[][] | null> {
  const sheetId = process.env.FB_ADS_SHEET_ID;
  if (!sheetId) {
    logger.warn("fb_sheet_shape.skipped", { reason: "missing FB_ADS_SHEET_ID" });
    return null;
  }
  const tab = process.env.FB_ADS_TAB_NAME?.trim() || FB_ADS_DEFAULT_TAB;
  try {
    const sheets = buildSheetsClient();
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `'${tab}'!A1:AZZ`,
    });
    return (resp.data.values ?? []) as unknown[][];
  } catch (e) {
    logger.warn("fb_sheet_shape.skipped", {
      reason: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}
