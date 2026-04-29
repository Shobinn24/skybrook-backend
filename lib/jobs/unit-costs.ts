// Latest-cost sync from Scott's `EVSKUmap` cost sheet. Populates BOTH
// `skus.unit_cost_usd` and `skus.unit_cost_intl_usd` from the leftmost
// (most recent) date pair on the EVSKUmap tab — every date column on
// the sheet has paired US + INTL cells. Runs as part of the daily cron
// alongside the existing source ingest + product-name sync.
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

export type ParsedCostRow = {
  sku: string;
  costUsd: number;
  // Null when the INTL cell is empty / non-numeric / non-positive — the
  // cost sheet has legitimate gaps where Scott hasn't priced INTL for a
  // SKU. Queries fall back to `costUsd` in that case.
  costIntlUsd: number | null;
};

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
  // Same numeric/positive guard the US column uses, lifted out so it can
  // run on the INTL cell too. INTL cells legitimately can be empty —
  // those return null rather than counting as an error row.
  const readCost = (cell: unknown): number | null => {
    if (typeof cell !== "number" || !Number.isFinite(cell) || cell <= 0) return null;
    return cell;
  };
  for (let r = 2; r < grid.length; r++) {
    const row = grid[r] ?? [];
    const skuRaw = String(row[0] ?? "").trim();
    if (!skuRaw) continue;
    const sku = canonicalizeInventorySku(skuRaw);
    const usCost = readCost(row[usCol]);
    // UNFORMATTED_VALUE: numeric cells come back as `number`. Errors
    // surface as strings ("#REF!", "#N/A") or wrapped objects depending
    // on the API version — the typeof check handles both safely.
    if (usCost === null) {
      errorRows++;
      continue;
    }
    const intlCost = intlCol >= 0 ? readCost(row[intlCol]) : null;
    rows.push({ sku, costUsd: usCost, costIntlUsd: intlCost });
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
  updatedIntl: number;
  unchanged: number;
  skippedNoSku: number;
  skippedErrors: number;
  latestColumn: string;
  duplicates: number;
  // Mirror pass — fc-line SKUs (e.g. ev-bshort-fc-*) inherit cost from
  // their non-fc sibling. Scott 2026-04-29: "Boyshort 5-color > Same
  // price as boyshort regular… Color doesn't change cost."
  mirrored: number;
  mirroredIntl: number;
};

// Drop the `-fc-` qualifier from the SKU to find its non-fc sibling.
// `ev-bshort-fc-5x-l`     → `ev-bshort-5x-l`
// `ev-bshort-fc-hf-5x-l`  → `ev-bshort-hf-5x-l`
// `ev-suphw-fc-5x-l`      → `ev-suphw-5x-l`
function fcMirrorBase(sku: string): string | null {
  if (!/^ev-(bshort|suphw)-fc-/.test(sku)) return null;
  return sku.replace("-fc-", "-");
}

