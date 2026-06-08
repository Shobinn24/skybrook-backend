import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { cashflowAssumptions, cashflowEvents, cashflowWeekly } from "@/lib/db/schema";
import type { CashflowAssumptions } from "@/lib/domain/cashflow-math";
import { netProfit, profitPayout, variance, isVarianceSignificant } from "@/lib/domain/cashflow-math";
import { weekStartsForward } from "@/lib/domain/cashflow-weeks";

/** Reads the single assumptions row, seeding defaults on first access. */
export async function getAssumptions(): Promise<CashflowAssumptions & { id: string }> {
  let [row] = await db.select().from(cashflowAssumptions).limit(1);
  if (!row) {
    [row] = await db.insert(cashflowAssumptions).values({}).returning();
  }
  const n = (s: string) => Number(s);
  return {
    id: row.id,
    ev: { revenueStart: n(row.evRevenueStart), weeklyGrowth: n(row.evWeeklyGrowth), netMargin: n(row.evNetMargin) },
    jm: { revenueStart: n(row.jmRevenueStart), weeklyGrowth: n(row.jmWeeklyGrowth), netMargin: n(row.jmNetMargin) },
    ewc: { revenueStart: n(row.ewcRevenueStart), weeklyGrowth: n(row.ewcWeeklyGrowth), netMargin: n(row.ewcNetMargin) },
    cogsPct: n(row.cogsPct),
    profitPayoutPct: n(row.profitPayoutPct),
    varianceThresholdUsd: n(row.varianceThresholdUsd),
  };
}

export interface CashflowWeekRow {
  weekStart: string;
  beginning: number;
  cashIn: number;
  cashOut: number; // includes payout
  payout: number;
  ending: number;
  actualEnding: number | null;
  variance: number | null;
  varianceSignificant: boolean;
  varianceReason: "volume" | "spending" | "timing" | null;
  byCategory: Record<string, number>; // signed: + in, - out
}

export interface CashflowGrid {
  weeks: CashflowWeekRow[];
  thresholdUsd: number;
}

const HORIZON = 13;

/**
 * Rolls a 13-week forecast grid from `firstWeekStart` (a Monday). Beginning
 * balance snowballs week-to-week (or anchors to a manually entered total-cash
 * figure); payout is computed live from assumptions + per-week override/skip
 * (not stored as an event) and folded into cashOut.
 */
