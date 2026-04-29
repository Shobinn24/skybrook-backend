import { and, desc, eq, gte, sql } from "drizzle-orm";
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
import { unitCostForLocation } from "@/lib/queries/stock";
import type { Location } from "@/lib/domain/warehouse-routing";

const VELOCITY_WINDOWS = [3, 7, 30] as const;
const VELOCITY_CHANNELS = ["all", "shopify_us", "shopify_intl"] as const;

export type SkuDetail = {
  sku: string;
  productName: string;
  productLine: string | null;
  active: boolean;
  firstSeenAt: string;
  unitCostUsd: number | null;
  unitCostIntlUsd: number | null;
  // Per-location current stock + computed value at the location-routed
  // cost. CN entry uses unit_cost_intl_usd when set, falls back to US.
  // Locations with no snapshot are returned with onHand=0 so the UI
  // always renders both warehouse cards rather than disappearing one.
  byLocation: Array<{
    location: Location;
    onHand: number;
    snapshotDate: string | null;
    stockValueUsd: number;
    flag: "healthy" | "watch" | "at_risk" | "overstocked" | null;
    runOutDate: string | null;
    reasoning: string | null;
    daysOfStock7d: number | null;
    incoming: Array<{
      shipmentName: string;
      quantity: number;
      expectedArrival: string;
      status: "po" | "dispatched" | "in_transit" | "arrived";
    }>;
  }>;
  // Velocity matrix — rows = window (3/7/30d), cols = channel.
  // Numeric values are units/day. Null means "no row exists for that
  // (sku, channel, window) at the latest as-of date" — distinguished
  // from 0 (which is "this SKU has zero sales in the window").
  velocityByWindow: Array<{
    windowDays: number;
    asOfDate: string | null;
    perChannel: Record<(typeof VELOCITY_CHANNELS)[number], number | null>;
  }>;
  // Daily sales over the last 30 days, split per Shopify channel.
  // Includes zero-sales days so the chart's x-axis stays continuous.
  // SPEC §5.7 mentions a 30-day history view; this powers the inline
  // bar chart on the SKU detail page.
  daily30d: Array<{
    date: string; // YYYY-MM-DD
    us: number;
    intl: number;
    total: number;
  }>;
};

const DAILY_WINDOW_DAYS = 30;

