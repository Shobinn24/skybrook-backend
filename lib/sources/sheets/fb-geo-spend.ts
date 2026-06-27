import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { fbGeoSpend } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import type { SourceRunner } from "@/lib/jobs/ingest";
import { buildDriveClient, buildSheetsClient } from "./client";

// ============================================================================
// FB per-ad delivery-country spend — "FB Geo Spend" tab of the AppLovin Live
// workbook (Supermetrics: Ad ID x Country code x Amount spent, last 30 days,
// include deleted ads). A 30-day WINDOW SNAPSHOT (no date dimension — a
// daily x country x ad-level query ScriptErrors the interactive pull), so this
// is a FULL delete-replace each ingest. getAllProductsRollup joins this to
// fb_ad_url_map on ad_id to derive a per-(ad_number, ad_prefix) US-vs-non-US
// fraction it applies to the date-flexible daily FB spend.
//   Row 1: ["Ad ID", "Country code", "Cost"]
//   Row N: [<ad id>,  <2-letter code>, <spend>]
// ============================================================================

const FB_GEO_DEFAULT_TAB = "FB Geo Spend";

export type FbGeoRow = {
  adId: string;
  countryCode: string;
  costUsd: number;
};

/** Pure parser: grid -> per-(adId, country) spend. No I/O. */
export function parseFbGeoSheet(
  grid: ReadonlyArray<ReadonlyArray<unknown>>,
): {
  rows: FbGeoRow[];
  skipped: Array<{ rowIdx: number; reason: string }>;
} {
  const skipped: Array<{ rowIdx: number; reason: string }> = [];
  const header = (grid[0] ?? []).map((c) => String(c ?? "").trim().toLowerCase());
  const ai = header.indexOf("ad id");
  const ci = header.findIndex((h) => h === "country code" || h === "country");
  const si = header.findIndex((h) => h === "cost" || h.startsWith("amount spent"));
  if (ai < 0 || ci < 0 || si < 0) {
    skipped.push({ rowIdx: 0, reason: `unexpected header: ${JSON.stringify(grid[0] ?? [])}` });
    return { rows: [], skipped };
  }

  // (adId, country) -> summed cost (Supermetrics already aggregates, but sum
  // defensively in case of duplicate rows).
  const byKey = new Map<string, number>();
  for (let r = 1; r < grid.length; r++) {
    const row = grid[r] ?? [];
    const adId = String(row[ai] ?? "").trim();
    if (!adId) continue; // blank row
    const country = String(row[ci] ?? "").trim().toUpperCase();
    const cost = Number(String(row[si] ?? "").trim().replace(/[$,]/g, ""));
    if (!Number.isFinite(cost) || cost === 0) continue;
    const key = `${adId} ${country}`;
    byKey.set(key, (byKey.get(key) ?? 0) + cost);
  }

  const rows: FbGeoRow[] = [];
  for (const [key, costUsd] of byKey) {
    const [adId, countryCode] = key.split(" ");
    rows.push({ adId, countryCode, costUsd });
  }
  return { rows, skipped };
}

/**
 * Full delete-replace (this is a window snapshot, not date-keyed). Empty pull
 * is a no-op so a bad/empty Supermetrics refresh never wipes the table.
 */
export async function replaceFbGeoSpend(
  rows: ReadonlyArray<FbGeoRow>,
  rawId: string,
): Promise<void> {
  if (rows.length === 0) return;
  await db.transaction(async (tx) => {
    await tx.delete(fbGeoSpend);
    const flat = rows.map((r) => ({
      adId: r.adId,
      countryCode: r.countryCode,
      costUsd: r.costUsd.toFixed(4),
      sourcePullId: rawId,
    }));
    const CHUNK = 1000;
    for (let i = 0; i < flat.length; i += CHUNK) {
      await tx.insert(fbGeoSpend).values(flat.slice(i, i + CHUNK));
    }
  });
}

export const sheetsFbGeoRunner: SourceRunner = async (_batchId) => {
  const sheetId = process.env.FB_GEO_SHEET_ID;
  if (!sheetId) throw new Error("sheets_fb_geo: missing FB_GEO_SHEET_ID");
  const tab = process.env.FB_GEO_TAB_NAME?.trim() || FB_GEO_DEFAULT_TAB;

  const sheets = buildSheetsClient();
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `'${tab}'!A:C`,
  });
  const grid = (resp.data.values ?? []) as unknown[][];

  let sheetModifiedTime: string | null = null;
  try {
    const drive = buildDriveClient();
    const meta = await drive.files.get({ fileId: sheetId, fields: "modifiedTime", supportsAllDrives: true });
    sheetModifiedTime = meta.data.modifiedTime ?? null;
  } catch (e) {
    logger.warn(
      `sheets_fb_geo: could not read sheet modifiedTime (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const { rows, skipped } = parseFbGeoSheet(grid);
  const total = rows.reduce((s, r) => s + r.costUsd, 0);
  const usTotal = rows.filter((r) => r.countryCode === "US").reduce((s, r) => s + r.costUsd, 0);

  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ tab, header: (grid[0] ?? []).map((c) => String(c ?? "").trim()) }))
    .digest("hex")
    .slice(0, 16);

  return {
    ok: true,
    rowCount: rows.length,
    rawPayload: {
      tab,
      sheetModifiedTime,
      adCount: new Set(rows.map((r) => r.adId)).size,
      countryCount: new Set(rows.map((r) => r.countryCode)).size,
      total: Number(total.toFixed(2)),
      usShare: total > 0 ? Number((usTotal / total).toFixed(4)) : null,
      skipped: skipped.slice(0, 50),
      skippedTotal: skipped.length,
    },
    schemaFingerprint: fingerprint,
    async normalize(rawId) {
      await replaceFbGeoSpend(rows, rawId);
    },
  };
};
