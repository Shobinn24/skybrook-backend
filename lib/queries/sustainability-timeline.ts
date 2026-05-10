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
  /** Net sales $ over the same date window. From `daily_sales.netSalesUsd`. */
  salesDollarsInWindow: number;
  proratedThirtyD: number;
  // Current state
  currentStock: number;
  // Per-shipment projection. The trailing entry is the synthetic
  // "+30d after last shipment" outlook (kind === "terminal") when at
  // least one real shipment exists.
  projections: ProjectionRow[];
};

export type ShipmentColumn = {
  shipmentName: string;
  eta: string; // YYYY-MM-DD
  daysFromToday: number;
  /** "shipment" for real PO arrivals, "terminal" for the synthetic +30d
   * outlook column appended after the last real shipment. UI uses this
   * to render the column header differently (no shipment name, just an
   * "outlook" label) without re-deriving from the row data. */
  kind: "shipment" | "terminal";
  /** True when this column represents a PO whose ETA was in the past
   * but it hasn't been auto-received yet. Within the OVERDUE_GRACE_DAYS
   * window we still credit it to the projection (treating it as
   * arriving today since walkProjection clamps past ETAs). UI styles
   * the column differently and shows the original ETA. */
  isOverdue?: boolean;
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
  /** Overdue POs that fell outside the grace window and were excluded
   * from the projection. UI surfaces this as a banner so operators
   * know to clean them up on /incoming. */
  excludedOverdue: {
    count: number;        // distinct (shipmentName, eta) groups
    totalQuantity: number;
  };
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** Overdue POs within this many days past their ETA still count toward
 * the projection — they're treated as "arriving today". Beyond this,
 * they're excluded (presumed canceled or accounted for elsewhere) and
 * surfaced via the excludedOverdue banner. Scott 2026-05-09 ask:
 * shapewear was reading as tight because real-but-overdue stock was
 * silently dropped. */
const OVERDUE_GRACE_DAYS = 14;

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

  // 2. Sales for the location's channel over the date window. Pulls both
  // unit count and net dollar amount; the dollar figure feeds the
  // per-product Sales $ column (Scott 2026-05-05: "Would be good to see
  // total sales $$ for each product in the selected period").
  const salesRows = await db
    .select({
      sku: dailySales.sku,
      unitsSold: dailySales.unitsSold,
      netSalesUsd: dailySales.netSalesUsd,
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
  const salesDollarsBySku = new Map<string, number>();
  for (const r of salesRows) {
    salesBySku.set(r.sku, (salesBySku.get(r.sku) ?? 0) + r.unitsSold);
    const dollars = Number(r.netSalesUsd);
    if (Number.isFinite(dollars)) {
      salesDollarsBySku.set(r.sku, (salesDollarsBySku.get(r.sku) ?? 0) + dollars);
    }
  }

  // 3. Shipments at the location. Includes future POs PLUS overdue POs
  // within the OVERDUE_GRACE_DAYS window — overdue stock that hasn't
  // been auto-received yet is real expected inventory, and silently
  // dropping it caused Scott's 2026-05-09 "I thought we were tight"
  // false alarm. Beyond the grace window we exclude them (probably
  // canceled or already accounted for) and surface a count via
  // excludedOverdue so operators can clean up on /incoming.
  // Already-received POs are filtered out below — those units are in
  // stock_snapshots so we don't double-count.
  const graceCutoff = addDays(opts.today, -OVERDUE_GRACE_DAYS);
  const shipmentRowsRaw = await db
    .select({
      sku: incomingShipments.sku,
      shipmentName: incomingShipments.shipmentName,
      destination: incomingShipments.destination,
      expectedArrival: incomingShipments.expectedArrival,
      quantity: incomingShipments.quantity,
    })
    .from(incomingShipments)
    .where(eq(incomingShipments.destination, opts.location))
    .orderBy(asc(incomingShipments.expectedArrival), asc(incomingShipments.shipmentName));
  const receivedKeys = await getReceivedShipmentKeys();
  // Partition by grace window. Already-received rows drop out of both
  // buckets — they're satisfied by stock_snapshots.
  type ShipmentRow = (typeof shipmentRowsRaw)[number];
  const shipmentRows: ShipmentRow[] = [];
  const excludedOverdueGroups = new Map<string, number>(); // key=shipmentName|eta, value=qty
  for (const r of shipmentRowsRaw) {
    const k = shipmentReceiptKey({
      shipmentName: r.shipmentName,
      destination: r.destination,
      expectedArrival: r.expectedArrival,
    });
    if (receivedKeys.has(k)) continue;
    if (r.expectedArrival < graceCutoff) {
      // Older than grace cutoff — exclude from projection, surface in banner.
      const groupKey = `${r.shipmentName}|${r.expectedArrival}`;
      excludedOverdueGroups.set(
        groupKey,
        (excludedOverdueGroups.get(groupKey) ?? 0) + r.quantity,
      );
      continue;
    }
    shipmentRows.push(r);
  }
  const excludedOverdue = {
    count: excludedOverdueGroups.size,
    totalQuantity: Array.from(excludedOverdueGroups.values()).reduce((a, b) => a + b, 0),
  };

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
    productName: r.productName,
    startDate: r.startDate,
    endDate: r.endDate,
    multiplier: Number(r.multiplier),
  }));
  const overridesWithMeta = overrideRows.map((r) => ({
    id: r.id,
    productName: r.productName,
    startDate: r.startDate,
    endDate: r.endDate,
    multiplier: Number(r.multiplier),
    note: r.note,
  }));
  const haveOverrides = overrides.length > 0;

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
    // For overdue shipments, daysFromToday carries the SIGNED days
    // (negative = N days late). Future shipments stay non-negative as
    // before. UI uses the sign to switch between "Nd" and "Nd late".
    const rawDaysFrom = daysBetween(opts.today, r.expectedArrival);
    const isOverdue = r.expectedArrival < opts.today;
    globalShipmentMap.set(k, {
      shipmentName: r.shipmentName,
      eta: r.expectedArrival,
      daysFromToday: isOverdue ? rawDaysFrom : Math.max(0, rawDaysFrom),
      kind: "shipment",
      ...(isOverdue ? { isOverdue: true } : {}),
    });
  }
  const shipmentColumns = Array.from(globalShipmentMap.values()).sort((a, b) =>
    a.eta < b.eta ? -1 : a.eta > b.eta ? 1 : 0,
  );

  // Append a synthetic "+30d after last shipment" outlook column so
  // operators can see whether stock holds for a month past the final
  // PO. Scott 2026-05-05: "there should be extra columns for 30D after
  // the last incoming shipment. To show whether it is sustainable 30
  // days after the last incoming shipment basically." Skipped when
  // there are no real shipments — the page is otherwise empty in that
  // state and the +30d column would just confuse.
  if (shipmentColumns.length > 0) {
    const lastEta = shipmentColumns[shipmentColumns.length - 1].eta;
    const terminalEta = addDays(lastEta, 30);
    shipmentColumns.push({
      shipmentName: "+30d outlook",
      eta: terminalEta,
      daysFromToday: Math.max(0, daysBetween(opts.today, terminalEta)),
      kind: "terminal",
    });
  }

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
    const meta = skuLookup.get(sku);
    const productName = meta?.productName ?? sku;
    // Per-product multiplier resolution: an override on (location,
    // productName, ymd) wins over a brand-level (productName=null)
    // override for the same day. resolveMultiplier handles the tier
    // ordering — caller just binds productName.
    const multiplierAt = haveOverrides
      ? (ymd: string) => resolveMultiplier(ymd, productName, overrides)
      : undefined;
    const projections = walkProjection(
      currentStock,
      dailyRate,
      opts.today,
      perSkuShipments,
      multiplierAt ? { multiplierAt } : undefined,
    );

    rows.push({
      sku,
      productName,
      productLine: meta?.productLine ?? null,
      salesInWindow,
      salesDollarsInWindow: Number((salesDollarsBySku.get(sku) ?? 0).toFixed(2)),
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
    excludedOverdue,
  };
}
