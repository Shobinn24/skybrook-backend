// Append the two missing FB URL -> product rows to the Jasper-maintained
// product map sheet (Shobinn 2026-07-14: cotton -> Cotton 9055, mens-brief
// -> Mens Brief). Reads the sheet first: verifies the header shape and skips
// any URL already present, so it is safe to re-run.
import { google } from "googleapis";

const sheetId = process.env.FB_PRODUCT_MAP_SHEET_ID?.trim();
const tab = process.env.FB_PRODUCT_MAP_TAB_NAME?.trim() || "Sheet1";
if (!sheetId) throw new Error("missing FB_PRODUCT_MAP_SHEET_ID");

const auth = new google.auth.GoogleAuth({
  keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

const NEW_ROWS = [
  ["https://shop.everdries.com/cotton", "INTL", "Cotton 9055"],
  ["https://shop.everdries.com/mens-brief", "INTL", "Mens Brief"],
];

const grid = (
  await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: `${tab}!A:C` })
).data.values ?? [];
const header = (grid[0] ?? []).map((c) => String(c).trim().toLowerCase());
if (header[0] !== "url") throw new Error(`unexpected header: ${JSON.stringify(grid[0])}`);
console.log(`sheet ok: ${grid.length - 1} data rows, header ${JSON.stringify(grid[0])}`);

const existing = new Set(
  grid.slice(1).map((r) => String(r[0] ?? "").trim().toLowerCase().replace(/\/+$/, "")),
);
const toAdd = NEW_ROWS.filter(
  (r) => !existing.has(r[0].toLowerCase()) && !existing.has(r[0].toLowerCase().replace("https://", "")),
);
if (toAdd.length === 0) {
  console.log("both URLs already present, nothing to do");
  process.exit(0);
}

const res = await sheets.spreadsheets.values.append({
  spreadsheetId: sheetId,
  range: `${tab}!A:C`,
  valueInputOption: "RAW",
  requestBody: { values: toAdd },
});
console.log(`appended ${toAdd.length} rows at ${res.data.updates?.updatedRange}`);
for (const r of toAdd) console.log("  +", r.join(" | "));
