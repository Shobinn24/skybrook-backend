import { SIZE_RANK } from "./mapper";

// Pure aggregation for the sizing views (spec steps 7-8). Inputs are
// pre-grouped DB rows; everything here is deterministic and unit-tested.

export type DirectionCell = {
  label: string;
  size: string;
  total: number;
  up: number;
  down: number;
  same: number;
  pctUp: number;
  pctDown: number;
  pctSame: number;
  /** total < 10 — render as '–', never drive a verdict (spec step 7) */
  lowConfidence: boolean;
  /** first/last size in this product's run — pct toward the wall is censored (spec 4.3) */
  boundary: boolean;
  /** XXS is a suspected placeholder until CS confirms (spec 4.2) */
  flagged: boolean;
};

const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);

export function buildDirectionMix(
  rows: Array<{ label: string; size: string; up: number; down: number; same: number }>,
  minN = 10,
): DirectionCell[] {
  const byLabel = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = byLabel.get(r.label) ?? [];
    list.push(r);
    byLabel.set(r.label, list);
  }

  const out: DirectionCell[] = [];
  for (const [label, list] of byLabel) {
    const ranked = list
      .filter((r) => SIZE_RANK[r.size] !== undefined)
      .sort((a, b) => SIZE_RANK[a.size] - SIZE_RANK[b.size]);
    const first = ranked[0]?.size;
    const last = ranked[ranked.length - 1]?.size;
    for (const r of ranked) {
      const total = r.up + r.down + r.same;
      out.push({
        label,
        size: r.size,
        total,
        up: r.up,
        down: r.down,
        same: r.same,
        pctUp: pct(r.up, total),
        pctDown: pct(r.down, total),
        pctSame: pct(r.same, total),
        lowConfidence: total < minN,
        boundary: r.size === first || r.size === last,
        flagged: r.size === "XXS" || r.size === "XXXS",
      });
    }
  }
  return out;
}

export type RateCell = {
  label: string;
  size: string;
  units: number;
  exchanges: number;
  up: number;
  down: number;
  pctExch: number;
  pctUp: number;
  pctDown: number;
  /** thresholds from the manual run: <5 normal, 7-10 watch, >10 problem */
  severity: "normal" | "watch" | "problem";
  flagged: boolean;
};

export function buildSalesWeighted(
  sales: Array<{ label: string; size: string; units: number }>,
  mix: DirectionCell[],
): RateCell[] {
  const mixKey = new Map(mix.map((m) => [`${m.label}|${m.size}`, m]));
  // LEFT from sales: sizes with sales but zero exchanges show 0%, not missing.
  return sales
    .filter((s) => s.units > 0)
    .map((s) => {
      const m = mixKey.get(`${s.label}|${s.size}`);
      const exchanges = m?.total ?? 0;
      const up = m?.up ?? 0;
      const down = m?.down ?? 0;
      const pctExch = pct(exchanges, s.units);
      return {
        label: s.label,
        size: s.size,
        units: s.units,
        exchanges,
        up,
        down,
        pctExch,
        pctUp: pct(up, s.units),
        pctDown: pct(down, s.units),
        severity: pctExch > 10 ? "problem" : pctExch >= 7 ? "watch" : "normal",
        flagged: s.size === "XXS" || s.size === "XXXS",
      } as RateCell;
    })
    .sort(
      (a, b) =>
        a.label.localeCompare(b.label) || (SIZE_RANK[a.size] ?? 99) - (SIZE_RANK[b.size] ?? 99),
    );
}

/**
 * Verdict per spec section 6, honoring every caveat: only non-boundary,
 * non-flagged, confident cells vote, and Std/Heavy are never merged
 * (the caller passes cells for ONE label).
 */
export function labelVerdict(cells: DirectionCell[]): "runs small" | "runs large" | "neutral" | "insufficient data" {
  const voting = cells.filter((c) => !c.boundary && !c.flagged && !c.lowConfidence);
  const total = voting.reduce((s, c) => s + c.total, 0);
  if (total < 30) return "insufficient data";
  const up = voting.reduce((s, c) => s + c.up, 0);
  const share = (up / total) * 100;
  if (share > 55) return "runs small";
  if (share < 45) return "runs large";
  return "neutral";
}
