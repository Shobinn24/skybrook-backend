// FB Ads Tracker diagnostic — pulls the live "FB Ads Tracker" sheet
// (Sheet7 of FB_ADS_SHEET_ID) and reports:
//   1. Date-column coverage (first, last, gaps, total column count)
//   2. Per-day spend totals for the last 30 days
//   3. 7D + 30D rollups
//
// Run from skybrook/: node scripts/diag_fb_ads_tracker.mjs
import { google } from "googleapis";
import "dotenv/config";

const sheetId = process.env.FB_ADS_SHEET_ID;
if (!sheetId) {
  console.error("Set FB_ADS_SHEET_ID in your local .env");
  process.exit(1);
}
const tab = process.env.FB_ADS_TAB_NAME?.trim() || "Sheet7";

const json = process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
const file = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
const scopes = ["https://www.googleapis.com/auth/spreadsheets.readonly"];
const sheets = json
  ? google.sheets({
      version: "v4",
      auth: new google.auth.GoogleAuth({ credentials: JSON.parse(json), scopes }),
    })
  : google.sheets({
      version: "v4",
      auth: new google.auth.GoogleAuth({ keyFile: file, scopes }),
    });

const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
console.log("Sheet:", meta.data.properties?.title, "| tab:", tab);
console.log("Pulled:", new Date().toISOString(), "(UTC)\n");

// Pull WIDE — go past A:EZ in case the sheet has grown.
const resp = await sheets.spreadsheets.values.get({
  spreadsheetId: sheetId,
  range: `'${tab}'!A1:ZZ`,
});
const grid = resp.data.values ?? [];
console.log(`Rows pulled: ${grid.length}`);
console.log(`Cols in header: ${grid[0]?.length ?? 0}\n`);

const header = (grid[0] ?? []).map((c) => String(c ?? "").trim());
const dateCols = [];
for (let c = 2; c < header.length; c++) {
  const h = header[c];
  if (/^\d{4}-\d{2}-\d{2}$/.test(h)) dateCols.push({ colIdx: c, date: h });
}
console.log(`Date columns found: ${dateCols.length}`);
if (dateCols.length === 0) {
  console.error("No date columns in header — Supermetrics push may be broken.");
  process.exit(2);
}
const first = dateCols[0];
const last = dateCols[dateCols.length - 1];
console.log(`First date: ${first.date} (col ${first.colIdx})`);
console.log(`Last date:  ${last.date} (col ${last.colIdx})\n`);

// Gap detection: do any consecutive date columns differ by >1 day?
const gaps = [];
for (let i = 1; i < dateCols.length; i++) {
  const a = new Date(`${dateCols[i - 1].date}T00:00:00Z`).getTime();
  const b = new Date(`${dateCols[i].date}T00:00:00Z`).getTime();
  const days = Math.round((b - a) / 86_400_000);
  if (days !== 1) gaps.push({ from: dateCols[i - 1].date, to: dateCols[i].date, days });
}
if (gaps.length > 0) {
  console.log("Date gaps detected:");
  for (const g of gaps) console.log(`  ${g.from} → ${g.to} (${g.days}d gap)`);
  console.log("");
}

// Per-day spend totals (sum across all ad rows) for the last 30 dates.
const lastN = dateCols.slice(-30);
console.log("Per-day TOTAL spend (last 30 dates in sheet):");
const dailyTotals = [];
for (const { colIdx, date } of lastN) {
  let sum = 0;
  let rowsWithValue = 0;
  for (let r = 1; r < grid.length; r++) {
    const raw = String(grid[r]?.[colIdx] ?? "").trim();
    if (!raw) continue;
    const n = Number(raw.replace(/[$,]/g, ""));
    if (Number.isFinite(n) && n > 0) {
      sum += n;
      rowsWithValue++;
    }
  }
  dailyTotals.push({ date, sum, rowsWithValue });
  console.log(`  ${date}  $${sum.toFixed(2).padStart(11)}  (${rowsWithValue} ads)`);
}

const total7 = dailyTotals.slice(-7).reduce((s, d) => s + d.sum, 0);
const total30 = dailyTotals.reduce((s, d) => s + d.sum, 0);
console.log("");
console.log(`7D total  : $${total7.toFixed(2)}`);
console.log(`30D total : $${total30.toFixed(2)}`);
console.log("");
console.log("Compare these against the FB ad account UI for the same date range.");
console.log("If they DIFFER materially → Supermetrics push is wrong (attribution,");
console.log("currency, or tz mismatch). If they MATCH but Skybrook /performance");
console.log("disagrees, it's a Skybrook ingest issue (re-pull + re-parse).");
