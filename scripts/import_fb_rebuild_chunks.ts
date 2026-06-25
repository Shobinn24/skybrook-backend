// One-time DB rebuild of fb_ad_spend_daily for the 2026-04-12 → 2026-06-10
// window from include-deleted Supermetrics chunk pulls saved as local CSVs.
//
// WHY: the live "FB Ads Live" query runs with deleted ads excluded and a
// small-spend filter, and Supermetrics never re-fetches older days. Every
// day in the DB is therefore frozen at its first capture: missing FB's
// 72h restatements, the sub-$2 long tail, and any spend whose ad was
// deleted between capture and now. Chunk pulls with INCLUDE_DELETED_ITEMS
// on and no filter were verified against Ads Manager exports to the cent
// (May 1-31: -$0.05 on $885,875.80; Jun 1-7: -$0.03; Jun 8: +$1.97).
//
// Unlike scripts/import_fb_history_to_db.ts (additive upsert), this is a
// windowed DELETE + INSERT: the corrected pull is authoritative for the
// window, and an upsert would leave behind (ad_number, spend_date) rows
// whose spend FB has since reattributed away. Guards before any write:
//   - every date in the window must be covered by exactly the chunks
//     (a hole would silently lose that day on delete)
//   - month-collapse guard (same thresholds as the live ingest): refuse
//     if any previously-material month's incoming total collapses
//   - ad_link backfill: chunk pulls carry no link column; links are
//     preserved from the existing rows by ad_number
//   - per-marketer lifetime-spend snapshot before/after, since
//     bonus-crossing tiers read this table — deltas are printed so a
//     shifted tier crossing is a known event, not a surprise
//
// Run (against PROD — set DATABASE_URL to the Railway public URL):
//   pnpm tsx scripts/import_fb_rebuild_chunks.ts --dry-run
//   pnpm tsx scripts/import_fb_rebuild_chunks.ts --apply
import "dotenv/config";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { and, gte, lte, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { fbAdSpendDaily, rawPulls } from "@/lib/db/schema";
import {
  parseFbAdsSheet,
  detectCollapsedMonths,
  type FbAdAggregated,
} from "@/lib/sources/sheets/fb-ads";
import { extractMarketers } from "@/lib/domain/fb-marketers";
import { extractFbPrefix } from "@/lib/domain/fb-product-attribution";

const CHUNK_DIR =
  process.env.FB_REBUILD_DIR ??
  join(
    process.env.HOME ?? "",
    "Desktop/Active/Everdries/Skybrook/exports/fb-rebuild",
  );

const args = process.argv.slice(2);
const apply = args.includes("--apply");

// Minimal RFC-4180 CSV parser (quoted fields, embedded commas/quotes).
// Ad names contain commas and parentheses; naive split would shear rows.
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    if (row.length > 1 || row[0] !== "") rows.push(row);
  }
  return rows;
}

