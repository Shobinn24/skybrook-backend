import { decomposePackSku } from "@/lib/domain/sku-pack";

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

export const MONTHS: Record<string, number> = {
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
  // Anchor-year selection. The rightmost header is "today" in the daily
  // flow, but it can legitimately sit a little in the FUTURE (tomorrow's
  // column pre-created at end of day). The old rule — any future
  // day/month ⇒ last year — turned one pre-created column into a
  // 12-month shift of the entire header row (anchor 2025, every column
  // walked back from there, pickLatestColumn then grabbed a mis-dated
  // column). Instead: pick the year in {today-1, today, today+1} whose
  // resulting date is closest to today without being more than
  // FORWARD_TOLERANCE_DAYS ahead. today+1 handles the Dec 31 / "1 Jan"
  // boundary; today-1 keeps the genuine stale-sheet case working.
  const FORWARD_TOLERANCE_DAYS = 7;
  const todayUtcMs = Date.UTC(todayYear, todayMonth - 1, todayDay);
  let year = todayYear;
  let bestAbsDays = Infinity;
  for (const y of [todayYear - 1, todayYear, todayYear + 1]) {
    const diffDays =
      (Date.UTC(y, last.month - 1, last.day) - todayUtcMs) / 86_400_000;
    if (diffDays > FORWARD_TOLERANCE_DAYS) continue;
    if (Math.abs(diffDays) < bestAbsDays) {
      bestAbsDays = Math.abs(diffDays);
      year = y;
    }
  }

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
