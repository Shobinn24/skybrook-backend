import { createHash } from "node:crypto";
import { google, type sheets_v4 } from "googleapis";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  adSpendDaily,
  fbAdSpendDaily,
  incomingShipments,
  skus,
  stockSnapshots,
} from "@/lib/db/schema";
import { decomposePackSku } from "@/lib/domain/sku-pack";
import { extractMarketers } from "@/lib/domain/fb-marketers";
import type { SourceRunner } from "@/lib/jobs/ingest";
import { toEstDate } from "@/lib/tz";

// Take the dash→x cosmetic rename from `decomposePackSku` but skip the
// 10/15 → 5x decomposition. Scott tracks inventory at the 5-pack level
// (2026-04-28), so a 10-pack inventory row would be misformatted source
// data; rather than silently halve/double quantities we leave it alone
// and let it surface as activeZeroSales for human investigation.
// Exported for cross-source canonicalization (cost sheet sync, etc.) so
// every place that joins SKUs to `skus` lands on the same canonical form.
export function canonicalizeInventorySku(rawSku: string): string {
  const lower = rawSku.trim().toLowerCase();
  const dec = decomposePackSku(lower);
  return dec && dec.multiplier === 1 ? dec.canonicalSku : lower;
}

const INCOMING_TAB = "Incoming_new";

function buildSheetsClient() {
  const scopes = ["https://www.googleapis.com/auth/spreadsheets.readonly"];
  const jsonContent = process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
  const keyFile = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  if (jsonContent) {
    return google.sheets({
      version: "v4",
      auth: new google.auth.GoogleAuth({ credentials: JSON.parse(jsonContent), scopes }),
    });
  }
  if (keyFile) {
    return google.sheets({
      version: "v4",
      auth: new google.auth.GoogleAuth({ keyFile, scopes }),
    });
  }
  throw new Error(
    "sheets: set GOOGLE_APPLICATION_CREDENTIALS (file path) or GOOGLE_SERVICE_ACCOUNT_JSON (content)"
  );
}

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
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
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
      // One-time idempotent legacy cleanup: prior runs persisted mixed-case
      // SKUs (`EV-mixed-xxs` alongside `ev-hw-xxs`) because the inventory
      // sheet itself mixes cases. After Shopify lowercased its side at parse
      // (`b89fbd6`), Postgres `=` left those legacy uppercase rows orphaned
      // from `daily_sales`. Now that this runner also lowercases at parse,
      // the only uppercase rows are stale — drop them. Derived tables
      // (sales_velocity / days_of_stock / sustainability_flags) are
      // upsert-only so their stale uppercase rows linger unless purged here;
      // Phase 2 rewrites the canonical lowercase rows after this runs.
      // After the first successful run, all queries match nothing → no-op.
      await db.execute(sql`DELETE FROM stock_snapshots WHERE sku ~ '[A-Z]'`);
      await db.execute(sql`DELETE FROM sales_velocity WHERE sku ~ '[A-Z]'`);
      await db.execute(sql`DELETE FROM days_of_stock WHERE sku ~ '[A-Z]'`);
      await db.execute(sql`DELETE FROM sustainability_flags WHERE sku ~ '[A-Z]'`);
      await db.execute(sql`DELETE FROM skus WHERE sku ~ '[A-Z]'`);

      // Same shape of idempotent legacy cleanup for dash-form pack tokens
      // and the `-2xl` size alias (canonicalized to `-xxl`).
      // The inventory sheet historically wrote `ev-9055-hf-5-3xl` (no `x`);
      // after `9641126` lowered the daily_sales side to canonical
      // `ev-9055-hf-5x-3xl`, the dash-form `skus`/`stock_snapshots` rows
      // mirror the orphaning pattern that the casing fix just resolved.
      // Now that this runner canonicalizes at parse, dash-form rows are
      // stale. Drop them only for 1- and 5-pack tokens — 10/15-pack tokens
      // are intentionally NOT decomposed at the inventory parser, so
      // deleting them would create a re-insert/delete loop. Same idempotent
      // behavior: after one successful run, queries match nothing.
      // Size-alias patterns are similarly narrowed to 1/5-pack rows: 10/15
      // packs aren't decomposed here, so wide `-2xl` cleanup would loop.
      const LEGACY_INVENTORY_PATTERNS = [
        "ev-%-1-%", "ev-%-5-%",        // dash-form pack tokens (1/5)
        "ev-mens-3-%", "ev-cb-3-%",    // dash-form 3-pack mens/cb
        "ev-hw-hf-3-%", "ev-og-hf-3-%", // dash-form 3-pack hw-hf/og-hf
        "ev-%-1x-2xl", "ev-%-5x-2xl",  // 2xl size alias on 1/5-pack SKUs
      ];
      for (const p of LEGACY_INVENTORY_PATTERNS) {
        await db.execute(sql`DELETE FROM stock_snapshots WHERE sku LIKE ${p}`);
        await db.execute(sql`DELETE FROM sales_velocity WHERE sku LIKE ${p}`);
        await db.execute(sql`DELETE FROM days_of_stock WHERE sku LIKE ${p}`);
        await db.execute(sql`DELETE FROM sustainability_flags WHERE sku LIKE ${p}`);
        await db.execute(sql`DELETE FROM skus WHERE sku LIKE ${p}`);
      }

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

