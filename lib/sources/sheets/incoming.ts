import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { incomingReceipts, incomingShipments, skus } from "@/lib/db/schema";
import type { SourceRunner } from "@/lib/jobs/ingest";
import { postAlert } from "@/lib/notifications/slack";
import { toEstDate } from "@/lib/tz";
import { buildSheetsClient } from "./client";
import {
  MONTHS,
  canonicalizeInventorySku,
  colIndexToA1,
  parseQty,
} from "./parse-helpers";

const INCOMING_TAB = "Incoming_new";

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
  // Receipt markers Grace writes one row below the Total row, one cell per
  // shipment column. Sheet legend in col A row 2-3: "delivered, invty not
  // yet updated" / "delivered & invty updated". Verbatim values observed in
  // production: "received, invty updated" / "received, invty not yet
  // updated" / "delivered, ..." / empty (= not yet received). Added
  // 2026-05-28 — Scott / Grace's receipt signal was being ignored entirely
  // before this, leaving 155 already-delivered CN shipments displaying as
  // overdue on /incoming.
  receipts: Array<{
    shipmentName: string;
    destination: "US" | "CN";
    expectedArrival: string;
    note: string;
  }>;
};

// Build a P2-alert spec for PO columns skipped during incoming ingest: a
// shipment name is present but its arrival date cannot be read (e.g. a date
// typed without a year). Returns null when nothing was skipped. Wired into the
// daily ingest cron so a silently-dropped PO surfaces in Slack instead of just
// vanishing from /incoming.
export function buildIncomingSkippedAlert(
  skipped: ParseIncomingResult["skippedColumns"],
): { title: string; fields: Record<string, string> } | null {
  if (!skipped || skipped.length === 0) return null;
  return {
    title: `${skipped.length} incoming PO column(s) skipped — unreadable arrival date`,
    fields: Object.fromEntries(
      skipped.slice(0, 10).map((s) => [s.label || `col ${s.colIdx}`, s.reason]),
    ),
  };
}

// Match Grace's receipt-status row markers. Case-insensitive, leading
// "received" or "delivered" both count — the suffix ("invty updated" vs
// "invty not yet updated") is captured in the note so the operator can
// still see what state the sheet was in when we marked it.
const RECEIPT_MARKER_RE = /^\s*(received|delivered)\b/i;

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
      receipts: [],
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

  // Receipt-status row scan. Grace writes "received, invty updated" or
  // "delivered, invty not yet updated" in the row immediately under Total,
  // one cell per shipment column. Scan up to 3 rows below Total to absorb
  // an inserted blank row without breaking. Stop scanning a row as soon as
  // col C carries a non-empty token longer than ~4 chars (heuristic: real
  // SKU rows have a label there; the receipt row's col C is empty).
  const receipts: ParseIncomingResult["receipts"] = [];
  const seenReceipts = new Set<string>();
  for (let r = totalRowIdx + 1; r <= Math.min(totalRowIdx + 3, grid.length - 1); r++) {
    const row = grid[r] ?? [];
    const colC = String(row[2] ?? "").trim();
    if (colC && colC.length > 4 && !RECEIPT_MARKER_RE.test(colC)) break;
    for (const po of poColumns) {
      const raw = String(row[po.colIdx] ?? "").trim();
      if (!raw || !RECEIPT_MARKER_RE.test(raw)) continue;
      const key = `${po.label}|${po.destination}|${po.date}`;
      if (seenReceipts.has(key)) continue;
      seenReceipts.add(key);
      receipts.push({
        shipmentName: po.label,
        destination: po.destination,
        expectedArrival: po.date!,
        note: raw,
      });
    }
  }

  return { rows, poColumns, skippedColumns, receipts };
}

// When the sheet nudges a received PO's ETA (observed: KAI Sec Mar26 + KAI
// Mens Apr26 drifted 06-03 -> 06-04 after the auto-receipt was recorded), the
// receipt's natural key (name, destination, expectedArrival) no longer matches
// any current shipment, so the PO falsely shows as overdue. This re-points each
// orphaned receipt to the nearest current shipment ETA with the same
// name+destination, within a tolerance. Pure + unit-tested; applied in the
// incoming ingest after the shipment truncate-replace.
const RECEIPT_REKEY_TOLERANCE_DAYS = 7;

