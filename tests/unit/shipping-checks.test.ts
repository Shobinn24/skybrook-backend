import { describe, it, expect } from "vitest";

import type { OrderRecord } from "@/lib/sources/shopify-fulfillments";
import { findDeliveredAt } from "@/lib/sources/shopify-fulfillments";
import {
  classifyOrderScope,
  computeStatsWindow,
  detectCarrierTransitViolations,
  detectFulfilmentSlaViolations,
  expectedShipDate,
  shiftStoreLocal,
} from "@/lib/domain/shipping-checks";

// ---------------------------------------------------------------------
// Test fixtures + helpers
// ---------------------------------------------------------------------

const NO_OOS = (_sku: string): number | undefined => 1_000_000;
const ADMIN_BASE = "https://incontinencepanties.myshopify.com";

function order(over: Partial<OrderRecord> = {}): OrderRecord {
  return {
    id: "gid://shopify/Order/100",
    name: "EV100",
    createdAt: "2026-05-12T15:00:00Z",
    cancelledAt: null,
    test: false,
    displayFinancialStatus: "PAID",
    displayFulfillmentStatus: "UNFULFILLED",
    shippingAddress: { countryCodeV2: "US", provinceCode: "TX" },
    customer: { displayName: "Test Buyer" },
    lineItems: [
      { sku: "ev-og-5x-m", name: "OG 5pk M", quantity: 1, fulfillableQuantity: 1 },
    ],
    fulfillments: [],
    ...over,
  };
}

// ---------------------------------------------------------------------
// 1. expectedShipDate
// ---------------------------------------------------------------------

describe("expectedShipDate (Spec §3.2)", () => {
  it("Mon → next day Tue", () => {
    // 2026-05-11 was a Monday.
    expect(expectedShipDate("2026-05-11")).toBe("2026-05-12");
  });
  it("Thu → next day Fri", () => {
    expect(expectedShipDate("2026-05-14")).toBe("2026-05-15");
  });
  it("Fri → next Mon", () => {
    // 2026-05-15 was Fri → 2026-05-18 Mon.
    expect(expectedShipDate("2026-05-15")).toBe("2026-05-18");
  });
  it("Sat → next Mon", () => {
    expect(expectedShipDate("2026-05-16")).toBe("2026-05-18");
  });
  it("Sun → next Mon", () => {
    expect(expectedShipDate("2026-05-17")).toBe("2026-05-18");
  });
});

// ---------------------------------------------------------------------
// 2. classifyOrderScope
// ---------------------------------------------------------------------

describe("classifyOrderScope (Spec §3.3)", () => {
  it("happy path → in scope", () => {
    expect(classifyOrderScope(order(), NO_OOS).inScope).toBe(true);
  });
  it("test order excluded", () => {
    const r = classifyOrderScope(order({ test: true }), NO_OOS);
    expect(r).toEqual({ inScope: false, reason: "test_order" });
  });
  it("cancelled excluded", () => {
    const r = classifyOrderScope(order({ cancelledAt: "2026-05-13T00:00:00Z" }), NO_OOS);
    expect(r).toEqual({ inScope: false, reason: "cancelled" });
  });
  it("fully refunded excluded", () => {
    const r = classifyOrderScope(
      order({ displayFinancialStatus: "REFUNDED" }),
      NO_OOS,
    );
    expect(r).toEqual({ inScope: false, reason: "fully_refunded" });
  });
  it("on-hold excluded", () => {
    const r = classifyOrderScope(
      order({ displayFulfillmentStatus: "ON_HOLD" }),
      NO_OOS,
    );
    expect(r.inScope).toBe(false);
    if (!r.inScope) expect(r.reason).toContain("on_hold");
  });
  it("non-US shipping excluded", () => {
    const r = classifyOrderScope(
      order({ shippingAddress: { countryCodeV2: "CA", provinceCode: null } }),
      NO_OOS,
    );
    expect(r.inScope).toBe(false);
    if (!r.inScope) expect(r.reason).toContain("non_us_ship");
  });
  it("OOS line item excludes the whole order", () => {
    const o = order({
      lineItems: [
        { sku: "ev-a", name: "A", quantity: 5, fulfillableQuantity: 5 },
      ],
    });
    const r = classifyOrderScope(o, (sku) => (sku === "ev-a" ? 0 : 100));
    expect(r.inScope).toBe(false);
    if (!r.inScope) expect(r.reason).toBe("oos:ev-a");
  });
  it("untracked SKU (lookup undefined) defaults to in-scope", () => {
    // Spec §7.5: custom/bundle items with no inventory row should NOT
    // exclude the order — better to false-flag and have ops look.
    const o = order({
      lineItems: [
        { sku: "bundle-xyz", name: "Bundle", quantity: 1, fulfillableQuantity: 1 },
      ],
    });
    const r = classifyOrderScope(o, () => undefined);
    expect(r.inScope).toBe(true);
  });
});

