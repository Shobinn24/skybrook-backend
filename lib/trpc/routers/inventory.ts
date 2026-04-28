import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { daysOfStock, salesVelocity, sustainabilityFlags } from "@/lib/db/schema";
import { getIncomingShipmentsView, getIncomingStock } from "@/lib/queries/incoming";
import { getInventoryRows } from "@/lib/queries/inventory";
import { getOverstockRows } from "@/lib/queries/overstock";
import {
  getStockLevels,
  getStockValue,
  getStockValueByProduct,
  getStockValueByProductLine,
} from "@/lib/queries/stock";
import { publicProcedure, router } from "@/lib/trpc/server";

const locationSchema = z.enum(["US", "CN"]);
const velocityWindowSchema = z
  .number()
  .int()
  .refine((n) => [3, 7, 30].includes(n), "windowDays must be 3, 7, or 30");

export const inventoryRouter = router({
  // One-shot view for the inventory page — returns rows with stock, velocity,
  // DOS, weeks of stock, flag, incoming units, and stock value per SKU.
  getInventoryRows: publicProcedure
    .input(z.object({ location: locationSchema }))
    .query(({ input }) => getInventoryRows(input.location)),

  getStockLevels: publicProcedure
    .input(z.object({ sku: z.string().optional(), location: locationSchema.optional() }).optional())
    .query(({ input }) => getStockLevels(input ?? {})),

  getStockValue: publicProcedure
    .input(z.object({ location: locationSchema.optional(), productLine: z.string().optional() }).optional())
    .query(({ input }) => getStockValue(input ?? {})),

  // Per-product-line $ rollup for the inventory page (SPEC §5.7 q2).
  // Honours the warehouse toggle so the breakdown matches the rest
  // of the page rather than fighting it with combined totals.
  getStockValueByProductLine: publicProcedure
    .input(z.object({ location: locationSchema.optional() }).optional())
    .query(({ input }) => getStockValueByProductLine(input ?? {})),

  // Per-product (garment-name) $ rollup for the dedicated /stock-value
  // page. Resolves Scott's #10 ask 2026-04-28 ("split it up by product
  // not main/sec").
  getStockValueByProduct: publicProcedure
    .input(z.object({ location: locationSchema.optional() }).optional())
    .query(({ input }) => getStockValueByProduct(input ?? {})),

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

  // Page-feeding endpoint for /overstock (SPEC §5.5). Returns enriched
  // InventoryRow records (SKU, product name, on-hand, velocity, DOS,
  // stock value, full trace) filtered to flag === "overstocked", sorted
  // by stock-value descending — biggest-leverage marketing candidates
  // first. Plus a summary block for the KPI strip at the top of the page.
  getOverstockView: publicProcedure.query(() => getOverstockRows()),

  // Page-feeding endpoint for /incoming (SPEC §5.7 q3). Forward-looking
  // arrivals view: returns the joined SKU + shipment rows sorted by
  // expectedArrival ascending plus a summary block (total units inbound,
  // shipment count, SKU count, next arrival). Status defaults to the
  // pending set (po + dispatched + in_transit) — `arrived` is excluded
  // unless the caller asks for history, since arrived units already
  // count in stock_snapshots and would just clutter the page.
  getIncomingShipmentsView: publicProcedure
    .input(
      z
        .object({
          destination: locationSchema.optional(),
          includeArrived: z.boolean().optional(),
        })
        .optional(),
    )
    .query(({ input }) => getIncomingShipmentsView(input ?? {})),
});
