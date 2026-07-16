import { z } from "zod";
import { and, eq, gte, isNull, lte, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { csExchanges, shopifyRefundLines, variantSalesMonthly } from "@/lib/db/schema";
import { opsProcedure, router } from "@/lib/trpc/server";
import { buildDirectionMix, buildSalesWeighted, labelVerdict } from "@/lib/sizing/compute";

// Sizing exchange analysis (Scott 2026-07-15). Two views per the spec:
// direction mix (denominator = exchanges: which way does a size miss?)
// and sales-weighted rate (denominator = units sold: how much does it
// matter?). Plus per-product exchange/refund rates for the reviews page.

const range = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

function exchangeConds(input: z.infer<typeof range>) {
  const conds = [
    isNull(csExchanges.excluded),
    eq(csExchanges.description, "sizing issue"),
    sql`${csExchanges.direction} in ('up','down','same')`,
  ];
  if (input.from) conds.push(gte(csExchanges.rowDate, input.from));
  if (input.to) conds.push(lte(csExchanges.rowDate, input.to));
  return conds;
}

async function directionRows(input: z.infer<typeof range>) {
  return db
    .select({
      label: sql<string>`${csExchanges.label}`,
      size: sql<string>`${csExchanges.sizeOrdered}`,
      up: sql<number>`count(*) filter (where ${csExchanges.direction} = 'up')::int`,
      down: sql<number>`count(*) filter (where ${csExchanges.direction} = 'down')::int`,
      same: sql<number>`count(*) filter (where ${csExchanges.direction} = 'same')::int`,
    })
    .from(csExchanges)
    .where(and(...exchangeConds(input), sql`${csExchanges.sizeOrdered} is not null`))
    .groupBy(csExchanges.label, csExchanges.sizeOrdered);
}

// Sales window: whole months covering the CS window (monthly grain).
function salesMonthConds(input: z.infer<typeof range>) {
  const conds = [];
  if (input.from) conds.push(gte(variantSalesMonthly.month, `${input.from.slice(0, 7)}-01`));
  if (input.to) conds.push(lte(variantSalesMonthly.month, `${input.to.slice(0, 7)}-01`));
  return conds;
}

export const sizingRouter = router({
  // Output 1 — direction mix by product × size, with verdicts.
  directionMix: opsProcedure.input(range).query(async ({ input }) => {
    const rows = await directionRows(input);
    const cells = buildDirectionMix(rows);
    const labels = [...new Set(cells.map((c) => c.label))];
    const panels = labels
      .map((label) => {
        const labelCells = cells.filter((c) => c.label === label);
        return {
          label,
          totalExchanges: labelCells.reduce((s, c) => s + c.total, 0),
          verdict: labelVerdict(labelCells),
          cells: labelCells,
        };
      })
      .sort((a, b) => b.totalExchanges - a.totalExchanges);
    return { panels };
  }),

  // Output 2 — sales-weighted exchange rate by product × size.
  salesWeighted: opsProcedure.input(range).query(async ({ input }) => {
    // Mismatched windows silently distort the rate (spec section 1B):
    // when no explicit from-date is given, the sales window derives from
    // the CS data's own start so both sides cover the same months.
    let effective = input;
    if (!input.from) {
      const [minRow] = await db
        .select({ min: sql<string | null>`min(${csExchanges.rowDate})::text` })
        .from(csExchanges)
        .where(isNull(csExchanges.excluded));
      if (minRow?.min) effective = { ...input, from: minRow.min };
    }
    const [mixRows, sales] = await Promise.all([
      directionRows(effective),
      db
        .select({
          label: variantSalesMonthly.label,
          size: variantSalesMonthly.size,
          units: sql<number>`sum(${variantSalesMonthly.units})::int`,
        })
        .from(variantSalesMonthly)
        .where(salesMonthConds(effective).length ? and(...salesMonthConds(effective)) : undefined)
        .groupBy(variantSalesMonthly.label, variantSalesMonthly.size),
    ]);
    const cells = buildSalesWeighted(sales, buildDirectionMix(mixRows));
    const labels = [...new Set(cells.map((c) => c.label))];
    const panels = labels
      .map((label) => {
        const labelCells = cells.filter((c) => c.label === label);
        return {
          label,
          units: labelCells.reduce((s, c) => s + c.units, 0),
          exchanges: labelCells.reduce((s, c) => s + c.exchanges, 0),
          cells: labelCells,
        };
      })
      .sort((a, b) => b.exchanges - a.exchanges);
    return { panels, salesCoverage: await salesCoverage() };
  }),

  // Per-product rates for the reviews page: keyed by (displayName, line).
  productRates: opsProcedure.query(async () => {
    const [exchangesByLabel, refundsByLabel, salesByLabel] = await Promise.all([
      db
        .select({
          label: csExchanges.label,
          n: sql<number>`count(*)::int`,
        })
        .from(csExchanges)
        .where(and(isNull(csExchanges.excluded), eq(csExchanges.description, "sizing issue")))
        .groupBy(csExchanges.label),
      // Refunds from Shopify refund objects (Scott 2026-07-16) — counts
      // refunded UNITS, so the rate shares the units-sold denominator.
      db
        .select({
          label: shopifyRefundLines.label,
          n: sql<number>`coalesce(sum(${shopifyRefundLines.units}), 0)::int`,
          amount: sql<number>`coalesce(sum(${shopifyRefundLines.amountUsd}), 0)::float`,
        })
        .from(shopifyRefundLines)
        .where(gte(shopifyRefundLines.refundDate, "2026-01-01"))
        .groupBy(shopifyRefundLines.label),
      db
        .select({
          label: variantSalesMonthly.label,
          units: sql<number>`sum(${variantSalesMonthly.units})::int`,
        })
        .from(variantSalesMonthly)
        // CS data starts 2026-01; rates use the same window
        .where(gte(variantSalesMonthly.month, "2026-01-01"))
        .groupBy(variantSalesMonthly.label),
    ]);

    const ex = new Map(exchangesByLabel.map((r) => [r.label, r.n]));
    const re = new Map(refundsByLabel.map((r) => [r.label, r]));
    const rates = salesByLabel
      .filter((s) => s.units > 0 && s.label != null)
      .map((s) => ({
        label: s.label!,
        units: s.units,
        exchanges: ex.get(s.label) ?? 0,
        refunds: re.get(s.label)?.n ?? 0,
        refundDollars: Math.round(re.get(s.label)?.amount ?? 0),
        pctExchange: Math.round(((ex.get(s.label) ?? 0) / s.units) * 1000) / 10,
        pctRefund: Math.round(((re.get(s.label)?.n ?? 0) / s.units) * 1000) / 10,
      }));
    return { rates, window: "2026-01-01 onward · refunds from Shopify" };
  }),
});

async function salesCoverage() {
  const [row] = await db
    .select({
      from: sql<string | null>`min(${variantSalesMonthly.month})::text`,
      to: sql<string | null>`max(${variantSalesMonthly.month})::text`,
    })
    .from(variantSalesMonthly);
  return row ?? { from: null, to: null };
}


