// One-shot sweep of legacy SKU rows written under canonicalization rules
// that no longer apply. This logic used to run inside the inventory and
// Shopify ingest runners on EVERY cron (55+ DELETE statements per run);
// it has matched nothing for weeks, so it moved here (2026-06-10).
// Re-run after any future canonicalization-rule change:
//   npx tsx scripts/cleanup_legacy_sku_rows.ts          # dry run (counts)
//   npx tsx scripts/cleanup_legacy_sku_rows.ts --apply  # delete
//
// Covers:
//   - mixed-case SKUs (lowercased at parse since b89fbd6)
//   - dash-form pack tokens + the -2xl size alias on 1/5-pack SKUs
//     (canonicalized at parse since 9641126); 10/15-pack tokens are NOT
//     swept — the inventory parser intentionally leaves them undecomposed
//     and deleting them would re-insert/delete loop
//   - daily_sales legacy rows: mixed-case, non-`ev-`, decomposed pack
//     forms, bare-size hw 5x
//
// CAUTION on daily_sales: deleting is only correct for rows INSIDE the
// rolling re-pull window (the next ingest re-creates them under current
// rules). Rows older than the window are frozen history — deleting them
// is permanent loss; REMAP to the current canonical instead (see the
// 2026-06-10 og-5x -> ev-mixed merge-rename for the pattern).

import "dotenv/config";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { PACK_SKU_DB_PATTERNS } from "@/lib/domain/sku-pack";

const SKU_TABLES = [
  "stock_snapshots",
  "sales_velocity",
  "days_of_stock",
  "sustainability_flags",
  "skus",
];

const LEGACY_INVENTORY_PATTERNS = [
  "ev-%-1-%", "ev-%-5-%",         // dash-form pack tokens (1/5)
  "ev-mens-3-%", "ev-cb-3-%",     // dash-form 3-pack mens/cb
  "ev-hw-hf-3-%", "ev-og-hf-3-%", // dash-form 3-pack hw-hf/og-hf
  "ev-%-1x-2xl", "ev-%-5x-2xl",   // 2xl size alias on 1/5-pack SKUs
];

async function run(label: string, countSql: ReturnType<typeof sql>, deleteSql: ReturnType<typeof sql>, apply: boolean) {
  const rows = (await db.execute(countSql)) as unknown as Array<{ n: string | number }>;
  const n = Number(rows[0]?.n ?? 0);
  if (n === 0) return;
  console.log(`${label}: ${n} row(s)${apply ? " — deleting" : ""}`);
  if (apply) await db.execute(deleteSql);
}

async function main() {
  const apply = process.argv.includes("--apply");
  console.log(apply ? "APPLY mode" : "DRY RUN — pass --apply to delete");

  for (const t of SKU_TABLES) {
    await run(
      `${t} mixed-case`,
      sql.raw(`SELECT count(*) AS n FROM ${t} WHERE sku ~ '[A-Z]'`),
      sql.raw(`DELETE FROM ${t} WHERE sku ~ '[A-Z]'`),
      apply,
    );
    for (const p of LEGACY_INVENTORY_PATTERNS) {
      await run(
        `${t} LIKE ${p}`,
        sql.raw(`SELECT count(*) AS n FROM ${t} WHERE sku LIKE '${p}'`),
        sql.raw(`DELETE FROM ${t} WHERE sku LIKE '${p}'`),
        apply,
      );
    }
  }

  const dsConds = [
    `sku <> LOWER(sku)`,
    `sku NOT LIKE 'ev-%'`,
    `sku ~ '^ev-hw-5x-[^-]+$'`,
    ...PACK_SKU_DB_PATTERNS.map((p) => `sku LIKE '${p}'`),
  ].join(" OR ");
  await run(
    "daily_sales legacy",
    sql.raw(`SELECT count(*) AS n FROM daily_sales WHERE ${dsConds}`),
    sql.raw(`DELETE FROM daily_sales WHERE ${dsConds}`),
    apply,
  );

  console.log("done");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