// ============================================================================
// Incoming POs (sheet `Incoming_new` in the Monthly Secondary Order spreadsheet)
//
// Layout — horizontally pivoted, one column per PO:
//   Row 1 (idx 0): warehouse banner. Merged cells; only first cell has value.
//                  E.g. "US" at col F (idx 5), "INTL" at col R (idx 17).
//   Row 2 (idx 1): month grouping (JANUARY/FEBRUARY/etc).
//   Row 3 (idx 2): PO label per column (e.g. "KAI Sec Mar26", "KAI 23").
//   Row 4 (idx 3): ESTIMATED ARRIVAL date per column. Freeform —
//                  "17 Mar 2026" / "9K - 17 Mar 2026\nRest - 24 Apr 2026" /
//                  "28 Feb, 5,13,17,17,18 Mar\n3,17 Apr" (partial year, skip).
//   Row 5 (idx 4): Total qty.
//   Row 6 (idx 5): "Product / SKU Breakdown / ok" header.
//   Rows 7+ (idx 6+): SKU rows. Col A = product family (or empty for continuation),
//                     col C = SKU, col D+ = per-PO qty.
// ============================================================================

// Extract every "DD Mon YYYY" pattern from a freeform arrival cell.
// Returns ISO YYYY-MM-DD strings, in cell order.
export function extractArrivalDates(cell: unknown): string[] {
  const s = String(cell ?? "");
  const out: string[] = [];
  const re = /(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const day = Number(m[1]);
    const month = MONTHS[m[2].toLowerCase()];
    const year = Number(m[3]);
    if (!month || day < 1 || day > 31) continue;
    out.push(`${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`);
  }
  return out;
}

// Pick the LATEST arrival date for projection — most pessimistic ETA.
// Returns null if no valid date in the cell.
export function pickArrivalDate(cell: unknown): string | null {
  const dates = extractArrivalDates(cell);
  if (dates.length === 0) return null;
  return dates.reduce((a, b) => (a > b ? a : b));
}

// Find the column index where INTL POs begin. Anything to the left is US.
// Returns Infinity if no INTL banner — implies all columns are US.
export function findIntlBoundary(banner: ReadonlyArray<unknown>): number {
  for (let i = 0; i < banner.length; i++) {
    const v = String(banner[i] ?? "").trim().toUpperCase();
    if (v === "INTL" || v === "INTERNATIONAL") return i;
  }
  return Number.POSITIVE_INFINITY;
}

// Find the first row whose column C cell equals `label` (case-insensitive, trimmed).
// Returns -1 if not found. Bounded scan — header rows are always near the top.
export function findHeaderRowByColC(
  grid: ReadonlyArray<ReadonlyArray<unknown>>,
  label: string,
): number {
  const target = label.trim().toUpperCase();
  const limit = Math.min(grid.length, 30);
  for (let i = 0; i < limit; i++) {
    if (String(grid[i]?.[2] ?? "").trim().toUpperCase() === target) return i;
  }
  return -1;
}

