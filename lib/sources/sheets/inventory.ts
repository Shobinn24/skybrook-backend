import { createHash } from "node:crypto";
import type { sheets_v4 } from "googleapis";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { skus, stockSnapshots } from "@/lib/db/schema";
import type { SourceRunner } from "@/lib/jobs/ingest";
import { toEstDate } from "@/lib/tz";
import { buildSheetsClient } from "./client";
import {
  canonicalizeInventorySku,
  colIndexToA1,
  parseQty,
  pickLatestColumn,
  walkDateHeaders,
} from "./parse-helpers";

// 6 inventory tabs in the New Daily Inventory Log: 3 brands × 2 warehouses.
// Tab names confirmed by Scott 2026-04-23.
const INVENTORY_TABS: ReadonlyArray<{
  tab: string;
  productLine: "Main" | "HF" | "Sec";
  location: "US" | "CN";
}> = [
  { tab: "EV Main US", productLine: "Main", location: "US" },
  { tab: "EV HF US", productLine: "HF", location: "US" },
  { tab: "EV Sec US", productLine: "Sec", location: "US" },
  { tab: "EV Main CN", productLine: "Main", location: "CN" },
  { tab: "EV HF CN", productLine: "HF", location: "CN" },
  { tab: "EV Sec CN", productLine: "Sec", location: "CN" },
];

export type TabSnapshot = {
  tab: string;
  productLine: "Main" | "HF" | "Sec";
  location: "US" | "CN";
  snapshotDate: string;
  rows: Array<{ sku: string; onHand: number }>;
};

export type FetchResult = {
  snapshots: TabSnapshot[];
  headerSummary: Record<string, string>;
};

// Two-phase fetch: pull header row from each tab to find the latest date column,
// then pull just (col A, col X) per tab in a single batch call. Avoids reading
// the full grid (some tabs are 1000+ columns wide).
export async function fetchInventorySnapshots(input: {
  sheets: sheets_v4.Sheets;
  spreadsheetId: string;
  todayYmd: string;
}): Promise<FetchResult> {
  const { sheets, spreadsheetId, todayYmd } = input;

  const headerResp = await sheets.spreadsheets.values.batchGet({
    spreadsheetId,
    ranges: INVENTORY_TABS.map((t) => `'${t.tab}'!1:1`),
  });
  const headerRows = (headerResp.data.valueRanges ?? []).map(
    (vr) => (vr.values?.[0] ?? []) as unknown[]
  );

  const headerSummary: Record<string, string> = {};
  type Pending = {
    tab: string;
    productLine: "Main" | "HF" | "Sec";
    location: "US" | "CN";
    snapshotDate: string;
    skuRangeIdx: number;
    qtyRangeIdx: number;
  };
  const dataRanges: string[] = [];
  const pending: (Pending | null)[] = [];

  for (let i = 0; i < INVENTORY_TABS.length; i++) {
    const t = INVENTORY_TABS[i];
    const parsed = walkDateHeaders(headerRows[i] ?? [], todayYmd);
    const latest = pickLatestColumn(parsed, todayYmd);
    if (!latest) {
      pending.push(null);
      headerSummary[t.tab] = "no parseable date column ≤ today";
      continue;
    }
    const colLetter = colIndexToA1(latest.colIdx);
    headerSummary[t.tab] = `${latest.date} → col ${colLetter}`;
    pending.push({
      tab: t.tab,
      productLine: t.productLine,
      location: t.location,
      snapshotDate: latest.date,
      skuRangeIdx: dataRanges.length,
      qtyRangeIdx: dataRanges.length + 1,
    });
    dataRanges.push(`'${t.tab}'!A2:A`);
    dataRanges.push(`'${t.tab}'!${colLetter}2:${colLetter}`);
  }

  if (dataRanges.length === 0) {
    return { snapshots: [], headerSummary };
  }

  const dataResp = await sheets.spreadsheets.values.batchGet({
    spreadsheetId,
    ranges: dataRanges,
  });
  const dataValues = dataResp.data.valueRanges ?? [];

  const snapshots: TabSnapshot[] = [];
  for (const meta of pending) {
    if (!meta) continue;
    const skuCol = (dataValues[meta.skuRangeIdx]?.values ?? []) as unknown[][];
    const qtyCol = (dataValues[meta.qtyRangeIdx]?.values ?? []) as unknown[][];
    const len = Math.min(skuCol.length, qtyCol.length);
    const rows: Array<{ sku: string; onHand: number }> = [];
    for (let r = 0; r < len; r++) {
      // Inventory sheet has historically mixed cases (`EV-mixed-xxs` next to
      // `ev-hw-xxs`) and dash-form pack tokens (`ev-9055-hf-5-l` instead of
      // the canonical `ev-9055-hf-5x-l` Shopify daily_sales lands on after
      // `b89fbd6`/`9641126`). Lowercase + canonicalize at parse so `skus`
      // and `stock_snapshots` end up in the same canonical form as
      // `daily_sales`, preventing case- or dash-form-mirrored orphans.
      const sku = canonicalizeInventorySku(String(skuCol[r]?.[0] ?? ""));
      const qty = parseQty(qtyCol[r]?.[0]);
      if (!sku || qty === null) continue;
      rows.push({ sku, onHand: qty });
    }
    snapshots.push({
      tab: meta.tab,
      productLine: meta.productLine,
      location: meta.location,
      snapshotDate: meta.snapshotDate,
      rows,
    });
  }

  return { snapshots, headerSummary };
}