// ---------------------------------------------------------------------
// 3. detectFulfilmentSlaViolations
// ---------------------------------------------------------------------

describe("detectFulfilmentSlaViolations (Spec §3)", () => {
  it("flags an UNFULFILLED Fri-placed order on the following Tue", () => {
    // Order placed Fri 2026-05-15 (any time of day in ET) → expected
    // ship Mon 2026-05-18. By Tue 5/19 it's 1 day past due.
    const o = order({
      createdAt: "2026-05-15T18:00:00Z", // afternoon ET → 5/15 local
      displayFulfillmentStatus: "UNFULFILLED",
    });
    const flags = detectFulfilmentSlaViolations({
      orders: [o],
      inventoryAvailable: NO_OOS,
      todayStoreLocal: "2026-05-19",
      adminLinkBase: ADMIN_BASE,
    });
    expect(flags).toHaveLength(1);
    expect(flags[0].daysPastDue).toBe(1);
    expect(flags[0].expectedShipDate).toBe("2026-05-18");
  });

  it("does NOT flag the same order before the SLA is up", () => {
    const o = order({
      createdAt: "2026-05-15T18:00:00Z",
      displayFulfillmentStatus: "UNFULFILLED",
    });
    expect(
      detectFulfilmentSlaViolations({
        orders: [o],
        inventoryAvailable: NO_OOS,
        todayStoreLocal: "2026-05-17", // before Mon expected ship
        adminLinkBase: ADMIN_BASE,
      }),
    ).toEqual([]);
  });

  it("does NOT flag a FULFILLED order", () => {
    const o = order({
      createdAt: "2026-05-15T18:00:00Z",
      displayFulfillmentStatus: "FULFILLED",
    });
    expect(
      detectFulfilmentSlaViolations({
        orders: [o],
        inventoryAvailable: NO_OOS,
        todayStoreLocal: "2026-05-19",
        adminLinkBase: ADMIN_BASE,
      }),
    ).toEqual([]);
  });

  it("PARTIALLY_FULFILLED: surfaces unshipped line items only", () => {
    const o = order({
      createdAt: "2026-05-15T18:00:00Z",
      displayFulfillmentStatus: "PARTIALLY_FULFILLED",
      lineItems: [
        { sku: "ev-a", name: "A", quantity: 2, fulfillableQuantity: 0 }, // shipped
        { sku: "ev-b", name: "B", quantity: 1, fulfillableQuantity: 1 }, // pending
      ],
      fulfillments: [
        {
          createdAt: "2026-05-16T10:00:00Z",
          deliveredAt: null,
          inTransitAt: null,
          status: "in_transit",
          trackingInfo: [],
          events: [],
        },
      ],
    });
    const flags = detectFulfilmentSlaViolations({
      orders: [o],
      inventoryAvailable: NO_OOS,
      todayStoreLocal: "2026-05-19",
      adminLinkBase: ADMIN_BASE,
    });
    expect(flags).toHaveLength(1);
    expect(flags[0].lineItems).toEqual([
      { sku: "ev-b", name: "B", quantity: 1 },
    ]);
    expect(flags[0].currentStatus).toBe("PARTIALLY_FULFILLED");
  });

  it("sorts by days_past_due desc", () => {
    const orders = [
      order({
        id: "gid://shopify/Order/1",
        createdAt: "2026-05-13T18:00:00Z", // due 5/14 → 5d past on 5/19
      }),
      order({
        id: "gid://shopify/Order/2",
        createdAt: "2026-05-15T18:00:00Z", // due 5/18 → 1d past on 5/19
      }),
    ];
    const flags = detectFulfilmentSlaViolations({
      orders,
      inventoryAvailable: NO_OOS,
      todayStoreLocal: "2026-05-19",
      adminLinkBase: ADMIN_BASE,
    });
    expect(flags.map((f) => f.orderId)).toEqual([
      "gid://shopify/Order/1",
      "gid://shopify/Order/2",
    ]);
    expect(flags[0].daysPastDue).toBeGreaterThan(flags[1].daysPastDue);
  });
});

