// One-time DB import of a frozen FB Ads history tab into
// `fb_ad_spend_daily`. Insulated from later sheet edits: once a year's
// chunk is in the DB it survives even if the source tab is clobbered
// (the 2026-05-26 lesson — the daily-merge approach was too fragile).
//
// The daily cron only refreshes the live window (spend_date >= the live
// tab's min date — see lib/sources/sheets.ts), so these pre-2026 rows
// are never touched by it. This import is purely ADDITIVE: it upserts
// on (ad_number, spend_date) and never deletes, so it can't disturb the
// current-year rows the cron owns.
//
// Run (against PROD — set DATABASE_URL to the Railway public URL):
//   pnpm tsx scripts/import_fb_history_to_db.ts --dry-run "Sheet6_2024_h1"
//   pnpm tsx scripts/import_fb_history_to_db.ts --apply   "Sheet6_2024_h1" "Sheet6_2024_h2"
//
// Idempotent: re-running the same tab upserts the same rows.
import "dotenv/config";
import { randomUUID, createHash } from "node:crypto";
import { google } from "googleapis";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { fbAdSpendDaily, rawPulls } from "@/lib/db/schema";
import { parseFbAdsSheet } from "@/lib/sources/sheets";
import { extractMarketers } from "@/lib/domain/fb-marketers";

// ON CONFLICT ... DO UPDATE SET col = excluded.col
function sqlExcluded(col: string) {
  return sql.raw(`excluded.${col}`);
}

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const dryRun = args.includes("--dry-run") || !apply;
const tabs = args.filter((a) => !a.startsWith("--"));

if (tabs.length === 0) {
  console.error('Usage: pnpm tsx scripts/import_fb_history_to_db.ts [--dry-run|--apply] "<tab>" ["<tab>"...]');
  process.exit(1);
}

function buildSheets() {
  const json = process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
  const file = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  const scopes = ["https://www.googleapis.com/auth/spreadsheets.readonly"];
  if (json)
    return google.sheets({ version: "v4", auth: new google.auth.GoogleAuth({ credentials: JSON.parse(json), scopes }) });
  if (file)
    return google.sheets({ version: "v4", auth: new google.auth.GoogleAuth({ keyFile: file, scopes }) });
  throw new Error("Set GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS");
}

