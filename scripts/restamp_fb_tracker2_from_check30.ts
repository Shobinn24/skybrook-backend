// One-time (re-runnable) restamp of the FB Tracker 2 "2026" tab from the
// "30D Check" tab. Context (2026-06-10): the daily append stamps each
// date once, T+1, but FB restates numbers for ~72h — every column in
// the 2026 tab was frozen at its day-one value, measured ~9%
// ($2.5-3k/day) below the 30D Check for the same dates. This pushes the
// accurate 30D Check values into every date the two tabs share, while
// preserving cells for ads that have since been deleted in FB (they
// drop off the 30D Check pull; blanking them would erase real history).
//
// The daily cron now does the same for the trailing 3 days on every
// run (lib/jobs/fb-tracker2-append.ts, restampDays default 3); this
// script exists for the initial catch-up and any future full-window
// repair.
//
// Usage:
//   npx tsx scripts/restamp_fb_tracker2_from_check30.ts          # dry run
//   npx tsx scripts/restamp_fb_tracker2_from_check30.ts --apply  # write

import "dotenv/config";
import { google } from "googleapis";
import { computeAppendOperations, parseDateCell, type Grid } from "@/lib/domain/fb-tracker2-append";
import { runFbTracker2Append } from "@/lib/jobs/fb-tracker2-append";

const SHEET_ID = "1L-1NUuB46Vi4yzTCmzFG1f8MptEsr44ewKsVqlDfGOI";
// Covers every date the two tabs can share (30D Check holds 30 days).
const RESTAMP_DAYS = 60;

function colSum(grid: Grid, colIdx: number): number {
  let s = 0;
  for (let r = 1; r < grid.length; r++) {
    const v = Number(String(grid[r]?.[colIdx] ?? "").replace(/[$,]/g, ""));
    if (Number.isFinite(v)) s += v;
  }
  return s;
}

async function main() {
  const apply = process.argv.includes("--apply");
  console.log(apply ? "APPLY mode" : "DRY RUN — pass --apply to write");

  const json = process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
  const file = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  const scopes = ["https://www.googleapis.com/auth/spreadsheets"];
  const auth = json
    ? new google.auth.GoogleAuth({ credentials: JSON.parse(json), scopes })
    : new google.auth.GoogleAuth({ keyFile: file, scopes });
  const sheets = google.sheets({ version: "v4", auth });

  const [check30Resp, tab2026Resp] = await Promise.all([
    sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `'30D Check'`, valueRenderOption: "UNFORMATTED_VALUE" }),
    sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `'2026'`, valueRenderOption: "UNFORMATTED_VALUE" }),
  ]);
  const check30Grid = (check30Resp.data.values ?? []) as Grid;
  const tab2026Grid = (tab2026Resp.data.values ?? []) as Grid;

  const ops = computeAppendOperations(check30Grid, tab2026Grid, { restampDays: RESTAMP_DAYS });
  console.log(`missing dates: ${ops.summary.missingDates.join(", ") || "(none)"}`);
  console.log(`restamped dates: ${ops.summary.restampedDates.length}, new ads: ${ops.summary.newAdsCount}, cells to change: ${ops.summary.updatedCellsCount}\n`);

  // Per-column before/after sums for the restamped columns.
  const check30Header = check30Grid[0] ?? [];
  const check30DateCols = new Map<string, number>();
  for (let c = 2; c < check30Header.length; c++) {
    const d = parseDateCell(check30Header[c]);
    if (d) check30DateCols.set(d, c);
  }
  for (const col of ops.columns.filter((c) => !c.isNew)) {
    const before = colSum(tab2026Grid, col.columnIndex);
    let after = 0;
    for (let r = 1; r < col.values.length; r++) {
      const v = Number(String(col.values[r] ?? "").replace(/[$,]/g, ""));
      if (Number.isFinite(v)) after += v;
    }
    const srcIdx = check30DateCols.get(col.date);
    const source = srcIdx !== undefined ? colSum(check30Grid, srcIdx) : NaN;
    console.log(
      `${col.date}: $${before.toFixed(0)} -> $${after.toFixed(0)} (30D Check: $${source.toFixed(0)}, delta ${(after - before >= 0 ? "+" : "")}${(after - before).toFixed(0)})`,
    );
  }

  if (!apply) return process.exit(0);
  const result = await runFbTracker2Append({ restampDays: RESTAMP_DAYS });
  console.log("\napplied:", JSON.stringify(result, null, 2).slice(0, 600));
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