export function reconcileReceiptKeys(
  shipments: ReadonlyArray<{ shipmentName: string; destination: string; expectedArrival: string }>,
  receipts: ReadonlyArray<{
    id: string;
    shipmentName: string;
    destination: string;
    expectedArrival: string;
  }>,
  toleranceDays: number = RECEIPT_REKEY_TOLERANCE_DAYS,
): Array<{ id: string; newExpectedArrival: string }> {
  const key = (name: string, dest: string, eta: string) => `${name} ${dest} ${eta}`;
  const shipmentKeys = new Set(
    shipments.map((s) => key(s.shipmentName, s.destination, s.expectedArrival)),
  );
  const etasByNameDest = new Map<string, string[]>();
  for (const s of shipments) {
    const k = `${s.shipmentName} ${s.destination}`;
    const arr = etasByNameDest.get(k) ?? [];
    arr.push(s.expectedArrival);
    etasByNameDest.set(k, arr);
  }
  // ETAs already claimed by a receipt (so we never put two receipts on one
  // shipment). Seeded with every receipt's current ETA, then grown as we
  // assign re-keys.
  const occupied = new Set<string>(
    receipts.map((rec) => key(rec.shipmentName, rec.destination, rec.expectedArrival)),
  );
  const dayDiff = (a: string, b: string) =>
    Math.abs((Date.parse(a) - Date.parse(b)) / 86_400_000);

  const out: Array<{ id: string; newExpectedArrival: string }> = [];
  // Deterministic: earliest receipt ETA wins a contested slot; ties by id.
  const ordered = [...receipts].sort(
    (a, b) => a.expectedArrival.localeCompare(b.expectedArrival) || a.id.localeCompare(b.id),
  );
  for (const rec of ordered) {
    if (shipmentKeys.has(key(rec.shipmentName, rec.destination, rec.expectedArrival))) continue;
    const candidates = etasByNameDest.get(`${rec.shipmentName} ${rec.destination}`) ?? [];
    let best: string | null = null;
    let bestDiff = Infinity;
    for (const eta of candidates) {
      const diff = dayDiff(rec.expectedArrival, eta);
      if (diff > toleranceDays) continue;
      if (occupied.has(key(rec.shipmentName, rec.destination, eta))) continue;
      if (diff < bestDiff || (diff === bestDiff && best !== null && eta < best)) {
        best = eta;
        bestDiff = diff;
      }
    }
    if (best !== null) {
      out.push({ id: rec.id, newExpectedArrival: best });
      occupied.add(key(rec.shipmentName, rec.destination, best));
    }
  }
  return out;
}

