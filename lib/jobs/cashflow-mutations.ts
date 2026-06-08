import { eq, and } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { cashflowAssumptions, cashflowWeekly, cashflowEvents } from "@/lib/db/schema";
import { getAssumptions } from "@/lib/queries/cashflow";
import { logger } from "@/lib/logger";

const HORIZON_WEEKS = 13;

export interface AssumptionPatch {
  evRevenueStart?: number; evWeeklyGrowth?: number; evNetMargin?: number;
  jmRevenueStart?: number; jmWeeklyGrowth?: number; jmNetMargin?: number;
  ewcRevenueStart?: number; ewcWeeklyGrowth?: number; ewcNetMargin?: number;
  cogsPct?: number; profitPayoutPct?: number; varianceThresholdUsd?: number;
}

export async function setAssumptions(patch: AssumptionPatch, by: string): Promise<void> {
  const current = await getAssumptions(); // ensures a row exists
  const toStr = (v: number | undefined) => (v == null ? undefined : String(v));
  await db.update(cashflowAssumptions)
    .set({
      evRevenueStart: toStr(patch.evRevenueStart), evWeeklyGrowth: toStr(patch.evWeeklyGrowth), evNetMargin: toStr(patch.evNetMargin),
      jmRevenueStart: toStr(patch.jmRevenueStart), jmWeeklyGrowth: toStr(patch.jmWeeklyGrowth), jmNetMargin: toStr(patch.jmNetMargin),
      ewcRevenueStart: toStr(patch.ewcRevenueStart), ewcWeeklyGrowth: toStr(patch.ewcWeeklyGrowth), ewcNetMargin: toStr(patch.ewcNetMargin),
      cogsPct: toStr(patch.cogsPct), profitPayoutPct: toStr(patch.profitPayoutPct), varianceThresholdUsd: toStr(patch.varianceThresholdUsd),
      updatedAt: new Date(), updatedBy: by,
    })
    .where(eq(cashflowAssumptions.id, current.id));
  logger.info("cashflow.assumptions.set", { patch, by });
}

async function upsertWeekly(
  weekStart: string,
  patch: Partial<typeof cashflowWeekly.$inferInsert>,
  by: string,
): Promise<void> {
  await db.insert(cashflowWeekly)
    .values({ weekStart, recordedBy: by, ...patch })
    .onConflictDoUpdate({
      target: cashflowWeekly.weekStart,
      set: { ...patch, recordedAt: new Date(), recordedBy: by },
    });
}

export async function enterWeeklyCash(weekStart: string, totalCashUsd: number, by: string): Promise<void> {
  await upsertWeekly(weekStart, { actualTotalCashUsd: totalCashUsd.toFixed(2) }, by);
}

export async function setPayout(
  weekStart: string,
  opts: { overrideUsd?: number | null; skipped?: boolean },
  by: string,
): Promise<void> {
  const patch: Partial<typeof cashflowWeekly.$inferInsert> = {};
  if (opts.overrideUsd !== undefined) {
    patch.payoutOverrideUsd = opts.overrideUsd == null ? null : opts.overrideUsd.toFixed(2);
  }
  if (opts.skipped !== undefined) patch.payoutSkipped = opts.skipped;
  await upsertWeekly(weekStart, patch, by);
}

export async function setVarianceReason(
  weekStart: string,
  reason: "volume" | "spending" | "timing" | null,
  note: string | null,
  by: string,
): Promise<void> {
  await upsertWeekly(weekStart, { varianceReason: reason, varianceNote: note }, by);
}

type EventInsert = typeof cashflowEvents.$inferInsert;

export interface ManualEntryInput {
  category: EventInsert["category"];
  direction?: EventInsert["direction"]; // defaults to "out" (expenses)
  amountUsd: number;
  cashDate: string; // YYYY-MM-DD
  description: string;
  repeatMonthly?: boolean;
}

/** Monthly occurrences on the same day-of-month, from `startYmd` forward,
 * staying within `horizonWeeks` of the start. */
function monthlyOccurrences(startYmd: string, horizonWeeks: number): string[] {
  const [y, m, d] = startYmd.split("-").map(Number);
  const limit = Date.UTC(y, m - 1, d) + horizonWeeks * 7 * 86_400_000;
  const out: string[] = [];
  let yy = y;
  let mm = m;
  for (let k = 0; k < 14; k++) {
    if (Date.UTC(yy, mm - 1, d) > limit) break;
    out.push(`${yy}-${String(mm).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
    mm += 1;
    if (mm > 12) {
      mm = 1;
      yy += 1;
    }
  }
  return out;
}

/** Add a manual cashflow entry (default direction "out" = an expense). When
 * `repeatMonthly`, materializes one event per month across the 13-week horizon,
 * all sharing one `sourceRef` group so they list + delete as a unit. Returns
 * the group ref. */
export async function addManualEntry(input: ManualEntryInput, by: string): Promise<string> {
  const ref = `manual:${randomUUID()}`;
  const dir = input.direction ?? "out";
  const dates = input.repeatMonthly
    ? monthlyOccurrences(input.cashDate, HORIZON_WEEKS)
    : [input.cashDate];
  const rows: EventInsert[] = dates.map((d) => ({
    kind: "forecast",
    category: input.category,
    direction: dir,
    amountUsd: input.amountUsd.toFixed(2),
    accrualDate: d,
    cashDate: d,
    source: "manual",
    sourceRef: ref,
    description: input.description,
  }));
  await db.insert(cashflowEvents).values(rows);
  logger.info("cashflow.manual.add", { ref, category: input.category, count: rows.length, by });
  return ref;
}

/** Delete a manual entry group (all events sharing the sourceRef). */
export async function deleteManualEntry(ref: string, by: string): Promise<void> {
  await db
    .delete(cashflowEvents)
    .where(and(eq(cashflowEvents.source, "manual"), eq(cashflowEvents.sourceRef, ref)));
  logger.info("cashflow.manual.delete", { ref, by });
}
