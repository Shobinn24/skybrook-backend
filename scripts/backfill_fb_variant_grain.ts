// One-time backfill: re-ingest a wider FB Ads window at VARIANT grain from a
// scratch Supermetrics sheet.
//
// WHY: the live "FB Ads Live" tab only holds ~14 days, and the daily ingest
// only re-writes from that pull's earliest date forward. So when variant
// grain (ad_prefix) shipped, days older than ~14 days stayed COLLAPSED
// (homepage/brand spend absorbed into the dominant product — the HOME
// undercount). The 30d /performance window therefore self-heals only over
// ~2 weeks. This script corrects the whole window in one shot: you pull
// 30-35 days of FB spend into a throwaway sheet, and it replaces exactly
// that date range in the DB with variant-grain rows.
//
// Each chunk MUST be the SAME query shape as FB Ads Live:
//   Row 1: ["Ad name", "Link to promoted post", "YYYY-MM-DD", ...dates]
//   Row N: [<raw ad name>, <fb url>, <spend per day>...]
// (Facebook Ads → Amount spent, split by Ad name + Date, date-as-columns.)
// Share the sheet with the service account (Viewer) so this can read it.
//
// CHUNKING: a single 30-day pull tends to time out in Supermetrics, so the
// window is split into chunks (e.g. two ~15-day tabs). This script reads
// ALL chunks and STITCHES them horizontally back into one logical 30-day
// grid BEFORE parsing — so the canonical (highest-spend) variant per
// ad_number is chosen GLOBALLY, exactly as a single pull would. Running the
// parser once per chunk instead would let an ad's canonical name/marketers
// differ between date ranges and reintroduce bonus-attribution drift.
//
// SAFETY:
//   - Contiguity guard: aborts if the chunks don't fully cover
//     [minDate, maxDate] (a hole would be deleted but not re-inserted).
//   - Bounded delete: only rows in [minDate, maxDate] are replaced, so a
//     newer day the chunks don't cover (e.g. today) is NOT wiped.
//   - Month-collapse guard: the same detector the live ingest uses.
//   - Link preservation: fills ad_link from existing rows when a chunk
//     lacks it, so /fb-ads + bonus links survive the replace.
//   - DRY RUN by default: prints the variant split (incl. HOME before/after)
//     and writes nothing. Pass --apply to actually replace the window.
//
// Usage — chunks as tabs in ONE scratch sheet (DRY RUN):
//   DATABASE_URL=<prod DATABASE_PUBLIC_URL> node_modules/.bin/tsx \
//     scripts/backfill_fb_variant_grain.ts <sheetId> "Chunk A" "Chunk B"
// Chunks across DIFFERENT sheets: pass <sheetId>!<tab> tokens instead.
// Apply: append --apply.

