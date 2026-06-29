import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import { fbProductMap } from "@/lib/db/schema";
import { canonicalProductLabel, normalizeFunnelUrl } from "@/lib/domain/fb-product-attribution";
import { logger } from "@/lib/logger";
import type { SourceRunner } from "@/lib/jobs/ingest";
import { buildDriveClient, buildSheetsClient } from "./client";

// ============================================================================
// FB Product Map — Jasper-maintained "URL | US/INTL | Product" sheet. The single
// source of truth for All-products FB attribution: each landing URL -> product
// family + funnel region (everdries.com = US, shop.everdries.com = INTL). A full
// delete-replace each ingest. getAllProductsRollup looks each ad's normalized
// dest_url up here; misses fall back to ad-name + geo and are surfaced by the
// fb-url-coverage check. URLs that don't normalize (social permalinks, blanks)
// and rows whose region isn't US/INTL are skipped + reported; a duplicate URL
// that AGREES collapses silently, a CONFLICTING duplicate keeps the first and
// is reported.
//   Row 1: ["URL", "US/INTL", "Product"]
// ============================================================================

const FB_PRODUCT_MAP_DEFAULT_TAB = "Sheet1";

export type FbProductMapRow = {
  normalizedUrl: string;
  rawUrl: string;
  region: "US" | "INTL";
  productLabel: string;
};

/** Pure parser: grid -> per-URL product/region rows (deduped). No I/O. */
export function parseFbProductMapSheet(
  grid: ReadonlyArray<ReadonlyArray<unknown>>,
): {
  rows: FbProductMapRow[];
  skipped: Array<{ rowIdx: number; reason: string }>;
} {
  const skipped: Array<{ rowIdx: number; reason: string }> = [];
  const header = (grid[0] ?? []).map((c) => String(c ?? "").trim().toLowerCase());
  const ui = header.indexOf("url");
  const ri = header.findIndex((h) => h === "us/intl" || h === "region");
  const pi = header.indexOf("product");
  if (ui < 0 || ri < 0 || pi < 0) {
    skipped.push({ rowIdx: 0, reason: `unexpected header: ${JSON.stringify(grid[0] ?? [])}` });
    return { rows: [], skipped };
  }

  const byUrl = new Map<string, FbProductMapRow>();
  for (let r = 1; r < grid.length; r++) {
    const row = grid[r] ?? [];
    const rawUrl = String(row[ui] ?? "").trim();
    if (!rawUrl) continue; // blank line
    const normalizedUrl = normalizeFunnelUrl(rawUrl);
    if (!normalizedUrl) {
      skipped.push({ rowIdx: r, reason: `unmappable url: ${rawUrl}` });
      continue;
    }
    const region = String(row[ri] ?? "").trim().toUpperCase();
    if (region !== "US" && region !== "INTL") {
      skipped.push({ rowIdx: r, reason: `bad region "${region}" for ${rawUrl}` });
      continue;
    }
    const { label: productLabel } = canonicalProductLabel(String(row[pi] ?? ""));
    const next: FbProductMapRow = { normalizedUrl, rawUrl, region, productLabel };
    const existing = byUrl.get(normalizedUrl);
    if (existing) {
      if (existing.region !== next.region || existing.productLabel !== next.productLabel) {
        skipped.push({
          rowIdx: r,
          reason: `conflict on ${normalizedUrl}: kept (${existing.region}/${existing.productLabel}), ignored (${next.region}/${next.productLabel})`,
        });
      }
      continue; // first occurrence wins
    }
    byUrl.set(normalizedUrl, next);
  }

  return { rows: [...byUrl.values()], skipped };
}

/** Full delete-replace (window snapshot). Empty pull is a no-op. */
export async function replaceFbProductMap(
  rows: ReadonlyArray<FbProductMapRow>,
  rawId: string,
): Promise<void> {
  if (rows.length === 0) return;
  await db.transaction(async (tx) => {
    await tx.delete(fbProductMap);
    const flat = rows.map((r) => ({
      normalizedUrl: r.normalizedUrl,
      rawUrl: r.rawUrl,
      region: r.region,
      productLabel: r.productLabel,
      sourcePullId: rawId,
    }));
    const CHUNK = 1000;
    for (let i = 0; i < flat.length; i += CHUNK) {
      await tx.insert(fbProductMap).values(flat.slice(i, i + CHUNK));
    }
  });
}

export const sheetsFbProductMapRunner: SourceRunner = async (_batchId) => {
  const sheetId = process.env.FB_PRODUCT_MAP_SHEET_ID;
  if (!sheetId) throw new Error("sheets_fb_product_map: missing FB_PRODUCT_MAP_SHEET_ID");
  const tab = process.env.FB_PRODUCT_MAP_TAB_NAME?.trim() || FB_PRODUCT_MAP_DEFAULT_TAB;

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
      `sheets_fb_product_map: could not read sheet modifiedTime (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const { rows, skipped } = parseFbProductMapSheet(grid);

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
      mappedUrls: rows.length,
      skipped: skipped.slice(0, 50),
      skippedTotal: skipped.length,
    },
    schemaFingerprint: fingerprint,
    async normalize(rawId) {
      await replaceFbProductMap(rows, rawId);
    },
  };
};
