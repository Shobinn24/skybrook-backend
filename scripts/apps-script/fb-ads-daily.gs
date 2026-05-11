// =========================================================================
// FB Ads Tracker 2 — Daily Append + Divergence Check
// Spreadsheet: https://docs.google.com/spreadsheets/d/1L-1NUuB46Vi4yzTCmzFG1f8MptEsr44ewKsVqlDfGOI
//
// PASTE THIS into the Apps Script editor attached to the FB Ads Tracker 2
// spreadsheet (Extensions → Apps Script). Then set up a daily time-driven
// trigger on `dailyAppendAndCheck` to run between 8am–9am GMT-3 (= 11am–
// 12pm UTC), i.e. shortly after the Supermetrics 8am GMT-3 refresh of
// the `Daily` tab.
//
// Two jobs run once per day:
//
//   1. appendDailyTo2026() — reads the single date in `Daily`, finds or
//      creates that date column on `2026`, then for every ad in `Daily`:
//        - existing ad: writes the spend into the date cell
//        - new ad: appends a row with name + link + spend
//      Idempotent: re-running the same day overwrites the existing column.
//
//   2. runDivergenceCheck() — for every (ad, date) pair that exists in
//      BOTH `2026` and `30D Check`, flags rows where the two disagree by
//      more than DIVERGENCE_ABS_THRESHOLD AND DIVERGENCE_PCT_THRESHOLD.
//      Output overwritten daily into the `Divergence Flags` tab; if zero
//      flags, that tab is cleared with just a header + an "OK" stamp.
// =========================================================================

const SHEET_2026 = "2026";
const SHEET_DAILY = "Daily";
const SHEET_30D = "30D Check";
const SHEET_FLAGS = "Divergence Flags";

// A divergence is flagged ONLY when both thresholds are crossed. Tune
// these together — $1 absolute filters out floating-point noise; 5%
// relative filters out near-zero days where pennies look huge.
const DIVERGENCE_ABS_THRESHOLD = 1.0;   // dollars
const DIVERGENCE_PCT_THRESHOLD = 0.05;  // 5%

function dailyAppendAndCheck() {
  const ss = SpreadsheetApp.getActive();
  const apply = appendDailyTo2026(ss);
  const check = runDivergenceCheck(ss);
  Logger.log(
    "Done. " +
    "Appended " + apply.dateHeader + ": " +
    apply.updated + " updated, " + apply.added + " new. " +
    "Divergence: " + check.flaggedCount + " flagged (out of " +
    check.overlapCells + " overlap cells)."
  );
}

// ---------------------------------------------------------------------------
// 1. Daily → 2026 append
// ---------------------------------------------------------------------------
function appendDailyTo2026(ss) {
  const daily = ss.getSheetByName(SHEET_DAILY);
  const main = ss.getSheetByName(SHEET_2026);
  if (!daily) throw new Error("Tab not found: " + SHEET_DAILY);
  if (!main) throw new Error("Tab not found: " + SHEET_2026);

  const dailyValues = daily.getDataRange().getValues();
  if (dailyValues.length < 2) {
    Logger.log("Daily has no data rows; skipping append.");
    return { dateHeader: "(empty)", updated: 0, added: 0 };
  }

  const dailyHeader = dailyValues[0];
  if (String(dailyHeader[0] || "").trim().toLowerCase() !== "ad name") {
    throw new Error("Daily col A header is not 'Ad name': " + dailyHeader[0]);
  }
  const dateHeader = formatDateCell_(dailyHeader[2]);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateHeader)) {
    throw new Error("Daily col C is not a YYYY-MM-DD date: " + dateHeader);
  }

  const mainValues = main.getDataRange().getValues();
  const mainHeader = mainValues[0];

  // Find or create the column for this date on `2026`.
  let dateColIdx = -1; // 0-based
  for (let c = 2; c < mainHeader.length; c++) {
    if (formatDateCell_(mainHeader[c]) === dateHeader) {
      dateColIdx = c;
      break;
    }
  }
  let appendedNewColumn = false;
  if (dateColIdx === -1) {
    dateColIdx = mainHeader.length;
    main.getRange(1, dateColIdx + 1).setValue(dateHeader);
    appendedNewColumn = true;
  }

  // Map ad name → existing row index (0-based, in mainValues).
  const adNameToRow = new Map();
  for (let r = 1; r < mainValues.length; r++) {
    const name = String(mainValues[r][0] || "").trim();
    if (name) adNameToRow.set(name, r);
  }

  // Batch updates: build the full column for dateColIdx, pre-filled with
  // current values (or empty for the new-column case), then apply the
  // Daily-row writes, then setValues once.
  const totalRows = mainValues.length;
  const existingColumn = new Array(totalRows);
  for (let r = 0; r < totalRows; r++) {
    existingColumn[r] = [appendedNewColumn ? "" : (mainValues[r][dateColIdx] ?? "")];
  }
  // Ensure the header cell of that column equals dateHeader (only matters
  // if we just appended the column — already wrote it above; keep as-is).
  if (appendedNewColumn) existingColumn[0] = [dateHeader];

  let updated = 0;
  let added = 0;
  const newRowsToAppend = [];
  for (let r = 1; r < dailyValues.length; r++) {
    const name = String(dailyValues[r][0] || "").trim();
    if (!name) continue;
    const link = String(dailyValues[r][1] || "").trim();
    const spendRaw = dailyValues[r][2];
    if (spendRaw === "" || spendRaw === null || spendRaw === undefined) continue;

    const rowIdx = adNameToRow.get(name);
    if (rowIdx === undefined) {
      // Brand-new ad: queue an append row.
      const newRow = new Array(Math.max(mainHeader.length, dateColIdx + 1)).fill("");
      newRow[0] = name;
      newRow[1] = link;
      newRow[dateColIdx] = spendRaw;
      newRowsToAppend.push(newRow);
      added++;
    } else {
      existingColumn[rowIdx] = [spendRaw];
      updated++;
    }
  }

  // Batched column write.
  main.getRange(1, dateColIdx + 1, totalRows, 1).setValues(existingColumn);

  // Append new ads, if any.
  if (newRowsToAppend.length > 0) {
    main
      .getRange(totalRows + 1, 1, newRowsToAppend.length, newRowsToAppend[0].length)
      .setValues(newRowsToAppend);
  }

  return { dateHeader, updated, added };
}

