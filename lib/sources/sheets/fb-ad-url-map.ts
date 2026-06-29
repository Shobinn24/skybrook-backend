import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import { fbAdUrlMap } from "@/lib/db/schema";
import { normalizeFunnelUrl } from "@/lib/domain/fb-product-attribution";
import { logger } from "@/lib/logger";
import type { SourceRunner } from "@/lib/jobs/ingest";
import { buildDriveClient, buildSheetsClient } from "./client";

// ============================================================================
// FB per-ad destination URL map — "FB Ad URL Map" tab of the AppLovin Live
// workbook (Supermetrics: Ad ID x Ad name x [Promoted post / External /
// Destination] URL x Amount spent, last 30 days). A 30-day WINDOW SNAPSHOT,
// FULL delete-replace each ingest. We coalesce the destination URL in priority
// order — Promoted post (~99.8% everdries coverage, fills video/boosted-post
// ads) -> External -> catch-all Destination — and store the first that resolves
// to an everdries.com page (else null). getAllProductsRollup parses ad_name for
// (ad_number, ad_prefix) and uses dest_url -> product (attributeUrlProduct),
// falling back to the ad-name prefix.
//   Row 1: ["Ad name", "Ad ID", "Destination URL", "External destination URL",
//           "Promoted post destination URL", "Cost"]
// ============================================================================

const FB_URL_MAP_DEFAULT_TAB = "FB Ad URL Map";

export type FbUrlMapRow = {
  adId: string;
  adName: string;
  destUrl: string | null;
  costUsd: number;
};

// First candidate that is a real landing page (parses + not a social permalink)
// wins; else null. Broadened from everdries-only so advertorial hosts (e.g.
// womansdailynews) are captured too — product attribution is now a lookup in
// the fb_product_map sheet (by normalized URL), not an everdries-path rule.
function coalesceLandingUrl(candidates: ReadonlyArray<string>): string | null {
  for (const c of candidates) {
    const u = (c ?? "").trim();
    if (u && normalizeFunnelUrl(u) !== null) return u;
  }
  return null;
}

/** Pure parser: grid -> per-ad URL row (deduped by adId, highest-cost wins). No I/O. */
export function parseFbUrlMapSheet(
  grid: ReadonlyArray<ReadonlyArray<unknown>>,
): {
  rows: FbUrlMapRow[];
  skipped: Array<{ rowIdx: number; reason: string }>;
} {
  const skipped: Array<{ rowIdx: number; reason: string }> = [];
  const header = (grid[0] ?? []).map((c) => String(c ?? "").trim().toLowerCase());
  const idx = (name: string) => header.indexOf(name);
  const ai = idx("ad id");
  const ni = idx("ad name");
  const cati = idx("destination url");
  const exti = idx("external destination url");
  const ppi = idx("promoted post destination url");
  const si = header.findIndex((h) => h === "cost" || h.startsWith("amount spent"));
  if (ai < 0 || ni < 0 || si < 0 || (cati < 0 && exti < 0 && ppi < 0)) {
    skipped.push({ rowIdx: 0, reason: `unexpected header: ${JSON.stringify(grid[0] ?? [])}` });
    return { rows: [], skipped };
  }

  // adId -> best (highest-cost) row, so a (rare) duplicate ad_id collapses
  // deterministically and the dominant creative's URL wins.
  const byAd = new Map<string, FbUrlMapRow>();
  for (let r = 1; r < grid.length; r++) {
    const row = grid[r] ?? [];
    const adId = String(row[ai] ?? "").trim();
    if (!adId) continue;
    const adName = String(row[ni] ?? "").trim();
    const cost = Number(String(row[si] ?? "").trim().replace(/[$,]/g, ""));
    const safeCost = Number.isFinite(cost) ? cost : 0;
    // Coalesce in priority order: promoted post -> external -> catch-all.
    const cand = [
      ppi >= 0 ? String(row[ppi] ?? "") : "",
      exti >= 0 ? String(row[exti] ?? "") : "",
      cati >= 0 ? String(row[cati] ?? "") : "",
    ];
    const destUrl = coalesceLandingUrl(cand);
    const existing = byAd.get(adId);
    if (!existing || safeCost > existing.costUsd) {
      byAd.set(adId, { adId, adName, destUrl, costUsd: safeCost });
    }
  }

  return { rows: [...byAd.values()], skipped };
}

/** Full delete-replace (window snapshot). Empty pull is a no-op. */
export async function replaceFbAdUrlMap(
  rows: ReadonlyArray<FbUrlMapRow>,
  rawId: string,
): Promise<void> {
  if (rows.length === 0) return;
  await db.transaction(async (tx) => {
    await tx.delete(fbAdUrlMap);
    const flat = rows.map((r) => ({
      adId: r.adId,
      adName: r.adName,
      destUrl: r.destUrl,
      costUsd: r.costUsd.toFixed(4),
      sourcePullId: rawId,
    }));
    const CHUNK = 1000;
    for (let i = 0; i < flat.length; i += CHUNK) {
      await tx.insert(fbAdUrlMap).values(flat.slice(i, i + CHUNK));
    }
  });
}

export const sheetsFbUrlMapRunner: SourceRunner = async (_batchId) => {
  const sheetId = process.env.FB_URL_MAP_SHEET_ID;
  if (!sheetId) throw new Error("sheets_fb_url_map: missing FB_URL_MAP_SHEET_ID");
  const tab = process.env.FB_URL_MAP_TAB_NAME?.trim() || FB_URL_MAP_DEFAULT_TAB;

  const sheets = buildSheetsClient();
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `'${tab}'!A:H`,
  });
  const grid = (resp.data.values ?? []) as unknown[][];

  let sheetModifiedTime: string | null = null;
  try {
    const drive = buildDriveClient();
    const meta = await drive.files.get({ fileId: sheetId, fields: "modifiedTime", supportsAllDrives: true });
    sheetModifiedTime = meta.data.modifiedTime ?? null;
  } catch (e) {
    logger.warn(
      `sheets_fb_url_map: could not read sheet modifiedTime (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const { rows, skipped } = parseFbUrlMapSheet(grid);
  const resolved = rows.filter((r) => r.destUrl !== null).length;

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
      adCount: rows.length,
      urlResolved: resolved,
      urlResolvedShare: rows.length > 0 ? Number((resolved / rows.length).toFixed(4)) : null,
      skipped: skipped.slice(0, 50),
      skippedTotal: skipped.length,
    },
    schemaFingerprint: fingerprint,
    async normalize(rawId) {
      await replaceFbAdUrlMap(rows, rawId);
    },
  };
};
