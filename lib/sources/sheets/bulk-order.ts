import { MONTHS } from "./parse-helpers";

// --- Bulk order payment forecast (cashflow Task 6) -------------------------

export type BulkOrderForecastRow = { weekDate: string; amountUsd: number };

/** Parse "D-Mon-YY" (e.g. "8-Apr-24") -> "YYYY-MM-DD", or null. Reuses the
 * module-level MONTHS map (number-valued) and zero-pads. */
function parseBulkOrderDate(raw: string): string | null {
  const m = raw.trim().match(/^(\d{1,2})-([A-Za-z]{3,})-(\d{2})$/);
  if (!m) return null;
  const day = m[1].padStart(2, "0");
  const mon = MONTHS[m[2].toLowerCase()];
  if (!mon) return null;
  return `20${m[3]}-${String(mon).padStart(2, "0")}-${day}`;
}

/** Reads the Bulk Order tab's right-side summary (col K = week date,
 * col L = total). Skips header / unparseable dates / $0 rows. */
export function parseBulkOrderForecast(
  grid: ReadonlyArray<ReadonlyArray<unknown>>,
): { rows: BulkOrderForecastRow[]; skipped: number } {
  const rows: BulkOrderForecastRow[] = [];
  let skipped = 0;
  for (const raw of grid) {
    const weekDate = parseBulkOrderDate(String(raw[10] ?? "").trim());
    if (!weekDate) {
      skipped++;
      continue;
    }
    const amount = Number(String(raw[11] ?? "").replace(/[$,]/g, ""));
    if (!Number.isFinite(amount) || amount === 0) {
      skipped++;
      continue;
    }
    rows.push({ weekDate, amountUsd: amount });
  }
  return { rows, skipped };
}
