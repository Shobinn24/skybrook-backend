import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  daysOfStock,
  incomingShipments,
  salesVelocity,
  sustainabilityFlags,
} from "@/lib/db/schema";
import { getStockLevels, type StockLevel } from "./stock";
import type { Location } from "@/lib/domain/warehouse-routing";

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
};

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

  // Sum future incoming units per SKU for this location.
  const incomingRows = await db
    .select()
    .from(incomingShipments)
    .where(eq(incomingShipments.destination, location));
  const incomingBySku = new Map<string, number>();
  for (const r of incomingRows) {
    if (r.status === "arrived") continue;
    incomingBySku.set(r.sku, (incomingBySku.get(r.sku) ?? 0) + r.quantity);
  }

  return stock.map((s: StockLevel): InventoryRow => {
    const dosRow = dosBySku.get(s.sku);
    const flagRow = flagBySku.get(s.sku);
    const velRow = velBySku.get(s.sku);
    const dos = dosRow ? Number(dosRow.daysOfStock) : null;
    return {
      sku: s.sku,
      location: s.location,
      productName: s.productName,
      productLine: s.productLine,
      onHand: s.onHand,
      stockValueUsd: s.onHand * Number(s.unitCostUsd ?? 0),
      velocityPerDay7d: velRow ? Number(velRow.unitsPerDay) : null,
      daysOfStock: dos,
      weeksOfStock: dos !== null && Number.isFinite(dos) ? dos / 7 : dos,
      flag: flagRow?.flag ?? null,
      runOutDate: flagRow?.runOutDate ?? null,
      reasoning: flagRow?.reasoning ?? null,
      snapshotDate: s.snapshotDate,
      incomingUnits: incomingBySku.get(s.sku) ?? 0,
    };
  });
}