export async function getCashflowGrid(firstWeekStart: string): Promise<CashflowGrid> {
  const a = await getAssumptions();
  const weeks = weekStartsForward(firstWeekStart, HORIZON);
  const lastWeek = weeks[weeks.length - 1];

  // Aggregate forecast events by (week, category, direction).
  // date_trunc('week') in Postgres is Monday — matches weekStartsForward.
  const agg = await db
    .select({
      week: sql<string>`to_char(date_trunc('week', ${cashflowEvents.cashDate}), 'YYYY-MM-DD')`,
      category: cashflowEvents.category,
      direction: cashflowEvents.direction,
      total: sql<string>`sum(${cashflowEvents.amountUsd})`,
    })
    .from(cashflowEvents)
    .where(sql`${cashflowEvents.kind} = 'forecast'
      AND ${cashflowEvents.cashDate} >= ${firstWeekStart}
      AND ${cashflowEvents.cashDate} <= ${lastWeek}`)
    .groupBy(sql`1`, cashflowEvents.category, cashflowEvents.direction);

  const inByWeek = new Map<string, number>();
  const outByWeek = new Map<string, number>();
  const catByWeek = new Map<string, Record<string, number>>();
  for (const r of agg) {
    const v = Number(r.total);
    const cat = catByWeek.get(r.week) ?? {};
    cat[r.category] = (cat[r.category] ?? 0) + (r.direction === "in" ? v : -v);
    catByWeek.set(r.week, cat);
    if (r.direction === "in") inByWeek.set(r.week, (inByWeek.get(r.week) ?? 0) + v);
    else outByWeek.set(r.week, (outByWeek.get(r.week) ?? 0) + v);
  }

  // Per-week manual inputs.
  const weeklyRows = await db.select().from(cashflowWeekly);
  const weeklyByWeek = new Map(weeklyRows.map((w) => [w.weekStart, w]));

  const rows: CashflowWeekRow[] = [];
  let prevEnding = 0;
  weeks.forEach((week, i) => {
    const manual = weeklyByWeek.get(week);
    const enteredCash = manual?.actualTotalCashUsd != null ? Number(manual.actualTotalCashUsd) : null;
    // The calculated/expected starting cash for this week = the prior week's
    // ending (the snowball, already re-anchored by any prior actual). The first
    // visible week has no in-window prior, so there's nothing to compare against.
    const expectedBeginning = i === 0 ? null : prevEnding;
    const beginning = enteredCash != null ? enteredCash : (expectedBeginning ?? 0);

    const np = netProfit(a, i);
    const payout = profitPayout(np, {
      payoutPct: a.profitPayoutPct,
      overrideUsd: manual?.payoutOverrideUsd != null ? Number(manual.payoutOverrideUsd) : null,
      skipped: manual?.payoutSkipped ?? false,
    });

    const cashIn = inByWeek.get(week) ?? 0;
    const cashOut = (outByWeek.get(week) ?? 0) + payout;
    const ending = beginning + cashIn - cashOut;

    const cat = { ...(catByWeek.get(week) ?? {}) };
    cat["profit_payout"] = (cat["profit_payout"] ?? 0) - payout;

    // Variance (the reference sheet's "Difference" row): the actual cash entered
    // for the week vs the cash we'd calculated (expected starting balance).
    // The entered actual then re-anchors the snowball going forward.
    const actualEnding = enteredCash;
    const v =
      enteredCash != null && expectedBeginning != null
        ? variance(enteredCash, expectedBeginning)
        : null;

    rows.push({
      weekStart: week,
      beginning,
      cashIn,
      cashOut,
      payout,
      ending,
      actualEnding,
      variance: v,
      varianceSignificant: v != null && isVarianceSignificant(v, a.varianceThresholdUsd),
      varianceReason: manual?.varianceReason ?? null,
      byCategory: cat,
    });
    prevEnding = ending;
  });

  return { weeks: rows, thresholdUsd: a.varianceThresholdUsd };
}

export interface ManualEntryRow {
  ref: string;
  category: string;
  direction: "in" | "out";
  amountUsd: string;
  description: string;
  firstDate: string; // YYYY-MM-DD
  recurring: boolean; // true when the group has > 1 occurrence
  count: number;
}

/** Lists manual cashflow entries whose cash dates fall in the 13-week window,
 * grouped by their sourceRef so a monthly entry shows as a single recurring
 * row. Drives the "manual entries" management list on /cashflow. */
export async function listManualEntries(firstWeekStart: string): Promise<ManualEntryRow[]> {
  const weeks = weekStartsForward(firstWeekStart, HORIZON);
  const lastWeek = weeks[weeks.length - 1];
  const rows = await db
    .select({
      ref: cashflowEvents.sourceRef,
      id: cashflowEvents.id,
      category: cashflowEvents.category,
      direction: cashflowEvents.direction,
      amountUsd: cashflowEvents.amountUsd,
      description: cashflowEvents.description,
      cashDate: sql<string>`to_char(${cashflowEvents.cashDate}, 'YYYY-MM-DD')`,
    })
    .from(cashflowEvents)
    .where(sql`${cashflowEvents.source} = 'manual'
      AND ${cashflowEvents.cashDate} >= ${firstWeekStart}
      AND ${cashflowEvents.cashDate} <= ${lastWeek}`);

  const byRef = new Map<string, ManualEntryRow>();
  for (const r of rows) {
    const ref = r.ref ?? r.id;
    const existing = byRef.get(ref);
    if (existing) {
      existing.count += 1;
      if (r.cashDate < existing.firstDate) existing.firstDate = r.cashDate;
    } else {
      byRef.set(ref, {
        ref,
        category: r.category,
        direction: r.direction,
        amountUsd: r.amountUsd,
        description: r.description ?? "",
        firstDate: r.cashDate,
        recurring: false,
        count: 1,
      });
    }
  }
  return [...byRef.values()]
    .map((g) => ({ ...g, recurring: g.count > 1 }))
    .sort((a, b) => a.firstDate.localeCompare(b.firstDate));
}