// Scan rows 0..maxRowExclusive for an "INTL"/"INTERNATIONAL" cell and return its
// column index. Used to locate the warehouse banner whether it lives on its own
// row (legacy layout) or is co-located with the Total row (current layout).
export function findIntlBoundaryInGrid(
  grid: ReadonlyArray<ReadonlyArray<unknown>>,
  maxRowExclusive: number,
): number {
  const stop = Math.min(grid.length, Math.max(maxRowExclusive, 0));
  for (let r = 0; r < stop; r++) {
    const row = grid[r] ?? [];
    for (let c = 0; c < row.length; c++) {
      const v = String(row[c] ?? "").trim().toUpperCase();
      if (v === "INTL" || v === "INTERNATIONAL") return c;
    }
  }
  return Number.POSITIVE_INFINITY;
}

export type IncomingShipment = {
  sku: string;
  destination: "US" | "CN";
  shipmentName: string;
  quantity: number;
  expectedArrival: string;
  status: "po" | "arrived";
  sourceRowRef: string;
};

export type ParseIncomingResult = {
  rows: IncomingShipment[];
  poColumns: Array<{ colIdx: number; label: string; date: string | null; destination: "US" | "CN" }>;
  skippedColumns: Array<{ colIdx: number; label: string; reason: string }>;
};

// Pure parser — takes the raw grid and produces incoming-shipment rows.
// All emitted rows have status='po'; receipt-driven reconciliation determines
// arrival at read time (see `incoming_receipts` table). `todayYmd` is kept on
// the signature for callers that may surface "ETA passed Nd ago" diagnostics
// downstream, but it no longer mutates row status.
//
// Layout discovery is header-driven (col C contains stable row labels:
// "SHIPMENT NAME", "ESTIMATED ARRIVAL", "Total"). This survives Scott
// inserting/removing rows above the data block — which happened 2026-04-28
// when the banner row was merged into the Total row.
export function parseIncomingGrid(grid: unknown[][], _todayYmd: string): ParseIncomingResult {
  const labelRowIdx = findHeaderRowByColC(grid, "SHIPMENT NAME");
  const arrivalRowIdx = findHeaderRowByColC(grid, "ESTIMATED ARRIVAL");
  const totalRowIdx = findHeaderRowByColC(grid, "Total");

  if (labelRowIdx < 0 || arrivalRowIdx < 0 || totalRowIdx < 0) {
    return {
      rows: [],
      poColumns: [],
      skippedColumns: [
        {
          colIdx: -1,
          label: "(layout)",
          reason: `missing header rows in col C: SHIPMENT NAME=${labelRowIdx} ESTIMATED ARRIVAL=${arrivalRowIdx} Total=${totalRowIdx}`,
        },
      ],
    };
  }

  const labelRow = grid[labelRowIdx] ?? [];
  const arrivalRow = grid[arrivalRowIdx] ?? [];
  // Banner cell (US/INTL) may be on its own row (legacy) or merged with the
  // Total row (current). Scan all header rows up to and including Total.
  const intlBoundary = findIntlBoundaryInGrid(grid, totalRowIdx + 1);
  // SKU rows start somewhere after Total. Empty col-C rows are naturally
  // skipped by the SKU loop, so any header rows between Total and the first
  // SKU don't need explicit handling.
  const SKU_DATA_START_ROW = totalRowIdx + 1;
  const poColumns: ParseIncomingResult["poColumns"] = [];
  const skippedColumns: ParseIncomingResult["skippedColumns"] = [];

  // Cols A–C carry the product family / identifier / SKU; PO columns start at D.
  for (let c = 3; c < labelRow.length; c++) {
    const label = String(labelRow[c] ?? "").trim();
    if (!label) continue;
    // Scott uses INTL in the sheet but Skybrook routes only US/CN. INTL → CN.
    const destination: "US" | "CN" = c >= intlBoundary ? "CN" : "US";
    const date = pickArrivalDate(arrivalRow[c]);
    if (!date) {
      skippedColumns.push({
        colIdx: c,
        label,
        reason: `unparseable arrival cell: ${String(arrivalRow[c] ?? "(empty)").slice(0, 60)}`,
      });
      continue;
    }
    poColumns.push({ colIdx: c, label, date, destination });
  }

  const rows: IncomingShipment[] = [];
  for (let r = SKU_DATA_START_ROW; r < grid.length; r++) {
    const row = grid[r] ?? [];
    // Lowercase + dash→x pack canonicalization to match daily_sales
    // (`b89fbd6`/`9641126`).
    const sku = canonicalizeInventorySku(String(row[2] ?? "")); // col C
    if (!sku) continue;
    for (const po of poColumns) {
      const qty = parseQty(row[po.colIdx]);
      if (qty === null || qty <= 0) continue;
      rows.push({
        sku,
        destination: po.destination,
        shipmentName: po.label,
        quantity: qty,
        expectedArrival: po.date!,
        // Always 'po'. Receipt confirmations live in `incoming_receipts` and
        // drive display status (pending / overdue / received) at read time.
        // Pre-2026-05-05 we flipped to 'arrived' once ETA passed, but that
        // hid POs from /incoming before stock had actually been counted.
        status: "po",
        sourceRowRef: `${INCOMING_TAB}!${colIndexToA1(po.colIdx)}${r + 1}`,
      });
    }
  }

  return { rows, poColumns, skippedColumns };
}