export const sheetsIncomingRunner: SourceRunner = async (_batchId) => {
  const sheetId = process.env.INCOMING_PO_SHEET_ID;
  if (!sheetId) throw new Error("sheets_incoming: missing INCOMING_PO_SHEET_ID");

  const sheets = buildSheetsClient();
  const todayYmd = toEstDate(new Date());

  // Read the full Incoming_new tab. Columns are UNBOUNDED to the right (A1:ZZ)
  // because PO columns accrue rightward over time — a hard `AG` cap silently
  // dropped new POs once the sheet grew past column AG (observed 2026-06-09: a
  // PO that had grown into column AH was never ingested, so its arrival date
  // did not surface in the tool). values.get trims trailing empty columns, so
  // an over-wide range costs nothing. Rows stay bounded (~360 used).
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `'${INCOMING_TAB}'!A1:ZZ400`,
  });
  const grid = (resp.data.values ?? []) as unknown[][];

  const { rows, poColumns, skippedColumns, receipts } = parseIncomingGrid(grid, todayYmd);

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
      receipts: receipts.length,
      sample: rows.slice(0, 5),
    },
    schemaFingerprint: fingerprint,
    async normalize(rawId) {
      // Refuse-to-wipe guard: an empty or layout-broken parse means the
      // SHEET READ failed (renamed col-C header, moved block — the
      // schema-drift class), not that every PO vanished overnight.
      // Truncating incoming_shipments on it would zero /incoming, the
      // sustainability projections, and stock-value future units while
      // still looking "healthy". Keep existing data, page P1, bail.
      // Same failure class as the FB month-collapse guard.
      const layoutBroken = skippedColumns.some((s) => s.label === "(layout)");
      if (rows.length === 0 || layoutBroken) {
        await postAlert({
          severity: "p1",
          channel: "alerts",
          dedupKey: "sheets_incoming.empty_parse",
          title:
            "Incoming-PO ingest blocked: parse produced no rows — refusing to truncate incoming_shipments",
          fields: {
            layoutBroken: String(layoutBroken),
            skippedColumns: skippedColumns.length,
            firstSkipReason: skippedColumns[0]?.reason ?? null,
          },
        });
        return;
      }
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
        const today = new Date().toISOString().slice(0, 10);
        const seenSkus = new Set<string>();
        // Pre-aggregate intra-pull duplicates on the natural key — two PO
        // columns sharing label + ETA + destination are legitimate sheet
        // layouts (quantities sum). This lets the insert below run
        // onConflictDoNothing against the natural-key unique index, so a
        // conflict can only mean a concurrent ingest already wrote the
        // row — dropping ours prevents the silent quantity-doubling that
        // a UUID-only PK allowed.
        const byNaturalKey = new Map<string, IncomingShipment>();
        for (const r of rows) {
          const k = `${r.sku}|${r.destination}|${r.shipmentName}|${r.expectedArrival}`;
          const prev = byNaturalKey.get(k);
          if (prev) prev.quantity += r.quantity;
          else byNaturalKey.set(k, { ...r });
        }
        for (const row of byNaturalKey.values()) {
          if (!seenSkus.has(row.sku)) {
            seenSkus.add(row.sku);
            // onConflictDoUpdate (not DoNothing) so a SKU that was
            // deactivated by runOrphanSkuSweep — because it had been
            // removed from the Incoming sheet and never received stock —
            // flips back to active=true the moment Grace re-adds it.
            // productName / productLine are deliberately NOT overwritten:
            // syncProductNames + the inventory runner own those fields
            // and the original Incoming-only insert can't improve them.
            await tx
              .insert(skus)
              .values({
                sku: row.sku,
                productName: row.sku, // syncProductNames replaces this
                productLine: null, // inventory runner fills this when the SKU lands
                firstSeenAt: today,
                active: true,
              })
              .onConflictDoUpdate({
                target: skus.sku,
                set: { active: sql`true` },
              });
          }
          await tx
            .insert(incomingShipments)
            .values({
              sku: row.sku,
              destination: row.destination,
              shipmentName: row.shipmentName,
              quantity: row.quantity,
              expectedArrival: row.expectedArrival,
              status: row.status,
              sourcePullId: rawId,
              sourceRowRef: row.sourceRowRef,
            })
            .onConflictDoNothing({
              target: [
                incomingShipments.sku,
                incomingShipments.destination,
                incomingShipments.shipmentName,
                incomingShipments.expectedArrival,
              ],
            });
        }
        // Receipt confirmations from Grace's row right under Total. Idempotent
        // via the natural key — the manual UI mutation (markIncomingReceived)
        // also onConflictDoNothing, so neither side clobbers the other.
        // Unreceipt is intentionally NOT modelled here: if Grace clears a
        // "received" marker on the sheet, Skybrook keeps the receipt so the
        // ledger still reflects the physical arrival. Manual unmark via UI
        // (unmarkIncomingReceived) is the only way to remove a receipt.
        for (const rec of receipts) {
          await tx
            .insert(incomingReceipts)
            .values({
              shipmentName: rec.shipmentName,
              destination: rec.destination,
              expectedArrival: rec.expectedArrival,
              note: `sheet: ${rec.note}`,
            })
            .onConflictDoNothing({
              target: [
                incomingReceipts.shipmentName,
                incomingReceipts.destination,
                incomingReceipts.expectedArrival,
              ],
            });
        }
        // Re-point receipts orphaned by an ETA nudge to the nearest current
        // shipment (same name+destination). Read receipts back inside the txn
        // so both sheet-receipts (above) and auto-receipts are reconciled.
        const currentShipments = Array.from(
          new Map(
            rows.map((row) => [
              `${row.shipmentName} ${row.destination} ${row.expectedArrival}`,
              {
                shipmentName: row.shipmentName,
                destination: row.destination,
                expectedArrival: row.expectedArrival,
              },
            ]),
          ).values(),
        );
        const existingReceipts = await tx
          .select({
            id: incomingReceipts.id,
            shipmentName: incomingReceipts.shipmentName,
            destination: incomingReceipts.destination,
            expectedArrival: incomingReceipts.expectedArrival,
          })
          .from(incomingReceipts);
        for (const rk of reconcileReceiptKeys(currentShipments, existingReceipts)) {
          await tx
            .update(incomingReceipts)
            .set({ expectedArrival: rk.newExpectedArrival })
            .where(eq(incomingReceipts.id, rk.id));
        }
      });
    },
  };
};
