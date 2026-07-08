import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import { launchInfo } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import type { SourceRunner } from "@/lib/jobs/ingest";
import { buildDriveClient, buildSheetsClient } from "./client";

// ============================================================================
// Launch Info — the "Launch Info" tab of the FB Product Map workbook
// (owner decision 2026-07-08: the sheet is the source of truth for
// launch-prep facts; the /launches page displays them READ-ONLY and the
// team edits the sheet, not the tool).
//   Row 1: Product | External Name | 5-Pack Price | Colours |
//          Main Composition | Liner Composition | China Photoshoot | Image Tool
// Keyed by trimmed Product name — a small (~10 row) snapshot, full
// delete-replace each ingest. Empty pull is a no-op so a mid-edit or
// broken tab never wipes the table.
// ============================================================================

const LAUNCH_INFO_DEFAULT_TAB = "Launch Info";

export type LaunchInfoRow = {
  product: string;
  externalName: string | null;
  packPriceUsd: number | null;
  colours: string | null;
  mainComposition: string | null;
  linerComposition: string | null;
  chinaPhotoshootUrl: string | null;
  imageToolUrl: string | null;
};

const text = (v: unknown): string | null => {
  const s = String(v ?? "").trim();
  return s === "" ? null : s;
};

const price = (v: unknown): number | null => {
  const n = Number(String(v ?? "").trim().replace(/[$,]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** Pure parser: grid -> launch-info rows. No I/O. */
export function parseLaunchInfoSheet(
  grid: ReadonlyArray<ReadonlyArray<unknown>>,
): {
  rows: LaunchInfoRow[];
  skipped: Array<{ rowIdx: number; reason: string }>;
} {
  const skipped: Array<{ rowIdx: number; reason: string }> = [];
  const header = (grid[0] ?? []).map((c) => String(c ?? "").trim().toLowerCase());
  const col = (name: string) => header.findIndex((h) => h === name);
  const pi = col("product");
  if (pi < 0 || col("main composition") < 0) {
    skipped.push({ rowIdx: 0, reason: `unexpected header: ${JSON.stringify(grid[0] ?? [])}` });
    return { rows: [], skipped };
  }
  const ei = col("external name");
  const $i = header.findIndex((h) => h.endsWith("price"));
  const ci = col("colours");
  const mi = col("main composition");
  const li = col("liner composition");
  const chi = col("china photoshoot");
  const iti = col("image tool");

  const byProduct = new Map<string, LaunchInfoRow>();
  for (let r = 1; r < grid.length; r++) {
    const row = grid[r] ?? [];
    const product = text(row[pi]);
    if (!product) continue; // blank row
    if (byProduct.has(product.toLowerCase())) {
      skipped.push({ rowIdx: r, reason: `duplicate product '${product}' (first row wins)` });
      continue;
    }
    byProduct.set(product.toLowerCase(), {
      product,
      externalName: ei < 0 ? null : text(row[ei]),
      packPriceUsd: $i < 0 ? null : price(row[$i]),
      colours: ci < 0 ? null : text(row[ci]),
      mainComposition: text(row[mi]),
      linerComposition: li < 0 ? null : text(row[li]),
      chinaPhotoshootUrl: chi < 0 ? null : text(row[chi]),
      imageToolUrl: iti < 0 ? null : text(row[iti]),
    });
  }
  return { rows: Array.from(byProduct.values()), skipped };
}

/** Full delete-replace (small snapshot, keyed by product). Empty pull is a
 * no-op so a bad refresh never wipes the table. */
export async function replaceLaunchInfo(
  rows: ReadonlyArray<LaunchInfoRow>,
  rawId: string,
): Promise<void> {
  if (rows.length === 0) return;
  await db.transaction(async (tx) => {
    await tx.delete(launchInfo);
    await tx.insert(launchInfo).values(
      rows.map((r) => ({
        product: r.product,
        externalName: r.externalName,
        packPriceUsd: r.packPriceUsd === null ? null : r.packPriceUsd.toFixed(2),
        colours: r.colours,
        mainComposition: r.mainComposition,
        linerComposition: r.linerComposition,
        chinaPhotoshootUrl: r.chinaPhotoshootUrl,
        imageToolUrl: r.imageToolUrl,
        sourcePullId: rawId,
      })),
    );
  });
}

export const sheetsLaunchInfoRunner: SourceRunner = async (_batchId) => {
  // Lives in the FB Product Map workbook; its own env override for the day
  // the tab moves to a dedicated sheet.
  const sheetId = process.env.LAUNCH_INFO_SHEET_ID || process.env.FB_PRODUCT_MAP_SHEET_ID;
  if (!sheetId) {
    throw new Error("sheets_launch_info: missing LAUNCH_INFO_SHEET_ID / FB_PRODUCT_MAP_SHEET_ID");
  }
  const tab = process.env.LAUNCH_INFO_TAB_NAME?.trim() || LAUNCH_INFO_DEFAULT_TAB;

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
      `sheets_launch_info: could not read sheet modifiedTime (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const { rows, skipped } = parseLaunchInfoSheet(grid);

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
      products: rows.map((r) => r.product),
      withComposition: rows.filter((r) => r.mainComposition).length,
      skipped: skipped.slice(0, 20),
      skippedTotal: skipped.length,
    },
    schemaFingerprint: fingerprint,
    async normalize(rawId) {
      await replaceLaunchInfo(rows, rawId);
    },
  };
};
