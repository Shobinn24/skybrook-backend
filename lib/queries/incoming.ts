import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { incomingShipments, skus } from "@/lib/db/schema";
import type { Location } from "@/lib/domain/warehouse-routing";

export async function getIncomingStock(filters: { sku?: string; location?: Location } = {}) {
  return db
    .select()
    .from(incomingShipments)
    .where(
      and(
        filters.sku ? eq(incomingShipments.sku, filters.sku) : sql`true`,
        filters.location ? eq(incomingShipments.destination, filters.location) : sql`true`
      )
    )
    .orderBy(asc(incomingShipments.expectedArrival));
}

/** Status values that count as "still incoming" — i.e. units that have
 * NOT yet landed in the warehouse and so are relevant to a forward-
 * looking arrivals view. `arrived` is excluded by default because
 * those units are already counted in stock_snapshots and would just
 * clutter the page; the page can opt-in via the `includeArrived` flag.
 */
export const PENDING_STATUSES = ["po", "dispatched", "in_transit"] as const;

export type IncomingShipmentRow = {
  id: string;
  sku: string;
  productName: string | null;
  productLine: string | null;
  destination: Location;
  shipmentName: string;
  quantity: number;
  expectedArrival: string; // ISO date YYYY-MM-DD
  status: "po" | "dispatched" | "in_transit" | "arrived";
};

export type IncomingShipmentsSummary = {
  /** Sum of quantity across the rows returned. The "how many units are
   * inbound" headline number for the KPI strip. */
  totalUnits: number;
  /** Number of shipment rows (each row = one PO line). */
  shipmentCount: number;
  /** Distinct SKU count across the rows. Helps Scott see breadth of
   * coverage at a glance — e.g. 3 shipments / 50 SKUs vs 50 shipments
   * of 3 SKUs are very different signals. */
  skuCount: number;
  /** Earliest expectedArrival across the rows, or null if no rows. */
  nextArrival: string | null;
};

export type IncomingShipmentsResult = {
  rows: IncomingShipmentRow[];
  summary: IncomingShipmentsSummary;
};

/** Page-feeding query for /incoming (SPEC §5.7 q3 — "What's on the way?
 * When is each shipment arriving?"). Joins SKU info so the table can
 * show product name without N+1 lookups, sorts by expected-arrival
 * ascending so the soonest arrivals land at the top.
 */
export async function getIncomingShipmentsView(opts: {
  destination?: Location;
  includeArrived?: boolean;
} = {}): Promise<IncomingShipmentsResult> {
  type Status = (typeof incomingShipments.status.enumValues)[number];
  const statuses: Status[] = opts.includeArrived
    ? ["po", "dispatched", "in_transit", "arrived"]
    : ["po", "dispatched", "in_transit"];

  const rows = await db
    .select({
      id: incomingShipments.id,
      sku: incomingShipments.sku,
      productName: skus.productName,
      productLine: skus.productLine,
      destination: incomingShipments.destination,
      shipmentName: incomingShipments.shipmentName,
      quantity: incomingShipments.quantity,
      expectedArrival: incomingShipments.expectedArrival,
      status: incomingShipments.status,
    })
    .from(incomingShipments)
    .leftJoin(skus, eq(incomingShipments.sku, skus.sku))
    .where(
      and(
        inArray(incomingShipments.status, statuses),
        opts.destination
          ? eq(incomingShipments.destination, opts.destination)
          : sql`true`,
      ),
    )
    .orderBy(asc(incomingShipments.expectedArrival));

  const totalUnits = rows.reduce((acc, r) => acc + r.quantity, 0);
  const skuSet = new Set(rows.map((r) => r.sku));
  const nextArrival = rows.length > 0 ? rows[0].expectedArrival : null;

  return {
    rows: rows as IncomingShipmentRow[],
    summary: {
      totalUnits,
      shipmentCount: rows.length,
      skuCount: skuSet.size,
      nextArrival,
    },
  };
}
