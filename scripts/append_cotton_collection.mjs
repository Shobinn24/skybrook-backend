// Append the cotton-collection FB URL -> product row to the Jasper-maintained
// product map sheet (Jasper 2026-08-04: cotton-collection -> Cotton 9055 "for
// now"). Reads the sheet first: verifies the header shape and skips the URL if
// already present, so it is safe to re-run.
import { google } from "googleapis";

const sheetId = process.env.FB_PRODUCT_MAP_SHEET_ID?.trim();
const tab = process.env.FB_PRODUCT_MAP_TAB_NAME?.trim() || "Sheet1";
if (!sheetId) throw new Error("missing FB_PRODUCT_MAP_SHEET_ID");

const auth = new google.auth.GoogleAuth({
  keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

const NEW_ROWS = [["https://shop.everdries.com/cotton-collection", "INTL", "Cotton 9055"]];

const grid = (
  await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: `${tab}!A:C` })
).data.values ?? [];
const header = (grid[0] ?? []).map((c) => String(c).trim().toLowerCase());
if (header[0] !== "url") throw new Error(`unexpected header: ${JSON.stringify(grid[0])}`);
console.log(`sheet ok: ${grid.length - 1} data rows, header ${JSON.stringify(grid[0])}`);

const norm = (s) => String(s ?? "").trim().toLowerCase().replace(/\/+$/, "").replace(/^https?:\/\//, "");
const existing = new Set(grid.slice(1).map((r) => norm(r[0])));
const toAdd = NEW_ROWS.filter((r) => !existing.has(norm(r[0])));
if (toAdd.length === 0) {
  console.log("URL already present, nothing to do");
  process.exit(0);
}

const res = await sheets.spreadsheets.values.append({
  spreadsheetId: sheetId,
  range: `${tab}!A:C`,
  valueInputOption: "RAW",
  requestBody: { values: toAdd },
});
console.log(`appended ${toAdd.length} row(s) at ${res.data.updates?.updatedRange}`);
for (const r of toAdd) console.log("  +", r.join(" | "));
