// Phase 2 — derives sales_velocity, days_of_stock, and sustainability_flags.
// Reconciliation (expected-vs-actual stock) is deferred past MVP; this file is the
// "derive" half only, kept under the name `reconcile.ts` for naming continuity with
// the original plan.

import { and, desc, eq, gte, lte } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  dailySales,
  daysOfStock,
  incomingShipments,
  salesVelocity,
  skus,
  stockSnapshots,
  sustainabilityFlags,
} from "@/lib/db/schema";
import { computeDaysOfStock } from "@/lib/domain/days-of-stock";
import { computeSustainabilityFlag, type IncomingPO } from "@/lib/domain/sustainability";
import { computeVelocity, type SaleEvent } from "@/lib/domain/velocity";
import {
  getReceivedShipmentKeys,
  shipmentReceiptKey,
} from "@/lib/queries/incoming";
import type { Location } from "@/lib/domain/warehouse-routing";
import { logger } from "@/lib/logger";

const LOCATIONS: Location[] = ["US", "CN"];
const VELOCITY_WINDOWS = [3, 7, 30];
const DOS_WINDOW = 7; // days-of-stock uses 7-day velocity

// Velocity rows we persist per (SKU, window, asOfDate). 'all' is the
// cross-channel total; the other two are the per-warehouse slices the
// dashboard needs to show different numbers per location toggle.
const VELOCITY_AGGREGATIONS: ReadonlyArray<{
  channel: string;
  routedLocation?: Location;
}> = [
  { channel: "all" },
  { channel: "shopify_us", routedLocation: "US" },
  { channel: "shopify_intl", routedLocation: "CN" },
];

// MVP heuristic (see QUESTIONS.md §3 tradeoff "Reports API instead of Orders API"):
// Main (US) store ships mostly to US → assume its sales deplete US stock.
// Intl store is 100% non-US by design → its sales deplete CN stock.
function channelToLocation(channel: string): Location {
  return channel === "shopify_us" ? "US" : "CN";
}

