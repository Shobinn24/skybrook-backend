// Smoke: fetch real Incoming_new tab w/ default FORMATTED_VALUE, run the
// production parser, report stats.
import { google } from "googleapis";
import "dotenv/config";

const id = process.env.INCOMING_PO_SHEET_ID || "1NaDU--HYArFYWOeACV0LQm4dc67zNQEqT27t_-k_7SI";
const json = process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
const file = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
const scopes = ["https://www.googleapis.com/auth/spreadsheets.readonly"];
const sheets = json
  ? google.sheets({ version: "v4", auth: new google.auth.GoogleAuth({ credentials: JSON.parse(json), scopes }) })
  : google.sheets({ version: "v4", auth: new google.auth.GoogleAuth({ keyFile: file, scopes }) });

const r = await sheets.spreadsheets.values.get({ spreadsheetId: id, range: `'Incoming_new'!A1:AG400` });
const grid = r.data.values ?? [];
console.log(`Fetched grid: ${grid.length} rows`);

// Inline copy of the parser logic — node can't import the TS module directly.
function findHeaderRowByColC(grid, label) {
  const target = label.trim().toUpperCase();
  const limit = Math.min(grid.length, 30);
  for (let i = 0; i < limit; i++) {
    if (String(grid[i]?.[2] ?? "").trim().toUpperCase() === target) return i;
  }
  return -1;
}
function findIntlBoundaryInGrid(grid, maxRowExclusive) {
  const stop = Math.min(grid.length, Math.max(maxRowExclusive, 0));
  for (let r = 0; r < stop; r++) {
    const row = grid[r] ?? [];
    for (let c = 0; c < row.length; c++) {
      const v = String(row[c] ?? "").trim().toUpperCase();
      if (v === "INTL" || v === "INTERNATIONAL") return c;
    }
  }
  return Number.POSITIVE_INFINITY;
}
function pickArrivalDate(cell) {
  const s = String(cell ?? "");
  const re = /(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})/g;
  const M = { jan:1, january:1, feb:2, february:2, mar:3, march:3, apr:4, april:4, may:5, jun:6, june:6, jul:7, july:7, aug:8, august:8, sep:9, sept:9, september:9, oct:10, october:10, nov:11, november:11, dec:12, december:12 };
  const out = [];
  let m;
  while ((m = re.exec(s)) !== null) {
    const day = Number(m[1]);
    const month = M[m[2].toLowerCase()];
    const year = Number(m[3]);
    if (!month || day < 1 || day > 31) continue;
    out.push(`${year}-${String(month).padStart(2,"0")}-${String(day).padStart(2,"0")}`);
  }
  return out.length ? out.reduce((a,b) => a > b ? a : b) : null;
}
function parseQty(cell) {
  if (cell == null || cell === "") return null;
  const s = String(cell).replace(/,/g, "").trim();
  if (s === "" || s === "-") return null;
  const n = Number(s);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

const labelRowIdx = findHeaderRowByColC(grid, "SHIPMENT NAME");
const arrivalRowIdx = findHeaderRowByColC(grid, "ESTIMATED ARRIVAL");
const totalRowIdx = findHeaderRowByColC(grid, "Total");
console.log(`Header row indices: SHIPMENT NAME=${labelRowIdx}, ESTIMATED ARRIVAL=${arrivalRowIdx}, Total=${totalRowIdx}`);

if (labelRowIdx < 0 || arrivalRowIdx < 0 || totalRowIdx < 0) {
  console.error("LAYOUT ERROR — header rows not all found");
  process.exit(1);
}

const labelRow = grid[labelRowIdx] ?? [];
const arrivalRow = grid[arrivalRowIdx] ?? [];
const intlBoundary = findIntlBoundaryInGrid(grid, totalRowIdx + 1);
console.log(`INTL boundary col: ${intlBoundary === Infinity ? "(none → all US)" : intlBoundary}`);

const poColumns = [];
const skipped = [];
for (let c = 3; c < labelRow.length; c++) {
  const label = String(labelRow[c] ?? "").trim();
  if (!label) continue;
  const destination = c >= intlBoundary ? "CN" : "US";
  const date = pickArrivalDate(arrivalRow[c]);
  if (!date) { skipped.push({ c, label, reason: String(arrivalRow[c] ?? "(empty)").slice(0,60) }); continue; }
  poColumns.push({ c, label, date, destination });
}
console.log(`PO columns parsed: ${poColumns.length}`);
console.log(`PO columns skipped: ${skipped.length}`);
console.log("\nFirst 10 PO columns:");
for (const p of poColumns.slice(0, 10)) console.log(`  col ${p.c}: ${p.destination} | "${p.label}" → ${p.date}`);
if (skipped.length) {
  console.log("\nSkipped columns:");
  for (const s of skipped) console.log(`  col ${s.c}: "${s.label}" reason: ${s.reason}`);
}

let rowCount = 0;
const sample = [];
for (let r = totalRowIdx + 1; r < grid.length; r++) {
  const row = grid[r] ?? [];
  const sku = String(row[2] ?? "").trim();
  if (!sku) continue;
  for (const po of poColumns) {
    const qty = parseQty(row[po.c]);
    if (qty === null || qty <= 0) continue;
    rowCount++;
    if (sample.length < 5) sample.push({ sku, dest: po.destination, name: po.label, qty, eta: po.date });
  }
}
console.log(`\nTotal incoming-shipment rows: ${rowCount}`);
console.log("Sample:");
for (const s of sample) console.log(`  ${s.sku} | ${s.dest} | ${s.name} | qty=${s.qty} | eta=${s.eta}`);