// ---------------------------------------------------------------------
// 4. detectCarrierTransitViolations
// ---------------------------------------------------------------------

describe("detectCarrierTransitViolations (Spec §4)", () => {
  it("flags as in_transit_over_10_days when no delivered event > 10d after ship", () => {
    const o = order({
      fulfillments: [
        {
          createdAt: "2026-05-01T12:00:00Z",
          deliveredAt: null,
          inTransitAt: "2026-05-01T15:00:00Z",
          status: "in_transit",
          trackingInfo: [
            { number: "T1", company: "DHL eCommerce", url: "https://dhl/track/T1" },
          ],
          events: [],
        },
      ],
    });
    const flags = detectCarrierTransitViolations({
      orders: [o],
      inventoryAvailable: NO_OOS,
      nowIso: "2026-05-18T12:00:00Z",
      adminLinkBase: ADMIN_BASE,
    });
    expect(flags).toHaveLength(1);
    expect(flags[0].status).toBe("in_transit_over_10_days");
    expect(flags[0].carrier).toBe("DHL eCommerce");
    expect(flags[0].daysSinceShip).toBeGreaterThanOrEqual(17);
  });

  it("flags as delivered_late when delivered > 10d after ship", () => {
    const o = order({
      fulfillments: [
        {
          createdAt: "2026-05-01T12:00:00Z",
          deliveredAt: "2026-05-13T12:00:00Z", // 12 days later
          inTransitAt: null,
          status: "delivered",
          trackingInfo: [],
          events: [],
        },
      ],
    });
    const flags = detectCarrierTransitViolations({
      orders: [o],
      inventoryAvailable: NO_OOS,
      nowIso: "2026-05-18T12:00:00Z",
      adminLinkBase: ADMIN_BASE,
    });
    expect(flags).toHaveLength(1);
    expect(flags[0].status).toBe("delivered_late");
  });

  it("does NOT flag when delivered on time (≤10d)", () => {
    const o = order({
      fulfillments: [
        {
          createdAt: "2026-05-01T12:00:00Z",
          deliveredAt: "2026-05-08T12:00:00Z", // 7 days
          inTransitAt: null,
          status: "delivered",
          trackingInfo: [],
          events: [],
        },
      ],
    });
    expect(
      detectCarrierTransitViolations({
        orders: [o],
        inventoryAvailable: NO_OOS,
        nowIso: "2026-05-18T12:00:00Z",
        adminLinkBase: ADMIN_BASE,
      }),
    ).toEqual([]);
  });

  it("does NOT flag fresh fulfillments within the 10d grace", () => {
    const o = order({
      fulfillments: [
        {
          createdAt: "2026-05-15T12:00:00Z",
          deliveredAt: null,
          inTransitAt: null,
          status: "in_transit",
          trackingInfo: [],
          events: [],
        },
      ],
    });
    expect(
      detectCarrierTransitViolations({
        orders: [o],
        inventoryAvailable: NO_OOS,
        nowIso: "2026-05-18T12:00:00Z",
        adminLinkBase: ADMIN_BASE,
      }),
    ).toEqual([]);
  });

  it("admin link is built from the numeric order id", () => {
    const o = order({
      id: "gid://shopify/Order/987654",
      fulfillments: [
        {
          createdAt: "2026-05-01T12:00:00Z",
          deliveredAt: null,
          inTransitAt: null,
          status: "in_transit",
          trackingInfo: [],
          events: [],
        },
      ],
    });
    const flags = detectCarrierTransitViolations({
      orders: [o],
      inventoryAvailable: NO_OOS,
      nowIso: "2026-05-18T12:00:00Z",
      adminLinkBase: ADMIN_BASE,
    });
    expect(flags[0].shopifyAdminLink).toBe(
      `${ADMIN_BASE}/admin/orders/987654`,
    );
  });
});

// ---------------------------------------------------------------------
// 5. computeStatsWindow
// ---------------------------------------------------------------------