export const sheetsIncomingRunner: SourceRunner = async (_batchId) => {
  const sheetId = process.env.INCOMING_PO_SHEET_ID;
  if (!sheetId) throw new Error("sheets_incoming: missing INCOMING_PO_SHEET_ID");

  const sheets = buildSheetsClient();
  const todayYmd = toEstDate(new Date());

  // Read the full Incoming_new tab — bounded (~325 rows × ~35 cols), one round trip.
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `'${INCOMING_TAB}'!A1:AG400`,
  });
  const grid = (resp.data.values ?? []) as unknown[][];

  const { rows, poColumns, skippedColumns } = parseIncomingGrid(grid, todayYmd);

  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ poCount: poColumns.length, intlBoundary: findIntlBoundary(grid[0] ?? []) }))
    .digest("hex")
    .slice(0, 16);

  return {
    ok: true,
    rowCount: rows.length,
    rawPayload: {
      poColumns: poColumns.map(({ colIdx, label, date, destination }) => ({ colIdx, label, date, destination })),
      skippedColumns,
      sample: rows.slice(0, 5),
    },
    schemaFingerprint: fingerprint,
    async normalize(rawId) {
      // Sheet is the canonical (and only) source of incoming POs in MVP.
      // Truncate-replace per pull keeps state in sync without needing a unique
      // constraint on (sku, shipmentName, expectedArrival, destination). When
      // a second source lands later, switch to delete-by-source-id.
      //
      // Upsert SKUs into the catalog as we go (Scott 2026-05-07): a SKU that
      // appears only in incoming (ordered but not yet stocked, e.g. a brand-
      // new variant being launched) was previously never in the `skus` table,
      // which made runLaunchAutoPopulate's innerJoin silently drop it. Upsert
      // here so the SKU enters the catalog the moment it's ordered. The
      // downstream syncProductNames job will rewrite the default productName
      // (the SKU itself) into a friendly label via deriveProductName.
      await db.transaction(async (tx) => {
        await tx.delete(incomingShipments);
        if (rows.length === 0) return;
        const today = new Date().toISOString().slice(0, 10);
        const seenSkus = new Set<string>();
        for (const row of rows) {
          if (!seenSkus.has(row.sku)) {
            seenSkus.add(row.sku);
            await tx
              .insert(skus)
              .values({
                sku: row.sku,
                productName: row.sku, // syncProductNames replaces this
                productLine: null, // inventory runner fills this when the SKU lands
                firstSeenAt: today,
                active: true,
              })
              .onConflictDoNothing({ target: skus.sku });
          }
          await tx.insert(incomingShipments).values({
            sku: row.sku,
            destination: row.destination,
            shipmentName: row.shipmentName,
            quantity: row.quantity,
            expectedArrival: row.expectedArrival,
            status: row.status,
            sourcePullId: rawId,
            sourceRowRef: row.sourceRowRef,
          });
        }
      });
    },
  };
};