export async function getSkuDetail(sku: string): Promise<SkuDetail | null> {
  const [skuRow] = await db.select().from(skus).where(eq(skus.sku, sku));
  if (!skuRow) return null;

  const stockRows = await db
    .select()
    .from(stockSnapshots)
    .where(eq(stockSnapshots.sku, sku))
    .orderBy(desc(stockSnapshots.snapshotDate));
  const latestStockByLoc = new Map<Location, (typeof stockRows)[number]>();
  for (const r of stockRows) {
    if (!latestStockByLoc.has(r.location)) latestStockByLoc.set(r.location, r);
  }

  const flagRows = await db
    .select()
    .from(sustainabilityFlags)
    .where(eq(sustainabilityFlags.sku, sku))
    .orderBy(desc(sustainabilityFlags.asOfDate));
  const latestFlagByLoc = new Map<Location, (typeof flagRows)[number]>();
  for (const r of flagRows) {
    if (!latestFlagByLoc.has(r.location)) latestFlagByLoc.set(r.location, r);
  }

  const dosRows = await db
    .select()
    .from(daysOfStock)
    .where(and(eq(daysOfStock.sku, sku), eq(daysOfStock.velocityWindowDays, 7)))
    .orderBy(desc(daysOfStock.asOfDate));
  const latestDosByLoc = new Map<Location, (typeof dosRows)[number]>();
  for (const r of dosRows) {
    if (!latestDosByLoc.has(r.location)) latestDosByLoc.set(r.location, r);
  }

  const incomingRows = await db
    .select()
    .from(incomingShipments)
    .where(eq(incomingShipments.sku, sku))
    .orderBy(incomingShipments.expectedArrival);
  const incomingByLoc = new Map<Location, typeof incomingRows>();
  for (const r of incomingRows) {
    if (r.status === "arrived") continue;
    const bucket = incomingByLoc.get(r.destination) ?? [];
    bucket.push(r);
    incomingByLoc.set(r.destination, bucket);
  }

  const byLocation: SkuDetail["byLocation"] = (["US", "CN"] as const).map((loc) => {
    const stock = latestStockByLoc.get(loc);
    const flag = latestFlagByLoc.get(loc);
    const dos = latestDosByLoc.get(loc);
    const onHand = stock?.onHand ?? 0;
    const cost = unitCostForLocation({
      location: loc,
      unitCostUsd: skuRow.unitCostUsd,
      unitCostIntlUsd: skuRow.unitCostIntlUsd,
    });
    return {
      location: loc,
      onHand,
      snapshotDate: stock?.snapshotDate ?? null,
      stockValueUsd: onHand * cost,
      flag: flag?.flag ?? null,
      runOutDate: flag?.runOutDate ?? null,
      reasoning: flag?.reasoning ?? null,
      daysOfStock7d: dos ? Number(dos.daysOfStock) : null,
      incoming: (incomingByLoc.get(loc) ?? []).map((r) => ({
        shipmentName: r.shipmentName,
        quantity: r.quantity,
        expectedArrival: r.expectedArrival,
        status: r.status,
      })),
    };
  });

  // Velocity matrix — fetch all (sku, channel ∈ {all, shopify_us, shopify_intl},
  // window ∈ {3, 7, 30}) rows, take the latest as-of per (channel, window).
  const velRows = await db
    .select()
    .from(salesVelocity)
    .where(eq(salesVelocity.sku, sku))
    .orderBy(desc(salesVelocity.asOfDate));
  const velLatest = new Map<string, (typeof velRows)[number]>();
  for (const r of velRows) {
    const k = `${r.channel}:${r.windowDays}`;
    if (!velLatest.has(k)) velLatest.set(k, r);
  }

  const velocityByWindow: SkuDetail["velocityByWindow"] = VELOCITY_WINDOWS.map((w) => {
    const perChannel: Record<(typeof VELOCITY_CHANNELS)[number], number | null> = {
      all: null,
      shopify_us: null,
      shopify_intl: null,
    };
    let asOfDate: string | null = null;
    for (const ch of VELOCITY_CHANNELS) {
      const r = velLatest.get(`${ch}:${w}`);
      if (r) {
        perChannel[ch] = Number(r.unitsPerDay);
        // Keep the most recent as-of across channels for the row label.
        if (!asOfDate || r.asOfDate > asOfDate) asOfDate = r.asOfDate;
      }
    }
    return { windowDays: w, asOfDate, perChannel };
  });

  // Daily sales — fetch raw (date, channel, units) rows for the last
  // 30 days, then fill in zero-sales days so the chart x-axis stays
  // continuous. Postgres CURRENT_DATE is server timezone; daily_sales
  // is keyed on sales_date which is already EST-anchored at ingest.
  const dailyRows = await db
    .select({
      date: dailySales.salesDate,
      channel: dailySales.channel,
      units: sql<number>`sum(${dailySales.unitsSold})::int`,
    })
    .from(dailySales)
    .where(
      and(
        eq(dailySales.sku, sku),
        gte(dailySales.salesDate, sql`CURRENT_DATE - INTERVAL '30 days'`),
      ),
    )
    .groupBy(dailySales.salesDate, dailySales.channel)
    .orderBy(dailySales.salesDate);

  const dailyByDate = new Map<string, { us: number; intl: number }>();
  for (const r of dailyRows) {
    const cur = dailyByDate.get(r.date) ?? { us: 0, intl: 0 };
    if (r.channel === "shopify_us") cur.us = Number(r.units);
    else if (r.channel === "shopify_intl") cur.intl = Number(r.units);
    dailyByDate.set(r.date, cur);
  }

  // Build the contiguous 30-day window ending today (EST). Walking
  // backward from a synthesized "today" rather than reading from
  // dailyRows ensures zero-sales days are present so bars don't gap.
  const today = new Date();
  const daily30d: SkuDetail["daily30d"] = [];
  for (let i = DAILY_WINDOW_DAYS - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    const ymd = d.toISOString().slice(0, 10);
    const entry = dailyByDate.get(ymd) ?? { us: 0, intl: 0 };
    daily30d.push({ date: ymd, us: entry.us, intl: entry.intl, total: entry.us + entry.intl });
  }

  return {
    sku: skuRow.sku,
    productName: skuRow.productName,
    productLine: skuRow.productLine,
    active: skuRow.active,
    firstSeenAt: skuRow.firstSeenAt,
    unitCostUsd: skuRow.unitCostUsd != null ? Number(skuRow.unitCostUsd) : null,
    unitCostIntlUsd: skuRow.unitCostIntlUsd != null ? Number(skuRow.unitCostIntlUsd) : null,
    byLocation,
    velocityByWindow,
    daily30d,
  };
}