describe("computeStatsWindow (Spec §5)", () => {
  it("includes delivered orders inside the window only", () => {
    const inWindow = order({
      id: "gid://shopify/Order/1",
      createdAt: "2026-05-01T12:00:00Z",
      fulfillments: [
        {
          createdAt: "2026-05-02T12:00:00Z", // 24h fulfilment
          deliveredAt: "2026-05-08T12:00:00Z", // 6d transit
          inTransitAt: null,
          status: "delivered",
          trackingInfo: [],
          events: [],
        },
      ],
    });
    const outsideWindow = order({
      id: "gid://shopify/Order/2",
      createdAt: "2026-03-01T12:00:00Z",
      fulfillments: [
        {
          createdAt: "2026-03-02T12:00:00Z",
          deliveredAt: "2026-03-08T12:00:00Z", // delivered way before window
          inTransitAt: null,
          status: "delivered",
          trackingInfo: [],
          events: [],
        },
      ],
    });

    const r = computeStatsWindow({
      orders: [inWindow, outsideWindow],
      inventoryAvailable: NO_OOS,
      windowStart: "2026-05-01",
      windowEnd: "2026-05-15",
    });
    expect(r.deliveredCount).toBe(1);
    expect(r.avgTransitDays).toBeCloseTo(6, 1);
    expect(r.avgFulfilmentHours).toBeCloseTo(24, 1);
    expect(r.transitHistogram["6"]).toBe(1);
  });

  it("skips orders that aren't delivered yet", () => {
    const undelivered = order({
      fulfillments: [
        {
          createdAt: "2026-05-02T12:00:00Z",
          deliveredAt: null,
          inTransitAt: null,
          status: "in_transit",
          trackingInfo: [],
          events: [],
        },
      ],
    });
    const r = computeStatsWindow({
      orders: [undelivered],
      inventoryAvailable: NO_OOS,
      windowStart: "2026-05-01",
      windowEnd: "2026-05-15",
    });
    expect(r.deliveredCount).toBe(0);
    expect(r.avgTransitDays).toBeNull();
  });

  it("histogram uses '>20' overflow for very-long transits", () => {
    const o = order({
      createdAt: "2026-04-01T12:00:00Z",
      fulfillments: [
        {
          createdAt: "2026-04-02T12:00:00Z",
          deliveredAt: "2026-05-05T12:00:00Z", // ~33 days transit
          inTransitAt: null,
          status: "delivered",
          trackingInfo: [],
          events: [],
        },
      ],
    });
    const r = computeStatsWindow({
      orders: [o],
      inventoryAvailable: NO_OOS,
      windowStart: "2026-05-01",
      windowEnd: "2026-05-15",
    });
    expect(r.transitHistogram[">20"]).toBe(1);
  });

  it("histogram has zeroed buckets even when nothing falls in them", () => {
    const r = computeStatsWindow({
      orders: [],
      inventoryAvailable: NO_OOS,
      windowStart: "2026-05-01",
      windowEnd: "2026-05-15",
    });
    expect(r.transitHistogram["0"]).toBe(0);
    expect(r.transitHistogram["20"]).toBe(0);
    expect(r.transitHistogram[">20"]).toBe(0);
  });
});

// ---------------------------------------------------------------------
// 6. findDeliveredAt
// ---------------------------------------------------------------------

describe("findDeliveredAt", () => {
  it("uses top-level deliveredAt when set", () => {
    expect(
      findDeliveredAt({
        createdAt: "2026-05-01T12:00:00Z",
        deliveredAt: "2026-05-08T12:00:00Z",
        inTransitAt: null,
        status: "delivered",
        trackingInfo: [],
        events: [{ status: "in_transit", happenedAt: "2026-05-02T12:00:00Z" }],
      }),
    ).toBe("2026-05-08T12:00:00Z");
  });
  it("falls back to events when deliveredAt is null", () => {
    expect(
      findDeliveredAt({
        createdAt: "2026-05-01T12:00:00Z",
        deliveredAt: null,
        inTransitAt: null,
        status: "delivered",
        trackingInfo: [],
        events: [
          { status: "in_transit", happenedAt: "2026-05-02T12:00:00Z" },
          { status: "delivered", happenedAt: "2026-05-09T12:00:00Z" },
        ],
      }),
    ).toBe("2026-05-09T12:00:00Z");
  });
  it("returns null when neither has data", () => {
    expect(
      findDeliveredAt({
        createdAt: "2026-05-01T12:00:00Z",
        deliveredAt: null,
        inTransitAt: null,
        status: "in_transit",
        trackingInfo: [],
        events: [],
      }),
    ).toBeNull();
  });
});

// Sanity check on the helper used by callers.
describe("shiftStoreLocal", () => {
  it("subtracts whole days", () => {
    expect(shiftStoreLocal("2026-05-18", -30)).toBe("2026-04-18");
  });
});
