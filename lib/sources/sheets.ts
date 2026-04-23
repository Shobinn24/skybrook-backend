import { createHash } from "node:crypto";
import { google, type sheets_v4 } from "googleapis";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { skus, stockSnapshots } from "@/lib/db/schema";
import type { SourceRunner } from "@/lib/jobs/ingest";
import { toEstDate } from "@/lib/tz";

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

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

// 0-based column index → A1 letter. 0='A', 25='Z', 26='AA', 701='ZZ', 702='AAA'.
export function colIndexToA1(idx: number): string {
  if (!Number.isInteger(idx) || idx < 0) throw new Error(`colIndexToA1: bad index ${idx}`);
  let n = idx;
  let out = "";
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

// Parse a header cell like "21/Apr" or "21 Apr" → { day, month }. Returns null if unparseable.
export function parseDayMonth(cell: unknown): { day: number; month: number } | null {
  const s = String(cell ?? "").trim();
  if (!s) return null;
  const m = s.match(/^(\d{1,2})[\s/\-]([A-Za-z]{3,})$/);
  if (!m) return null;
  const day = Number(m[1]);
  const month = MONTHS[m[2].toLowerCase()];
  if (!month || day < 1 || day > 31) return null;
  return { day, month };
}

// Walk a date-header row and assign a year to each parseable cell, anchoring
// on the RIGHTMOST cell (which is "today" in Scott's daily-update flow).
// Anchor year = todayYmd's year if the rightmost day/month is on or before
// today, else todayYmd's year - 1 (the rightmost belongs to the prior year).
// We then walk leftward, decrementing the year whenever the month INCREASES
// (a Jan→Dec jump means we crossed back into the previous year).
export function walkDateHeaders(
  headers: ReadonlyArray<unknown>,
  todayYmd: string
): Array<{ colIdx: number; date: string }> {
  const parsed: Array<{ colIdx: number; day: number; month: number }> = [];
  for (let i = 0; i < headers.length; i++) {
    const dm = parseDayMonth(headers[i]);
    if (dm) parsed.push({ colIdx: i, ...dm });
  }
  if (parsed.length === 0) return [];

  const todayYear = Number(todayYmd.slice(0, 4));
  const todayMonth = Number(todayYmd.slice(5, 7));
  const todayDay = Number(todayYmd.slice(8, 10));

  const last = parsed[parsed.length - 1];
  let year =
    last.month > todayMonth || (last.month === todayMonth && last.day > todayDay)
      ? todayYear - 1
      : todayYear;

  const fmt = (y: number, m: number, d: number) =>
    `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

  const out: Array<{ colIdx: number; date: string }> = new Array(parsed.length);
  out[parsed.length - 1] = { colIdx: last.colIdx, date: fmt(year, last.month, last.day) };
  let prevMonth = last.month;
  for (let i = parsed.length - 2; i >= 0; i--) {
    const c = parsed[i];
    if (c.month > prevMonth) year -= 1;
    prevMonth = c.month;
    out[i] = { colIdx: c.colIdx, date: fmt(year, c.month, c.day) };
  }
  return out;
}

// Of all parsed-date columns, return the rightmost one whose date ≤ todayYmd.
export function pickLatestColumn(
  parsed: ReadonlyArray<{ colIdx: number; date: string }>,
  todayYmd: string
): { colIdx: number; date: string } | null {
  let pick: { colIdx: number; date: string } | null = null;
  for (const p of parsed) {
    if (p.date <= todayYmd && (pick === null || p.date >= pick.date)) {
      pick = p;
    }
  }
  return pick;
}

export function parseQty(v: unknown): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? Math.trunc(v) : null;
  const s = String(v).trim().replace(/,/g, "");
  if (!s || s === "-") return null;
  const n = Number(s);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

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
      const sku = String(skuCol[r]?.[0] ?? "").trim();
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

  const scopes = ["https://www.googleapis.com/auth/spreadsheets.readonly"];
  const jsonContent = process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
  const keyFile = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  let auth;
  if (jsonContent) {
    auth = new google.auth.GoogleAuth({ credentials: JSON.parse(jsonContent), scopes });
  } else if (keyFile) {
    auth = new google.auth.GoogleAuth({ keyFile, scopes });
  } else {
    throw new Error(
      "sheets_inventory: set GOOGLE_APPLICATION_CREDENTIALS (file path) or GOOGLE_SERVICE_ACCOUNT_JSON (content)"
    );
  }
  const sheets = google.sheets({ version: "v4", auth });

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
