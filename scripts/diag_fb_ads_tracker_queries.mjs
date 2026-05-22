// Dump the SupermetricsQueries metadata tab for FB Ads Tracker to see
// last-refresh state + any error returned by the Supermetrics scheduler.
import { google } from "googleapis";
import "dotenv/config";

const id = process.env.FB_ADS_SHEET_ID;
const json = process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
const file = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
const scopes = ["https://www.googleapis.com/auth/spreadsheets.readonly"];
const sheets = json
  ? google.sheets({ version: "v4", auth: new google.auth.GoogleAuth({ credentials: JSON.parse(json), scopes }) })
  : google.sheets({ version: "v4", auth: new google.auth.GoogleAuth({ keyFile: file, scopes }) });

const meta = await sheets.spreadsheets.get({ spreadsheetId: id });
console.log("Tabs in FB Ads Tracker sheet:");
for (const s of meta.data.sheets ?? []) {
  console.log(`  - ${s.properties?.title}`);
}
console.log("");

// Try the well-known Supermetrics metadata tab name.
const queriesTab = "SupermetricsQueries";
try {
  const r = await sheets.spreadsheets.values.get({
    spreadsheetId: id,
    range: `'${queriesTab}'!A1:AC50`,
  });
  const values = r.data.values ?? [];
  if (values.length === 0) {
    console.log("SupermetricsQueries tab is empty.");
  } else {
    console.log(`SupermetricsQueries header: ${JSON.stringify(values[0])}`);
    console.log("");
    for (let i = 1; i < values.length; i++) {
      console.log(`Row ${i}: ${JSON.stringify(values[i])}`);
    }
  }
} catch (e) {
  console.error("Couldn't read SupermetricsQueries tab:", e.message);
}
