import { createHash } from "node:crypto";
import { gte, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { fbAdSpendDaily } from "@/lib/db/schema";
import { extractMarketers } from "@/lib/domain/fb-marketers";
import { logger } from "@/lib/logger";
import type { SourceRunner } from "@/lib/jobs/ingest";
import { postAlert, type AlertInput } from "@/lib/notifications/slack";
import { buildDriveClient, buildSheetsClient } from "./client";

// ============================================================================
// FB Ads Tracker — per-ad daily spend
// ============================================================================
// Source: standalone "FB Ads Tracker" sheet (id in FB_ADS_SHEET_ID), tab
// defaults to "Sheet7" (the linked gid 773835769). Layout:
//   Row 1: ["Ad name", "Link to promoted post", "YYYY-MM-DD", ...dates]
//   Row N: [<raw ad name>,                 <fb url>,             spend...]
//
// Naming convention has drifted; Scott's instruction is "for the most
// part, the ad number comes after 'Ad ' or 'DCA '". We extract the
// first match of /\b(?:Ad|DCA)\s+(\d+)\b/ (case-sensitive — avoids
// matching the lowercase "ad" inside e.g. "AIad"). Same ad number can
// be launched into multiple campaigns (e.g. "(OG Lav CC) Ad 537" and
// "(LAV ASC) DCA 537" are both ad 537), so we aggregate spend by
// (ad_number, spend_date).
//
// Display name & link: pick the variant with the highest TOTAL spend
// across the full date window as the canonical row — that's the most
// representative creative for that ad number.
// ============================================================================

const FB_ADS_DEFAULT_TAB = "Sheet7";

export type FbAdSheetVariant = {
  /** Verbatim col A. */
  rawName: string;
  /** Trimmed descriptive portion — what follows "Ad NNN - " / "DCA NNN - ".
   * Falls back to rawName when there is no separator after the marker. */
  displayName: string;
  link: string | null;
  /** Per-day cost. Sparse — only non-zero/non-empty days included. */
  dailySpend: Array<{ spendDate: string; costUsd: number }>;
};

export type FbAdAggregated = {
  adNumber: string;
  adName: string;
  adNameRaw: string;
  adLink: string | null;
  /** Aggregated (already summed across variants). */
  dailySpend: Array<{ spendDate: string; costUsd: number }>;
};

const FB_ADS_NUMBER_REGEX = /\b(?:Ad|DCA)\s+(\d+)\b/;

/** Pull the descriptive tail from a raw name. Example:
 *   "(OG Lav CC) Ad 537 - OG Lavender images" → "OG Lavender images"
 *   "(HW ASC) 4 Jul25 - Ad 1026 - Elie Long Copy Static 1" → "Elie Long Copy Static 1"
 * If no " - " follows the marker we fall back to the trimmed rawName. */
export function trimFbAdDisplayName(rawName: string): string {
  const m = rawName.match(/\b(?:Ad|DCA)\s+\d+\s*-\s*(.+)$/);
  if (m && m[1].trim()) return m[1].trim();
  return rawName.trim();
}

export function parseFbAdsSheet(
  grid: ReadonlyArray<ReadonlyArray<unknown>>,
): {
  variants: FbAdSheetVariant[];
  aggregated: FbAdAggregated[];
  skipped: Array<{ rowIdx: number; reason: string }>;
} {
  const skipped: Array<{ rowIdx: number; reason: string }> = [];
  const variants: FbAdSheetVariant[] = [];

  const header = (grid[0] ?? []).map((c) => String(c ?? "").trim());
  if (
    header[0]?.toLowerCase() !== "ad name" ||
    !/promoted post/i.test(header[1] ?? "")
  ) {
    skipped.push({
      rowIdx: 0,
      reason: `unexpected header: ${JSON.stringify(grid[0] ?? [])}`,
    });
    return { variants, aggregated: [], skipped };
  }

  // Identify date columns (header position → YYYY-MM-DD). Anything that
  // doesn't parse as ISO date is skipped from the iteration.
  const dateCols: Array<{ colIdx: number; date: string }> = [];
  for (let c = 2; c < header.length; c++) {
    const h = header[c];
    if (/^\d{4}-\d{2}-\d{2}$/.test(h)) dateCols.push({ colIdx: c, date: h });
  }
  if (dateCols.length === 0) {
    skipped.push({ rowIdx: 0, reason: "no date columns found in header" });
    return { variants, aggregated: [], skipped };
  }

  // Per-ad-number aggregation. Maps ad_number → date → summed cost.
  const sumByAdAndDate = new Map<string, Map<string, number>>();
  // Per-ad-number → array of {variant, totalSpend} so we can pick the
  // canonical (highest-total-spend) raw name + link after aggregation.
  const variantsByAd = new Map<
    string,
    Array<{ variant: FbAdSheetVariant; totalSpend: number }>
  >();

  for (let r = 1; r < grid.length; r++) {
    const row = grid[r] ?? [];
    const rawName = String(row[0] ?? "").trim();
    if (!rawName) continue; // blank row
    const linkRaw = String(row[1] ?? "").trim();
    const link = linkRaw || null;

    const m = rawName.match(FB_ADS_NUMBER_REGEX);
    if (!m) {
      skipped.push({
        rowIdx: r,
        reason: `no Ad/DCA number in "${rawName.slice(0, 60)}"`,
      });
      continue;
    }
    const adNumber = m[1];
    const displayName = trimFbAdDisplayName(rawName);

    const variantDaily: Array<{ spendDate: string; costUsd: number }> = [];
    let variantTotal = 0;
    for (const { colIdx, date } of dateCols) {
      const cellRaw = String(row[colIdx] ?? "").trim();
      if (!cellRaw) continue;
      const cleaned = cellRaw.replace(/[$,]/g, "");
      const cost = Number(cleaned);
      if (!Number.isFinite(cost) || cost === 0) continue;
      variantDaily.push({ spendDate: date, costUsd: cost });
      variantTotal += cost;

      const byDate = sumByAdAndDate.get(adNumber) ?? new Map<string, number>();
      byDate.set(date, (byDate.get(date) ?? 0) + cost);
      sumByAdAndDate.set(adNumber, byDate);
    }

    const variant: FbAdSheetVariant = {
      rawName,
      displayName,
      link,
      dailySpend: variantDaily,
    };
    variants.push(variant);
    const arr = variantsByAd.get(adNumber) ?? [];
    arr.push({ variant, totalSpend: variantTotal });
    variantsByAd.set(adNumber, arr);
  }

  const aggregated: FbAdAggregated[] = [];
  for (const [adNumber, byDate] of sumByAdAndDate) {
    // Canonical variant = highest total spend; ties broken by first
    // occurrence (Map preserves insertion order).
    const arr = variantsByAd.get(adNumber) ?? [];
    let best = arr[0];
    for (const v of arr) {
      if (v.totalSpend > best.totalSpend) best = v;
    }
    const daily = Array.from(byDate.entries())
      .map(([spendDate, costUsd]) => ({ spendDate, costUsd }))
      .sort((a, b) => a.spendDate.localeCompare(b.spendDate));
    aggregated.push({
      adNumber,
      adName: best.variant.displayName,
      adNameRaw: best.variant.rawName,
      adLink: best.variant.link,
      dailySpend: daily,
    });
  }

  return { variants, aggregated, skipped };
}

export const sheetsFbAdsRunner: SourceRunner = async (_batchId) => {
  const sheetId = process.env.FB_ADS_SHEET_ID;
  if (!sheetId) throw new Error("sheets_fb_ads: missing FB_ADS_SHEET_ID");
  const tab = process.env.FB_ADS_TAB_NAME?.trim() || FB_ADS_DEFAULT_TAB;

  const sheets = buildSheetsClient();

  // Pull A:AZZ (col 1378 = 1376 date slots, ~3.77 years of daily data)
  // so the ingest covers Supermetrics's full 36-month FB Ads history
  // window with safe headroom. Scott confirmed 2026-05-22 that
  // Supermetrics caps FB export at 36 months (~1097 date cols), and our
  // prior A:ANK guess (col 1051) would clip ~46 cols off the right edge
  // of the sheet — i.e., we'd silently lose the most recent ~6 weeks of
  // spend on every cron after he widens the source. AZZ gives us
  // ~9 months of headroom past the 36-month max.
  //
  // ~3015 rows × 1378 cols ≈ 4.2M cells is comfortably under the
  // Sheets API 10M-cell range cap. Until Scott actually widens the
  // Supermetrics query, this is a no-op widening — empty trailing
  // columns get skipped by parseFbAdsSheet.
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `'${tab}'!A1:AZZ`,
  });
  const grid = (resp.data.values ?? []) as unknown[][];

  // Record when Supermetrics last refreshed the sheet, so we can compare it
  // against this pull's time and tune the cron to run after the daily
  // refresh. Best-effort: a Drive hiccup must never fail the ingest.
  let sheetModifiedTime: string | null = null;
  try {
    const drive = buildDriveClient();
    const meta = await drive.files.get({
      fileId: sheetId,
      fields: "modifiedTime",
      supportsAllDrives: true,
    });
    sheetModifiedTime = meta.data.modifiedTime ?? null;
  } catch (e) {
    logger.warn(
      `sheets_fb_ads: could not read sheet modifiedTime (non-fatal): ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }

  // The live tab covers the current year only. Pre-2026 history is a
  // one-time DB import (scripts/import_fb_history_to_db.ts) that lives
  // below this runner's live window, so the daily cron never re-reads it
  // and the scoped delete in normalize() leaves it untouched. (The old
  // FB_ADS_HISTORY_TABS daily-merge was retired 2026-05-27 — re-pulling
  // 5 frozen tabs every cron was too fragile; they kept reverting to a
  // 2023 date range and clobbering the merge.)
  const { variants, skipped, aggregated } = parseFbAdsSheet(grid);

  // SCHEMA signal = the leading structural header columns (e.g.
  // "Ad name", "Promoted post") BEFORE the date columns. Date columns
  // grow by one every day, and variant/ad counts grow with volume —
  // neither is schema drift, so a count/date-based fingerprint would
  // false-fire daily. Hash only the fixed structural prefix so drift
  // fires when those columns actually change shape.
  const fbHeader = (grid[0] ?? []).map((c) => String(c ?? "").trim());
  const structuralHeader: string[] = [];
  for (const h of fbHeader) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(h)) break;
    structuralHeader.push(h);
  }

  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        tab,
        structuralHeader,
      }),
    )
    .digest("hex")
    .slice(0, 16);

  const rowCount = aggregated.reduce((s, a) => s + a.dailySpend.length, 0);

  return {
    ok: true,
    rowCount,
    rawPayload: {
      tab,
      // When Supermetrics last refreshed the sheet (UTC ISO). Compared to
      // this pull's pulled_at to learn the daily refresh time and tune the
      // cron to run after it. null if the Drive read failed.
      sheetModifiedTime,
      variantCount: variants.length,
      adCount: aggregated.length,
      sample: aggregated.slice(0, 5).map((a) => ({
        adNumber: a.adNumber,
        adName: a.adName,
        days: a.dailySpend.length,
      })),
      skipped: skipped.slice(0, 50),
      skippedTotal: skipped.length,
    },
    schemaFingerprint: fingerprint,
    async normalize(rawId) {
      await replaceFbAdSpendLiveWindow(aggregated, rawId);
    },
  };
};

// Month-collapse guard thresholds. A completed past month re-pulls at
// ~100% of its prior total (±small attribution drift); the current
// in-progress month only grows pull-over-pull. So a previously-material
// month whose incoming total drops below half is never legitimate — it
// signals a broken/partial source pull (e.g. a Supermetrics query that
// timed out mid-write and left a month hollow). We refuse the overwrite
// rather than wipe good data. Floor of $50k sits well below the smallest
// real month on record (~$154k) and well above hollow/noise (~$26k).
const FB_MONTH_COLLAPSE_RATIO = 0.5;
const FB_MONTH_MATERIAL_FLOOR_USD = 50_000;

/**
 * Pure detector: given incoming and existing per-month totals (keyed
 * "YYYY-MM"), return the months whose incoming total has collapsed
 * against a material existing total. No DB, no I/O — unit-testable.
 */
export function detectCollapsedMonths(
  incomingByMonth: ReadonlyMap<string, number>,
  existingByMonth: ReadonlyMap<string, number>,
): Array<{ month: string; existing: number; incoming: number }> {
  const collapsed: Array<{ month: string; existing: number; incoming: number }> = [];
  for (const [month, existing] of existingByMonth) {
    if (existing < FB_MONTH_MATERIAL_FLOOR_USD) continue;
    const incoming = incomingByMonth.get(month) ?? 0;
    if (incoming < FB_MONTH_COLLAPSE_RATIO * existing) {
      collapsed.push({ month, existing, incoming });
    }
  }
  return collapsed;
}

/**
 * Refresh the live window of `fb_ad_spend_daily` from a freshly-parsed
 * current-year pull, leaving everything below the window untouched.
 *
 * The live tab is the current year, so the earliest date in `aggregated`
 * is the window floor: we delete `spend_date >= liveMin` and re-insert.
 * Pre-window history (one-time import via
 * scripts/import_fb_history_to_db.ts) sits below the floor and survives
 * every cron — this used to be a full-table wipe, which erased imported
 * history daily (the reason the FB_ADS_HISTORY_TABS daily-merge existed
 * and kept breaking).
 *
 * An empty `aggregated` (e.g. a Supermetrics error pull) is a no-op: we
 * do NOT delete, so a bad pull can't wipe good current-year data.
 *
 * A *partially* hollow pull (e.g. a year-to-date Supermetrics query that
 * timed out mid-write, leaving a whole month blank) is NOT empty, so the
 * empty-guard above doesn't catch it. The month-collapse guard below
 * does: if any previously-material month's incoming total has collapsed,
 * we fire a P1 and abort the whole replace rather than overwrite good
 * data with blanks. `opts.alert` is injectable for tests.
 */
export async function replaceFbAdSpendLiveWindow(
  aggregated: ReadonlyArray<FbAdAggregated>,
  rawId: string,
  opts: { alert?: (input: AlertInput) => Promise<unknown> } = {},
): Promise<void> {
  if (aggregated.length === 0) return;

  const liveMinDate = aggregated
    .flatMap((a) => a.dailySpend.map((d) => d.spendDate))
    .reduce((min, d) => (d < min ? d : min));

  // Month-collapse guard: compare incoming per-month totals against what's
  // already in the DB for the same live window. A material month dropping
  // below half = a broken pull; refuse + alert instead of wiping.
  const incomingByMonth = new Map<string, number>();
  for (const ad of aggregated) {
    for (const d of ad.dailySpend) {
      const m = d.spendDate.slice(0, 7);
      incomingByMonth.set(m, (incomingByMonth.get(m) ?? 0) + d.costUsd);
    }
  }
  const existingRows = await db
    .select({
      month: sql<string>`to_char(${fbAdSpendDaily.spendDate}, 'YYYY-MM')`,
      total: sql<number>`sum(${fbAdSpendDaily.costUsd})::float`,
    })
    .from(fbAdSpendDaily)
    .where(gte(fbAdSpendDaily.spendDate, liveMinDate))
    .groupBy(sql`to_char(${fbAdSpendDaily.spendDate}, 'YYYY-MM')`);
  const existingByMonth = new Map<string, number>(
    existingRows.map((r) => [r.month, Number(r.total)]),
  );
  const collapsed = detectCollapsedMonths(incomingByMonth, existingByMonth);
  if (collapsed.length > 0) {
    const alert = opts.alert ?? postAlert;
    const detail = collapsed
      .map((c) => `${c.month}: $${Math.round(c.existing).toLocaleString()} -> $${Math.round(c.incoming).toLocaleString()}`)
      .join("; ");
    await alert({
      severity: "p1",
      channel: "alerts",
      dedupKey: "anomaly:fb_ad_spend_month_collapse",
      title: "FB ad-spend ingest blocked: a month total collapsed",
      fields: {
        blocked_months: collapsed.map((c) => c.month).join(", "),
        detail,
        action:
          "Ingest skipped to protect existing data. Likely a broken/partial source pull. Fix the source, then re-run.",
      },
    });
    return; // ABORT: do not delete or insert.
  }

  await db.transaction(async (tx) => {
    await tx
      .delete(fbAdSpendDaily)
      .where(gte(fbAdSpendDaily.spendDate, liveMinDate));
    // Insert in chunks to keep the parameterized query within Postgres'
    // parameter limit. 7 cols × 1000 rows ≈ 7K params, well under 65k.
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
          sourcePullId: rawId,
        });
      }
    }
    const CHUNK = 1000;
    for (let i = 0; i < flat.length; i += CHUNK) {
      await tx.insert(fbAdSpendDaily).values(flat.slice(i, i + CHUNK));
    }
  });
}
