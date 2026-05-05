import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import {
  daysOfStock,
  incomingReceipts,
  salesVelocity,
  sustainabilityFlags,
  velocityOverrides,
} from "@/lib/db/schema";
import { getIncomingShipmentsView, getIncomingStock } from "@/lib/queries/incoming";
import { getInventoryRows } from "@/lib/queries/inventory";
import { getOverstockRows } from "@/lib/queries/overstock";
import {
  getStockLevels,
  getStockValue,
  getStockValueByProduct,
  getStockValueByProductLine,
} from "@/lib/queries/stock";
import { getSkuDetail } from "@/lib/queries/sku-detail";
import { getSustainabilityTimeline } from "@/lib/queries/sustainability-timeline";
import { toEstDate } from "@/lib/tz";
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

  // Per-delivery sustainability timeline view powering the redesigned
  // /sustainability page. Mirrors Scott's "Sustainability Check" sheet
  // (2026-04-28 punch-list #8). For each SKU at the location: sales
  // over a configurable window, prorated 30-day equivalent, current
  // stock, and a projection row per upcoming shipment.
  getSustainabilityTimeline: publicProcedure
    .input(
      z.object({
        location: locationSchema,
        windowDays: z.number().int().min(1).max(90).optional(),
      }),
    )
    .query(({ input }) =>
      getSustainabilityTimeline({
        location: input.location,
        today: toEstDate(new Date()),
        windowDays: input.windowDays,
      }),
    ),

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

  // Per-SKU detail page (SPEC §5.7 q1+q6). Single fat query that
  // returns the full picture for one SKU: per-warehouse stock + value
  // + flag + DOS + incoming POs, plus a velocity matrix at 3/7/30d
  // across `all` / `shopify_us` / `shopify_intl` channels. Returns
  // null when the SKU isn't in the catalog (404 at the page level).
  getSkuDetail: publicProcedure
    .input(z.object({ sku: z.string().min(1) }))
    .query(({ input }) => getSkuDetail(input.sku)),

  // Page-feeding endpoint for /overstock (SPEC §5.5). Returns enriched
  // InventoryRow records (SKU, product name, on-hand, velocity, DOS,
  // stock value, full trace) filtered to flag === "overstocked", sorted
  // by stock-value descending — biggest-leverage marketing candidates
  // first. Plus a summary block for the KPI strip at the top of the page.
  getOverstockView: publicProcedure.query(() => getOverstockRows()),

  // Page-feeding endpoint for /incoming (SPEC §5.7 q3). Forward-looking
  // arrivals view: returns the joined SKU + shipment rows sorted by
  // expectedArrival ascending plus a summary block (total units inbound,
  // shipment count, SKU count, next arrival, overdue count). Default view
  // shows pending + overdue rows (anything without a receipt confirmation);
  // `includeReceived: true` adds historical received rows for the page-level
  // "Show past shipments" toggle.
  getIncomingShipmentsView: publicProcedure
    .input(
      z
        .object({
          destination: locationSchema.optional(),
          includeReceived: z.boolean().optional(),
        })
        .optional(),
    )
    .query(({ input }) => getIncomingShipmentsView(input ?? {})),

  // Mark a PO received. Idempotent — re-clicking is a no-op (ON CONFLICT DO
  // NOTHING on the natural-key unique index). Keyed by the same triple the
  // sheet ingest produces, so receipts survive truncate-replace cron runs.
  markIncomingReceived: publicProcedure
    .input(
      z.object({
        shipmentName: z.string().min(1),
        destination: locationSchema,
        expectedArrival: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        note: z.string().max(500).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      await db
        .insert(incomingReceipts)
        .values({
          shipmentName: input.shipmentName,
          destination: input.destination,
          expectedArrival: input.expectedArrival,
          note: input.note ?? null,
        })
        .onConflictDoNothing({
          target: [
            incomingReceipts.shipmentName,
            incomingReceipts.destination,
            incomingReceipts.expectedArrival,
          ],
        });
      return { ok: true as const };
    }),

  // Undo "mark received" — Scott clicked the button by mistake or the PO
  // turned out not to have actually arrived. Idempotent; deleting a missing
  // row is a no-op.
  unmarkIncomingReceived: publicProcedure
    .input(
      z.object({
        shipmentName: z.string().min(1),
        destination: locationSchema,
        expectedArrival: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      }),
    )
    .mutation(async ({ input }) => {
      await db
        .delete(incomingReceipts)
        .where(
          and(
            eq(incomingReceipts.shipmentName, input.shipmentName),
            eq(incomingReceipts.destination, input.destination),
            eq(incomingReceipts.expectedArrival, input.expectedArrival),
          ),
        );
      return { ok: true as const };
    }),

  // Add a velocity override (scaling factor) for a date range at a
  // location. Multiplier is a positive number; 1.0 = no change, 1.2 =
  // +20%, 0.8 = -20%. Range is [startDate, endDate] inclusive.
  addVelocityOverride: publicProcedure
    .input(
      z
        .object({
          location: locationSchema,
          startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          multiplier: z.number().positive().lte(10),
          note: z.string().max(200).optional(),
        })
        .refine((d) => d.startDate <= d.endDate, {
          message: "startDate must be on or before endDate",
        }),
    )
    .mutation(async ({ input }) => {
      const [row] = await db
        .insert(velocityOverrides)
        .values({
          location: input.location,
          startDate: input.startDate,
          endDate: input.endDate,
          multiplier: input.multiplier.toString(),
          note: input.note ?? null,
        })
        .returning({ id: velocityOverrides.id });
      return { id: row.id };
    }),

  removeVelocityOverride: publicProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input }) => {
      await db.delete(velocityOverrides).where(eq(velocityOverrides.id, input.id));
      return { ok: true as const };
    }),
});
