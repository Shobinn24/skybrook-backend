import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { daysOfStock, salesVelocity, sustainabilityFlags } from "@/lib/db/schema";
import { getIncomingStock } from "@/lib/queries/incoming";
import { getStockLevels, getStockValue } from "@/lib/queries/stock";
import { publicProcedure, router } from "@/lib/trpc/server";

const locationSchema = z.enum(["US", "CN"]);
const velocityWindowSchema = z
  .number()
  .int()
  .refine((n) => [3, 7, 30].includes(n), "windowDays must be 3, 7, or 30");

export const inventoryRouter = router({
  getStockLevels: publicProcedure
    .input(z.object({ sku: z.string().optional(), location: locationSchema.optional() }).optional())
    .query(({ input }) => getStockLevels(input ?? {})),

  getStockValue: publicProcedure
    .input(z.object({ location: locationSchema.optional(), productLine: z.string().optional() }).optional())
    .query(({ input }) => getStockValue(input ?? {})),

  getIncomingStock: publicProcedure
    .input(z.object({ sku: z.string().optional(), location: locationSchema.optional() }).optional())
    .query(({ input }) => getIncomingStock(input ?? {})),

  getSalesVelocity: publicProcedure
    .input(z.object({ sku: z.string(), windowDays: velocityWindowSchema }))
    .query(async ({ input }) => {
      const [row] = await db
        .select()
        .from(salesVelocity)
        .where(
          and(
            eq(salesVelocity.sku, input.sku),
            eq(salesVelocity.channel, "all"),
            eq(salesVelocity.windowDays, input.windowDays)
          )
        )
        .orderBy(desc(salesVelocity.asOfDate))
        .limit(1);
      return row ?? null;
    }),

  getDaysOfStock: publicProcedure
    .input(
      z.object({
        sku: z.string(),
        location: locationSchema,
        velocityWindow: z.number().int().default(7),
      })
    )
    .query(async ({ input }) => {
      const [row] = await db
        .select()
        .from(daysOfStock)
        .where(
          and(
            eq(daysOfStock.sku, input.sku),
            eq(daysOfStock.location, input.location),
            eq(daysOfStock.velocityWindowDays, input.velocityWindow)
          )
        )
        .orderBy(desc(daysOfStock.asOfDate))
        .limit(1);
      return row ?? null;
    }),

  getSustainabilityStatus: publicProcedure
    .input(z.object({ sku: z.string() }))
    .query(async ({ input }) => {
      return db
        .select()
        .from(sustainabilityFlags)
        .where(eq(sustainabilityFlags.sku, input.sku))
        .orderBy(desc(sustainabilityFlags.asOfDate))
        .limit(10);
    }),

  // Scott's signature output: every latest sustainability flag per (SKU, location).
  listLatestSustainabilityFlags: publicProcedure
    .input(z.object({ location: locationSchema.optional() }).optional())
    .query(async ({ input }) => {
      const rows = await db
        .select()
        .from(sustainabilityFlags)
        .orderBy(desc(sustainabilityFlags.asOfDate));
      const seen = new Set<string>();
      const latest: typeof rows = [];
      for (const r of rows) {
        const k = `${r.sku}:${r.location}`;
        if (seen.has(k)) continue;
        seen.add(k);
        if (input?.location && r.location !== input.location) continue;
        latest.push(r);
      }
      return latest;
    }),

  // Convenience: "overstocked" SKUs — pulls from latest sustainability flags only.
  getOverstockedSKUs: publicProcedure
    .input(z.object({ location: locationSchema.optional() }).optional())
    .query(async ({ input }) => {
      const rows = await db
        .select()
        .from(sustainabilityFlags)
        .where(eq(sustainabilityFlags.flag, "overstocked"))
        .orderBy(desc(sustainabilityFlags.asOfDate));
      const seen = new Set<string>();
      const latest: typeof rows = [];
      for (const r of rows) {
        const k = `${r.sku}:${r.location}`;
        if (seen.has(k)) continue;
        seen.add(k);
        if (input?.location && r.location !== input.location) continue;
        latest.push(r);
      }
      return latest;
    }),
});