function addDaysYmd(ymd: string, delta: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

export async function runPhase2(input: { asOfDate: string; pullBatchId?: string }): Promise<{
  skusProcessed: number;
  skusSkipped: number;
}> {
  const start = Date.now();
  const allSkus = await db.select().from(skus);

  // Pull every sale within 30-day window.
  const windowStart = addDaysYmd(input.asOfDate, -29);
  const sales = await db
    .select()
    .from(dailySales)
    .where(
      and(
        gte(dailySales.salesDate, windowStart),
        lte(dailySales.salesDate, input.asOfDate)
      )
    );

  // Trust the row's stored `routedLocation` (Scott 2026-05-12 — US-
  // store orders with non-US ship-to now route to CN). Legacy rows
  // that pre-date the column got backfilled with `channelToLocation`
  // semantics, which keeps pre-fix data equivalent to its previous
  // behavior. The channel→location fallback below covers any future
  // rows where the column is unexpectedly missing.
  const saleEvents: SaleEvent[] = sales.map((s) => ({
    sku: s.sku,
    quantity: s.unitsSold,
    orderDateEst: s.salesDate,
    routedLocation: s.routedLocation ?? channelToLocation(s.channel),
  }));

  // Pull every incoming shipment, grouped once by (sku, destination).
  // Also pull the set of POs manually marked received — those units are
  // already counted in stock_snapshots, so excluding them from the
  // forward-looking incoming projection prevents double-counting.
  const allIncoming = await db.select().from(incomingShipments);
  const receivedKeys = await getReceivedShipmentKeys();
  const incomingBySkuLoc = new Map<string, IncomingPO[]>();
  for (const i of allIncoming) {
    const receiptKey = shipmentReceiptKey({
      shipmentName: i.shipmentName,
      destination: i.destination,
      expectedArrival: i.expectedArrival,
    });
    if (receivedKeys.has(receiptKey)) continue;
    const k = `${i.sku}|${i.destination}`;
    const bucket = incomingBySkuLoc.get(k) ?? [];
    bucket.push({ arrivalDate: i.expectedArrival, quantity: i.quantity });
    incomingBySkuLoc.set(k, bucket);
  }

  // Latest snapshot per (sku, location) at or before asOfDate, in ONE
  // DISTINCT ON query. The old per-SKU-per-location SELECT issued
  // ~2 queries per SKU (thousands of sequential round trips per cron) —
  // the single biggest consumer of the route's 300s budget, and the
  // reason a slow Shopify retry could push the cron into a timeout that
  // left a PARTIALLY-derived day (some SKUs at today's velocity, the
  // rest at yesterday's, nothing flagging the mix).
  const latestSnapshots = await db
    .selectDistinctOn([stockSnapshots.sku, stockSnapshots.location])
    .from(stockSnapshots)
    .where(lte(stockSnapshots.snapshotDate, input.asOfDate))
    .orderBy(
      stockSnapshots.sku,
      stockSnapshots.location,
      desc(stockSnapshots.snapshotDate),
    );
  const snapshotBySkuLoc = new Map(
    latestSnapshots.map((r) => [`${r.sku}|${r.location}`, r]),
  );

  let processed = 0;
  let skipped = 0;

  // Velocity windows END at yesterday (the last complete sales day), not
  // today. Including today's partial sales diluted the 7d average
  // because today has near-zero sales by the time the 5am EDT cron
  // runs (Grace 2026-05-19: UI 7d preset disagreed with the same-window
  // Custom picker by 10-22%). This matches the on-demand
  // `getVelocityForRange` query's `[yesterday-N, yesterday]` semantics so
  // the two paths agree per SKU. `input.asOfDate` (today) is preserved
  // as the row tag and as the analysis date for sustainability + DOS
  // computation — they project forward from "today's stock at today's
  // rate," and the rate is the trailing complete window.
  const velocityWindowEnd = addDaysYmd(input.asOfDate, -1);

  // Compute everything in memory first, then bulk-upsert per table inside
  // one transaction. Two wins over the old per-row await pattern:
  // ~13-15 sequential round trips per SKU collapse into a handful of
  // chunked statements, and a mid-run crash now leaves a consistent
  // whole-day-old derived state instead of a torn day.
  const velocityRows: (typeof salesVelocity.$inferInsert)[] = [];
  const dosRows: (typeof daysOfStock.$inferInsert)[] = [];
  const flagRows: (typeof sustainabilityFlags.$inferInsert)[] = [];

  for (const s of allSkus) {
    // Sales velocity — combined + per-channel at each window.
    for (const windowDays of VELOCITY_WINDOWS) {
      for (const agg of VELOCITY_AGGREGATIONS) {
        const perDay = computeVelocity({
          events: saleEvents,
          asOfDate: velocityWindowEnd,
          windowDays,
          sku: s.sku,
          routedLocation: agg.routedLocation,
        });
        velocityRows.push({
          sku: s.sku,
          channel: agg.channel,
          windowDays,
          asOfDate: input.asOfDate,
          unitsPerDay: String(perDay),
        });
      }
    }

    for (const location of LOCATIONS) {
      const curr = snapshotBySkuLoc.get(`${s.sku}|${location}`);
      if (!curr) {
        skipped++;
        continue;
      }

      const locVelocity = computeVelocity({
        events: saleEvents,
        asOfDate: velocityWindowEnd,
        windowDays: DOS_WINDOW,
        sku: s.sku,
        routedLocation: location,
      });

      const dos = computeDaysOfStock({ onHand: curr.onHand, velocityPerDay: locVelocity });
      dosRows.push({
        sku: s.sku,
        location,
        asOfDate: input.asOfDate,
        velocityWindowDays: DOS_WINDOW,
        // Sentinel for "no demand" — column is numeric(12,2), max ~10^10.
        daysOfStock: String(dos === Infinity ? 99999999.99 : dos),
        sourceRefs: { snapshotDate: curr.snapshotDate, velocityWindowDays: DOS_WINDOW },
      });

      // Incoming POs for this SKU × location, excluding any that have been
      // manually marked received (those units are already in stock_snapshots).
      // Pre-2026-05-05 we filtered by status !== 'arrived'; that field used
      // to auto-flip on `today >= ETA` regardless of actual receipt, which
      // double-excluded delayed-but-not-yet-counted shipments.
      const incoming = incomingBySkuLoc.get(`${s.sku}|${location}`) ?? [];

      const flag = computeSustainabilityFlag({
        onHand: curr.onHand,
        velocityPerDay: locVelocity,
        incoming,
        today: input.asOfDate,
      });

      flagRows.push({
        sku: s.sku,
        location,
        asOfDate: input.asOfDate,
        flag: flag.flag,
        reasoning: flag.reasoning,
        runOutDate: flag.runOutDate,
        afterNextPoDate: incoming[0]?.arrivalDate ?? null,
        sourceRefs: {
          snapshotDate: curr.snapshotDate,
          incomingPoCount: incoming.length,
          velocityWindowDays: DOS_WINDOW,
        },
      });

      processed++;
    }
  }

  // 1,000-row chunks keep each statement well under Postgres'
  // 65,534-parameter cap (widest table here is 8 columns).
  const CHUNK = 1000;
  await db.transaction(async (tx) => {
    for (let i = 0; i < velocityRows.length; i += CHUNK) {
      await tx
        .insert(salesVelocity)
        .values(velocityRows.slice(i, i + CHUNK))
        .onConflictDoUpdate({
          target: [salesVelocity.sku, salesVelocity.channel, salesVelocity.windowDays, salesVelocity.asOfDate],
          set: { unitsPerDay: sql`excluded.units_per_day` },
        });
    }
    for (let i = 0; i < dosRows.length; i += CHUNK) {
      await tx
        .insert(daysOfStock)
        .values(dosRows.slice(i, i + CHUNK))
        .onConflictDoUpdate({
          target: [daysOfStock.sku, daysOfStock.location, daysOfStock.asOfDate, daysOfStock.velocityWindowDays],
          set: {
            daysOfStock: sql`excluded.days_of_stock`,
            sourceRefs: sql`excluded.source_refs`,
          },
        });
    }
    for (let i = 0; i < flagRows.length; i += CHUNK) {
      await tx
        .insert(sustainabilityFlags)
        .values(flagRows.slice(i, i + CHUNK))
        .onConflictDoUpdate({
          target: [sustainabilityFlags.sku, sustainabilityFlags.location, sustainabilityFlags.asOfDate],
          set: {
            flag: sql`excluded.flag`,
            reasoning: sql`excluded.reasoning`,
            runOutDate: sql`excluded.run_out_date`,
            afterNextPoDate: sql`excluded.after_next_po_date`,
            sourceRefs: sql`excluded.source_refs`,
          },
        });
    }
  });

  logger.info("phase2.done", {
    batch: input.pullBatchId,
    asOfDate: input.asOfDate,
    processed,
    skipped,
    ms: Date.now() - start,
  });

  return { skusProcessed: processed, skusSkipped: skipped };
}
