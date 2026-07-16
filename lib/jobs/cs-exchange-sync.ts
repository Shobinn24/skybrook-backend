import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { csExchanges } from "@/lib/db/schema";
import { buildSheetsClient } from "@/lib/sources/sheets";
import { logger } from "@/lib/logger";
import { direction, isMultiProduct, labelOf, mapStyle, normSize } from "@/lib/sizing/mapper";

// CS returns/replacements workbook ingest (Scott 2026-07-15). One
// workbook per year, tab EV. Full delete+reinsert per source year on
// every run: the CS team edits historical rows, so incremental sync
// would drift. ~22k rows/year, cheap.
//
// Fulfillment errors (customer received the WRONG item, logged on the
// AF/PD tabs) are excluded from fit analysis by order number — the
// customer's size choice was right, the warehouse pick was wrong.

const WORKBOOKS: Array<{ year: number; env: string; fallbackId?: string }> = [
  // 2025 workbook: pending link from the team; set CS_RETURNS_SHEET_2025.
  { year: 2025, env: "CS_RETURNS_SHEET_2025" },
  {
    year: 2026,
    env: "CS_RETURNS_SHEET_2026",
    fallbackId: "1HOs4NHXYnKgzFgpI_3YxUmK4dY4Vs5zwSKDjk6qSKkA",
  },
];

// 2025 → 2026 header harmonization (spec section 1A).
const HEADER_ALIASES: Record<string, string> = {
  "HF SL HW": "Style",
  Size: "Size Ordered",
  Replace: "Size Replaced",
  " ": "Date",
  "": "Date",
};

const FULFILLMENT_ERROR_TABS = ["AF Order Issues", "PD Order Issues"];

type RawRow = Record<string, string>;

function rowsFromValues(values: string[][]): RawRow[] {
  if (!values.length) return [];
  const headers = values[0].map((h) => {
    const name = String(h ?? "").trim();
    return HEADER_ALIASES[name] ?? name;
  });
  return values.slice(1).map((r) => {
    const row: RawRow = {};
    headers.forEach((h, i) => {
      if (h) row[h] = String(r[i] ?? "").trim();
    });
    return row;
  });
}

// The sheet's Date column contains junk (literal "k" was observed).
export function parseSheetDate(v: string | undefined): string | null {
  if (v == null || v === "") return null;
  const s = String(v).trim();
  // Google Sheets serial number (UNFORMATTED_VALUE): days since 1899-12-30.
  // Plausible range ~2020-2035 keeps junk (a literal "k", tiny numbers) out.
  const serial = Number(s);
  if (!Number.isNaN(serial) && serial > 43800 && serial < 49500) {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(serial) * 86400000);
    return d.toISOString().slice(0, 10);
  }
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(s);
  if (m) {
    const year = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${year}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  }
  return null;
}

export type CsExchangeSyncResult = {
  configured: boolean;
  years: Array<{
    year: number;
    rows: number;
    inserted: number;
    inScope: number;
    excluded: Record<string, number>;
    error?: string;
  }>;
};

export async function syncCsExchanges(): Promise<CsExchangeSyncResult> {
  const sheets = buildSheetsClient();
  const result: CsExchangeSyncResult = { configured: false, years: [] };

  for (const wb of WORKBOOKS) {
    const sheetId = process.env[wb.env]?.trim() || wb.fallbackId;
    if (!sheetId) continue;
    result.configured = true;
    const r: CsExchangeSyncResult["years"][number] = {
      year: wb.year,
      rows: 0,
      inserted: 0,
      inScope: 0,
      excluded: {},
    };
    try {
      // Fulfillment-error order numbers from the agent issue tabs.
      const errorOrders = new Set<string>();
      for (const tab of FULFILLMENT_ERROR_TABS) {
        try {
          const resp = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: `'${tab}'!A1:H10000`,
          });
          for (const row of rowsFromValues((resp.data.values as string[][]) ?? [])) {
            const orderNo = row["Order No."]?.trim();
            if (orderNo) errorOrders.add(orderNo.toUpperCase());
          }
        } catch {
          // tab may not exist in every year's workbook — fine
        }
      }

      const resp = await sheets.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range: "'EV'!A1:M50000",
        // dates arrive as serial numbers instead of whatever display
        // format the tab happens to use
        valueRenderOption: "UNFORMATTED_VALUE",
      });
      const raw = rowsFromValues((resp.data.values as string[][]) ?? []);

      const inserts: (typeof csExchanges.$inferInsert)[] = [];
      for (const row of raw) {
        const orderNo = row["Order No."]?.trim();
        if (!orderNo) continue;
        r.rows += 1;

        const styleRaw = row["Style"] || null;
        const sizeOrderedRaw = row["Size Ordered"] || null;
        const sizeReplacedRaw = row["Size Replaced"] || null;

        let excluded: string | null = null;
        let label: string | null = null;
        if (errorOrders.has(orderNo.toUpperCase())) {
          excluded = "fulfillment_error";
        } else if (isMultiProduct(styleRaw) || isMultiProduct(sizeReplacedRaw)) {
          excluded = "multi_product";
        } else {
          const mapping = mapStyle(styleRaw);
          if (mapping) {
            label = labelOf(mapping);
          } else if (/(^|\s)SL(\s|$)/.test((styleRaw ?? "").toUpperCase())) {
            excluded = "seamless";
          } else {
            excluded = "unmapped";
          }
        }

        const sizeOrdered = excluded ? null : normSize(sizeOrderedRaw);
        const sizeReplaced = excluded ? null : normSize(sizeReplacedRaw);
        if (excluded) r.excluded[excluded] = (r.excluded[excluded] ?? 0) + 1;
        else r.inScope += 1;

        inserts.push({
          sourceYear: wb.year,
          rowDate: parseSheetDate(row["Date"]),
          orderNo,
          email: row["Email Address"]?.toLowerCase() || null,
          country: row["Country"] || null,
          process: row["Process"]?.toLowerCase() || null,
          styleRaw,
          sizeOrderedRaw,
          sizeReplacedRaw,
          description: row["Description"]?.toLowerCase().trim() || null,
          // Amount carries currency suffixes ("92CAD") — store the number.
          amount:
            row["Amount"] && !isNaN(parseFloat(row["Amount"]))
              ? String(parseFloat(row["Amount"]))
              : null,
          label,
          sizeOrdered,
          sizeReplaced,
          direction: excluded ? null : direction(sizeOrdered, sizeReplaced),
          excluded,
        });
      }

      await db.transaction(async (tx) => {
        await tx.delete(csExchanges).where(eq(csExchanges.sourceYear, wb.year));
        for (let i = 0; i < inserts.length; i += 2000) {
          const batch = inserts.slice(i, i + 2000);
          const done = await tx
            .insert(csExchanges)
            .values(batch)
            .onConflictDoNothing() // year-overlap rows: first workbook wins
            .returning({ id: csExchanges.id });
          r.inserted += done.length;
        }
      });
    } catch (e) {
      r.error = e instanceof Error ? e.message.slice(0, 200) : String(e);
      logger.error("cs_exchanges.year_failed", { year: wb.year, error: r.error });
    }
    result.years.push(r);
  }

  logger.info("cs_exchanges.sync.done", { years: result.years });
  return result;
}
