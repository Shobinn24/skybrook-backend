import { createHash } from "node:crypto";
import { gte } from "drizzle-orm";
import { db } from "@/lib/db";
import { fbCampaignDaily } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import type { SourceRunner } from "@/lib/jobs/ingest";
import { buildDriveClient, buildSheetsClient } from "./client";

// ============================================================================
// FB campaign-level daily spend + purchase value — "Campaign Daily" tab.
// ============================================================================
// Source: the FB Ads Tracker sheet (FB_ADS_SHEET_ID), tab "Campaign Daily".
// A rolling last-14-days Supermetrics query in LONG format:
//   Row 1: ["Date", "Campaign name", "Cost", "Website purchases conversion value"]
//   Row N: [YYYY-MM-DD, <campaign>, <spend>, <value>]
//
// Campaign names land VERBATIM; bucketing happens at read time via
// lib/domain/campaign-buckets.ts. Purchase value can be blank on zero-
// conversion days -> 0. Windowed delete-replace per pull (delete from the
// earliest pulled date, re-insert) because FB restates the trailing ~2 days;
// frozen history below the window survives. Empty pull is a no-op so a bad
// Supermetrics refresh can never wipe data.
// ============================================================================

const FB_CAMPAIGNS_DEFAULT_TAB = "Campaign Daily";
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export type CampaignDailyRow = {
  campaignName: string;
  spendDate: string;
  costUsd: number;
  purchaseValueUsd: number;
};

/**
 * Pure parser: long-format grid -> per-(campaign, date) rows. No I/O.
 * Duplicate (campaign, date) rows are summed defensively (Supermetrics
 * shouldn't emit them at campaign grain, but a merge hiccup must not
 * violate the table's PK).
 */
export function parseCampaignSheet(grid: ReadonlyArray<ReadonlyArray<unknown>>): {
  rows: CampaignDailyRow[];
  skipped: Array<{ rowIdx: number; reason: string }>;
} {
  const skipped: Array<{ rowIdx: number; reason: string }> = [];
  const header = (grid[0] ?? []).map((c) => String(c ?? "").trim().toLowerCase());
  const di = header.indexOf("date");
  const ni = header.indexOf("campaign name");
  const si = header.findIndex((h) => h === "cost" || h.startsWith("amount spent"));
  const vi = header.findIndex((h) => h.startsWith("website purchases conversion value"));
  if (di < 0 || ni < 0 || si < 0 || vi < 0) {
    skipped.push({ rowIdx: 0, reason: `unexpected header: ${JSON.stringify(grid[0] ?? [])}` });
    return { rows: [], skipped };
  }

  const byKey = new Map<string, CampaignDailyRow>();
  for (let r = 1; r < grid.length; r++) {
    const row = grid[r] ?? [];
    const campaignName = String(row[ni] ?? "").trim();
    const spendDate = String(row[di] ?? "").trim().slice(0, 10);
    if (!ISO_DATE.test(spendDate)) {
      skipped.push({ rowIdx: r, reason: `bad date: ${String(row[di] ?? "")}` });
      continue;
    }
    if (!campaignName) {
      skipped.push({ rowIdx: r, reason: "empty campaign name" });
      continue;
    }
    const costUsd = Number(row[si]);
    if (!Number.isFinite(costUsd)) {
      skipped.push({ rowIdx: r, reason: `bad cost: ${String(row[si] ?? "")}` });
      continue;
    }
    const valueRaw = row[vi];
    const purchaseValueUsd =
      valueRaw === "" || valueRaw === null || valueRaw === undefined ? 0 : Number(valueRaw);
    if (!Number.isFinite(purchaseValueUsd)) {
      skipped.push({ rowIdx: r, reason: `bad purchase value: ${String(valueRaw)}` });
      continue;
    }
    const key = `${campaignName}|${spendDate}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.costUsd += costUsd;
      existing.purchaseValueUsd += purchaseValueUsd;
    } else {
      byKey.set(key, { campaignName, spendDate, costUsd, purchaseValueUsd });
    }
  }
  return { rows: [...byKey.values()], skipped };
}

/**
 * Windowed delete-replace: deletes spend_date >= the earliest pulled date,
 * then re-inserts. Empty pull is a no-op (a bad/empty Supermetrics refresh
 * must never wipe existing data).
 */
export async function replaceCampaignDailyWindow(
  rows: ReadonlyArray<CampaignDailyRow>,
  rawId: string,
): Promise<void> {
  if (rows.length === 0) return;
  const minDate = rows.reduce((min, r) => (r.spendDate < min ? r.spendDate : min), rows[0].spendDate);
  await db.transaction(async (tx) => {
    await tx.delete(fbCampaignDaily).where(gte(fbCampaignDaily.spendDate, minDate));
    const flat = rows.map((r) => ({
      campaignName: r.campaignName,
      spendDate: r.spendDate,
      costUsd: r.costUsd.toFixed(4),
      purchaseValueUsd: r.purchaseValueUsd.toFixed(4),
      sourcePullId: rawId,
    }));
    const CHUNK = 1000;
    for (let i = 0; i < flat.length; i += CHUNK) {
      await tx.insert(fbCampaignDaily).values(flat.slice(i, i + CHUNK));
    }
  });
}

export const sheetsFbCampaignsRunner: SourceRunner = async (_batchId) => {
  const sheetId = process.env.FB_ADS_SHEET_ID;
  if (!sheetId) throw new Error("sheets_fb_campaigns: missing FB_ADS_SHEET_ID");
  const tab = process.env.FB_CAMPAIGNS_TAB_NAME?.trim() || FB_CAMPAIGNS_DEFAULT_TAB;

  const sheets = buildSheetsClient();
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `'${tab}'!A:D`,
  });
  const grid = (resp.data.values ?? []) as unknown[][];

  // Best-effort refresh evidence, same as the other sheet sources.
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
      `sheets_fb_campaigns: could not read sheet modifiedTime (non-fatal): ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }

  const { rows, skipped } = parseCampaignSheet(grid);

  // Header-shape fingerprint only — row count grows daily.
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ tab, header: (grid[0] ?? []).map((c) => String(c ?? "").trim()) }))
    .digest("hex")
    .slice(0, 16);

  const dates = rows.map((r) => r.spendDate).sort();
  return {
    ok: true,
    rowCount: rows.length,
    rawPayload: {
      tab,
      sheetModifiedTime,
      campaignCount: new Set(rows.map((r) => r.campaignName)).size,
      dateRange: rows.length > 0 ? { min: dates[0], max: dates[dates.length - 1] } : null,
      totalCost: Number(rows.reduce((s, r) => s + r.costUsd, 0).toFixed(2)),
      skipped: skipped.slice(0, 50),
      skippedTotal: skipped.length,
    },
    schemaFingerprint: fingerprint,
    async normalize(rawId) {
      await replaceCampaignDailyWindow(rows, rawId);
    },
  };
};