import "dotenv/config";
import { randomUUID, createHash } from "node:crypto";
import { and, gte, lte, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { fbAdSpendDaily, rawPulls } from "@/lib/db/schema";
import { extractMarketers } from "@/lib/domain/fb-marketers";
import { attributeFbPrefix } from "@/lib/domain/fb-product-attribution";
import { detectCollapsedMonths, parseFbAdsSheet } from "@/lib/sources/sheets/fb-ads";
import { buildSheetsClient } from "@/lib/sources/sheets/client";

const ISO = /^\d{4}-\d{2}-\d{2}$/;

function money(n: number): string {
  return `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

function usage(): void {
  console.error(
    'Usage:\n' +
      '  tsx scripts/backfill_fb_variant_grain.ts <sheetId> "Chunk A" ["Chunk B" ...] [--apply]\n' +
      '  tsx scripts/backfill_fb_variant_grain.ts <sheetId>!<tab> [<sheetId>!<tab> ...] [--apply]',
  );
}

// Every YYYY-MM-DD between a and b inclusive (UTC, DST-agnostic).
function isoDatesBetween(a: string, b: string): string[] {
  const out: string[] = [];
  const d = new Date(`${a}T00:00:00Z`);
  const end = new Date(`${b}T00:00:00Z`);
  while (d <= end) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

// Stitch multiple chunk grids (same rows, different date columns) into one
// grid spanning the union of all date columns, keyed by raw ad name (col A).
// Reusing the single-grid parser on the stitched result guarantees the same
// global canonical selection a single 30-day pull would produce.
function horizontalMerge(grids: unknown[][][]): unknown[][] {
  const dateSet = new Set<string>();
  for (const g of grids) {
    const header = (g[0] ?? []).map((c) => String(c ?? "").trim());
    if (header[0]?.toLowerCase() !== "ad name" || !/promoted post/i.test(header[1] ?? ""))
      throw new Error(`a chunk has an unexpected header: ${JSON.stringify(g[0] ?? [])}`);
    for (const h of header) if (ISO.test(h)) dateSet.add(h);
  }
  const dates = [...dateSet].sort();
  const dateIndex = new Map(dates.map((d, i) => [d, i]));

  type Row = { name: string; link: string; costs: string[] };
  const byName = new Map<string, Row>();
  for (const g of grids) {
    const header = (g[0] ?? []).map((c) => String(c ?? "").trim());
    const colDate = header.map((h) => (ISO.test(h) ? h : null));
    for (let r = 1; r < g.length; r++) {
      const row = g[r] ?? [];
      const name = String(row[0] ?? "").trim();
      if (!name) continue;
      const link = String(row[1] ?? "").trim();
      let rec = byName.get(name);
      if (!rec) {
        rec = { name, link, costs: new Array(dates.length).fill("") };
        byName.set(name, rec);
      } else if (!rec.link && link) {
        rec.link = link;
      }
      for (let c = 2; c < row.length; c++) {
        const d = colDate[c];
        if (!d) continue;
        const v = String(row[c] ?? "").trim();
        if (v) rec.costs[dateIndex.get(d)!] = v; // overlap-safe: last non-empty wins
      }
    }
  }

  const merged: unknown[][] = [["Ad name", "Link to promoted post", ...dates]];
  for (const rec of byName.values()) merged.push([rec.name, rec.link, ...rec.costs]);
  return merged;
}

async function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const positional = argv.filter((a) => a !== "--apply");

  let sources: Array<{ sheetId: string; tab: string }>;
  if (positional[0]?.includes("!")) {
    sources = positional.map((s) => {
      const i = s.indexOf("!");
      return { sheetId: s.slice(0, i), tab: s.slice(i + 1) };
    });
  } else {
    const [sheetId, ...tabs] = positional;
    if (!sheetId || tabs.length === 0) {
      usage();
      process.exit(1);
    }
    sources = tabs.map((t) => ({ sheetId, tab: t }));
  }

  // ── Read each chunk, then stitch into one logical grid ──────────────
  const sheets = buildSheetsClient();
  const grids: unknown[][][] = [];
  for (const s of sources) {
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: s.sheetId,
      range: `'${s.tab}'!A1:AZZ`,
    });
    const g = (resp.data.values ?? []) as unknown[][];
    if (g.length === 0) throw new Error(`chunk "${s.tab}" returned no rows`);
    grids.push(g);
    console.log(`read chunk "${s.tab}": ${g.length - 1} data rows`);
  }
  const grid = grids.length === 1 ? grids[0] : horizontalMerge(grids);

  const { aggregated, skipped } = parseFbAdsSheet(grid);
  if (aggregated.length === 0) {
    console.error(
      `parseFbAdsSheet produced 0 rows. First skip reason: ${
        skipped[0]?.reason ?? "<none>"
      }\nEach chunk header must be ["Ad name", "Link to promoted post", <dates>...].`,
    );
    process.exit(1);
  }

  // ── Window bounds from the parsed data ──────────────────────────────
  const allDates = aggregated
    .flatMap((a) => a.dailySpend.map((d) => d.spendDate))
    .sort();
  const minDate = allDates[0];
  const maxDate = allDates[allDates.length - 1];
  const incomingTotal = aggregated.reduce(
    (s, a) => s + a.dailySpend.reduce((ss, d) => ss + d.costUsd, 0),
    0,
  );

  // ── Contiguity guard: every day in [minDate,maxDate] must be covered,
  // else the bounded delete would drop an uncovered day. FB spends every
  // day, so a hole means a chunk is missing, not a real zero day. ──
  const present = new Set(allDates);
  const holes = isoDatesBetween(minDate, maxDate).filter((d) => !present.has(d));
  if (holes.length > 0)
    throw new Error(
      `window ${minDate}..${maxDate} has ${holes.length} uncovered day(s): ${holes
        .slice(0, 10)
        .join(", ")}${holes.length > 10 ? " …" : ""}\nAdd the missing chunk(s) before applying.`,
    );

  // ── Preserve ad_link from existing rows when the scratch pull lacks it
  // (so a bounded delete+reinsert never strands /fb-ads + bonus links). ──
  const linkRows = await db
    .select({ adNumber: fbAdSpendDaily.adNumber, adLink: fbAdSpendDaily.adLink })
    .from(fbAdSpendDaily)
    .where(sql`${fbAdSpendDaily.adLink} is not null`);
  const linkByAd = new Map<string, string>();
  for (const r of linkRows) if (r.adLink) linkByAd.set(r.adNumber, r.adLink);
  let linkFilled = 0;
  for (const a of aggregated) {
    if (!a.adLink) {
      const l = linkByAd.get(a.adNumber);
      if (l) {
        a.adLink = l;
        linkFilled++;
      }
    }
  }

  // ── Variant breakdown by product (incoming) ─────────────────────────
  const incomingByProduct = new Map<string, number>();
  const incomingByMonth = new Map<string, number>();
  for (const a of aggregated) {
    const fam = attributeFbPrefix(a.adPrefix).product;
    for (const d of a.dailySpend) {
      incomingByProduct.set(fam, (incomingByProduct.get(fam) ?? 0) + d.costUsd);
      const m = d.spendDate.slice(0, 7);
      incomingByMonth.set(m, (incomingByMonth.get(m) ?? 0) + d.costUsd);
    }
  }

  // ── Existing state in the same window (collapsed) ───────────────────
  const existingRows = await db
    .select({ adPrefix: fbAdSpendDaily.adPrefix, cost: sql<number>`sum(${fbAdSpendDaily.costUsd})::float` })
    .from(fbAdSpendDaily)
    .where(and(gte(fbAdSpendDaily.spendDate, minDate), lte(fbAdSpendDaily.spendDate, maxDate)))
    .groupBy(fbAdSpendDaily.adPrefix);
  const existingByProduct = new Map<string, number>();
  let existingTotal = 0;
  for (const r of existingRows) {
    const fam = attributeFbPrefix(r.adPrefix ?? "").product;
    existingByProduct.set(fam, (existingByProduct.get(fam) ?? 0) + Number(r.cost));
    existingTotal += Number(r.cost);
  }
  const existingByMonthRows = await db
    .select({ month: sql<string>`to_char(${fbAdSpendDaily.spendDate}, 'YYYY-MM')`, total: sql<number>`sum(${fbAdSpendDaily.costUsd})::float` })
    .from(fbAdSpendDaily)
    .where(and(gte(fbAdSpendDaily.spendDate, minDate), lte(fbAdSpendDaily.spendDate, maxDate)))
    .groupBy(sql`to_char(${fbAdSpendDaily.spendDate}, 'YYYY-MM')`);
  const existingByMonth = new Map(existingByMonthRows.map((r) => [r.month, Number(r.total)]));

  // ── Month-collapse guard ────────────────────────────────────────────
  const collapsed = detectCollapsedMonths(incomingByMonth, existingByMonth);

  // ── Report ──────────────────────────────────────────────────────────
  console.log(`\nWindow: ${minDate} → ${maxDate} (${allDates.length === 0 ? 0 : new Set(allDates).size} days, ${aggregated.length} variant rows)`);
  console.log(`Existing window total: ${money(existingTotal)}`);
  console.log(`Incoming window total: ${money(incomingTotal)}  (delta ${money(incomingTotal - existingTotal)})`);
  console.log(`Parser skipped ${skipped.length} source rows; ad_link preserved from DB for ${linkFilled} ads missing a link in the scratch pull.`);

  console.log(`\nProduct attribution — collapsed (now) vs variant (incoming):`);
  const fams = [...new Set([...existingByProduct.keys(), ...incomingByProduct.keys()])].sort(
    (a, b) => (incomingByProduct.get(b) ?? 0) - (incomingByProduct.get(a) ?? 0),
  );
  for (const f of fams) {
    const e = existingByProduct.get(f) ?? 0;
    const i = incomingByProduct.get(f) ?? 0;
    const mark = Math.abs(i - e) >= 100 ? "  <-- shift" : "";
    console.log(`  ${f.padEnd(20)} ${money(e).padStart(10)} -> ${money(i).padStart(10)} (${i - e >= 0 ? "+" : ""}${money(i - e)})${mark}`);
  }

  if (collapsed.length > 0) {
    console.error(
      `\nMONTH-COLLAPSE GUARD TRIPPED — refusing to write:\n  ${collapsed
        .map((c) => `${c.month}: ${money(c.existing)} -> ${money(c.incoming)}`)
        .join("\n  ")}\nThe scratch sheet is missing data for a material month. Widen the pull and retry.`,
    );
    process.exit(1);
  }

  if (!apply) {
    console.log(`\n[dry-run] no writes performed. Re-run with --apply to replace the window.`);
    return;
  }

  // ── Bounded delete + variant-grain insert in one transaction ────────
  await db.transaction(async (tx) => {
    const sourceLabel = sources.map((s) => `${s.sheetId}!${s.tab}`).join(",");
    const fingerprint = createHash("sha256")
      .update(`fb-variant-backfill:${minDate}:${maxDate}:${sourceLabel}`)
      .digest("hex")
      .slice(0, 16);
    const [pull] = await tx
      .insert(rawPulls)
      .values({
        source: "sheets_fb_ads",
        pullBatchId: randomUUID(),
        payload: { import: "fb_variant_grain_backfill", sources: sourceLabel, minDate, maxDate, variantRows: aggregated.length, total: incomingTotal },
        rowCount: aggregated.reduce((s, a) => s + a.dailySpend.length, 0),
        schemaFingerprint: fingerprint,
      })
      .returning({ id: rawPulls.id });

    await tx
      .delete(fbAdSpendDaily)
      .where(and(gte(fbAdSpendDaily.spendDate, minDate), lte(fbAdSpendDaily.spendDate, maxDate)));

    const flat: Array<typeof fbAdSpendDaily.$inferInsert> = [];
    for (const a of aggregated) {
      const marketers = extractMarketers(a.adNameRaw);
      for (const d of a.dailySpend) {
        flat.push({
          adNumber: a.adNumber,
          adName: a.adName,
          adNameRaw: a.adNameRaw,
          adPrefix: a.adPrefix,
          adLink: a.adLink,
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
    console.log(`\n[applied] replaced ${minDate}..${maxDate} with ${flat.length} variant-grain rows (pull ${pull.id}).`);
  });
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
