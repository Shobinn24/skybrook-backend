// Skybrook port of the FB Ads Tracker 2 Daily->2026 append. Replaces
// the Apps Script `appendDailyTo2026` that was silently skipping
// date columns because Daily lags FB Ads' 48h finalization window —
// see lib/domain/fb-tracker2-append.ts for the full background.
//
// Reads from the `30D Check` tab (rolling 30-day pull that includes
// T-1 once FB has finalized) and writes missing date columns + new
// ad rows into the `2026` tab. Runs in the afternoon ad-spend refresh
// cron (app/api/cron/refresh-ad-spend/route.ts) — well after FB has
// finalized T-1 numbers.
//
// Idempotent: if 2026 already has every date 30D Check has, this is
// a no-op (zero Sheets writes).
//
// Service account `everdries-uploader@everdries-drive.iam.gserviceaccount.com`
// must have Editor access on the FB Ads Tracker 2 spreadsheet (was
// Viewer before the port). Without Editor, the write call returns 403
// and the job surfaces a P1 Slack alert.

import { google, type sheets_v4 } from "googleapis";
import {
  computeAppendOperations,
  type Grid,
} from "@/lib/domain/fb-tracker2-append";
import { logger } from "@/lib/logger";

const FB_TRACKER_2_SHEET_ID = "1L-1NUuB46Vi4yzTCmzFG1f8MptEsr44ewKsVqlDfGOI";
const SHEET_2026 = "2026";
const SHEET_30D_CHECK = "30D Check";

export type FbTracker2AppendResult = {
  /** Dates that were newly added to the 2026 tab. */
  appendedDates: string[];
  /** Number of brand-new ad rows appended. */
  newAdsCount: number;
  /** Total cells written across all the appended columns. */
  updatedCellsCount: number;
  /** Skipped (no-op) — true when 2026 was already up to date. */
  skipped: boolean;
};

function buildSheetsClient(): sheets_v4.Sheets {
  const json = process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
  const file = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  // Editor scope — required for the values.update + values.append writes.
  const scopes = ["https://www.googleapis.com/auth/spreadsheets"];
  const auth = json
    ? new google.auth.GoogleAuth({ credentials: JSON.parse(json), scopes })
    : new google.auth.GoogleAuth({ keyFile: file, scopes });
  return google.sheets({ version: "v4", auth });
}

/** A1-notation column letter for a 0-based index. Handles A..Z, AA..AZ, etc. */
function colLetter(index: number): string {
  let n = index;
  let s = "";
  while (n >= 0) {
    s = String.fromCharCode((n % 26) + 65) + s;
    n = Math.floor(n / 26) - 1;
  }
  return s;
}