// ---------------------------------------------------------------------------
// 2. Divergence check: 2026 vs 30D Check
// ---------------------------------------------------------------------------
function runDivergenceCheck(ss) {
  const main = ss.getSheetByName(SHEET_2026);
  const check = ss.getSheetByName(SHEET_30D);
  if (!main) throw new Error("Tab not found: " + SHEET_2026);
  if (!check) throw new Error("Tab not found: " + SHEET_30D);

  const mainData = main.getDataRange().getValues();
  const checkData = check.getDataRange().getValues();

  const mainDateCols = headerDateColumns_(mainData[0]);
  const checkDateCols = headerDateColumns_(checkData[0]);

  // Overlap dates (both tabs have them).
  const overlapDates = [];
  for (const [d] of checkDateCols) {
    if (mainDateCols.has(d)) overlapDates.push(d);
  }
  overlapDates.sort();

  const mainMap = buildAdDateMap_(mainData, mainDateCols);
  const checkMap = buildAdDateMap_(checkData, checkDateCols);

  const flags = [
    ["Ad name", "Date", "2026 spend", "30D Check spend", "Abs diff", "% diff"],
  ];
  let overlapCells = 0;
  const allNames = new Set([...mainMap.keys(), ...checkMap.keys()]);
  for (const date of overlapDates) {
    for (const name of allNames) {
      const a = (mainMap.get(name) || {})[date] || 0;
      const b = (checkMap.get(name) || {})[date] || 0;
      if (a === 0 && b === 0) continue;
      overlapCells++;
      const absDiff = Math.abs(a - b);
      const pctDiff = absDiff / Math.max(Math.abs(a), Math.abs(b), 1e-9);
      if (absDiff >= DIVERGENCE_ABS_THRESHOLD && pctDiff >= DIVERGENCE_PCT_THRESHOLD) {
        flags.push([
          name,
          date,
          a,
          b,
          Number(absDiff.toFixed(2)),
          Number((pctDiff * 100).toFixed(1)),
        ]);
      }
    }
  }

  let flagsTab = ss.getSheetByName(SHEET_FLAGS);
  if (!flagsTab) flagsTab = ss.insertSheet(SHEET_FLAGS);
  flagsTab.clear();
  flagsTab.getRange(1, 1, flags.length, flags[0].length).setValues(flags);
  flagsTab.getRange(1, 1, 1, flags[0].length).setFontWeight("bold");
  if (flags.length === 1) {
    flagsTab
      .getRange(2, 1)
      .setValue(
        "OK as of " +
          new Date().toISOString() +
          " — " +
          overlapCells +
          " overlap cells compared, 0 flagged."
      );
  }
  flagsTab.setFrozenRows(1);

  return { flaggedCount: flags.length - 1, overlapCells };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function headerDateColumns_(headerRow) {
  // Returns Map<YYYY-MM-DD string, 0-based column index>
  const m = new Map();
  for (let c = 2; c < headerRow.length; c++) {
    const s = formatDateCell_(headerRow[c]);
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) m.set(s, c);
  }
  return m;
}

function buildAdDateMap_(data, dateColMap) {
  // Returns Map<adName, {YYYY-MM-DD: number}>.
  // Sums across duplicate-name rows just in case (defensive).
  const m = new Map();
  for (let r = 1; r < data.length; r++) {
    const name = String(data[r][0] || "").trim();
    if (!name) continue;
    let byDate = m.get(name);
    if (!byDate) {
      byDate = {};
      m.set(name, byDate);
    }
    for (const [date, col] of dateColMap) {
      const v = data[r][col];
      if (v === "" || v === null || v === undefined) continue;
      const n = Number(v);
      if (Number.isFinite(n)) byDate[date] = (byDate[date] || 0) + n;
    }
  }
  return m;
}

function formatDateCell_(v) {
  // Apps Script may return date cells as JS Date objects, strings, or
  // numbers (serial). Normalize to YYYY-MM-DD in the spreadsheet's
  // timezone so comparisons work across all three.
  if (v instanceof Date) {
    return Utilities.formatDate(
      v,
      SpreadsheetApp.getActive().getSpreadsheetTimeZone(),
      "yyyy-MM-dd"
    );
  }
  return String(v || "").trim();
}