export const sheetsInventoryRunner: SourceRunner = async (_batchId) => {
  const sheetId = process.env.INVENTORY_SHEET_ID;
  if (!sheetId) throw new Error("sheets_inventory: missing INVENTORY_SHEET_ID");

  const sheets = buildSheetsClient();
  const todayYmd = toEstDate(new Date());

  const { snapshots, headerSummary } = await fetchInventorySnapshots({
    sheets,
    spreadsheetId: sheetId,
    todayYmd,
  });

  const totalRows = snapshots.reduce((sum, s) => sum + s.rows.length, 0);
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(headerSummary))
    .digest("hex")
    .slice(0, 16);

  return {
    ok: true,
    rowCount: totalRows,
    rawPayload: {
      headerSummary,
      tabs: snapshots.map((s) => ({
        tab: s.tab,
        snapshotDate: s.snapshotDate,
        rowCount: s.rows.length,
      })),
    },
    schemaFingerprint: fingerprint,
    async normalize(rawId) {
      // Legacy mixed-case / dash-form / 2xl-alias SKU cleanup used to run
      // here on every cron (55 DELETE statements). Those rows have been
      // gone for weeks — the sweep now lives in
      // scripts/cleanup_legacy_sku_rows.ts, to be run once after any
      // canonicalization-rule change instead of on the hot path.
      for (const snap of snapshots) {
        for (const r of snap.rows) {
          await db
            .insert(skus)
            .values({
              sku: r.sku,
              productName: r.sku,
              productLine: snap.productLine,
              firstSeenAt: snap.snapshotDate,
              active: true,
            })
            .onConflictDoUpdate({
              target: skus.sku,
              set: {
                productLine: sql`excluded.product_line`,
                active: sql`true`,
              },
            });

          await db
            .insert(stockSnapshots)
            .values({
              sku: r.sku,
              location: snap.location,
              snapshotDate: snap.snapshotDate,
              onHand: r.onHand,
              sourcePullId: rawId,
            })
            .onConflictDoUpdate({
              target: [stockSnapshots.sku, stockSnapshots.location, stockSnapshots.snapshotDate],
              set: {
                onHand: sql`excluded.on_hand`,
                sourcePullId: rawId,
              },
            });
        }
      }
    },
  };
};