function isoDatesBetween(min: string, max: string): string[] {
  const out: string[] = [];
  const d = new Date(`${min}T00:00:00Z`);
  const end = new Date(`${max}T00:00:00Z`);
  while (d <= end) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

async function main() {
  console.log(`Mode: ${apply ? "APPLY (writing to DB)" : "DRY-RUN"}`);
  console.log(
    `DB: ${process.env.DATABASE_URL?.replace(/:\/\/[^@]*@/, "://***@")}`,
  );
  console.log(`Chunks: ${CHUNK_DIR}`);

  const files = readdirSync(CHUNK_DIR)
    .filter((f) => /^deleted-on_\d{4}-\d{2}-\d{2}_to_\d{4}-\d{2}-\d{2}\.csv$/.test(f))
    .sort();
  if (files.length === 0) throw new Error(`no chunk CSVs found in ${CHUNK_DIR}`);

  // Parse every chunk through the EXACT prod parse path. Chunk pulls have
  // no link column (header: Ad name, <dates...>), and parseFbAdsSheet
  // hard-requires header[1] to be the promoted-post column — shim an
  // empty link column into every row so the same aggregation, canonical
  // naming, and number extraction apply.
  type DayCell = { spendDate: string; costUsd: number };
  const sumByAdAndDate = new Map<string, Map<string, number>>();
  const canonical = new Map<string, { name: string; raw: string; total: number }>();
  const coveredDates = new Set<string>();
  let totalSkipped = 0;

  for (const file of files) {
    const grid = parseCsv(readFileSync(join(CHUNK_DIR, file), "utf8"));
    const hdr = grid[0] ?? [];
    if (hdr[0]?.trim().toLowerCase() !== "ad name")
      throw new Error(`${file}: unexpected header ${JSON.stringify(hdr.slice(0, 3))}`);
    const dates = hdr.slice(1).filter((h) => /^\d{4}-\d{2}-\d{2}$/.test(h.trim()));
    if (dates.length === 0) throw new Error(`${file}: no date columns`);

    // filename encodes the intended range — refuse a chunk whose data drifted
    const fm = file.match(/^deleted-on_(\d{4}-\d{2}-\d{2})_to_(\d{4}-\d{2}-\d{2})\.csv$/);
    if (fm && (dates[0] !== fm[1] || dates[dates.length - 1] !== fm[2]))
      throw new Error(
        `${file}: dates inside (${dates[0]}..${dates[dates.length - 1]}) don't match filename — re-save the chunk`,
      );

    const shimmed: unknown[][] = grid.map((r, i) =>
      i === 0
        ? ["Ad name", "Link to promoted post", ...r.slice(1)]
        : [r[0], "", ...r.slice(1)],
    );
    const { aggregated, skipped } = parseFbAdsSheet(shimmed);
    totalSkipped += skipped.length;
    if (aggregated.length === 0) throw new Error(`${file}: parsed 0 ads`);

    let fileTotal = 0;
    for (const ad of aggregated) {
      for (const d of ad.dailySpend) {
        // chunk files may overlap at edges; a date is owned by the first
        // chunk (sorted order) that carries it — coveredDates is updated
        // only after a file finishes, so membership = an earlier chunk
        if (coveredDates.has(d.spendDate)) continue;
        const byDate = sumByAdAndDate.get(ad.adNumber) ?? new Map<string, number>();
        byDate.set(d.spendDate, (byDate.get(d.spendDate) ?? 0) + d.costUsd);
        sumByAdAndDate.set(ad.adNumber, byDate);
        fileTotal += d.costUsd;
      }
      const prev = canonical.get(ad.adNumber);
      const adTotal = ad.dailySpend.reduce((s, d) => s + d.costUsd, 0);
      if (!prev || adTotal > prev.total)
        canonical.set(ad.adNumber, { name: ad.adName, raw: ad.adNameRaw, total: adTotal });
    }
    for (const d of dates) coveredDates.add(d);
    console.log(
      `  ${file}: ${aggregated.length} ads, ${dates.length} days, $${fileTotal.toLocaleString(undefined, { maximumFractionDigits: 2 })}, skipped ${skipped.length}`,
    );
  }

  const allDates = [...coveredDates].sort();
  const minDate = allDates[0];
  const maxDate = allDates[allDates.length - 1];

  // Contiguity guard: a hole inside the delete window would lose that day.
  const expected = isoDatesBetween(minDate, maxDate);
  const holes = expected.filter((d) => !coveredDates.has(d));
  if (holes.length > 0)
    throw new Error(`window ${minDate}..${maxDate} has uncovered dates: ${holes.join(", ")}`);

  // Build aggregated rows in the live-ingest shape.
  const aggregated: FbAdAggregated[] = [];
  for (const [adNumber, byDate] of sumByAdAndDate) {
    const c = canonical.get(adNumber)!;
    aggregated.push({
      adNumber,
      adName: c.name,
      adNameRaw: c.raw,
      // Frozen history is collapsed by ad_number; derive the prefix from
      // the canonical name (same as the 0024 migration backfill). Variant
      // grain only applies to the live window going forward.
      adPrefix: extractFbPrefix(c.raw),
      adLink: null, // backfilled from existing rows below
      dailySpend: [...byDate.entries()]
        .map(([spendDate, costUsd]) => ({ spendDate, costUsd }))
        .sort((a, b) => a.spendDate.localeCompare(b.spendDate)),
    });
  }
  const incomingTotal = aggregated.reduce(
    (s, a) => s + a.dailySpend.reduce((ss, d) => ss + d.costUsd, 0),
    0,
  );

  // ── Existing-state reads (all read-only) ────────────────────────────
  const existingMonths = await db
    .select({
      month: sql<string>`to_char(${fbAdSpendDaily.spendDate}, 'YYYY-MM')`,
      total: sql<number>`sum(${fbAdSpendDaily.costUsd})::float`,
    })
    .from(fbAdSpendDaily)
    .where(and(gte(fbAdSpendDaily.spendDate, minDate), lte(fbAdSpendDaily.spendDate, maxDate)))
    .groupBy(sql`to_char(${fbAdSpendDaily.spendDate}, 'YYYY-MM')`);
  const existingByMonth = new Map(existingMonths.map((r) => [r.month, Number(r.total)]));
  const existingWindowTotal = [...existingByMonth.values()].reduce((a, b) => a + b, 0);

  const incomingByMonth = new Map<string, number>();
  for (const ad of aggregated)
    for (const d of ad.dailySpend) {
      const m = d.spendDate.slice(0, 7);
      incomingByMonth.set(m, (incomingByMonth.get(m) ?? 0) + d.costUsd);
    }

  // Month-collapse guard — same detector the live ingest uses.
  const collapsed = detectCollapsedMonths(incomingByMonth, existingByMonth);
  if (collapsed.length > 0)
    throw new Error(
      `month-collapse guard: ${collapsed.map((c) => `${c.month} $${Math.round(c.existing)}→$${Math.round(c.incoming)}`).join("; ")} — refusing`,
    );

  // ad_link backfill from existing rows (chunks carry no links).
  const linkRows = await db
    .select({ adNumber: fbAdSpendDaily.adNumber, adLink: fbAdSpendDaily.adLink })
    .from(fbAdSpendDaily)
    .where(sql`${fbAdSpendDaily.adLink} is not null`);
  const linkByAd = new Map<string, string>();
  for (const r of linkRows) if (r.adLink) linkByAd.set(r.adNumber, r.adLink);
  let linked = 0;
  for (const ad of aggregated) {
    const l = linkByAd.get(ad.adNumber);
    if (l) {
      ad.adLink = l;
      linked++;
    }
  }

  // Bonus-tier snapshot: per-marketer lifetime spend (this table feeds
  // bonus tier crossings).
  async function marketerLifetime(): Promise<Map<string, number>> {
    const rows = await db.execute(sql`
      select m.marketer, sum(f.cost_usd)::float as total
      from ${fbAdSpendDaily} f, lateral unnest(f.marketers) as m(marketer)
      group by m.marketer order by m.marketer
    `);
    return new Map(
      (rows as unknown as Array<{ marketer: string; total: number }>).map((r) => [
        r.marketer,
        Number(r.total),
      ]),
    );
  }
  const lifetimeBefore = await marketerLifetime();

  console.log(`\nWindow: ${minDate} → ${maxDate} (${allDates.length} days, ${aggregated.length} ad numbers)`);
  console.log(`Existing window total: $${existingWindowTotal.toLocaleString(undefined, { maximumFractionDigits: 2 })}`);
  console.log(`Incoming window total: $${incomingTotal.toLocaleString(undefined, { maximumFractionDigits: 2 })}`);
  console.log(`Delta: $${(incomingTotal - existingWindowTotal).toLocaleString(undefined, { maximumFractionDigits: 2 })}`);
  console.log(`Links preserved for ${linked}/${aggregated.length} ad numbers; rows skipped by parser: ${totalSkipped}`);
  for (const [m, v] of [...incomingByMonth.entries()].sort()) {
    const e = existingByMonth.get(m) ?? 0;
    console.log(`  ${m}: $${e.toLocaleString(undefined, { maximumFractionDigits: 0 })} → $${v.toLocaleString(undefined, { maximumFractionDigits: 0 })} (${v - e >= 0 ? "+" : ""}$${(v - e).toLocaleString(undefined, { maximumFractionDigits: 0 })})`);
  }

  if (!apply) {
    console.log(`\n[dry-run] no writes performed. Re-run with --apply to import.`);
    return;
  }

  // ── Windowed delete + insert in one transaction ─────────────────────
  await db.transaction(async (tx) => {
    const pullBatchId = randomUUID();
    const fingerprint = createHash("sha256")
      .update(`fb-rebuild:${minDate}:${maxDate}:${files.join(",")}`)
      .digest("hex")
      .slice(0, 16);
    const [pull] = await tx
      .insert(rawPulls)
      .values({
        source: "sheets_fb_ads",
        pullBatchId,
        payload: {
          import: "fb_rebuild_chunks",
          files,
          minDate,
          maxDate,
          ads: aggregated.length,
          total: incomingTotal,
        },
        rowCount: aggregated.reduce((s, a) => s + a.dailySpend.length, 0),
        schemaFingerprint: fingerprint,
      })
      .returning({ id: rawPulls.id });

    await tx
      .delete(fbAdSpendDaily)
      .where(and(gte(fbAdSpendDaily.spendDate, minDate), lte(fbAdSpendDaily.spendDate, maxDate)));

    const flat: Array<typeof fbAdSpendDaily.$inferInsert> = [];
    for (const ad of aggregated) {
      const marketers = extractMarketers(ad.adNameRaw);
      for (const d of ad.dailySpend) {
        flat.push({
          adNumber: ad.adNumber,
          adName: ad.adName,
          adNameRaw: ad.adNameRaw,
          adLink: ad.adLink,
          marketers,
          spendDate: d.spendDate,
          costUsd: d.costUsd.toString(),
          sourcePullId: pull.id,
        });
      }
    }
    const CHUNK = 1000;
    for (let i = 0; i < flat.length; i += CHUNK) {
      await tx.insert(fbAdSpendDaily).values(flat.slice(i, i + CHUNK));
    }
    console.log(`\n[applied] replaced window with ${flat.length} rows (pull ${pull.id})`);
  });

  // Post-import: lifetime deltas per marketer (bonus-tier early warning).
  const lifetimeAfter = await marketerLifetime();
  console.log(`\nMarketer lifetime spend deltas:`);
  const names = new Set([...lifetimeBefore.keys(), ...lifetimeAfter.keys()]);
  for (const n of [...names].sort()) {
    const b = lifetimeBefore.get(n) ?? 0;
    const a = lifetimeAfter.get(n) ?? 0;
    if (Math.abs(a - b) > 0.005)
      console.log(`  ${n}: $${b.toLocaleString(undefined, { maximumFractionDigits: 0 })} → $${a.toLocaleString(undefined, { maximumFractionDigits: 0 })} (+$${(a - b).toLocaleString(undefined, { maximumFractionDigits: 0 })})`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
