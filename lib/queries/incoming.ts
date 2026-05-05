import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { incomingReceipts, incomingShipments, skus } from "@/lib/db/schema";
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

/** Display-time status driven by the receipts table.
 *
 * - `pending`  — no receipt, ETA in future. Normal in-flight PO.
 * - `overdue`  — no receipt, ETA in past. Either delayed or delivered-but-
 *                not-yet-counted; Scott confirms via "Mark received".
 * - `received` — receipt row exists. Hidden from default view; opt-in via
 *                `includeReceived`.
 *
 * Replaces the pre-2026-05-05 model where the parser flipped `status` to
 * `arrived` based on `today >= ETA`. That auto-flip caused real POs to
 * vanish from /incoming the day after their ETA regardless of whether
 * stock had actually been counted (Scott flagged 2026-05-05).
 */
export type IncomingDisplayStatus = "pending" | "overdue" | "received";

export type IncomingShipmentRow = {
  id: string;
  sku: string;
  productName: string | null;
  productLine: string | null;
  destination: Location;
  shipmentName: string;
  quantity: number;
  expectedArrival: string; // ISO date YYYY-MM-DD
  displayStatus: IncomingDisplayStatus;
  receivedAt: string | null; // ISO timestamp; null when not yet received
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
  /** Count of rows whose ETA has passed but no receipt is on file. These
   * are exactly the shipments Scott needs to confirm or chase. */
  overdueCount: number;
};

export type IncomingShipmentsResult = {
  rows: IncomingShipmentRow[];
  summary: IncomingShipmentsSummary;
};

/** Page-feeding query for /incoming (SPEC §5.7 q3 — "What's on the way?
 * When is each shipment arriving?"). LEFT JOINs `incoming_receipts` on
 * the natural shipment identity (name + destination + ETA) so each row
 * carries its receipt state. Default view omits received rows; opt-in
 * via `includeReceived` to see them on a "past shipments" toggle.
 */
export async function getIncomingShipmentsView(opts: {
  destination?: Location;
  includeReceived?: boolean;
  asOfDate?: string; // optional ISO YYYY-MM-DD; defaults to DB-side current_date
} = {}): Promise<IncomingShipmentsResult> {
  // Receipt match key = (shipmentName, destination, expectedArrival).
  // Status derives from the join + date comparison done in SQL so we
  // don't have to re-implement timezone handling in JS.
  const todayExpr = opts.asOfDate
    ? sql<string>`${opts.asOfDate}::date`
    : sql<string>`current_date`;

  const displayStatusSql = sql<IncomingDisplayStatus>`
    case
      when ${incomingReceipts.id} is not null then 'received'
      when ${incomingShipments.expectedArrival} < ${todayExpr} then 'overdue'
      else 'pending'
    end
  `.as("display_status");

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
      displayStatus: displayStatusSql,
      receivedAt: incomingReceipts.receivedAt,
    })
    .from(incomingShipments)
    .leftJoin(skus, eq(incomingShipments.sku, skus.sku))
    .leftJoin(
      incomingReceipts,
      and(
        eq(incomingReceipts.shipmentName, incomingShipments.shipmentName),
        eq(incomingReceipts.destination, incomingShipments.destination),
        eq(incomingReceipts.expectedArrival, incomingShipments.expectedArrival),
      ),
    )
    .where(
      and(
        opts.includeReceived ? sql`true` : isNull(incomingReceipts.id),
        opts.destination
          ? eq(incomingShipments.destination, opts.destination)
          : sql`true`,
      ),
    )
    .orderBy(asc(incomingShipments.expectedArrival));

  const totalUnits = rows.reduce((acc, r) => acc + r.quantity, 0);
  const skuSet = new Set(rows.map((r) => r.sku));
  const nextArrival = rows.length > 0 ? rows[0].expectedArrival : null;
  const overdueCount = rows.filter((r) => r.displayStatus === "overdue").length;

  return {
    rows: rows.map((r) => ({
      ...r,
      receivedAt: r.receivedAt ? r.receivedAt.toISOString() : null,
    })) as IncomingShipmentRow[],
    summary: {
      totalUnits,
      shipmentCount: rows.length,
      skuCount: skuSet.size,
      nextArrival,
      overdueCount,
    },
  };
}

/** Returns the natural keys of every PO that has been manually received.
 * Used by `reconcile` to exclude received-and-stocked POs from the
 * forward-looking incoming projection.
 */
export async function getReceivedShipmentKeys(): Promise<
  Set<string>
> {
  const rows = await db
    .select({
      shipmentName: incomingReceipts.shipmentName,
      destination: incomingReceipts.destination,
      expectedArrival: incomingReceipts.expectedArrival,
    })
    .from(incomingReceipts)
    .where(isNotNull(incomingReceipts.id));
  return new Set(
    rows.map((r) => `${r.shipmentName}|${r.destination}|${r.expectedArrival}`),
  );
}

export function shipmentReceiptKey(input: {
  shipmentName: string;
  destination: Location;
  expectedArrival: string;
}): string {
  return `${input.shipmentName}|${input.destination}|${input.expectedArrival}`;
}
