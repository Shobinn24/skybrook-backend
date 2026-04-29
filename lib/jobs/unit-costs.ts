// Latest-cost sync from Scott's `EVSKUmap` cost sheet. Populates the
// `skus.unit_cost_usd` column from the leftmost (most recent) US cost
// column on the EVSKUmap tab. Runs as part of the daily cron alongside
// the existing source ingest + product-name sync.
//
// Sheet layout reverse-engineered 2026-04-28 from
//   docs.google.com/spreadsheets/d/15ycRH-u43kWMGb52PGGpBu_2v6iDH39RJUPUFfkh9YA
//
//   row 1 (idx 0): date headers ("May'25", "Apr'25", ...). Each date
//                  spans two cells — US then INTL. Leftmost date is
//                  always the most recent.
//   row 2 (idx 1): "SKUs", "number", "quantity", "", "product", "pack",
//                  "5s", "3s", "5 or 3", then alternating "US"/"INTL"
//                  pairs aligned with row-1 dates.
//   rows 3+:       SKU rows. Col A = SKU (mixed case + dash-form pack
//                  tokens — same canonicalization rules as the
//                  inventory sheet). Cost cells are USD.
//
// `valueRenderOption: UNFORMATTED_VALUE` returns numeric cost cells as
// numbers and formula errors as strings (`"#REF!"` etc.) — so the type
// guard reliably skips the legacy date columns whose formulas resolve
// against a deleted EVOldCOGS sheet.

import { google } from "googleapis";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { skus } from "@/lib/db/schema";
import { canonicalizeInventorySku } from "@/lib/sources/sheets";
import { logger } from "@/lib/logger";

const COST_TAB = "EVSKUmap";
const COST_RANGE = `${COST_TAB}!A1:Z2070`;

function buildSheetsClient() {
  const scopes = ["https://www.googleapis.com/auth/spreadsheets.readonly"];
  const json = process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
  const file = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  if (json) {
    return google.sheets({
      version: "v4",
      auth: new google.auth.GoogleAuth({ credentials: JSON.parse(json), scopes }),
    });
  }
  if (file) {
    return google.sheets({
      version: "v4",
      auth: new google.auth.GoogleAuth({ keyFile: file, scopes }),
    });
  }
  throw new Error(
    "unit-costs: set GOOGLE_APPLICATION_CREDENTIALS or GOOGLE_SERVICE_ACCOUNT_JSON"
  );
}

export type ParsedCostRow = { sku: string; costUsd: number };

export type ParsedCostResult = {
  rows: ParsedCostRow[];
  latestColumn: { dateLabel: string; usCol: number; intlCol: number };
  errorRows: number;
};

// Pure parser — kept separate so tests can pin layout assumptions.
export function parseCostSheetRows(grid: unknown[][]): ParsedCostResult {
  const dateRow = grid[0] ?? [];
  const headerRow = grid[1] ?? [];

  // The leftmost (date, "US") pair is the most recent cost. Walk left→right
  // and stop at the first match.
  let usCol = -1;
  let intlCol = -1;
  let dateLabel = "";
  for (let c = 0; c < dateRow.length; c++) {
    const date = String(dateRow[c] ?? "").trim();
    const cat = String(headerRow[c] ?? "").trim().toUpperCase();
    if (date && cat === "US") {
      usCol = c;
      intlCol = c + 1;
      dateLabel = date;
      break;
    }
  }
  if (usCol < 0) {
    return {
      rows: [],
      latestColumn: { dateLabel: "", usCol: -1, intlCol: -1 },
      errorRows: 0,
    };
  }

  const rows: ParsedCostRow[] = [];
  let errorRows = 0;
  for (let r = 2; r < grid.length; r++) {
    const row = grid[r] ?? [];
    const skuRaw = String(row[0] ?? "").trim();
    if (!skuRaw) continue;
    const sku = canonicalizeInventorySku(skuRaw);
    const cost = row[usCol];
    // UNFORMATTED_VALUE: numeric cells come back as `number`. Errors
    // surface as strings ("#REF!", "#N/A") or wrapped objects depending
    // on the API version — the typeof check handles both safely.
    if (typeof cost !== "number" || !Number.isFinite(cost) || cost <= 0) {
      errorRows++;
      continue;
    }
    rows.push({ sku, costUsd: cost });
  }

  return {
    rows,
    latestColumn: { dateLabel, usCol, intlCol },
    errorRows,
  };
}

