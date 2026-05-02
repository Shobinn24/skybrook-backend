// velocity_recheck.mjs
// Re-do the sheet-vs-Skybrook velocity reconciliation correctly.
// The previous compare.mjs only summed col D (US block) of the velocity
// sheet, then compared against Skybrook's US + INTL total. That made
// every SKU look ~1.6x off. The sheet has US in cols D-N and INTL in
// cols P-Z (header row 1: "EV Main" at col D, "EV INTL" at col P).
//
// This script reads BOTH blocks per SKU, sums 4 weekly blocks (~28 days),
// and compares to Skybrook's 30d daily_sales totals (~30 days). A small
// residual gap from the 28d/30d window mismatch is expected (~7%); if the
// ratio is much further from 1.0 there's a real bug.

import { google } from "googleapis";
import "dotenv/config";

const VELOCITY_SHEET = "1ra1vvx_43oIWJN1ZonV0Nd_WpNgxCYpARasuWYmybAQ";
const APP_URL = "https://skybrook-backend-production.up.railway.app";

function buildClient() {
  const json = process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
  const file = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  const scopes = ["https://www.googleapis.com/auth/spreadsheets.readonly"];
  if (json) return google.sheets({ version: "v4", auth: new google.auth.GoogleAuth({ credentials: JSON.parse(json), scopes }) });
  return google.sheets({ version: "v4", auth: new google.auth.GoogleAuth({ keyFile: file, scopes }) });
}

// Mirror lib/domain/sku-pack.ts canonicalization (dash→x for 1/5-pack
// tokens, trailing -2xl → -xxl) so sheet SKUs match Skybrook's stored form.
function canonicalize(raw) {
  if (!raw) return "";
  let s = String(raw).trim().toLowerCase();
  s = s.replace(/^(ev-[a-z0-9]+(?:-hf)?(?:-fc)?(?:-[a-z]+)*)-1-/, "$1-1x-");
  s = s.replace(/^(ev-[a-z0-9]+(?:-hf)?(?:-fc)?(?:-[a-z]+)*)-5-/, "$1-5x-");
  s = s.replace(/(^|-)2xl$/, "$1xxl");
  return s;
}

const sheets = buildClient();

// 1) Pull EV Main A:Z (covers both US block D-N + INTL block P-Z)
console.log("Pulling EV Main!A1:Z7400 ...");
const rows = (await sheets.spreadsheets.values.get({
  spreadsheetId: VELOCITY_SHEET,
  range: "EV Main!A1:Z7400",
  valueRenderOption: "UNFORMATTED_VALUE",
})).data.values ?? [];
console.log(`  got ${rows.length} rows`);

// Walk weekly blocks. Date marker: col A starts with "\d{1,2}\s*-".
// Inside a week block, SKU rows have col C (idx 2) = SKU.
// US qty in col D (idx 3), INTL qty in col P (idx 15).
const FOUR_WEEK_LIMIT = 4;
let weekCounter = 0;
let weekLabel = null;
let inWeek = false;
const acc = new Map(); // sku → { us, intl }
const weekLabels = [];

for (const row of rows) {
  const a = String(row[0] ?? "").trim();
  const c = String(row[2] ?? "").trim();
  const usQty = Number(row[3]);
  const intlQty = Number(row[15]);
  if (/^\s*\d{1,2}\s*-/.test(a)) {
    weekCounter++;
    if (weekCounter > FOUR_WEEK_LIMIT) break;
    weekLabel = a;
    weekLabels.push(weekLabel);
    inWeek = true;
    continue;
  }
  if (!inWeek) continue;
  if (!c.toLowerCase().startsWith("ev-")) continue;
  const sku = canonicalize(c);
  if (!sku) continue;
  const cur = acc.get(sku) ?? { us: 0, intl: 0 };
  if (Number.isFinite(usQty)) cur.us += usQty;
  if (Number.isFinite(intlQty)) cur.intl += intlQty;
  acc.set(sku, cur);
}
console.log(`  weeks read: ${weekCounter > FOUR_WEEK_LIMIT ? FOUR_WEEK_LIMIT : weekCounter} → ${weekLabels.join(" | ")}`);
console.log(`  unique SKUs aggregated: ${acc.size}`);

// 2) Hit Skybrook /api/admin/data-snapshot
const cronSecret = process.env.CRON_SECRET?.trim();
if (!cronSecret) {
  console.error("CRON_SECRET missing in env");
  process.exit(1);
}
console.log(`\nFetching ${APP_URL}/api/admin/data-snapshot ...`);
const res = await fetch(`${APP_URL}/api/admin/data-snapshot`, {
  headers: { Authorization: `Bearer ${cronSecret}` },
});
if (!res.ok) {
  const body = await res.text();
  console.error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
  process.exit(1);
}
const snap = await res.json();
console.log(`  asOf=${snap.asOf}, dailyTotals30d=${snap.counts.dailyTotals30d}`);

