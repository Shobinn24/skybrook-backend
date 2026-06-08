import { db } from "@/lib/db";
import { cashflowEvents, dailySales } from "@/lib/db/schema";
import { getAssumptions } from "@/lib/queries/cashflow";
import { weekStartsForward, weekStartEst } from "@/lib/domain/cashflow-weeks";
import { projectRevenue } from "@/lib/domain/cashflow-math";
import type { ChannelKey } from "@/lib/domain/cashflow-math";
import { sql, gte, lte, and } from "drizzle-orm";
import { logger } from "@/lib/logger";
import { buildSheetsClient, parseBulkOrderForecast } from "@/lib/sources/sheets";

const HORIZON_WEEKS = 13;
const REVENUE_CATEGORY: Record<ChannelKey, "revenue_ev" | "revenue_jm" | "revenue_ewc"> = {
  ev: "revenue_ev", jm: "revenue_jm", ewc: "revenue_ewc",
};

/** Generates 13 weeks of revenue (per channel) + cogs_addback forecast events
 * from the current assumptions, starting at `firstWeekStart` (a Monday). */
export async function generateRevenueForecast(firstWeekStart: string): Promise<void> {
  const a = await getAssumptions();
  const weeks = weekStartsForward(firstWeekStart, HORIZON_WEEKS);
  const rows: (typeof cashflowEvents.$inferInsert)[] = [];
  weeks.forEach((week, i) => {
    let totalRev = 0;
    (Object.keys(REVENUE_CATEGORY) as ChannelKey[]).forEach((k) => {
      const rev = projectRevenue(a[k], i);
      totalRev += rev;
      rows.push({
        kind: "forecast", category: REVENUE_CATEGORY[k], direction: "in",
        amountUsd: rev.toFixed(2), accrualDate: week, cashDate: week,
        source: "auto_revenue", sourceRef: `revenue:${k}:${week}`,
        description: `${k.toUpperCase()} forecast revenue`,
      });
    });
    rows.push({
      kind: "forecast", category: "cogs_addback", direction: "in",
      amountUsd: (a.cogsPct * totalRev).toFixed(2), accrualDate: week, cashDate: week,
      source: "auto_revenue", sourceRef: `cogs:${week}`,
      description: "COGS add-back (paid via bulk orders)",
    });
  });
  await upsertGeneratedEvents(rows);
  logger.info("cashflow-forecast.revenue.done", { firstWeekStart, weeks: weeks.length, rows: rows.length });
}

/** Upsert generated events on the (source, source_ref) unique index so
 * re-running is a no-op / refresh, never a duplicate. */
export async function upsertGeneratedEvents(
  rows: (typeof cashflowEvents.$inferInsert)[],
): Promise<void> {
  if (rows.length === 0) return;
  await db.insert(cashflowEvents).values(rows).onConflictDoUpdate({
    target: [cashflowEvents.source, cashflowEvents.sourceRef],
    targetWhere: sql`${cashflowEvents.source} <> 'manual' AND ${cashflowEvents.sourceRef} IS NOT NULL`,
    set: {
      amountUsd: sql`excluded.amount_usd`,
      accrualDate: sql`excluded.accrual_date`,
      cashDate: sql`excluded.cash_date`,
      description: sql`excluded.description`,
      updatedAt: sql`now()`,
    },
  });
}

/**
 * Buckets daily_sales net sales (all channels = Everdries) into weekly
 * `actual` revenue_ev events for the [from,to] date range (inclusive).
 *
 * Sales are bucketed to the Monday of their week. If [from,to] does not span
 * whole weeks, the boundary weeks produce partial-week actuals; these
 * self-correct on the next run that covers the full week (the sourceRef is
 * keyed to the week-Monday, so the upsert overwrites in place).
 *
 * NOTE: do NOT add a throw/guard for non-week-aligned ranges — this function
 * is intentionally called with a non-week-aligned `to` (e.g. yesterday).
 */
export async function generateEvActuals(from: string, to: string): Promise<void> {
  const sales = await db.select({ salesDate: dailySales.salesDate, net: dailySales.netSalesUsd })
    .from(dailySales)
    .where(and(gte(dailySales.salesDate, from), lte(dailySales.salesDate, to)));
  const byWeek = new Map<string, number>();
  for (const s of sales) {
    const wk = weekStartEst(s.salesDate);
    // Amounts are summed as floats and rounded once via .toFixed(2) at the push site — do not refactor to integer-cent math.
    byWeek.set(wk, (byWeek.get(wk) ?? 0) + Number(s.net));
  }
  const rows: (typeof cashflowEvents.$inferInsert)[] = [];
  for (const [week, total] of byWeek) {
    rows.push({
      kind: "actual", category: "revenue_ev", direction: "in",
      amountUsd: total.toFixed(2), accrualDate: week, cashDate: week,
      source: "auto_revenue", sourceRef: `actual_revenue:ev:${week}`,
      description: "EV actual revenue (daily_sales)",
    });
  }
  await upsertGeneratedEvents(rows);
  logger.info("cashflow-forecast.ev-actuals.done", { from, to, rows: rows.length });
}

const BULK_ORDER_SHEET_ID = "1xcKzn6D6etJwcj5vjmR-6qqO16j7bnoXHcHa1caWYmU";
const BULK_ORDER_TAB = "Bulk Order Payment Forecast";

/** Pull the bulk-order schedule and write `bulk_order` forecast events
 * (out), bucketed to the Monday of each payment's week. Reuses the shared
 * read-only sheets client (GOOGLE_SERVICE_ACCOUNT_JSON / _CREDENTIALS). */
export async function generateBulkOrderForecast(): Promise<void> {
  const sheets = buildSheetsClient();
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: BULK_ORDER_SHEET_ID,
    range: `'${BULK_ORDER_TAB}'!A1:L400`,
  });
  const { rows: parsed, skipped } = parseBulkOrderForecast(resp.data.values ?? []);
  const rows: (typeof cashflowEvents.$inferInsert)[] = parsed.map((p) => {
    const week = weekStartEst(p.weekDate);
    return {
      kind: "forecast", category: "bulk_order", direction: "out",
      amountUsd: p.amountUsd.toFixed(2), accrualDate: p.weekDate, cashDate: week,
      source: "sheet_pull", sourceRef: `bulk:${p.weekDate}`,
      description: "Bulk order payment (sheet)",
    };
  });
  await upsertGeneratedEvents(rows);
  logger.info("cashflow-forecast.bulk-order.done", { rows: rows.length, skipped });
}

/**
 * Daily cron entry point: rolls the revenue/COGS forecast forward to the
 * current week and refreshes the bulk-order pull. The bulk pull hits the live
 * sheet, so it's best-effort — a sheet hiccup must not block the rest of the
 * ingest cron. (EV actuals aren't generated here yet — the grid reads only
 * `forecast` events, so actuals have no consumer until a later phase.)
 */
export async function runCashflowGenerators(asOfDate: string): Promise<{
  forecastWeek: string;
  bulkOk: boolean;
}> {
  const forecastWeek = weekStartEst(asOfDate);
  await generateRevenueForecast(forecastWeek);
  let bulkOk = false;
  try {
    await generateBulkOrderForecast();
    bulkOk = true;
  } catch (e) {
    logger.error("cashflow-forecast.bulk-order.failed", {
      error: e instanceof Error ? e.message : String(e),
    });
  }
  return { forecastWeek, bulkOk };
}
