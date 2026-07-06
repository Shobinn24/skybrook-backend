// One-time DB backfill of campaign-level FB history (2026-05-11 →) into
// `fb_campaign_daily` from CSV snapshots of the one-shot "Campaign
// Backfill" Supermetrics pulls (the interactive sidebar ScriptErrors on
// long ranges, so the backfill was pulled in chunks and snapshotted to
// CSV on 2026-07-06; the live tab only carries a rolling 14 days).
//
// Purely ADDITIVE: upserts on (campaign_name, spend_date) with
// DO NOTHING, so rows the daily cron already owns (the live window) are
// never disturbed — the cron's restated values win. Idempotent.
//
// Run (dev uses .env; for PROD set DATABASE_URL to the Railway public URL):
//   pnpm tsx scripts/backfill_campaign_daily.ts --dry-run file1.csv file2.csv …
//   pnpm tsx scripts/backfill_campaign_daily.ts --apply   file1.csv file2.csv …
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { fbCampaignDaily, rawPulls } from "@/lib/db/schema";
import { parseCampaignSheet } from "@/lib/sources/sheets";

function parseCsv(text: string): string[][] {
  // Snapshot format: every cell double-quoted, quotes doubled inside.
  return text
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => (l.match(/"((?:[^"]|"")*)"/g) ?? []).map((c) => c.slice(1, -1).replaceAll('""', '"')));
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const dryRun = args.includes("--dry-run");
  const files = args.filter((a) => !a.startsWith("--"));
  if ((!apply && !dryRun) || files.length === 0) {
    console.error("usage: pnpm tsx scripts/backfill_campaign_daily.ts (--dry-run|--apply) <csv…>");
    process.exit(1);
  }

  // Later files win on duplicate (campaign, date) across files, though the
  // snapshot chunks don't overlap by construction.
  const byKey = new Map<string, { campaignName: string; spendDate: string; costUsd: number; purchaseValueUsd: number }>();
  for (const f of files) {
    const grid = parseCsv(readFileSync(f, "utf8"));
    const { rows, skipped } = parseCampaignSheet(grid);
    if (skipped.length > 0) {
      console.error(`${f}: ${skipped.length} skipped rows`, skipped.slice(0, 5));
      process.exit(1);
    }
    for (const r of rows) byKey.set(`${r.campaignName}|${r.spendDate}`, r);
    console.log(`${f}: ${rows.length} rows`);
  }
  const rows = [...byKey.values()].sort((a, b) =>
    a.spendDate === b.spendDate ? a.campaignName.localeCompare(b.campaignName) : a.spendDate.localeCompare(b.spendDate),
  );
  const dates = rows.map((r) => r.spendDate);
  const total = rows.reduce((s, r) => s + r.costUsd, 0);
  console.log(
    `combined: ${rows.length} rows | ${new Set(rows.map((r) => r.campaignName)).size} campaigns | ` +
      `${dates[0]} → ${dates[dates.length - 1]} | total cost $${total.toFixed(2)}`,
  );

  if (!apply) {
    console.log("dry run — nothing written.");
    return;
  }

  const [raw] = await db
    .insert(rawPulls)
    .values({
      source: "sheets_fb_campaigns",
      pullBatchId: randomUUID(),
      payload: { backfill: true, files, rowCount: rows.length },
      rowCount: rows.length,
      schemaFingerprint: "backfill-csv-2026-07-06",
    })
    .returning({ id: rawPulls.id });

  let inserted = 0;
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK).map((r) => ({
      campaignName: r.campaignName,
      spendDate: r.spendDate,
      costUsd: r.costUsd.toFixed(4),
      purchaseValueUsd: r.purchaseValueUsd.toFixed(4),
      sourcePullId: raw.id,
    }));
    const res = await db.insert(fbCampaignDaily).values(chunk).onConflictDoNothing();
    inserted += res.length ?? 0;
  }

  const [{ count, min, max: maxDate }] = (await db.execute(
    sql`SELECT count(*)::int AS count, min(spend_date) AS min, max(spend_date) AS max FROM fb_campaign_daily`,
  )) as unknown as Array<{ count: number; min: string; max: string }>;
  console.log(`applied. table now: ${count} rows, ${min} → ${maxDate}`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