export async function runFbTracker2Append(): Promise<FbTracker2AppendResult> {
  const sheets = buildSheetsClient();

  // Pull both tabs in parallel. Both are well under the 5MB cell-data
  // limit so a single getValues each is fine. UNFORMATTED_VALUE gives
  // us numbers + Excel date serials we can parse on the read side.
  const [check30Resp, tab2026Resp] = await Promise.all([
    sheets.spreadsheets.values.get({
      spreadsheetId: FB_TRACKER_2_SHEET_ID,
      range: `'${SHEET_30D_CHECK}'`,
      valueRenderOption: "UNFORMATTED_VALUE",
    }),
    sheets.spreadsheets.values.get({
      spreadsheetId: FB_TRACKER_2_SHEET_ID,
      range: `'${SHEET_2026}'`,
      valueRenderOption: "UNFORMATTED_VALUE",
    }),
  ]);

  const check30Grid: Grid = (check30Resp.data.values ?? []) as Grid;
  const tab2026Grid: Grid = (tab2026Resp.data.values ?? []) as Grid;

  const ops = computeAppendOperations(check30Grid, tab2026Grid);

  if (ops.summary.missingDates.length === 0) {
    logger.info("fb-tracker2-append.skipped", {
      reason: "2026 has every date present on 30D Check",
      check30Cols: (check30Grid[0] ?? []).length,
      tab2026Cols: (tab2026Grid[0] ?? []).length,
    });
    return {
      appendedDates: [],
      newAdsCount: 0,
      updatedCellsCount: 0,
      skipped: true,
    };
  }

  // 1. Append new ad rows first. Using values.append with INSERT_ROWS
  // grows the sheet so the subsequent column writes have somewhere to
  // land. valueInputOption RAW preserves the spend numbers verbatim
  // (USER_ENTERED would re-format the cell, which would convert "0.00"
  // to 0 etc. — RAW keeps the original Supermetrics shape).
  if (ops.newRows.length > 0) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: FB_TRACKER_2_SHEET_ID,
      range: `'${SHEET_2026}'!A1`,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: {
        values: ops.newRows.map((r) => r.values as unknown[]),
      },
    });
  }

  // 1b. Ensure the grid is wide enough for the new date columns. The
  // column writes below use values.batchUpdate, which (unlike the
  // INSERT_ROWS append above) does NOT auto-grow the sheet — so once
  // the 2026 tab fills its column allotment, the next day's write fails
  // with "exceeds grid limits" and the whole append silently aborts
  // (caught by the cron, surfaced only in logs). Grow the grid first
  // when the new column would land past the current edge, with headroom
  // so this doesn't run every single day. (Found 2026-06-01: the tab hit
  // its 152-column cap and 05-31 couldn't be written.)
  if (ops.columns.length > 0) {
    const neededColumns =
      Math.max(...ops.columns.map((c) => c.columnIndex)) + 1; // 0-based idx → 1-based count
    const meta = await sheets.spreadsheets.get({
      spreadsheetId: FB_TRACKER_2_SHEET_ID,
      fields: "sheets(properties(sheetId,title,gridProperties(columnCount)))",
    });
    const sheet2026 = meta.data.sheets?.find(
      (s) => s.properties?.title === SHEET_2026,
    );
    const currentColumns =
      sheet2026?.properties?.gridProperties?.columnCount ?? 0;
    const sheet2026Id = sheet2026?.properties?.sheetId;
    if (sheet2026Id != null && neededColumns > currentColumns) {
      const addColumns = neededColumns - currentColumns + 24; // + headroom
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: FB_TRACKER_2_SHEET_ID,
        requestBody: {
          requests: [
            {
              appendDimension: {
                sheetId: sheet2026Id,
                dimension: "COLUMNS",
                length: addColumns,
              },
            },
          ],
        },
      });
      logger.info("fb-tracker2-append.grew-columns", {
        from: currentColumns,
        to: currentColumns + addColumns,
        neededColumns,
      });
    }
  }

  // 2. Write each missing-date column. Single batched call —
  // values.batchUpdate accepts multiple ranges in one round-trip.
  // Each column's `values` array is already sized to the final row
  // count (existing rows + appended new ad rows), so we write the
  // entire column in one range.
  const data: sheets_v4.Schema$ValueRange[] = ops.columns.map((col) => ({
    range: `'${SHEET_2026}'!${colLetter(col.columnIndex)}1:${colLetter(col.columnIndex)}${col.values.length}`,
    values: col.values.map((v) => [v]),
  }));

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: FB_TRACKER_2_SHEET_ID,
    requestBody: {
      valueInputOption: "RAW",
      data,
    },
  });

  logger.info("fb-tracker2-append.applied", {
    appendedDates: ops.summary.missingDates,
    newAdsCount: ops.summary.newAdsCount,
    updatedCellsCount: ops.summary.updatedCellsCount,
  });

  return {
    appendedDates: ops.summary.missingDates,
    newAdsCount: ops.summary.newAdsCount,
    updatedCellsCount: ops.summary.updatedCellsCount,
    skipped: false,
  };
}
