/**
 * Assemble all DB facts needed by the Factory Order calc engine,
 * then call it.
 *
 * Spec: docs/factory-order-spec/factory-order-automation.md §3, §9.5
 */

import { and, eq, gte, lt, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  dailySales,
  incomingShipments,
  skus as skusTable,
  stockSnapshots,
} from "@/lib/db/schema";
import {
  runCalculation,
  type CalcInputs,
  type CalculationResult,
  type SkuFacts,
} from "@/lib/domain/factory-order-calc";
import {
  getOrCreateDraft,
  monthKey,
} from "@/lib/queries/factory-order";
import { getReceivedShipmentKeys, shipmentReceiptKey } from "@/lib/queries/incoming";

/**
 * Build the (sku → SkuFacts) map needed by the calc engine.
 *
 * `asOfDate` is the calc "today" — defaults to the first of the order
 * month + 30 days, so the 30D sales window covers the trailing month
 * leading up to order placement. Tests pin this for reproducibility.
 */
async function assembleSkuFacts(asOfDate: Date): Promise<{
  facts: Map<string, SkuFacts>;
  catalog: string[];
}> {
  const windowStart = new Date(asOfDate);
  windowStart.setUTCDate(windowStart.getUTCDate() - 30);
  const windowStartYmd = windowStart.toISOString().slice(0, 10);
  const asOfYmd = asOfDate.toISOString().slice(0, 10);

  // 30D Shopify units per (sku, channel).
  const salesRows = await db
    .select({
      sku: dailySales.sku,
      channel: dailySales.channel,
      units: sql<number>`SUM(${dailySales.unitsSold})`,
    })
    .from(dailySales)
    .where(
      and(
        gte(dailySales.salesDate, windowStartYmd),
        lt(dailySales.salesDate, asOfYmd),
      ),
    )
    .groupBy(dailySales.sku, dailySales.channel);

  // Latest stock per (sku, location).
  const stockRows = await db
    .select({
      sku: stockSnapshots.sku,
      location: stockSnapshots.location,
      onHand: stockSnapshots.onHand,
      snapshotDate: stockSnapshots.snapshotDate,
    })
    .from(stockSnapshots)
    .orderBy(stockSnapshots.snapshotDate);
  // The orderBy above is ASC, so newest = last seen. Walk and keep the
  // last value per key.
  const latestStock = new Map<string, number>();
  for (const r of stockRows) {
    latestStock.set(`${r.sku}|${r.location}`, r.onHand);
  }

  // Incoming POs excluding received receipts.
  const incomingRows = await db
    .select({
      sku: incomingShipments.sku,
      destination: incomingShipments.destination,
      quantity: incomingShipments.quantity,
      shipmentName: incomingShipments.shipmentName,
      expectedArrival: incomingShipments.expectedArrival,
    })
    .from(incomingShipments);
  const receivedKeys = await getReceivedShipmentKeys();
  const incomingTotals = new Map<string, number>();
  for (const r of incomingRows) {
    const key = shipmentReceiptKey({
      shipmentName: r.shipmentName,
      destination: r.destination,
      expectedArrival: r.expectedArrival,
    });
    if (receivedKeys.has(key)) continue;
    const mk = `${r.sku}|${r.destination}`;
    incomingTotals.set(mk, (incomingTotals.get(mk) ?? 0) + r.quantity);
  }

  // SKU catalog with unit costs.
  const catalogRows = await db
    .select({
      sku: skusTable.sku,
      unitCostUsd: skusTable.unitCostUsd,
      unitCostIntlUsd: skusTable.unitCostIntlUsd,
      active: skusTable.active,
    })
    .from(skusTable);

  // Per-channel sales lookup (sum is per-(sku,channel)).
  const usSales = new Map<string, number>();
  const intlSales = new Map<string, number>();
  for (const r of salesRows) {
    if (r.channel === "shopify_us") usSales.set(r.sku, Number(r.units));
    if (r.channel === "shopify_intl") intlSales.set(r.sku, Number(r.units));
  }

  const facts = new Map<string, SkuFacts>();
  const catalog: string[] = [];
  for (const r of catalogRows) {
    if (!r.active) continue;
    catalog.push(r.sku);
    facts.set(r.sku, {
      sku: r.sku,
      shopifyUs30d: usSales.get(r.sku) ?? 0,
      shopifyIntl30d: intlSales.get(r.sku) ?? 0,
      pdStock: latestStock.get(`${r.sku}|US`) ?? 0,
      antStock: latestStock.get(`${r.sku}|CN`) ?? 0,
      incomingUs: incomingTotals.get(`${r.sku}|US`) ?? 0,
      incomingIntl: incomingTotals.get(`${r.sku}|CN`) ?? 0,
      unitCostUs: r.unitCostUsd !== null ? Number(r.unitCostUsd) : 0,
      unitCostIntl:
        r.unitCostIntlUsd !== null ? Number(r.unitCostIntlUsd) : 0,
    });
  }

  return { facts, catalog };
}

export async function calculateOrder(opts: {
  orderId: string;
  /** Override the as-of date for tests; defaults to today UTC. */
  asOfDate?: Date;
}): Promise<CalculationResult> {
  // Pull the draft inputs by re-resolving via month — the orderId
  // alone is enough since `getOrCreateDraft` doesn't write when the
  // row exists. But we need the orderMonth to pick the as-of date.
  // Simpler: load the header + inputs directly.
  const orderMonth = await loadOrderMonth(opts.orderId);
  const draft = await getOrCreateDraft(orderMonth);

  const asOf = opts.asOfDate ?? defaultAsOfDate(orderMonth);

  const { facts, catalog } = await assembleSkuFacts(asOf);
  const calcInput: CalcInputs = {
    inputs: draft.inputs,
    skuFacts: facts,
    catalog,
  };
  return runCalculation(calcInput);
}

async function loadOrderMonth(orderId: string): Promise<string> {
  const { factoryOrders } = await import("@/lib/db/schema");
  const rows = await db
    .select()
    .from(factoryOrders)
    .where(eq(factoryOrders.id, orderId))
    .limit(1);
  if (rows.length === 0) {
    throw new Error(`factory_order ${orderId} not found`);
  }
  return rows[0].orderMonth;
}

/**
 * Default "as of" instant for the calc — first-of-month at UTC
 * midnight + 30 days. This gives a 30D sales window of the calendar
 * month immediately preceding the order (e.g., placing the May 1
 * order pulls Apr 1 → Apr 30 sales).
 */
function defaultAsOfDate(orderMonth: string): Date {
  const start = new Date(`${monthKey(orderMonth)}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() + 30);
  return start;
}

// Re-export for the tRPC layer + tests.
export { assembleSkuFacts };
