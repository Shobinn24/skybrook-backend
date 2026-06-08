/** Monday (YYYY-MM-DD) of the ISO week containing the given date string. */
export function weekStartEst(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12));
  const dow = dt.getUTCDay(); // 0=Sun..6=Sat
  const deltaToMonday = (dow + 6) % 7; // Mon→0, Sun→6
  dt.setUTCDate(dt.getUTCDate() - deltaToMonday);
  return dt.toISOString().slice(0, 10);
}

/** N consecutive Monday week-starts beginning at `firstWeekStart` (inclusive). */
export function weekStartsForward(firstWeekStart: string, count: number): string[] {
  const out: string[] = [];
  const [y, m, d] = firstWeekStart.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12));
  for (let i = 0; i < count; i++) {
    out.push(dt.toISOString().slice(0, 10));
    dt.setUTCDate(dt.getUTCDate() + 7);
  }
  return out;
}
