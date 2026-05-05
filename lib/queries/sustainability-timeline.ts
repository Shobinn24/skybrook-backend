// Per-delivery sustainability timeline query — feeds the redesigned
// /sustainability page that mirrors Scott's "Sustainability Check"
// sheet (2026-04-28 punch-list #8).
//
// For each SKU in the chosen warehouse, this returns:
//   - Sales over a configurable date window (default 14 days)
//   - Prorated 30-day equivalent (sales × 30 / windowDays)
//   - Current on-hand stock at the location
//   - One projection row per upcoming shipment, computed via the
//     pure walkProjection helper
//
// SKUs included: anything that has a non-zero stock snapshot OR a
// future shipment in the location. SKUs with neither are dropped —
// they'd render as empty rows that just clutter the page.

import { and, asc, eq, gte, inArray, lte, ne, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  dailySales,
  incomingShipments,
  skus,
  stockSnapshots,
  velocityOverrides as velocityOverridesTable,
} from "@/lib/db/schema";
import {
  resolveMultiplier,
  walkProjection,
  type ProjectionRow,
  type VelocityOverride,
} from "@/lib/domain/sustainability-timeline";
import { getReceivedShipmentKeys, shipmentReceiptKey } from "./incoming";
import type { Location } from "@/lib/domain/warehouse-routing";

export type SustainabilityTimelineRow = {
  sku: string;
  productName: string;
  productLine: string | null;
  // Sales window inputs
  salesInWindow: number;
  proratedThirtyD: number;
  // Current state
  currentStock: number;
  // Per-shipment projection
  projections: ProjectionRow[];
};

export type ShipmentColumn = {
  shipmentName: string;
  eta: string; // YYYY-MM-DD
  daysFromToday: number;
};

