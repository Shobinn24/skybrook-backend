import { z } from "zod";
import { cashflowProcedure, router } from "@/lib/trpc/server";
import { getAssumptions, getCashflowGrid, listManualEntries } from "@/lib/queries/cashflow";
import {
  setAssumptions, enterWeeklyCash, setPayout, setVarianceReason,
  addManualEntry, deleteManualEntry,
} from "@/lib/jobs/cashflow-mutations";

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD");

const manualCategory = z.enum([
  "sales_tax", "tax", "payroll", "whitelisting", "software", "agency",
  "ad_spend_google", "ad_spend_meta", "tatari", "bulk_order", "one_off",
]);

// Every procedure here is cashflowProcedure — gated to the
// SKYBROOK_CASHFLOW_EMAILS allowlist server-side, mirroring the /cashflow
// page gate in middleware.ts. Write attribution comes from the session
// (ctx.email), never from client input.
export const cashflowRouter = router({
  getGrid: cashflowProcedure
    .input(z.object({ firstWeekStart: ymd }))
    .query(({ input }) => getCashflowGrid(input.firstWeekStart)),

  getAssumptions: cashflowProcedure.query(() => getAssumptions()),

  setAssumptions: cashflowProcedure
    .input(z.object({
      patch: z.object({
        evRevenueStart: z.number().optional(), evWeeklyGrowth: z.number().optional(), evNetMargin: z.number().optional(),
        jmRevenueStart: z.number().optional(), jmWeeklyGrowth: z.number().optional(), jmNetMargin: z.number().optional(),
        ewcRevenueStart: z.number().optional(), ewcWeeklyGrowth: z.number().optional(), ewcNetMargin: z.number().optional(),
        cogsPct: z.number().optional(), profitPayoutPct: z.number().optional(), varianceThresholdUsd: z.number().optional(),
      }),
      firstWeekStart: ymd.optional(),
    }))
    .mutation(({ input, ctx }) => setAssumptions(input.patch, ctx.email, input.firstWeekStart)),

  enterWeeklyCash: cashflowProcedure
    .input(z.object({ weekStart: ymd, totalCashUsd: z.number() }))
    .mutation(({ input, ctx }) => enterWeeklyCash(input.weekStart, input.totalCashUsd, ctx.email)),

  setPayout: cashflowProcedure
    .input(z.object({ weekStart: ymd, overrideUsd: z.number().nullable().optional(), skipped: z.boolean().optional() }))
    .mutation(({ input, ctx }) => setPayout(input.weekStart, { overrideUsd: input.overrideUsd, skipped: input.skipped }, ctx.email)),

  setVarianceReason: cashflowProcedure
    .input(z.object({ weekStart: ymd, reason: z.enum(["volume", "spending", "timing"]).nullable(), note: z.string().nullable() }))
    .mutation(({ input, ctx }) => setVarianceReason(input.weekStart, input.reason, input.note, ctx.email)),

  listManualEntries: cashflowProcedure
    .input(z.object({ firstWeekStart: ymd }))
    .query(({ input }) => listManualEntries(input.firstWeekStart)),

  addManualEntry: cashflowProcedure
    .input(z.object({
      category: manualCategory,
      direction: z.enum(["in", "out"]).optional(),
      amountUsd: z.number(),
      cashDate: ymd,
      description: z.string(),
      repeatMonthly: z.boolean().optional(),
    }))
    .mutation(({ input, ctx }) => addManualEntry(input, ctx.email)),

  deleteManualEntry: cashflowProcedure
    .input(z.object({ ref: z.string() }))
    .mutation(({ input, ctx }) => deleteManualEntry(input.ref, ctx.email)),
});
