import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { router, publicProcedure } from "@/lib/trpc/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { factoryOrders } from "@/lib/db/schema";
import {
  getOrCreateDraft,
  listOrders,
  monthKey,
  saveInputs,
  type FactoryOrderInputs,
} from "@/lib/queries/factory-order";
import { calculateOrder } from "@/lib/queries/factory-order-calc";

// Zod shapes mirror lib/queries/factory-order.ts. Kept here so the
// router file is the single source of validation for incoming
// requests; persistence layer trusts what it gets.

const forecastSchema = z.object({
  us: z.array(z.number().min(0)).length(4),
  intl: z.array(z.number().min(0)).length(3),
});

const splitsSchema = z.object({
  us: z.record(z.string(), z.number()),
  intl: z.record(z.string(), z.number()),
});

const inputsSchema = z.object({
  revenueUs: z.number().min(0).nullable(),
  revenueIntl: z.number().min(0).nullable(),
  revenueAmazon: z.number().min(0).nullable(),
  forecast: forecastSchema,
  splits: splitsSchema,
  scaling: z.record(z.string(), z.number()),
  customQtys: z.record(z.string(), z.number().int().min(0)),
  customUsShare: z.record(z.string(), z.number().min(0).max(1)),
  amazonData: z.record(
    z.string(),
    z.object({
      sales30d: z.number().min(0).optional(),
      stock: z.number().int().min(0).optional(),
      hold: z.number().int().min(0).optional(),
    }),
  ),
  comments: z.record(z.string(), z.string()),
  orderNotes: z.string().nullable(),
});

export const factoryOrderRouter = router({
  // Resolve a draft order for the given month. Idempotent — creates
  // the row if it doesn't exist so the dashboard can navigate
  // straight into "May 2026" without a preceding click-to-create.
  getDraft: publicProcedure
    .input(z.object({ orderMonth: z.string().min(7) })) // "YYYY-MM" or full date
    .query(({ input }) => getOrCreateDraft(input.orderMonth)),

  // Auto-save edits to the input panel. Errors with FORBIDDEN if the
  // order has already been approved — UI should disable inputs but
  // we double-check on the server.
  saveInputs: publicProcedure
    .input(
      z.object({
        orderId: z.string().uuid(),
        inputs: inputsSchema,
      }),
    )
    .mutation(async ({ input }) => {
      const header = await db
        .select()
        .from(factoryOrders)
        .where(eq(factoryOrders.id, input.orderId))
        .limit(1);
      if (header.length === 0) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `factory_order ${input.orderId} not found`,
        });
      }
      if (header[0].status === "approved") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Order is already approved and frozen",
        });
      }
      await saveInputs({
        orderId: input.orderId,
        inputs: input.inputs as FactoryOrderInputs,
      });
      return { ok: true as const };
    }),

  // Run the MOS calculation chain against the saved inputs + the
  // current state of daily_sales, stock_snapshots, incoming_shipments,
  // and skus. Pure computation on the server — does not mutate the
  // order. The dashboard hits this on every input change to refresh
  // the summary + detail tables.
  calculate: publicProcedure
    .input(z.object({ orderId: z.string().uuid() }))
    .query(({ input }) => calculateOrder({ orderId: input.orderId })),

  // List orders newest-first for the picker UI.
  list: publicProcedure.query(() => listOrders()),

  // Convenience: normalize an "any day in month" string to the first
  // of the month. Useful for the month-picker on the client without
  // having to import date utilities.
  monthKey: publicProcedure
    .input(z.object({ date: z.string().min(7) }))
    .query(({ input }) => monthKey(input.date)),
});
