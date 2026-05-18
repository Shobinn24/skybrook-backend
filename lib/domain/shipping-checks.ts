/**
 * Pure functions for the Shipping Performance checks.
 *
 * Spec: docs/shipping-checks-spec/ops-shipping-checks-spec.md
 *
 * All date math runs in America/New_York to match the spec. UTC ISO
 * strings are parsed as instants; we convert to store-local where the
 * spec says to (SLA boundary, "today", histogram bucketing).
 *
 * No I/O. No DB calls. Caller passes the OrderRecord list (from
 * `shopify-fulfillments.fetchOrdersSince`) plus the inventory map for
 * the OOS exclusion.
 */

import { formatInTimeZone, fromZonedTime } from "date-fns-tz";

import type {
  FulfilmentRecord,
  OrderRecord,
} from "@/lib/sources/shopify-fulfillments";
import { findDeliveredAt } from "@/lib/sources/shopify-fulfillments";

export const STORE_TZ = "America/New_York";

// ---------------------------------------------------------------------
// 1. Expected ship-by date (Spec §3.2)
// ---------------------------------------------------------------------

/**
 * For an order created on `orderLocalDate` (store-local YYYY-MM-DD),
 * return the date by which the 3PL should have shipped it:
 *   Mon–Thu order → next calendar day
 *   Fri          → next Monday (+3 days)
 *   Sat          → next Monday (+2 days)
 *   Sun          → next Monday (+1 day)
 *
 * Implemented purely on date arithmetic so it stays DST-safe (we only
 * touch the date portion, never the time).
 */
export function expectedShipDate(orderLocalDate: string): string {
  // Parse as a local date (no timezone applied — just Y/M/D math).
  const [y, m, d] = orderLocalDate.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const weekday = dt.getUTCDay(); // 0=Sun, 1=Mon, …, 6=Sat
  let addDays: number;
  if (weekday >= 1 && weekday <= 4) addDays = 1; // Mon–Thu
  else if (weekday === 5) addDays = 3;           // Fri → Mon
  else if (weekday === 6) addDays = 2;           // Sat → Mon
  else addDays = 1;                              // Sun → Mon
  dt.setUTCDate(dt.getUTCDate() + addDays);
  return dt.toISOString().slice(0, 10);
}

function isoToStoreDate(iso: string): string {
  return formatInTimeZone(new Date(iso), STORE_TZ, "yyyy-MM-dd");
}

function localDayDiff(fromLocal: string, toLocal: string): number {
  const a = new Date(`${fromLocal}T00:00:00Z`).getTime();
  const b = new Date(`${toLocal}T00:00:00Z`).getTime();
  return Math.floor((b - a) / 86400000);
}

// ---------------------------------------------------------------------
// 2. Scope / exclusions (Spec §3.3)
// ---------------------------------------------------------------------

const EXCLUDED_FULFILMENT_STATES = new Set(["ON_HOLD", "SCHEDULED"]);

export type InventoryAvailability = (sku: string) => number | undefined;

/**
 * Whether the order is *in scope* for the SLA + carrier checks.
 *
 * `inventoryAvailable` is a lookup: SKU → available qty. Pass `undefined`
 * for SKUs the inventory table doesn't track (custom items, bundles)
 * — per spec we default to *including* those rather than silently
 * dropping (better to false-flag once and have ops eyeball it).
 *
 * Returns either `{ inScope: true }` or `{ inScope: false, reason }`.
 * The reason is useful for telemetry / debugging the flag list.
 */
export function classifyOrderScope(
  order: OrderRecord,
  inventoryAvailable: InventoryAvailability,
): { inScope: true } | { inScope: false; reason: string } {
  if (order.test) return { inScope: false, reason: "test_order" };
  if (order.cancelledAt) return { inScope: false, reason: "cancelled" };
  if (order.displayFinancialStatus === "REFUNDED") {
    return { inScope: false, reason: "fully_refunded" };
  }
  if (EXCLUDED_FULFILMENT_STATES.has(order.displayFulfillmentStatus)) {
    return {
      inScope: false,
      reason: `fulfillment_status:${order.displayFulfillmentStatus.toLowerCase()}`,
    };
  }
  const country = order.shippingAddress?.countryCodeV2 ?? null;
  if (country !== "US") {
    return { inScope: false, reason: `non_us_ship:${country ?? "null"}` };
  }
  // OOS check — any line item whose tracked SKU is short of qty kills
  // the order. Untracked SKUs (lookup returns undefined) default to
  // available (spec §7.5).
  for (const li of order.lineItems) {
    if (!li.sku) continue;
    const avail = inventoryAvailable(li.sku);
    if (avail === undefined) continue;
    if (avail < li.quantity) {
      return { inScope: false, reason: `oos:${li.sku}` };
    }
  }
  return { inScope: true };
}

// ---------------------------------------------------------------------
// 3. Check A — Fulfilment SLA (Spec §3)
// ---------------------------------------------------------------------