async function fetchCostSheet(spreadsheetId: string): Promise<ParsedCostResult> {
  const client = buildSheetsClient();
  const r = await client.spreadsheets.values.get({
    spreadsheetId,
    range: COST_RANGE,
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  return parseCostSheetRows((r.data.values ?? []) as unknown[][]);
}

export type UnitCostSyncResult = {
  updated: number;
  unchanged: number;
  skippedNoSku: number;
  skippedErrors: number;
  latestColumn: string;
  duplicates: number;
  // Mirror pass — fc-line SKUs (e.g. ev-bshort-fc-*) inherit cost from
  // their non-fc sibling. Scott 2026-04-29: "Boyshort 5-color > Same
  // price as boyshort regular… Color doesn't change cost."
  mirrored: number;
};

// Drop the `-fc-` qualifier from the SKU to find its non-fc sibling.
// `ev-bshort-fc-5x-l`     → `ev-bshort-5x-l`
// `ev-bshort-fc-hf-5x-l`  → `ev-bshort-hf-5x-l`
// `ev-suphw-fc-5x-l`      → `ev-suphw-5x-l`
function fcMirrorBase(sku: string): string | null {
  if (!/^ev-(bshort|suphw)-fc-/.test(sku)) return null;
  return sku.replace("-fc-", "-");
}

export async function syncUnitCosts(opts?: {
  // Tests inject a deterministic provider; production reads the sheet.
  costsProvider?: () => Promise<ParsedCostResult>;
}): Promise<UnitCostSyncResult> {
  const start = Date.now();
  const provider =
    opts?.costsProvider ??
    (async () => {
      const sheetId = process.env.EVERDRIES_COST_SHEET_ID;
      if (!sheetId) {
        logger.warn("unit-costs.no-sheet-id", {
          reason: "EVERDRIES_COST_SHEET_ID not set; skipping cost sync",
        });
        return {
          rows: [] as ParsedCostRow[],
          latestColumn: { dateLabel: "", usCol: -1, intlCol: -1 },
          errorRows: 0,
        };
      }
      return fetchCostSheet(sheetId);
    });

  const { rows, latestColumn, errorRows } = await provider();

  // Multiple cost-sheet rows can canonicalize to the same SKU (e.g. a
  // dash-form 5-pack and an x-form 5-pack both resolve to the same
  // x-form). Last-write-wins isn't deterministic — but with the
  // canonicalization step, all such collisions point at the same physical
  // garment whose cost should be identical. Keep the first non-zero cost
  // we see and count the rest.
  const seen = new Map<string, number>();
  let duplicates = 0;
  for (const r of rows) {
    if (seen.has(r.sku)) {
      duplicates++;
      continue;
    }
    seen.set(r.sku, r.costUsd);
  }

  const all = await db.select({ sku: skus.sku, unitCostUsd: skus.unitCostUsd }).from(skus);
  const allSkus = new Set(all.map((s) => s.sku));
  const currentBySku = new Map(all.map((s) => [s.sku, s.unitCostUsd]));

  let updated = 0;
  let unchanged = 0;
  let skippedNoSku = 0;
  for (const [sku, cost] of seen.entries()) {
    if (!allSkus.has(sku)) {
      skippedNoSku++;
      continue;
    }
    // numeric(12, 4) — Postgres returns a string. Compare textually after
    // normalizing both sides to 4 decimal places.
    const newCostStr = cost.toFixed(4);
    const currentRaw = currentBySku.get(sku);
    const currentStr = currentRaw == null ? null : Number(currentRaw).toFixed(4);
    if (currentStr === newCostStr) {
      unchanged++;
      continue;
    }
    await db.update(skus).set({ unitCostUsd: newCostStr }).where(eq(skus.sku, sku));
    updated++;
    currentBySku.set(sku, newCostStr); // keep map in sync for the mirror pass
  }

  // Mirror pass: any fc-line SKU still without a cost inherits from its
  // non-fc sibling's cost (this run's fresh cost preferred over the
  // pre-existing DB value).
  let mirrored = 0;
  const isPriced = (raw: unknown): boolean => {
    if (raw == null) return false;
    const n = typeof raw === "number" ? raw : Number(raw);
    return Number.isFinite(n) && n > 0;
  };
  for (const fcSku of allSkus) {
    if (isPriced(currentBySku.get(fcSku))) continue;
    const baseSku = fcMirrorBase(fcSku);
    if (!baseSku) continue;
    const baseCost = seen.get(baseSku) ?? Number(currentBySku.get(baseSku) ?? NaN);
    if (!Number.isFinite(baseCost) || baseCost <= 0) continue;
    const baseCostStr = baseCost.toFixed(4);
    await db.update(skus).set({ unitCostUsd: baseCostStr }).where(eq(skus.sku, fcSku));
    currentBySku.set(fcSku, baseCostStr);
    mirrored++;
  }

  logger.info("unit-costs.done", {
    updated,
    unchanged,
    skippedNoSku,
    skippedErrors: errorRows,
    duplicates,
    mirrored,
    latestColumn: latestColumn.dateLabel,
    sheetSkus: rows.length,
    distinctSkus: seen.size,
    ms: Date.now() - start,
  });

  return {
    updated,
    unchanged,
    skippedNoSku,
    skippedErrors: errorRows,
    latestColumn: latestColumn.dateLabel,
    duplicates,
    mirrored,
  };
}
