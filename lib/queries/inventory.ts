import { and, desc, eq, gte, lte } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  dailySales,
  daysOfStock,
  incomingShipments,
  salesVelocity,
  sustainabilityFlags,
} from "@/lib/db/schema";
import { getStockLevels, type StockLevel } from "./stock";
import type { Location } from "@/lib/domain/warehouse-routing";

// Interim channel→location heuristic (matches lib/jobs/reconcile.ts). Must
// stay in sync: the derive job used the same routing when computing DOS, so
// reproducing it here gives the trace popover the exact velocity the DOS came
// from. Replace when per-order destination country lands in daily_sales.
function channelToLocation(channel: string): Location {
  return channel === "shopify_us" ? "US" : "CN";
}

function addDaysYmd(ymd: string, delta: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/**
 * A displayable provenance record for a single number. The popover UI (client
 * component TracedNumber) renders this shape directly — no secondary fetch.
 *
 * Spec §3.1 requires "every displayed number must be traceable, reproducible,
 * and validated", and §8.2 requires click-through to source.
 */
export type NumberTrace = {
  label: string;
  formula?: string;
  inputs?: Array<{ label: string; value: string }>;
  sources: Array<{ label: string; ref: string }>;
  note?: string;
};

export type InventoryRowTrace = {
  onHand: NumberTrace;
  stockValue: NumberTrace;
  velocity: NumberTrace | null;
  weeksOfStock: NumberTrace | null;
  incoming: NumberTrace;
};

export type InventoryRow = {
  sku: string;
  location: Location;
  productName: string;
  productLine: string | null;
  onHand: number;
  stockValueUsd: number;
  velocityPerDay7d: number | null;
  daysOfStock: number | null;
  weeksOfStock: number | null;
  flag: "healthy" | "watch" | "at_risk" | "overstocked" | null;
  runOutDate: string | null;
  reasoning: string | null;
  snapshotDate: string;
  incomingUnits: number;
  trace: InventoryRowTrace;
};

function fmtNumber(n: number, digits = 2): string {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function fmtMoney(n: number): string {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  });
}