export type FulfilmentFlag = {
  orderId: string;
  orderName: string;
  orderCreatedAt: string;
  expectedShipDate: string;
  daysPastDue: number;
  customerName: string | null;
  shippingState: string | null;
  lineItems: Array<{
    sku: string | null;
    name: string | null;
    quantity: number;
  }>;
  currentStatus: string;
  lastSeenInThreePl: string | null;
  shopifyAdminLink: string;
};

const FLAGGABLE_FULFILMENT_STATUS = new Set([
  "UNFULFILLED",
  "PARTIALLY_FULFILLED",
]);

/**
 * Pure version of the SLA check — caller supplies "today" in store
 * tz, scope-filtered orders, and the Shopify admin link template.
 */
export function detectFulfilmentSlaViolations(opts: {
  orders: OrderRecord[];
  inventoryAvailable: InventoryAvailability;
  todayStoreLocal: string;
  adminLinkBase: string;
}): FulfilmentFlag[] {
  const out: FulfilmentFlag[] = [];
  for (const o of opts.orders) {
    if (!FLAGGABLE_FULFILMENT_STATUS.has(o.displayFulfillmentStatus)) continue;
    const scope = classifyOrderScope(o, opts.inventoryAvailable);
    if (!scope.inScope) continue;

    const orderLocal = isoToStoreDate(o.createdAt);
    const expectShip = expectedShipDate(orderLocal);
    if (opts.todayStoreLocal <= expectShip) continue; // not yet due

    const daysPastDue = localDayDiff(expectShip, opts.todayStoreLocal);
    const lastSeen = mostRecentFulfillmentEvent(o.fulfillments);

    out.push({
      orderId: o.id,
      orderName: o.name,
      orderCreatedAt: o.createdAt,
      expectedShipDate: expectShip,
      daysPastDue,
      customerName: o.customer?.displayName ?? null,
      shippingState: o.shippingAddress?.provinceCode ?? null,
      lineItems: lineItemsToReport(o),
      currentStatus: o.displayFulfillmentStatus,
      lastSeenInThreePl: lastSeen,
      shopifyAdminLink: shopifyAdminLink(opts.adminLinkBase, o.id),
    });
  }
  out.sort((a, b) => b.daysPastDue - a.daysPastDue);
  return out;
}

function lineItemsToReport(o: OrderRecord): FulfilmentFlag["lineItems"] {
  // Spec §3.6: for partial fulfilments, surface only the unshipped
  // line items. fulfillableQuantity > 0 ⇒ still owed to the customer.
  const anyShipped = (o.fulfillments?.length ?? 0) > 0;
  return o.lineItems
    .filter((li) => !anyShipped || li.fulfillableQuantity > 0)
    .map((li) => ({
      sku: li.sku,
      name: li.name,
      quantity: anyShipped ? li.fulfillableQuantity : li.quantity,
    }));
}

function mostRecentFulfillmentEvent(
  fulfillments: FulfilmentRecord[],
): string | null {
  let best: string | null = null;
  for (const f of fulfillments) {
    for (const e of f.events) {
      if (best === null || e.happenedAt > best) best = e.happenedAt;
    }
  }
  return best;
}

// ---------------------------------------------------------------------
// 4. Check B — Carrier transit (Spec §4)
// ---------------------------------------------------------------------

export type CarrierFlag = {
  orderId: string;
  orderName: string;
  orderCreatedAt: string;
  fulfilledAt: string;
  daysSinceShip: number;
  deliveredAt: string | null;
  carrier: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  shippingState: string | null;
  status: "in_transit_over_10_days" | "delivered_late";
  shopifyAdminLink: string;
};

const TRANSIT_GRACE_DAYS = 10;

export function detectCarrierTransitViolations(opts: {
  orders: OrderRecord[];
  inventoryAvailable: InventoryAvailability;
  nowIso: string; // current instant (server now), TZ-irrelevant since we diff timestamps
  adminLinkBase: string;
}): CarrierFlag[] {
  const out: CarrierFlag[] = [];
  const now = new Date(opts.nowIso).getTime();

  for (const o of opts.orders) {
    const scope = classifyOrderScope(o, opts.inventoryAvailable);
    if (!scope.inScope) continue;
    if (o.fulfillments.length === 0) continue;

    for (const f of o.fulfillments) {
      const fulfilledAt = new Date(f.createdAt).getTime();
      const daysSinceShip = (now - fulfilledAt) / 86400000;
      if (daysSinceShip <= TRANSIT_GRACE_DAYS) continue;

      const delivered = findDeliveredAt(f);
      let status: CarrierFlag["status"];
      if (!delivered) {
        status = "in_transit_over_10_days";
      } else {
        const transitDays =
          (new Date(delivered).getTime() - fulfilledAt) / 86400000;
        if (transitDays > TRANSIT_GRACE_DAYS) status = "delivered_late";
        else continue; // delivered on time → no flag
      }

      out.push({
        orderId: o.id,
        orderName: o.name,
        orderCreatedAt: o.createdAt,
        fulfilledAt: f.createdAt,
        daysSinceShip: Math.floor(daysSinceShip),
        deliveredAt: delivered,
        carrier: f.trackingInfo[0]?.company ?? null,
        trackingNumber: f.trackingInfo[0]?.number ?? null,
        trackingUrl: f.trackingInfo[0]?.url ?? null,
        shippingState: o.shippingAddress?.provinceCode ?? null,
        status,
        shopifyAdminLink: shopifyAdminLink(opts.adminLinkBase, o.id),
      });
    }
  }
  out.sort((a, b) => b.daysSinceShip - a.daysSinceShip);
  return out;
}

