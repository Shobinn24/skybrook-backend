import { z } from "zod";
import { publicProcedure, router } from "@/lib/trpc/server";
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

export const cashflowRouter = router({
  getGrid: publicProcedure
    .input(z.object({ firstWeekStart: ymd }))
    .query(({ input }) => getCashflowGrid(input.firstWeekStart)),

  getAssumptions: publicProcedure.query(() => getAssumptions()),

  setAssumptions: publicProcedure
    .input(z.object({
      patch: z.object({
        evRevenueStart: z.number().optional(), evWeeklyGrowth: z.number().optional(), evNetMargin: z.number().optional(),
        jmRevenueStart: z.number().optional(), jmWeeklyGrowth: z.number().optional(), jmNetMargin: z.number().optional(),
        ewcRevenueStart: z.number().optional(), ewcWeeklyGrowth: z.number().optional(), ewcNetMargin: z.number().optional(),
        cogsPct: z.number().optional(), profitPayoutPct: z.number().optional(), varianceThresholdUsd: z.number().optional(),
      }),
      by: z.string(),
      firstWeekStart: ymd.optional(),
    }))
    .mutation(({ input }) => setAssumptions(input.patch, input.by, input.firstWeekStart)),

  enterWeeklyCash: publicProcedure
    .input(z.object({ weekStart: ymd, totalCashUsd: z.number(), by: z.string() }))
    .mutation(({ input }) => enterWeeklyCash(input.weekStart, input.totalCashUsd, input.by)),

  setPayout: publicProcedure
    .input(z.object({ weekStart: ymd, overrideUsd: z.number().nullable().optional(), skipped: z.boolean().optional(), by: z.string() }))
    .mutation(({ input }) => setPayout(input.weekStart, { overrideUsd: input.overrideUsd, skipped: input.skipped }, input.by)),

  setVarianceReason: publicProcedure
    .input(z.object({ weekStart: ymd, reason: z.enum(["volume", "spending", "timing"]).nullable(), note: z.string().nullable(), by: z.string() }))
    .mutation(({ input }) => setVarianceReason(input.weekStart, input.reason, input.note, input.by)),

  listManualEntries: publicProcedure
    .input(z.object({ firstWeekStart: ymd }))
    .query(({ input }) => listManualEntries(input.firstWeekStart)),

  addManualEntry: publicProcedure
    .input(z.object({
      category: manualCategory,
      direction: z.enum(["in", "out"]).optional(),
      amountUsd: z.number(),
      cashDate: ymd,
      description: z.string(),
      repeatMonthly: z.boolean().optional(),
      by: z.string(),
    }))
    .mutation(({ input }) => addManualEntry(input, input.by)),

  deleteManualEntry: publicProcedure
    .input(z.object({ ref: z.string(), by: z.string() }))
    .mutation(({ input }) => deleteManualEntry(input.ref, input.by)),
});