export async function getInventoryRows(location: Location): Promise<InventoryRow[]> {
  const stock = await getStockLevels({ location });

  // Latest DOS row per SKU at this location (7d velocity window).
  const dosRows = await db
    .select()
    .from(daysOfStock)
    .where(and(eq(daysOfStock.location, location), eq(daysOfStock.velocityWindowDays, 7)))
    .orderBy(desc(daysOfStock.asOfDate));
  const dosBySku = new Map<string, (typeof dosRows)[number]>();
  for (const r of dosRows) if (!dosBySku.has(r.sku)) dosBySku.set(r.sku, r);

  // Latest sustainability flag per SKU at this location.
  const flagRows = await db
    .select()
    .from(sustainabilityFlags)
    .where(eq(sustainabilityFlags.location, location))
    .orderBy(desc(sustainabilityFlags.asOfDate));
  const flagBySku = new Map<string, (typeof flagRows)[number]>();
  for (const r of flagRows) if (!flagBySku.has(r.sku)) flagBySku.set(r.sku, r);

  // Latest combined velocity per SKU (channel='all', 7d).
  const velRows = await db
    .select()
    .from(salesVelocity)
    .where(and(eq(salesVelocity.channel, "all"), eq(salesVelocity.windowDays, 7)))
    .orderBy(desc(salesVelocity.asOfDate));
  const velBySku = new Map<string, (typeof velRows)[number]>();
  for (const r of velRows) if (!velBySku.has(r.sku)) velBySku.set(r.sku, r);

  // Location-routed velocity is what the derive job used to compute DOS, but
  // sales_velocity only persists the combined (channel='all') rows. Recompute
  // the location slice from daily_sales so the Weeks-of-stock popover shows
  // numbers that reconcile instead of the misleading combined figure.
  const latestDosDate = dosRows[0]?.asOfDate ?? null;
  const locVelocityBySku = new Map<string, { unitsInWindow: number; perDay: number }>();
  if (latestDosDate) {
    const windowStart = addDaysYmd(latestDosDate, -6);
    const sales = await db
      .select()
      .from(dailySales)
      .where(
        and(
          gte(dailySales.salesDate, windowStart),
          lte(dailySales.salesDate, latestDosDate)
        )
      );
    for (const s of sales) {
      if (channelToLocation(s.channel) !== location) continue;
      const prev = locVelocityBySku.get(s.sku)?.unitsInWindow ?? 0;
      locVelocityBySku.set(s.sku, {
        unitsInWindow: prev + s.unitsSold,
        perDay: (prev + s.unitsSold) / 7,
      });
    }
  }

  // Group pending incoming shipments per SKU so the trace can list each PO.
  const incomingRows = await db
    .select()
    .from(incomingShipments)
    .where(eq(incomingShipments.destination, location));
  const incomingBySku = new Map<string, typeof incomingRows>();
  for (const r of incomingRows) {
    if (r.status === "arrived") continue;
    const bucket = incomingBySku.get(r.sku) ?? [];
    bucket.push(r);
    incomingBySku.set(r.sku, bucket);
  }

  return stock.map((s: StockLevel): InventoryRow => {
    const dosRow = dosBySku.get(s.sku);
    const flagRow = flagBySku.get(s.sku);
    const velRow = velBySku.get(s.sku);
    const dos = dosRow ? Number(dosRow.daysOfStock) : null;
    const velocityPerDay = velRow ? Number(velRow.unitsPerDay) : null;
    const unitCost = Number(s.unitCostUsd ?? 0);
    const stockValueUsd = s.onHand * unitCost;
    const pendingPos = incomingBySku.get(s.sku) ?? [];
    const incomingUnits = pendingPos.reduce((acc, r) => acc + r.quantity, 0);

    const trace: InventoryRowTrace = {
      onHand: {
        label: `Stock on hand — ${s.sku} @ ${s.location}`,
        formula: "Latest daily snapshot from the inventory sheet.",
        inputs: [
          { label: "On hand", value: `${s.onHand.toLocaleString()} units` },
          { label: "Snapshot date (EST)", value: s.snapshotDate },
        ],
        sources: [
          { label: "Source", ref: "Inventory Google Sheet (stock_snapshots table)" },
          { label: "Snapshot date", ref: s.snapshotDate },
        ],
      },
      stockValue: {
        label: `Stock value — ${s.sku} @ ${s.location}`,
        formula: "On-hand units × unit cost",
        inputs: [
          { label: "On hand", value: `${s.onHand.toLocaleString()} units` },
          { label: "Unit cost", value: unitCost > 0 ? fmtMoney(unitCost) : "not set" },
          { label: "Stock value", value: fmtMoney(stockValueUsd) },
        ],
        sources: [
          { label: "Stock snapshot", ref: s.snapshotDate },
          {
            label: "Unit cost source",
            ref: unitCost > 0 ? "skus.unit_cost_usd" : "missing — defaults to $0",
          },
        ],
        note:
          unitCost > 0
            ? undefined
            : "Unit cost is not set for this SKU; stock value defaults to $0.",
      },
      velocity:
        velRow && velocityPerDay !== null
          ? {
              label: `Sales velocity (7d) — ${s.sku}`,
              formula: "Total units sold in the trailing 7 days ÷ 7 (all channels combined)",
              inputs: [
                { label: "Window", value: "Trailing 7 days" },
                { label: "As-of date (EST)", value: velRow.asOfDate },
                { label: "Channel", value: velRow.channel },
                { label: "Units/day", value: fmtNumber(velocityPerDay) },
                { label: "Units in window", value: fmtNumber(velocityPerDay * 7, 0) },
              ],
              sources: [
                { label: "Table", ref: "sales_velocity" },
                { label: "Derived at", ref: velRow.asOfDate },
                {
                  label: "Underlying sales",
                  ref: "daily_sales (channel='shopify_us' + 'shopify_intl')",
                },
              ],
              note:
                "This column is combined across channels. Days-of-stock and weeks-of-stock use location-routed velocity (shopify_us → US, shopify_intl → CN) which will be a smaller number per-warehouse — see the Weeks of stock popover for that math.",
            }
          : null,
      weeksOfStock:
        (() => {
          if (dos === null || !Number.isFinite(dos)) return null;
          const loc = locVelocityBySku.get(s.sku);
          const locPerDay = loc?.perDay ?? 0;
          if (locPerDay <= 0) return null;
          return {
            label: `Weeks of stock — ${s.sku} @ ${s.location}`,
            formula: "(On hand ÷ location-routed daily velocity) ÷ 7",
            inputs: [
              { label: "On hand", value: `${s.onHand.toLocaleString()} units` },
              {
                label: `Daily velocity @ ${s.location} (7d)`,
                value: `${fmtNumber(locPerDay)} units/day`,
              },
              {
                label: "Units sold in window",
                value: `${(loc?.unitsInWindow ?? 0).toLocaleString()} units`,
              },
              { label: "Days of stock", value: fmtNumber(dos) },
              { label: "Weeks of stock", value: fmtNumber(dos / 7) },
            ],
            sources: [
              { label: "Stock snapshot", ref: s.snapshotDate },
              { label: "Sales window", ref: `7 days ending ${latestDosDate}` },
              {
                label: "Channels counted",
                ref: s.location === "US" ? "shopify_us only" : "shopify_intl only",
              },
              { label: "Table", ref: "days_of_stock (window=7d)" },
            ],
            note:
              "Per spec §5.1, sales decrement whichever warehouse fulfilled them. Until per-order destination country ships, we route by channel: shopify_us sales deplete US stock, shopify_intl deplete CN stock.",
          };
        })(),
      incoming: {
        label: `Incoming units — ${s.sku} @ ${s.location}`,
        formula: "Sum of quantities on pending incoming POs.",
        inputs:
          pendingPos.length > 0
            ? pendingPos.map((p) => ({
                label: `PO arriving ${p.expectedArrival} (${p.status})`,
                value: `${p.quantity.toLocaleString()} units`,
              }))
            : [{ label: "Pending POs", value: "none" }],
        sources: [
          { label: "Source", ref: "Incoming PO Google Sheet (incoming_shipments table)" },
          { label: "Total pending", ref: `${incomingUnits.toLocaleString()} units` },
        ],
      },
    };

    return {
      sku: s.sku,
      location: s.location,
      productName: s.productName,
      productLine: s.productLine,
      onHand: s.onHand,
      stockValueUsd,
      velocityPerDay7d: velocityPerDay,
      daysOfStock: dos,
      weeksOfStock: dos !== null && Number.isFinite(dos) ? dos / 7 : dos,
      flag: flagRow?.flag ?? null,
      runOutDate: flagRow?.runOutDate ?? null,
      reasoning: flagRow?.reasoning ?? null,
      snapshotDate: s.snapshotDate,
      incomingUnits,
      trace,
    };
  });
}
