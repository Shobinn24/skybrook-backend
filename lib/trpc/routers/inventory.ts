import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import {
  daysOfStock,
  incomingReceipts,
  productLaunches,
  salesVelocity,
  sustainabilityFlags,
  velocityOverrides,
} from "@/lib/db/schema";
import { getIncomingShipmentsView, getIncomingStock } from "@/lib/queries/incoming";
import {
  getDistinctProductNames,
  getDistinctShipmentNames,
  getLaunches,
} from "@/lib/queries/launches";
import { getFbAdsRollup } from "@/lib/queries/fb-ads";
import { getBonusTracker } from "@/lib/queries/bonus-tracker";
import { getPerformanceRollup } from "@/lib/queries/performance";
import { getInventoryRows } from "@/lib/queries/inventory";
import { getVelocityForRange } from "@/lib/queries/velocity-range";
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

  // On-demand per-SKU velocity over an arbitrary date range. Used by
  // /inventory when an operator opens the date picker to cross-check
  // velocity against an external spreadsheet over a chosen window.
  // The default 7-day velocity still comes from the pre-computed
  // sales_velocity table via getInventoryRows.
  getVelocityForRange: publicProcedure
    .input(
      z.object({
        location: locationSchema,
        rangeStart: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, "rangeStart must be YYYY-MM-DD"),
        rangeEnd: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, "rangeEnd must be YYYY-MM-DD"),
      }),
    )
    .query(({ input }) => getVelocityForRange(input)),

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
  // `productName` is optional; null/omitted = brand-level (applies to
  // every SKU at the location). Set to a productName for product-scoped
  // overrides — those take precedence over brand-level for the same day.
  addVelocityOverride: publicProcedure
    .input(
      z
        .object({
          location: locationSchema,
          productName: z.string().min(1).max(120).optional(),
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
          productName: input.productName ?? null,
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

  // /performance page rollup. Returns per-canonical-product revenue +
  // spend + ROAS for the trailing rangeDays ending on endDate (or
  // yesterday EST if endDate omitted). rangeDays=1 is a single day.
  getPerformance: publicProcedure
    .input(
      z.object({
        rangeDays: z
          .number()
          .int()
          .refine((n) => [1, 7, 14, 30].includes(n), "rangeDays must be 1, 7, 14, or 30"),
        endDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, "endDate must be YYYY-MM-DD")
          .optional(),
      }),
    )
    .query(({ input }) => {
      // Rollup treats `today` as the not-yet-complete anchor and
      // returns [today - rangeDays, today - 1]. To make the window
      // end on a chosen endDate, anchor today at endDate + 1 day.
      let today: string;
      if (input.endDate) {
        const [y, m, d] = input.endDate.split("-").map(Number);
        today = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
      } else {
        today = toEstDate(new Date());
      }
      return getPerformanceRollup({
        today,
        rangeDays: input.rangeDays,
      });
    }),

  // /launches page — returns all launch rows with derived ETA Ant/PD.
  getLaunches: publicProcedure.query(() => getLaunches()),

  // Dropdowns powering the "Add launch" form.
  getLaunchFormOptions: publicProcedure.query(async () => {
    const [productNames, shipmentNames] = await Promise.all([
      getDistinctProductNames(),
      getDistinctShipmentNames(),
    ]);
    return { productNames, shipmentNames };
  }),

  addLaunch: publicProcedure
    .input(
      z.object({
        productName: z.string().min(1).max(120),
        shipmentName: z.string().min(1).max(200),
      }),
    )
    .mutation(async ({ input }) => {
      const [row] = await db
        .insert(productLaunches)
        .values({
          productName: input.productName,
          shipmentName: input.shipmentName,
        })
        .onConflictDoNothing({
          target: [productLaunches.productName, productLaunches.shipmentName],
        })
        .returning({ id: productLaunches.id });
      return { id: row?.id ?? null };
    }),

  // Patch one or more of the four manual launch dates. Pass null to
  // clear a previously-set date.
  updateLaunchDates: publicProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        intlSiteLive: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
        intlLaunchDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
        usSiteLive: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
        usLaunchDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
        note: z.string().max(500).nullable().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const { id, ...rest } = input;
      // Build a partial object with only fields the caller actually sent
      // — `undefined` means "leave alone", `null` means "clear".
      const set: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(rest)) {
        if (v !== undefined) set[k] = v;
      }
      if (Object.keys(set).length === 0) return { ok: true as const };
      await db.update(productLaunches).set(set).where(eq(productLaunches.id, id));
      return { ok: true as const };
    }),

  removeLaunch: publicProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input }) => {
      await db.delete(productLaunches).where(eq(productLaunches.id, input.id));
      return { ok: true as const };
    }),

  // /fb-ads — top-spending FB ads, pivoted by ad number, for an
  // arbitrary [rangeStart, rangeEnd] window. Sorted desc by spend.
  // Optional `marketers` filter narrows to ads attributed to any of
  // the selected names; passing "Unassigned" includes ads whose
  // ad_name_raw didn't match the 8-marketer roster at ingest.
  getFbAdsRollup: publicProcedure
    .input(
      z.object({
        rangeStart: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, "rangeStart must be YYYY-MM-DD"),
        rangeEnd: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, "rangeEnd must be YYYY-MM-DD"),
        marketers: z.array(z.string()).optional(),
      }),
    )
    .query(({ input }) => {
      const { rangeStart, rangeEnd, marketers } = input;
      const norm = marketers && marketers.length > 0 ? marketers : undefined;
      if (rangeStart > rangeEnd) {
        return getFbAdsRollup({
          rangeStart: rangeEnd,
          rangeEnd: rangeStart,
          marketers: norm,
        });
      }
      return getFbAdsRollup({ rangeStart, rangeEnd, marketers: norm });
    }),

  // Lifetime FB ad spend per bonus-eligible marketer. No date filter —
  // bonus tiers are cumulative. Spec: §Bonus Tracker, Jasper 2026-05-11.
  getBonusTracker: publicProcedure.query(() => getBonusTracker()),
});
