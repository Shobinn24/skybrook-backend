// Daily-check helper: landed-cost backlog + live-sheet progress.
//
// Reports two things:
//   (1) DB side  — active SKUs still missing unit_cost_usd AFTER the
//       nightly sync + fc/size mirror passes ran. This is the count that
//       drives the `factory_orders.active_skus_missing_cost` health fail
//       (and keeps `overall:fail` red while the backlog is non-zero).
//   (2) Sheet side — pulls the LIVE EVSKUmap cost sheet and reports how
//       many of those still-missing SKUs are now priced on the sheet
//       (so they will clear on the next cron sync) vs genuinely unpriced.
//       Honors the standing cross-reference-the-live-sheet mandate: the
//       DB only mirrors the sheet as of the last ingest.
//
// Run against PROD:
//   DATABASE_URL=<public url> EVERDRIES_COST_SHEET_ID=15ycRH-u43kWMGb52PGGpBu_2v6iDH39RJUPUFfkh9YA \
//     node_modules/.bin/tsx scripts/check_grace_costs.ts
//
// The live-sheet cross-ref needs GOOGLE_APPLICATION_CREDENTIALS (or
// GOOGLE_SERVICE_ACCOUNT_JSON) for the read-only Sheets pull; without it
// the script still prints the DB backlog and skips part (2).
import "dotenv/config";
import { google } from "googleapis";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { skus } from "@/lib/db/schema";
import { parseCostSheetRows } from "@/lib/jobs/unit-costs";

const COST_RANGE = "EVSKUmap!A1:Z2070";

function buildSheetsClient() {
  const scopes = ["https://www.googleapis.com/auth/spreadsheets.readonly"];
  const json = process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
  const file = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  if (json) {
    return google.sheets({
      version: "v4",
      auth: new google.auth.GoogleAuth({ credentials: JSON.parse(json), scopes }),
    });
  }
  if (file) {
    return google.sheets({
      version: "v4",
      auth: new google.auth.GoogleAuth({ keyFile: file, scopes }),
    });
  }
  return null;
}

// Group by product-line prefix for a scannable summary (ev-cottonhip-... -> cottonhip).
function lineOf(sku: string): string {
  const m = sku.match(/^ev-([a-z0-9]+)/i);
  return m ? m[1] : sku;
}

async function main() {
  const missing = await db
    .select({ sku: skus.sku })
    .from(skus)
    .where(and(eq(skus.active, true), isNull(skus.unitCostUsd)));
  const missingSkus = missing.map((m) => m.sku).sort();

  console.log(`Active SKUs missing unit_cost_usd (DB, post-sync): ${missingSkus.length}`);
  if (missingSkus.length === 0) {
    console.log("All active SKUs priced -> factory_orders.active_skus_missing_cost should PASS.");
    return;
  }

  const byLine = new Map<string, number>();
  for (const s of missingSkus) byLine.set(lineOf(s), (byLine.get(lineOf(s)) ?? 0) + 1);
  console.log("By line: " + [...byLine.entries()].map(([k, v]) => `${k}=${v}`).join(", "));

  const sheetId = process.env.EVERDRIES_COST_SHEET_ID;
  const client = sheetId ? buildSheetsClient() : null;
  if (!sheetId || !client) {
    console.log(
      "\n(Skipping live-sheet cross-ref: set EVERDRIES_COST_SHEET_ID + " +
        "GOOGLE_APPLICATION_CREDENTIALS to see the sheet vs DB delta.)"
    );
    return;
  }

  const r = await client.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: COST_RANGE,
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  const parsed = parseCostSheetRows((r.data.values ?? []) as unknown[][]);
  const pricedOnSheet = new Set(parsed.rows.map((x) => x.sku));

  const nowPriced = missingSkus.filter((s) => pricedOnSheet.has(s));
  const stillUnpriced = missingSkus.filter((s) => !pricedOnSheet.has(s));

  console.log(`\nLive EVSKUmap latest cost column: ${parsed.latestColumn.dateLabel || "(none)"}`);
  console.log(
    `Of ${missingSkus.length} missing, now priced on live sheet (clears next sync): ${nowPriced.length}`
  );
  if (nowPriced.length) console.log("  " + nowPriced.join(", "));
  console.log(`Still unpriced on live sheet (true Grace backlog): ${stillUnpriced.length}`);
  if (stillUnpriced.length) console.log("  " + stillUnpriced.join(", "));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