// ============================================================================
// Ad spend (Supermetrics FB sheet) — one tab per product, two columns
// (Date, Cost). Refreshed by Supermetrics at 4am Asuncion time daily
// (= 3am EDT / 7am UTC); we re-pull at the regular 09:00 UTC cron run,
// giving Supermetrics a 2h completion buffer. Schedule updated
// 2026-05-14 — see SESSION_HANDOFF and scripts/README for the
// rationale + Paraguay DST gotcha.
//
// Tab list is intentionally hardcoded so a typo / renamed tab fails
// loud instead of silently dropping a product. Update here when Scott
// adds a new tab.
// ============================================================================
const AD_SPEND_TABS = [
  "Men",
  "Shapewear",
  "SuperHW",
  "Men AL",
  "Shapewear AL",
  "Super HW AL",
] as const;

export type AdSpendRow = {
  product: string;
  spendDate: string; // YYYY-MM-DD
  costUsd: number;
  sourceRowRef: string;
};

// Parse a single (Date, Cost|Spend) tab. Supermetrics' FB connector
// labels the value column "Cost"; the AppLovin connector labels it
// "Spend". Both are accepted. Skips header + blank rows. Values
// come back as either plain numbers ("2791.18") or formatted
// currency ("$2,791.18") depending on cell formatting — strip
// non-numeric characters before Number().
export function parseAdSpendTab(
  tabName: string,
  grid: ReadonlyArray<ReadonlyArray<unknown>>,
): { rows: AdSpendRow[]; skipped: Array<{ rowIdx: number; reason: string }> } {
  const rows: AdSpendRow[] = [];
  const skipped: Array<{ rowIdx: number; reason: string }> = [];

  // Row 0 is header. Bail if header doesn't look right.
  const header = (grid[0] ?? []).map((c) => String(c ?? "").trim().toLowerCase());
  const valueHeaderOk = header[1] === "cost" || header[1] === "spend";
  if (header[0] !== "date" || !valueHeaderOk) {
    skipped.push({
      rowIdx: 0,
      reason: `unexpected header: ${JSON.stringify(grid[0] ?? [])}`,
    });
    return { rows, skipped };
  }

  for (let r = 1; r < grid.length; r++) {
    const row = grid[r] ?? [];
    const rawDate = String(row[0] ?? "").trim();
    const rawCost = String(row[1] ?? "").trim();
    if (!rawDate && !rawCost) continue; // blank row

    // Date: accept ISO YYYY-MM-DD verbatim; if it's a different format
    // we flag it (Supermetrics outputs ISO, but defensive in case
    // someone changes the cell format).
    if (!/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
      skipped.push({ rowIdx: r, reason: `unparseable date "${rawDate}"` });
      continue;
    }

    const cleaned = rawCost.replace(/[$,]/g, "");
    const cost = Number(cleaned);
    if (!Number.isFinite(cost)) {
      skipped.push({ rowIdx: r, reason: `unparseable cost "${rawCost}"` });
      continue;
    }

    rows.push({
      product: tabName,
      spendDate: rawDate,
      costUsd: cost,
      sourceRowRef: `${tabName}!A${r + 1}`,
    });
  }

  return { rows, skipped };
}

/** Collapse rows that share a (product, spendDate) key into a single
 * last-write-wins row, returning the deduped rows alongside metadata
 * about which collisions were collapsed. Supermetrics occasionally
 * emits the same date twice in a single tab (observed 2026-05-10 in
 * SuperHW: rows 7 and 9 both 2026-05-09 = 310.82). Before deduping,
 * the second INSERT collided on the PK (product, spend_date) and the
 * whole truncate-replace transaction rolled back, leaving the table
 * empty and breaking the Performance tab. Last-write-wins matches
 * PostgreSQL's natural ON CONFLICT DO UPDATE semantics; the collapsed
 * dupes flow into rawPayload.dupesCollapsed for diagnostic visibility.
 */
