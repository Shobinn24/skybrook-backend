// Two-source product-name sync: explicit mapping from Scott's velocity
// sheet wins (canonical), and a deterministic SKU-pattern parser fills
// in the gap for SKUs the sheet doesn't cover. Runs as part of the
// daily cron alongside ingest+derive.

import { google } from "googleapis";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { skus } from "@/lib/db/schema";
import { deriveProductName } from "@/lib/domain/sku-naming";
import {
  loadFamilyOverrides,
  type FamilyOverrideMap,
} from "@/lib/domain/sku-naming-overrides";
import { logger } from "@/lib/logger";

// Sheet layout reverse-engineered 2026-04-28 from
// docs.google.com/spreadsheets/d/1ra1vvx_43oIWJN1ZonV0Nd_WpNgxCYpARasuWYmybAQ
//   col B = sticky "Style ..." label per block
//   col C = SKU code (ev-...)
// Same SKU appears across multiple weekly blocks; a single block label
// applies to every SKU below it until the next labeled row. Across
// weeks, layout is consistent — we majority-vote when the same SKU
// shows up under different labels (mostly an artifact of the sheet
// rotating between Boyshort and Boyshort Black naming for the same
// row).
const VELOCITY_TAB = "EV Main";
const VELOCITY_RANGE = `${VELOCITY_TAB}!A1:C7400`;

// Header rows that should NOT be treated as a style label.
const HEADER_LABELS = new Set(["", "date", "product"]);

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
    "product-names: set GOOGLE_APPLICATION_CREDENTIALS or GOOGLE_SERVICE_ACCOUNT_JSON"
  );
}

export type ProductNameSyncResult = {
  fromSheet: number;
  fromPattern: number;
  unchanged: number;
};

// Walks raw cells from the velocity sheet and returns the (SKU → style)
// majority-vote map. Pure function — kept separate from the API call so
// tests can pin layout assumptions without hitting Google.
export function parseVelocitySheetRows(rows: unknown[][]): Map<string, string> {
  let currentStyle = "";
  const votes = new Map<string, Map<string, number>>(); // sku → style → count
  for (const row of rows) {
    const b = typeof row[1] === "string" ? row[1].trim() : "";
    const c = typeof row[2] === "string" ? row[2].trim() : "";
    const lowerB = b.toLowerCase();
    if (b && !HEADER_LABELS.has(lowerB) && !lowerB.startsWith("date")) {
      currentStyle = b;
    }
    if (c.startsWith("ev-") && currentStyle) {
      const inner = votes.get(c) ?? new Map<string, number>();
      inner.set(currentStyle, (inner.get(currentStyle) ?? 0) + 1);
      votes.set(c, inner);
    }
  }

  // Majority vote — break ties by alphabetical style name for determinism.
  const out = new Map<string, string>();
  for (const [sku, inner] of votes.entries()) {
    const sorted = [...inner.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
    );
    out.set(sku, sorted[0][0]);
  }
  return out;
}

async function fetchSheetMapping(spreadsheetId: string): Promise<Map<string, string>> {
  const client = buildSheetsClient();
  const r = await client.spreadsheets.values.get({
    spreadsheetId,
    range: VELOCITY_RANGE,
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  return parseVelocitySheetRows((r.data.values ?? []) as unknown[][]);
}

export async function syncProductNames(opts?: {
  // Tests inject a deterministic provider; production reads the sheet.
  mappingProvider?: () => Promise<Map<string, string>>;
  // Tests inject a deterministic override map; production loads from
  // the sku_family_overrides table.
  overridesProvider?: () => Promise<FamilyOverrideMap>;
}): Promise<ProductNameSyncResult> {
  const start = Date.now();
  const provider =
    opts?.mappingProvider ??
    (async () => {
      const sheetId = process.env.EVERDRIES_VELOCITY_SHEET_ID;
      if (!sheetId) {
        logger.warn("product-names.no-sheet-id", {
          reason: "EVERDRIES_VELOCITY_SHEET_ID not set; falling back to pattern parser only",
        });
        return new Map<string, string>();
      }
      return fetchSheetMapping(sheetId);
    });

  const sheetMap = await provider();
  const overrides = await (opts?.overridesProvider ?? loadFamilyOverrides)();
  const all = await db.select().from(skus);

  let fromSheet = 0;
  let fromPattern = 0;
  let unchanged = 0;

  for (const row of all) {
    const fromSheetName = sheetMap.get(row.sku);
    const patternName = deriveProductName(row.sku, overrides);

    // Scott 2026-05-06: parser is canonical for known families because
    // it produces color-consolidated rollup names ("Boyshort", not
    // "Boyshort Beige"). Sheet is the override for unknown families
    // (jac/mlb/new/etc.) and any human-supplied label the parser
    // can't reproduce.
    let target: string | null = null;
    let bucket: "fromSheet" | "fromPattern" | null = null;
    if (patternName) {
      target = patternName;
      bucket = "fromPattern";
    } else if (fromSheetName) {
      target = fromSheetName;
      bucket = "fromSheet";
    }

    if (!target || target === row.productName) {
      unchanged++;
      continue;
    }

    await db
      .update(skus)
      .set({ productName: target })
      .where(eq(skus.sku, row.sku));

    if (bucket === "fromSheet") fromSheet++;
    else fromPattern++;
  }

  logger.info("product-names.done", {
    fromSheet,
    fromPattern,
    unchanged,
    sheetMappingSize: sheetMap.size,
    overridesSize: overrides.size,
    ms: Date.now() - start,
  });

  return { fromSheet, fromPattern, unchanged };
}