export type SustainabilityTimelineResult = {
  location: Location;
  windowStart: string; // YYYY-MM-DD inclusive
  windowEnd: string;   // YYYY-MM-DD inclusive
  windowDays: number;
  today: string;       // YYYY-MM-DD anchor used for the projection
  // Global (location-wide) ordered list of upcoming shipment columns.
  // The page renders one column block per entry. SKUs not in a given
  // shipment have a 0-qty projection row at that ETA.
  shipmentColumns: ShipmentColumn[];
  rows: SustainabilityTimelineRow[];
  // Velocity overrides currently in effect for this location. Returned
  // so the UI can display + edit them in the same payload that powers
  // the projection table.
  overrides: Array<VelocityOverride & { id: string; note: string | null }>;
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function ymdToUtcMs(ymd: string): number {
  const [y, m, d] = ymd.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

function addDays(ymd: string, days: number): string {
  return new Date(ymdToUtcMs(ymd) + days * MS_PER_DAY).toISOString().slice(0, 10);
}

function daysBetween(fromYmd: string, toYmd: string): number {
  return Math.round((ymdToUtcMs(toYmd) - ymdToUtcMs(fromYmd)) / MS_PER_DAY);
}

// US warehouse fulfils shopify_us; CN warehouse fulfils shopify_intl.
// Mirrors `routeOrder` in lib/domain/warehouse-routing.ts.
function locationToChannel(location: Location): "shopify_us" | "shopify_intl" {
  return location === "US" ? "shopify_us" : "shopify_intl";
}

export async function getSustainabilityTimeline(opts: {
  location: Location;
  today: string;
  windowDays?: number;
}): Promise<SustainabilityTimelineResult> {
  const windowDays = opts.windowDays ?? 14;
  const windowEnd = opts.today;
  const windowStart = addDays(windowEnd, -(windowDays - 1));
  const channel = locationToChannel(opts.location);

  // 1. Latest stock snapshot per SKU at the location.
  // Drizzle doesn't expose a clean DISTINCT ON here, so we pull all
  // rows for the location and take the latest in JS. The volume is
  // bounded (~5K stock_snapshots × ½ years of history) which is
  // tractable.
  const stockRows = await db
    .select({
      sku: stockSnapshots.sku,
      onHand: stockSnapshots.onHand,
      snapshotDate: stockSnapshots.snapshotDate,
    })
    .from(stockSnapshots)
    .where(eq(stockSnapshots.location, opts.location))
    .orderBy(asc(stockSnapshots.sku), asc(stockSnapshots.snapshotDate));
  const stockBySku = new Map<string, number>();
  for (const r of stockRows) {
    // Last write wins because the rows are sorted ascending by date.
    stockBySku.set(r.sku, r.onHand);
  }

  // 2. Sales for the location's channel over the date window.
  const salesRows = await db
    .select({
      sku: dailySales.sku,
      unitsSold: dailySales.unitsSold,
    })
    .from(dailySales)
    .where(
      and(
        eq(dailySales.channel, channel),
        gte(dailySales.salesDate, windowStart),
        lte(dailySales.salesDate, windowEnd),
      ),
    );
  const salesBySku = new Map<string, number>();
  for (const r of salesRows) {
    salesBySku.set(r.sku, (salesBySku.get(r.sku) ?? 0) + r.unitsSold);
  }

  // 3. Future shipments at the location. Excludes:
  //    - Shipments already received (those units are in stock_snapshots).
  //    - Past-ETA shipments (the timeline projects forward from today;
  //      overdue POs are surfaced on /incoming for confirmation, not here).
  const shipmentRowsRaw = await db
    .select({
      sku: incomingShipments.sku,
      shipmentName: incomingShipments.shipmentName,
      destination: incomingShipments.destination,
      expectedArrival: incomingShipments.expectedArrival,
      quantity: incomingShipments.quantity,
    })
    .from(incomingShipments)
    .where(
      and(
        eq(incomingShipments.destination, opts.location),
        gte(incomingShipments.expectedArrival, opts.today),
      ),
    )
    .orderBy(asc(incomingShipments.expectedArrival), asc(incomingShipments.shipmentName));
  const receivedKeys = await getReceivedShipmentKeys();
  const shipmentRows = shipmentRowsRaw.filter((r) => {
    const k = shipmentReceiptKey({
      shipmentName: r.shipmentName,
      destination: r.destination,
      expectedArrival: r.expectedArrival,
    });
    return !receivedKeys.has(k);
  });

  // Velocity overrides for this location. Sorted by startDate ASC so
  // resolution prefers earlier-starting windows when multiple overrides
  // overlap a given day. Operators define non-overlapping ranges in
  // practice; tie-break is documented behavior, not a relied-on contract.
  const overrideRows = await db
    .select()
    .from(velocityOverridesTable)
    .where(eq(velocityOverridesTable.location, opts.location))
    .orderBy(asc(velocityOverridesTable.startDate));
  const overrides: VelocityOverride[] = overrideRows.map((r) => ({
    startDate: r.startDate,
    endDate: r.endDate,
    multiplier: Number(r.multiplier),
  }));
  const overridesWithMeta = overrideRows.map((r) => ({
    id: r.id,
    startDate: r.startDate,
    endDate: r.endDate,
    multiplier: Number(r.multiplier),
    note: r.note,
  }));
  const multiplierAt = overrides.length > 0
    ? (ymd: string) => resolveMultiplier(ymd, overrides)
    : undefined;

  // Build the GLOBAL shipment-column list across all SKUs. Keyed by ETA
  // ONLY — multiple shipments with the same ETA collapse into one
  // column block (Scott 5/02 ask: "combine orders scheduled to deliver
  // on same date into the same column, e.g. Kai 24 + KAI SEC Feb 26").
  // Combined columns show all shipment names joined with " + " in the
  // header, and per-SKU qtys are summed across the merged shipments.
  const globalShipmentMap = new Map<string, ShipmentColumn>(); // key = eta
  for (const r of shipmentRows) {
    const k = r.expectedArrival;
    const existing = globalShipmentMap.get(k);
    if (existing) {
      // Append name only if not already included (defensive against
      // duplicate rows for the same shipment).
      const names = existing.shipmentName.split(" + ");
      if (!names.includes(r.shipmentName)) {
        existing.shipmentName = `${existing.shipmentName} + ${r.shipmentName}`;
      }
      continue;
    }
    globalShipmentMap.set(k, {
      shipmentName: r.shipmentName,
      eta: r.expectedArrival,
      daysFromToday: Math.max(0, daysBetween(opts.today, r.expectedArrival)),
    });
  }
  const shipmentColumns = Array.from(globalShipmentMap.values()).sort((a, b) =>
    a.eta < b.eta ? -1 : a.eta > b.eta ? 1 : 0,
  );

  // Per-SKU lookup: for each ETA column, what's the total qty THIS SKU
  // gets across all shipments arriving on that date (0 if not included).
  const skuQtyByColumn = new Map<string, Map<string, number>>(); // sku → eta → qty (summed across same-date shipments)
  for (const r of shipmentRows) {
    const k = r.expectedArrival;
    const inner = skuQtyByColumn.get(r.sku) ?? new Map<string, number>();
    inner.set(k, (inner.get(k) ?? 0) + r.quantity);
    skuQtyByColumn.set(r.sku, inner);
  }

  // 4. SKU directory for productName / productLine. Pull only the
  // SKUs that actually appear in stock OR sales OR shipments — skip
  // a full table scan.
  const skusOfInterest = new Set<string>([
    ...stockBySku.keys(),
    ...salesBySku.keys(),
    ...skuQtyByColumn.keys(),
  ]);
  const skuRows = skusOfInterest.size
    ? await db
        .select({
          sku: skus.sku,
          productName: skus.productName,
          productLine: skus.productLine,
        })
        .from(skus)
        .where(inArray(skus.sku, Array.from(skusOfInterest)))
    : [];
  const skuLookup = new Map(skuRows.map((r) => [r.sku, r]));

  // 5. Build rows. Drop SKUs with neither stock nor a future shipment
  // — sales-only SKUs are mapping artifacts (Shopify selling something
  // not in inventory) and would just be empty rows here.
  const rows: SustainabilityTimelineRow[] = [];
  for (const sku of skusOfInterest) {
    const currentStock = stockBySku.get(sku) ?? 0;
    const skuQtys = skuQtyByColumn.get(sku);
    if (currentStock === 0 && !skuQtys) continue;

    const salesInWindow = salesBySku.get(sku) ?? 0;
    const proratedThirtyD = (salesInWindow * 30) / windowDays;
    const dailyRate = salesInWindow / windowDays;

    // Walk through the GLOBAL shipment columns so each SKU's projection
    // aligns to the same column structure across the table. SKUs not
    // included in a given shipment get a 0-qty projection row. Same-date
    // shipments are already collapsed into one column above; the qty
    // here is the SKU's total across that ETA's merged shipments.
    const perSkuShipments = shipmentColumns.map((col) => ({
      shipmentName: col.shipmentName,
      eta: col.eta,
      quantity: skuQtys?.get(col.eta) ?? 0,
    }));
    const projections = walkProjection(
      currentStock,
      dailyRate,
      opts.today,
      perSkuShipments,
      multiplierAt ? { multiplierAt } : undefined,
    );

    const meta = skuLookup.get(sku);
    rows.push({
      sku,
      productName: meta?.productName ?? sku,
      productLine: meta?.productLine ?? null,
      salesInWindow,
      proratedThirtyD: Number(proratedThirtyD.toFixed(2)),
      currentStock,
      projections,
    });
  }

  // Sort by current stock value descending so the highest-capital SKUs
  // surface first — matches the operator decision flow.
  rows.sort((a, b) => b.currentStock - a.currentStock);

  return {
    location: opts.location,
    windowStart,
    windowEnd,
    windowDays,
    today: opts.today,
    shipmentColumns,
    rows,
    overrides: overridesWithMeta,
  };
}