export function dedupeAdSpendRows(rows: ReadonlyArray<AdSpendRow>): {
  dedupedRows: AdSpendRow[];
  dupesCollapsed: Array<{
    product: string;
    spendDate: string;
    firstRowRef: string;
    secondRowRef: string;
  }>;
} {
  const map = new Map<string, AdSpendRow>();
  const dupesCollapsed: Array<{
    product: string;
    spendDate: string;
    firstRowRef: string;
    secondRowRef: string;
  }> = [];
  for (const r of rows) {
    const key = `${r.product}!${r.spendDate}`;
    const prior = map.get(key);
    if (prior) {
      dupesCollapsed.push({
        product: r.product,
        spendDate: r.spendDate,
        firstRowRef: prior.sourceRowRef,
        secondRowRef: r.sourceRowRef,
      });
    }
    map.set(key, r);
  }
  return { dedupedRows: Array.from(map.values()), dupesCollapsed };
}

export const sheetsAdSpendRunner: SourceRunner = async (_batchId) => {
  const sheetId = process.env.AD_SPEND_SHEET_ID;
  if (!sheetId) throw new Error("sheets_ad_spend: missing AD_SPEND_SHEET_ID");

  const sheets = buildSheetsClient();

  // One batchGet round-trip across all tabs — cheaper than per-tab gets
  // when there are 4 tabs.
  const ranges = AD_SPEND_TABS.map((t) => `'${t}'!A1:B400`);
  const resp = await sheets.spreadsheets.values.batchGet({
    spreadsheetId: sheetId,
    ranges,
  });

  const allRows: AdSpendRow[] = [];
  const allSkipped: Array<{ tab: string; rowIdx: number; reason: string }> = [];

  for (let i = 0; i < AD_SPEND_TABS.length; i++) {
    const tab = AD_SPEND_TABS[i];
    const grid = (resp.data.valueRanges?.[i]?.values ?? []) as unknown[][];
    const { rows, skipped } = parseAdSpendTab(tab, grid);
    allRows.push(...rows);
    for (const s of skipped) allSkipped.push({ tab, ...s });
  }

  const { dedupedRows, dupesCollapsed } = dedupeAdSpendRows(allRows);

  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        tabs: AD_SPEND_TABS,
        rowCount: dedupedRows.length,
      }),
    )
    .digest("hex")
    .slice(0, 16);

  return {
    ok: true,
    rowCount: dedupedRows.length,
    rawPayload: {
      tabs: AD_SPEND_TABS,
      sample: dedupedRows.slice(0, 5),
      skipped: allSkipped,
      dupesCollapsed,
    },
    schemaFingerprint: fingerprint,
    async normalize(rawId) {
      // Truncate-replace per pull. Supermetrics history is ~30-90 days
      // depending on Scott's query config; refreshing the whole table
      // keeps us aligned without needing change-detection.
      await db.transaction(async (tx) => {
        await tx.delete(adSpendDaily);
        if (dedupedRows.length === 0) return;
        for (const r of dedupedRows) {
          await tx.insert(adSpendDaily).values({
            product: r.product,
            spendDate: r.spendDate,
            costUsd: r.costUsd.toString(),
            sourcePullId: rawId,
          });
        }
      });
    },
  };
};

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

  // Pull A:ANK (col 1027) so the ingest is ready for a 3-year date
  // window when Scott widens the Supermetrics FB Ads export. ANK
  // covers 1025 date columns — roughly 2.8 years of daily slots — and
  // ~3015 rows × 1027 cols ≈ 3.1M cells is comfortably under the
  // Sheets API 10M-cell range cap. Until then this is a no-op widening:
  // empty trailing columns get skipped by parseFbAdsSheet.
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `'${tab}'!A1:ANK`,
  });
  const grid = (resp.data.values ?? []) as unknown[][];

  const { variants, aggregated, skipped } = parseFbAdsSheet(grid);

  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        tab,
        variantCount: variants.length,
        adCount: aggregated.length,
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
      await db.transaction(async (tx) => {
        await tx.delete(fbAdSpendDaily);
        if (aggregated.length === 0) return;
        // Insert in chunks to keep the parameterized query within
        // Postgres' parameter limit. 7 cols × 1000 rows ≈ 7K params,
        // well under the 65k cap.
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
    },
  };
};
