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

  const saleEvents: SaleEvent[] = sales.map((s) => ({
    sku: s.sku,
    quantity: s.unitsSold,
    orderDateEst: s.salesDate,
    routedLocation: channelToLocation(s.channel),
  }));

  // Pull every incoming shipment (filtered per SKU × location below).
  // Also pull the set of POs Scott has manually marked received — those
  // units are already counted in stock_snapshots, so excluding them from
  // the forward-looking incoming projection prevents double-counting.
  const allIncoming = await db.select().from(incomingShipments);
  const receivedKeys = await getReceivedShipmentKeys();

  let processed = 0;
  let skipped = 0;

  for (const s of allSkus) {
    // Sales velocity — combined + per-channel at each window.
    for (const windowDays of VELOCITY_WINDOWS) {
      for (const agg of VELOCITY_AGGREGATIONS) {
        const perDay = computeVelocity({
          events: saleEvents,
          asOfDate: input.asOfDate,
          windowDays,
          sku: s.sku,
          routedLocation: agg.routedLocation,
        });
        await db
          .insert(salesVelocity)
          .values({
            sku: s.sku,
            channel: agg.channel,
            windowDays,
            asOfDate: input.asOfDate,
            unitsPerDay: String(perDay),
          })
          .onConflictDoUpdate({
            target: [salesVelocity.sku, salesVelocity.channel, salesVelocity.windowDays, salesVelocity.asOfDate],
            set: { unitsPerDay: sql`excluded.units_per_day` },
          });
      }
    }

    for (const location of LOCATIONS) {
      // Latest stock snapshot at or before asOfDate.
      const [curr] = await db
        .select()
        .from(stockSnapshots)
        .where(
          and(
            eq(stockSnapshots.sku, s.sku),
            eq(stockSnapshots.location, location),
            lte(stockSnapshots.snapshotDate, input.asOfDate)
          )
        )
        .orderBy(desc(stockSnapshots.snapshotDate))
        .limit(1);

      if (!curr) {
        skipped++;
        continue;
      }

      const locVelocity = computeVelocity({
        events: saleEvents,
        asOfDate: input.asOfDate,
        windowDays: DOS_WINDOW,
        sku: s.sku,
        routedLocation: location,
      });

      const dos = computeDaysOfStock({ onHand: curr.onHand, velocityPerDay: locVelocity });
      await db
        .insert(daysOfStock)
        .values({
          sku: s.sku,
          location,
          asOfDate: input.asOfDate,
          velocityWindowDays: DOS_WINDOW,
          // Sentinel for "no demand" — column is numeric(12,2), max ~10^10.
          daysOfStock: String(dos === Infinity ? 99999999.99 : dos),
          sourceRefs: { snapshotDate: curr.snapshotDate, velocityWindowDays: DOS_WINDOW },
        })
        .onConflictDoUpdate({
          target: [daysOfStock.sku, daysOfStock.location, daysOfStock.asOfDate, daysOfStock.velocityWindowDays],
          set: {
            daysOfStock: sql`excluded.days_of_stock`,
            sourceRefs: sql`excluded.source_refs`,
          },
        });

      // Incoming POs for this SKU × location, excluding any that have been
      // manually marked received (those units are already in stock_snapshots).
      // Pre-2026-05-05 we filtered by status !== 'arrived'; that field used
      // to auto-flip on `today >= ETA` regardless of actual receipt, which
      // double-excluded delayed-but-not-yet-counted shipments.
      const incoming: IncomingPO[] = allIncoming
        .filter((i) => {
          if (i.sku !== s.sku || i.destination !== location) return false;
          const key = shipmentReceiptKey({
            shipmentName: i.shipmentName,
            destination: i.destination,
            expectedArrival: i.expectedArrival,
          });
          return !receivedKeys.has(key);
        })
        .map((i) => ({ arrivalDate: i.expectedArrival, quantity: i.quantity }));

      const flag = computeSustainabilityFlag({
        onHand: curr.onHand,
        velocityPerDay: locVelocity,
        incoming,
        today: input.asOfDate,
      });

      await db
        .insert(sustainabilityFlags)
        .values({
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
        })
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

      processed++;
    }
  }

  logger.info("phase2.done", {
    batch: input.pullBatchId,
    asOfDate: input.asOfDate,
    processed,
    skipped,
    ms: Date.now() - start,
  });

  return { skusProcessed: processed, skusSkipped: skipped };
}