// numeric(12, 4) — Postgres returns a string. Compare textually after
// normalizing both sides to 4 decimal places.
function eqCost(currentRaw: unknown, next: number): boolean {
  if (currentRaw == null) return false;
  return Number(currentRaw).toFixed(4) === next.toFixed(4);
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
  // garment whose cost should be identical. Keep the first row we see
  // and count the rest.
  type SeenCost = { us: number; intl: number | null };
  const seen = new Map<string, SeenCost>();
  let duplicates = 0;
  for (const r of rows) {
    if (seen.has(r.sku)) {
      duplicates++;
      continue;
    }
    seen.set(r.sku, { us: r.costUsd, intl: r.costIntlUsd });
  }

  const all = await db
    .select({
      sku: skus.sku,
      unitCostUsd: skus.unitCostUsd,
      unitCostIntlUsd: skus.unitCostIntlUsd,
    })
    .from(skus);
  const allSkus = new Set(all.map((s) => s.sku));
  const currentUsBySku = new Map(all.map((s) => [s.sku, s.unitCostUsd]));
  const currentIntlBySku = new Map(all.map((s) => [s.sku, s.unitCostIntlUsd]));

  let updated = 0;
  let updatedIntl = 0;
  let unchanged = 0;
  let skippedNoSku = 0;
  for (const [sku, cost] of seen.entries()) {
    if (!allSkus.has(sku)) {
      skippedNoSku++;
      continue;
    }

    const usChanged = !eqCost(currentUsBySku.get(sku), cost.us);
    // INTL is only updated when the sheet has a positive value. A null
    // INTL cell does NOT clear the DB column — Scott's sheet has
    // legitimate gaps and we don't want a transient empty cell to wipe
    // out a previously-synced cost.
    const intlChanged =
      cost.intl !== null && !eqCost(currentIntlBySku.get(sku), cost.intl);

    if (!usChanged && !intlChanged) {
      unchanged++;
      continue;
    }

    const patch: { unitCostUsd?: string; unitCostIntlUsd?: string } = {};
    if (usChanged) {
      const usStr = cost.us.toFixed(4);
      patch.unitCostUsd = usStr;
      currentUsBySku.set(sku, usStr);
      updated++;
    }
    if (intlChanged && cost.intl !== null) {
      const intlStr = cost.intl.toFixed(4);
      patch.unitCostIntlUsd = intlStr;
      currentIntlBySku.set(sku, intlStr);
      updatedIntl++;
    }
    await db.update(skus).set(patch).where(eq(skus.sku, sku));
  }

  // Mirror pass: any fc-line SKU still without a cost inherits from its
  // non-fc sibling's cost (this run's fresh cost preferred over the
  // pre-existing DB value). Runs independently for US and INTL — fc SKU
  // can have one column inherited and the other left null if the base
  // SKU only has US priced.
  let mirrored = 0;
  let mirroredIntl = 0;
  const isPriced = (raw: unknown): boolean => {
    if (raw == null) return false;
    const n = typeof raw === "number" ? raw : Number(raw);
    return Number.isFinite(n) && n > 0;
  };
  const baseUsCost = (baseSku: string): number | null => {
    const fresh = seen.get(baseSku)?.us;
    if (fresh != null && fresh > 0) return fresh;
    const stored = Number(currentUsBySku.get(baseSku) ?? NaN);
    return Number.isFinite(stored) && stored > 0 ? stored : null;
  };
  const baseIntlCost = (baseSku: string): number | null => {
    const fresh = seen.get(baseSku)?.intl ?? null;
    if (fresh != null && fresh > 0) return fresh;
    const stored = Number(currentIntlBySku.get(baseSku) ?? NaN);
    return Number.isFinite(stored) && stored > 0 ? stored : null;
  };
  for (const fcSku of allSkus) {
    const baseSku = fcMirrorBase(fcSku);
    if (!baseSku) continue;
    const patch: { unitCostUsd?: string; unitCostIntlUsd?: string } = {};
    if (!isPriced(currentUsBySku.get(fcSku))) {
      const inherited = baseUsCost(baseSku);
      if (inherited !== null) {
        const s = inherited.toFixed(4);
        patch.unitCostUsd = s;
        currentUsBySku.set(fcSku, s);
        mirrored++;
      }
    }
    if (!isPriced(currentIntlBySku.get(fcSku))) {
      const inherited = baseIntlCost(baseSku);
      if (inherited !== null) {
        const s = inherited.toFixed(4);
        patch.unitCostIntlUsd = s;
        currentIntlBySku.set(fcSku, s);
        mirroredIntl++;
      }
    }
    if (patch.unitCostUsd || patch.unitCostIntlUsd) {
      await db.update(skus).set(patch).where(eq(skus.sku, fcSku));
    }
  }

  logger.info("unit-costs.done", {
    updated,
    updatedIntl,
    unchanged,
    skippedNoSku,
    skippedErrors: errorRows,
    duplicates,
    mirrored,
    mirroredIntl,
    latestColumn: latestColumn.dateLabel,
    sheetSkus: rows.length,
    distinctSkus: seen.size,
    ms: Date.now() - start,
  });

  return {
    updated,
    updatedIntl,
    unchanged,
    skippedNoSku,
    skippedErrors: errorRows,
    latestColumn: latestColumn.dateLabel,
    duplicates,
    mirrored,
    mirroredIntl,
  };
}