const skyByCh = new Map();
for (const d of snap.dailyTotals30d) {
  skyByCh.set(`${d.sku.toLowerCase()}|${d.channel}`, Number(d.units_sold) || 0);
}
const skyDateRange = (() => {
  let earliest = null, latest = null;
  for (const d of snap.dailyTotals30d) {
    if (!earliest || d.earliest_date < earliest) earliest = d.earliest_date;
    if (!latest || d.latest_date > latest) latest = d.latest_date;
  }
  return { earliest, latest };
})();
console.log(`  sky daily_sales date range: ${skyDateRange.earliest} → ${skyDateRange.latest}`);

// 3) Reconciliation table
console.log("\n=== RECONCILIATION (sheet 4-wk vs Skybrook 30d, both US+INTL summed) ===");
console.log("SKU                                   sheet_us  sheet_in  sheet_to    sky_us  sky_intl  sky_tot   ratio  note");
console.log("─".repeat(120));

const rowsOut = [];
for (const [sku, sheetVal] of acc.entries()) {
  const skyUs = skyByCh.get(`${sku}|shopify_us`) ?? 0;
  const skyIntl = skyByCh.get(`${sku}|shopify_intl`) ?? 0;
  const sheetTot = sheetVal.us + sheetVal.intl;
  const skyTot = skyUs + skyIntl;
  const ratio = sheetTot > 0 ? skyTot / sheetTot : null;
  rowsOut.push({ sku, sheetUs: sheetVal.us, sheetIntl: sheetVal.intl, sheetTot, skyUs, skyIntl, skyTot, ratio });
}

// Print top 30 by sheet total
rowsOut.sort((a, b) => b.sheetTot - a.sheetTot);
for (const r of rowsOut.slice(0, 30)) {
  const ratioStr = r.ratio == null ? "  -" : r.ratio.toFixed(2);
  console.log(`${r.sku.padEnd(38)} ${String(r.sheetUs).padStart(8)} ${String(r.sheetIntl).padStart(9)} ${String(r.sheetTot).padStart(9)}  ${String(r.skyUs).padStart(8)} ${String(r.skyIntl).padStart(9)} ${String(r.skyTot).padStart(8)}  ${ratioStr.padStart(6)}`);
}

// Aggregate stats across ALL skus with sheetTot >= 5 (filter noise)
const meaningful = rowsOut.filter(r => r.sheetTot >= 5);
const totalSheet = meaningful.reduce((s, r) => s + r.sheetTot, 0);
const totalSky = meaningful.reduce((s, r) => s + r.skyTot, 0);
const totalSheetUs = meaningful.reduce((s, r) => s + r.sheetUs, 0);
const totalSkyUs = meaningful.reduce((s, r) => s + r.skyUs, 0);
const totalSheetIntl = meaningful.reduce((s, r) => s + r.sheetIntl, 0);
const totalSkyIntl = meaningful.reduce((s, r) => s + r.skyIntl, 0);

console.log("\n=== AGGREGATE (SKUs with sheet 4-wk total >= 5 units) ===");
console.log(`  SKUs:              ${meaningful.length}`);
console.log(`  sheet US total:    ${totalSheetUs.toLocaleString()}`);
console.log(`  sheet INTL total:  ${totalSheetIntl.toLocaleString()}`);
console.log(`  sheet GRAND total: ${totalSheet.toLocaleString()}`);
console.log(`  sky US total:      ${totalSkyUs.toLocaleString()}`);
console.log(`  sky INTL total:    ${totalSkyIntl.toLocaleString()}`);
console.log(`  sky GRAND total:   ${totalSky.toLocaleString()}`);
console.log(`  US ratio sky/sheet:    ${(totalSkyUs / totalSheetUs).toFixed(3)}`);
console.log(`  INTL ratio sky/sheet:  ${(totalSkyIntl / totalSheetIntl).toFixed(3)}`);
console.log(`  GRAND ratio sky/sheet: ${(totalSky / totalSheet).toFixed(3)}`);

// Outliers — sky=0 but sheet>0 (missing entirely), or ratio extreme
const skyZero = rowsOut.filter(r => r.sheetTot >= 10 && r.skyTot === 0);
console.log(`\n=== OUTLIERS — sheet >= 10 but Skybrook 0 (${skyZero.length}) ===`);
for (const r of skyZero.slice(0, 20)) {
  console.log(`  ${r.sku.padEnd(38)} sheet=${r.sheetTot}  (us=${r.sheetUs}, intl=${r.sheetIntl})`);
}

const lowRatio = rowsOut.filter(r => r.sheetTot >= 20 && r.ratio != null && r.ratio < 0.5);
console.log(`\n=== OUTLIERS — sheet >= 20 but ratio < 0.5 (${lowRatio.length}) ===`);
for (const r of lowRatio.slice(0, 20)) {
  console.log(`  ${r.sku.padEnd(38)} sheet=${r.sheetTot} sky=${r.skyTot} ratio=${r.ratio.toFixed(2)}`);
}

const highRatio = rowsOut.filter(r => r.sheetTot >= 20 && r.ratio != null && r.ratio > 2);
console.log(`\n=== OUTLIERS — sheet >= 20 but ratio > 2 (${highRatio.length}) ===`);
for (const r of highRatio.slice(0, 20)) {
  console.log(`  ${r.sku.padEnd(38)} sheet=${r.sheetTot} sky=${r.skyTot} ratio=${r.ratio.toFixed(2)}`);
}