async function importTab(sheets: ReturnType<typeof buildSheets>, sheetId: string, tab: string) {
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `'${tab}'!A1:AZZ`,
  });
  const grid = (resp.data.values ?? []) as unknown[][];
  if (grid.length === 0) throw new Error(`${tab}: empty range`);

  // History tabs leave A1 blank (the "Ad name" label only lives on the
  // live tab). parseFbAdsSheet hard-requires header[0] === "Ad name" and
  // header[1] to contain "promoted post". Inject the label so we reuse
  // the EXACT prod parse/aggregate/canonical-name path; bail loudly if
  // B1 doesn't look like the link column (guards against a shifted grid).
  const b1 = String(grid[0]?.[1] ?? "");
  if (!/promoted post/i.test(b1))
    throw new Error(`${tab}: B1 is ${JSON.stringify(b1)}, expected the "Link to promoted post" column — refusing to import a misaligned tab`);
  grid[0][0] = "Ad name";

  const { aggregated, skipped } = parseFbAdsSheet(grid);
  if (aggregated.length === 0)
    throw new Error(`${tab}: parsed 0 ads (skipped ${skipped.length}) — refusing to import`);

  // Date sanity: confirm the tab actually holds the year we think it
  // does, not a reverted 2023 range.
  const allDates = aggregated.flatMap((a) => a.dailySpend.map((d) => d.spendDate)).sort();
  const minDate = allDates[0];
  const maxDate = allDates[allDates.length - 1];
  const years = [...new Set(allDates.map((d) => d.slice(0, 4)))].sort();
  const total = aggregated.reduce((s, a) => s + a.dailySpend.reduce((ss, d) => ss + d.costUsd, 0), 0);

  // Refuse to import a tab whose dates don't match the year/half encoded
  // in its name (Sheet6_2024_h1 → 2024 Jan–Jun, Sheet6_2023 → all 2023).
  // The frozen history tabs have silently reverted to a 2023 date range
  // before (2026-05-26) — this turns that into a hard failure instead of
  // a silent double-count.
  const m = tab.match(/_(\d{4})(?:_h([12]))?\b/);
  if (m) {
    const wantYear = m[1];
    const half = m[2]; // "1" | "2" | undefined
    const bad = allDates.filter((d) => {
      if (d.slice(0, 4) !== wantYear) return true;
      if (!half) return false;
      const mo = Number(d.slice(5, 7));
      return half === "1" ? mo > 6 : mo < 7;
    });
    if (bad.length > 0)
      throw new Error(
        `${tab}: ${bad.length} date(s) outside the expected window (got years ${years.join(",")}, ` +
          `e.g. ${bad.slice(0, 3).join(", ")}). Tab may have reverted — re-pull it. Refusing to import.`,
      );
  }

  // Flatten to rows.
  const rows: Array<typeof fbAdSpendDaily.$inferInsert & { spendDate: string }> = [];
  for (const ad of aggregated) {
    const marketers = extractMarketers(ad.adNameRaw);
    for (const d of ad.dailySpend) {
      rows.push({
        adNumber: ad.adNumber,
        adName: ad.adName,
        adNameRaw: ad.adNameRaw,
        adLink: ad.adLink,
        marketers,
        spendDate: d.spendDate,
        costUsd: d.costUsd.toString(),
        sourcePullId: "", // filled at apply time
      });
    }
  }

  console.log(`\n── ${tab} ──`);
  console.log(`  ads: ${aggregated.length}  rows: ${rows.length}  skipped: ${skipped.length}`);
  console.log(`  dates: ${minDate} → ${maxDate}  years: ${years.join(",")}`);
  console.log(`  total spend: $${total.toLocaleString(undefined, { maximumFractionDigits: 2 })}`);

  if (dryRun) {
    console.log(`  [dry-run] would upsert ${rows.length} rows`);
    return { tab, rows: rows.length };
  }

  // Create a raw_pulls provenance row, then upsert the daily rows.
  await db.transaction(async (tx) => {
    const pullBatchId = randomUUID();
    const fingerprint = createHash("sha256").update(`history-import:${tab}`).digest("hex").slice(0, 16);
    const [pull] = await tx
      .insert(rawPulls)
      .values({
        source: "sheets_fb_ads",
        pullBatchId,
        payload: { import: "fb_history_db_import", tab, minDate, maxDate, ads: aggregated.length, rows: rows.length, total },
        rowCount: rows.length,
        schemaFingerprint: fingerprint,
      })
      .returning({ id: rawPulls.id });

    const CHUNK = 1000;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const slice = rows.slice(i, i + CHUNK).map((r) => ({ ...r, sourcePullId: pull.id }));
      await tx
        .insert(fbAdSpendDaily)
        .values(slice)
        .onConflictDoUpdate({
          target: [fbAdSpendDaily.adNumber, fbAdSpendDaily.spendDate],
          set: {
            adName: sqlExcluded("ad_name"),
            adNameRaw: sqlExcluded("ad_name_raw"),
            adLink: sqlExcluded("ad_link"),
            marketers: sqlExcluded("marketers"),
            costUsd: sqlExcluded("cost_usd"),
            sourcePullId: sqlExcluded("source_pull_id"),
          },
        });
    }
  });
  console.log(`  [applied] upserted ${rows.length} rows`);
  return { tab, rows: rows.length };
}

async function main() {
  const sheetId = process.env.FB_ADS_SHEET_ID;
  if (!sheetId) throw new Error("Set FB_ADS_SHEET_ID");
  console.log(`Mode: ${apply ? "APPLY (writing to DB)" : "DRY-RUN"}`);
  console.log(`DB: ${process.env.DATABASE_URL?.replace(/:\/\/[^@]*@/, "://***@")}`);
  const sheets = buildSheets();
  let totalRows = 0;
  for (const tab of tabs) {
    const r = await importTab(sheets, sheetId, tab);
    totalRows += r.rows;
  }
  console.log(`\nDone. ${apply ? "Upserted" : "Would upsert"} ${totalRows} rows across ${tabs.length} tab(s).`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