// ---------------------------------------------------------------------
// 5. Check C — Stats panel (Spec §5)
// ---------------------------------------------------------------------

export type StatsWindowSummary = {
  windowStart: string; // YYYY-MM-DD (store-local), inclusive
  windowEnd: string;   // YYYY-MM-DD (store-local), exclusive
  deliveredCount: number;
  avgFulfilmentHours: number | null;
  avgTransitDays: number | null;
  avgTotalDays: number | null;
  // Histogram of carrier-transit days, bin width 1, x range 0–20 with
  // ">20" overflow. Keys are "0".."20" or ">20"; values are counts.
  transitHistogram: Record<string, number>;
};

const HISTOGRAM_OVERFLOW = ">20";

function bucketKey(transitDays: number): string {
  if (transitDays > 20) return HISTOGRAM_OVERFLOW;
  if (transitDays < 0) return "0"; // negative would be data error
  return String(Math.floor(transitDays));
}

/**
 * Compute the stats panel for delivered orders whose delivered_at
 * falls in [windowStart, windowEnd) — store-local dates.
 */
export function computeStatsWindow(opts: {
  orders: OrderRecord[];
  inventoryAvailable: InventoryAvailability;
  windowStart: string; // YYYY-MM-DD store-local, inclusive
  windowEnd: string;   // YYYY-MM-DD store-local, exclusive
}): StatsWindowSummary {
  const fulfilmentHours: number[] = [];
  const transitDays: number[] = [];
  const totalDays: number[] = [];
  const histogram: Record<string, number> = {};
  // Initialize every bucket to 0 so the chart has a stable axis even
  // when some bins are empty.
  for (let i = 0; i <= 20; i++) histogram[String(i)] = 0;
  histogram[HISTOGRAM_OVERFLOW] = 0;

  for (const o of opts.orders) {
    const scope = classifyOrderScope(o, opts.inventoryAvailable);
    if (!scope.inScope) continue;
    const firstF = pickFirstFulfilment(o.fulfillments);
    if (!firstF) continue;
    const delivered = findDeliveredAt(firstF);
    if (!delivered) continue;

    const deliveredLocal = isoToStoreDate(delivered);
    if (deliveredLocal < opts.windowStart || deliveredLocal >= opts.windowEnd) {
      continue;
    }

    const orderTs = new Date(o.createdAt).getTime();
    const shipTs = new Date(firstF.createdAt).getTime();
    const delivTs = new Date(delivered).getTime();

    const fHours = (shipTs - orderTs) / 3600000;
    const tDays = (delivTs - shipTs) / 86400000;
    const totDays = (delivTs - orderTs) / 86400000;

    if (Number.isFinite(fHours) && fHours >= 0) fulfilmentHours.push(fHours);
    if (Number.isFinite(tDays) && tDays >= 0) {
      transitDays.push(tDays);
      histogram[bucketKey(tDays)] = (histogram[bucketKey(tDays)] ?? 0) + 1;
    }
    if (Number.isFinite(totDays) && totDays >= 0) totalDays.push(totDays);
  }

  return {
    windowStart: opts.windowStart,
    windowEnd: opts.windowEnd,
    deliveredCount: transitDays.length,
    avgFulfilmentHours: mean(fulfilmentHours),
    avgTransitDays: mean(transitDays),
    avgTotalDays: mean(totalDays),
    transitHistogram: histogram,
  };
}

function pickFirstFulfilment(
  fulfillments: FulfilmentRecord[],
): FulfilmentRecord | null {
  if (fulfillments.length === 0) return null;
  return [...fulfillments].sort((a, b) =>
    a.createdAt < b.createdAt ? -1 : 1,
  )[0];
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

// ---------------------------------------------------------------------
// 6. Helpers exposed for tests + callers
// ---------------------------------------------------------------------

export function todayStoreLocal(now: Date = new Date()): string {
  return formatInTimeZone(now, STORE_TZ, "yyyy-MM-dd");
}

export function shiftStoreLocal(ymd: string, deltaDays: number): string {
  const dt = new Date(`${ymd}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return dt.toISOString().slice(0, 10);
}

/** Returns the UTC instant for midnight at `ymd` in the store TZ. */
export function storeLocalMidnight(ymd: string): Date {
  return fromZonedTime(`${ymd}T00:00:00`, STORE_TZ);
}

function shopifyAdminLink(base: string, gid: string): string {
  // gid://shopify/Order/12345 → 12345
  const m = gid.match(/Order\/(\d+)/);
  const numericId = m ? m[1] : gid;
  return `${base.replace(/\/$/, "")}/admin/orders/${numericId}`;
}
