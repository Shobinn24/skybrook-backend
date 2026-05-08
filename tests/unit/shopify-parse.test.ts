import { describe, it, expect } from "vitest";
import { aggregateToDailySales } from "@/lib/sources/shopify";

type LineItem = {
  sku: string | null;
  quantity: number;
  discountedUnitPriceAfterAllDiscountsSet: { shopMoney: { amount: string } } | null;
};
type MoneySet = { shopMoney: { amount: string } } | null;
type Order = {
  createdAt: string;
  lineItems: { nodes: LineItem[] };
  totalTaxSet?: MoneySet;
  totalShippingPriceSet?: MoneySet;
  totalTipReceivedSet?: MoneySet;
};

function order(createdAt: string, lines: LineItem[]): Order {
  return { createdAt, lineItems: { nodes: lines } };
}
function li(sku: string | null, quantity: number, amount: string | null = "20.00"): LineItem {
  return {
    sku,
    quantity,
    discountedUnitPriceAfterAllDiscountsSet: amount != null ? { shopMoney: { amount } } : null,
  };
}
function money(amount: string): MoneySet {
  return { shopMoney: { amount } };
}
function orderWith(
  createdAt: string,
  lines: LineItem[],
  ancillary: { tax?: string; shipping?: string; tip?: string },
): Order {
  return {
    createdAt,
    lineItems: { nodes: lines },
    totalTaxSet: ancillary.tax != null ? money(ancillary.tax) : null,
    totalShippingPriceSet: ancillary.shipping != null ? money(ancillary.shipping) : null,
    totalTipReceivedSet: ancillary.tip != null ? money(ancillary.tip) : null,
  };
}

describe("aggregateToDailySales", () => {
  it("sums quantity and net_sales per (sku, day) across orders", () => {
    const orders = [
      order("2026-04-22T10:00:00Z", [li("ev-bshort-5x-m", 2, "20.00")]),
      order("2026-04-22T14:30:00Z", [li("ev-bshort-5x-m", 3, "20.00")]),
      order("2026-04-22T18:00:00Z", [li("ev-bshort-5x-l", 1, "22.00")]),
    ];
    const result = aggregateToDailySales(orders);
    expect(result).toEqual([
      { sku: "ev-bshort-5x-l", salesDate: "2026-04-22", unitsSold: 1, netSalesUsd: 22 },
      { sku: "ev-bshort-5x-m", salesDate: "2026-04-22", unitsSold: 5, netSalesUsd: 100 },
    ]);
  });

  it("slices createdAt to YYYY-MM-DD (UTC) for salesDate", () => {
    const orders = [
      order("2026-04-22T23:59:59Z", [li("ev-a", 1, "10.00")]),
      order("2026-04-23T00:00:01Z", [li("ev-a", 1, "10.00")]),
    ];
    const result = aggregateToDailySales(orders);
    expect(result).toEqual([
      { sku: "ev-a", salesDate: "2026-04-22", unitsSold: 1, netSalesUsd: 10 },
      { sku: "ev-a", salesDate: "2026-04-23", unitsSold: 1, netSalesUsd: 10 },
    ]);
  });

  it("skips line items with null sku (gift cards, custom items)", () => {
    const orders = [
      order("2026-04-22T10:00:00Z", [
        li(null, 1, "50.00"),
        li("ev-real", 2, "20.00"),
      ]),
    ];
    expect(aggregateToDailySales(orders)).toEqual([
      { sku: "ev-real", salesDate: "2026-04-22", unitsSold: 2, netSalesUsd: 40 },
    ]);
  });

  it("skips line items with zero or non-finite quantity", () => {
    const orders = [
      order("2026-04-22T10:00:00Z", [
        li("ev-zero", 0, "20.00"),
        li("ev-nan", Number.NaN, "20.00"),
        li("ev-ok", 3, "20.00"),
      ]),
    ];
    expect(aggregateToDailySales(orders)).toEqual([
      { sku: "ev-ok", salesDate: "2026-04-22", unitsSold: 3, netSalesUsd: 60 },
    ]);
  });

  it("treats null discountedUnitPriceAfterAllDiscountsSet as $0 net sales but still counts units", () => {
    const orders = [
      order("2026-04-22T10:00:00Z", [li("ev-free", 4, null)]),
    ];
    expect(aggregateToDailySales(orders)).toEqual([
      { sku: "ev-free", salesDate: "2026-04-22", unitsSold: 4, netSalesUsd: 0 },
    ]);
  });

  it("counts cancelled/refunded orders in the sum (Scott 2026-04-23)", () => {
    // No filter on order.displayFinancialStatus — raw units sold matches
    // the old ShopifyQL units_sold semantics. Caller doesn't need to know.
    const orders = [
      order("2026-04-22T10:00:00Z", [li("ev-x", 5, "20.00")]),
      order("2026-04-22T11:00:00Z", [li("ev-x", 2, "20.00")]), // imagine this one got refunded
    ];
    expect(aggregateToDailySales(orders)).toEqual([
      { sku: "ev-x", salesDate: "2026-04-22", unitsSold: 7, netSalesUsd: 140 },
    ]);
  });

  it("returns results sorted by date then sku for stable snapshots", () => {
    const orders = [
      order("2026-04-23T10:00:00Z", [li("ev-z", 1, "20.00")]),
      order("2026-04-22T10:00:00Z", [li("ev-b", 1, "20.00")]),
      order("2026-04-22T10:00:00Z", [li("ev-a", 1, "20.00")]),
    ];
    const result = aggregateToDailySales(orders);
    expect(result.map((r) => `${r.salesDate}|${r.sku}`)).toEqual([
      "2026-04-22|ev-a",
      "2026-04-22|ev-b",
      "2026-04-23|ev-z",
    ]);
  });

  it("rounds netSalesUsd to 4 decimal places (numeric(14,4) db column)", () => {
    const orders = [
      order("2026-04-22T10:00:00Z", [li("ev-a", 3, "19.995")]), // 59.985
    ];
    expect(aggregateToDailySales(orders)).toEqual([
      { sku: "ev-a", salesDate: "2026-04-22", unitsSold: 3, netSalesUsd: 59.985 },
    ]);
  });

  it("returns empty for empty orders input", () => {
    expect(aggregateToDailySales([])).toEqual([]);
  });

  it("decomposes 10-pack SKUs into 5-pack equivalents (units × 2, net unchanged)", () => {
    const orders = [
      order("2026-04-22T10:00:00Z", [li("ev-9055-10x-l", 1, "200.00")]),
    ];
    expect(aggregateToDailySales(orders)).toEqual([
      // 1 ten-pack sold = 2 five-pack equivalents depleted; revenue stays at $200.
      { sku: "ev-9055-5x-l", salesDate: "2026-04-22", unitsSold: 2, netSalesUsd: 200 },
    ]);
  });

  it("decomposes 15-pack SKUs into 5-pack equivalents (units × 3)", () => {
    const orders = [
      order("2026-04-22T10:00:00Z", [li("ev-9055-15x-l", 1, "300.00")]),
    ];
    expect(aggregateToDailySales(orders)).toEqual([
      { sku: "ev-9055-5x-l", salesDate: "2026-04-22", unitsSold: 3, netSalesUsd: 300 },
    ]);
  });

  it("rolls up 5-pack and 10-pack sales of the same garment into one row", () => {
    const orders = [
      order("2026-04-22T10:00:00Z", [li("ev-9055-5x-l", 4, "100.00")]),  //  4 units
      order("2026-04-22T11:00:00Z", [li("ev-9055-10x-l", 2, "200.00")]), // 2 × 2 = 4 units
    ];
    expect(aggregateToDailySales(orders)).toEqual([
      // 4 + 4 = 8 five-pack-equivalents, $400 + $400 = $800 revenue.
      { sku: "ev-9055-5x-l", salesDate: "2026-04-22", unitsSold: 8, netSalesUsd: 800 },
    ]);
  });

  it("does not decompose 1-pack SKUs (separate inventory)", () => {
    const orders = [
      order("2026-04-22T10:00:00Z", [li("ev-og-1x-beige-l", 3, "30.00")]),
    ];
    expect(aggregateToDailySales(orders)).toEqual([
      { sku: "ev-og-1x-beige-l", salesDate: "2026-04-22", unitsSold: 3, netSalesUsd: 90 },
    ]);
  });

  it("lowercases SKUs at ingest so mixed-case Shopify SKUs match the lowercase catalog", () => {
    const orders = [
      order("2026-04-22T10:00:00Z", [
        // Same garment sold under three different casings — should fold to one row.
        li("EV-hw-l", 2, "20.00"),
        li("ev-hw-l", 1, "20.00"),
        li("EV-HW-L", 3, "20.00"),
      ]),
    ];
    expect(aggregateToDailySales(orders)).toEqual([
      { sku: "ev-hw-l", salesDate: "2026-04-22", unitsSold: 6, netSalesUsd: 120 },
    ]);
  });

  it("decomposes Shopify's dash-form pack tokens (EV-hw-10-l → ev-hw-l × 2)", () => {
    // HW family collapses bare-size 5-pack rows to no-pack form to
    // match the inventory `ev-hw-{size}` convention. The 10-pack still
    // decomposes (multiplier 2) but lands on the no-pack canonical SKU.
    const orders = [
      order("2026-04-22T10:00:00Z", [li("EV-hw-10-l", 1, "200.00")]),
    ];
    expect(aggregateToDailySales(orders)).toEqual([
      { sku: "ev-hw-l", salesDate: "2026-04-22", unitsSold: 2, netSalesUsd: 200 },
    ]);
  });

  it("decomposes HF-in-family pack SKUs (EV-9055-HF-10-xl)", () => {
    const orders = [
      order("2026-04-22T10:00:00Z", [li("EV-9055-HF-10-xl", 1, "200.00")]),
    ];
    expect(aggregateToDailySales(orders)).toEqual([
      { sku: "ev-9055-hf-5x-xl", salesDate: "2026-04-22", unitsSold: 2, netSalesUsd: 200 },
    ]);
  });

  // ---- Tax / shipping / tips inclusion (Scott 2026-05-07) -----------------

  it("adds tax + shipping + tips to revenue, single SKU gets all of it", () => {
    const orders = [
      orderWith(
        "2026-04-22T10:00:00Z",
        [li("ev-a", 1, "100.00")],
        { tax: "8.00", shipping: "5.00", tip: "2.00" },
      ),
    ];
    expect(aggregateToDailySales(orders)).toEqual([
      // 100 line + (8+5+2) ancillary = 115
      { sku: "ev-a", salesDate: "2026-04-22", unitsSold: 1, netSalesUsd: 115 },
    ]);
  });

  it("pro-rates ancillary across multiple SKUs by line-item revenue share", () => {
    const orders = [
      orderWith(
        "2026-04-22T10:00:00Z",
        [
          li("ev-a", 1, "75.00"),  // 75% share
          li("ev-b", 1, "25.00"),  // 25% share
        ],
        { tax: "10.00", shipping: "10.00" }, // 20 total ancillary
      ),
    ];
    expect(aggregateToDailySales(orders)).toEqual([
      // ev-a: 75 + 0.75 * 20 = 90
      { sku: "ev-a", salesDate: "2026-04-22", unitsSold: 1, netSalesUsd: 90 },
      // ev-b: 25 + 0.25 * 20 = 30
      { sku: "ev-b", salesDate: "2026-04-22", unitsSold: 1, netSalesUsd: 30 },
    ]);
  });

  it("falls back to even split when tracked line revenue is 0 (free-promo with shipping)", () => {
    const orders = [
      orderWith(
        "2026-04-22T10:00:00Z",
        [li("ev-a", 1, "0.00"), li("ev-b", 1, "0.00")],
        { shipping: "10.00" },
      ),
    ];
    expect(aggregateToDailySales(orders)).toEqual([
      { sku: "ev-a", salesDate: "2026-04-22", unitsSold: 1, netSalesUsd: 5 },
      { sku: "ev-b", salesDate: "2026-04-22", unitsSold: 1, netSalesUsd: 5 },
    ]);
  });

  it("ancillary is fully attributed to tracked SKUs even when order also has gift cards", () => {
    // Mixed order: $50 tracked EV + $50 untracked gift card + $5 tax.
    // Pro-rate denominator is tracked-only revenue, so all $5 lands on
    // the tracked SKU. Acceptable approximation since ev-only orders
    // are the common case at Everdries.
    const orders = [
      orderWith(
        "2026-04-22T10:00:00Z",
        [
          li("ev-real", 1, "50.00"),
          li("gift-card", 1, "50.00"), // skipped (no ev- prefix)
        ],
        { tax: "5.00" },
      ),
    ];
    expect(aggregateToDailySales(orders)).toEqual([
      { sku: "ev-real", salesDate: "2026-04-22", unitsSold: 1, netSalesUsd: 55 },
    ]);
  });

  it("missing ancillary fields default to 0 (existing behavior preserved)", () => {
    // No tax/shipping/tip on an OrderWith — verifies optional-field path.
    const orders = [
      orderWith("2026-04-22T10:00:00Z", [li("ev-a", 1, "100.00")], {}),
    ];
    expect(aggregateToDailySales(orders)).toEqual([
      { sku: "ev-a", salesDate: "2026-04-22", unitsSold: 1, netSalesUsd: 100 },
    ]);
  });

  it("ancillary distributes correctly across pack-SKU lines after decomposition", () => {
    // 5x-m at $100 + 10x-m at $200 → both fold to ev-bshort-5x-m
    // Total tracked rev = $300. Tax of $30 split 1:2.
    // 5x line: 100 + (100/300)*30 = 110
    // 10x line: 200 + (200/300)*30 = 220
    // Sum after agg merge: 110 + 220 = 330
    const orders = [
      orderWith(
        "2026-04-22T10:00:00Z",
        [
          li("ev-bshort-5x-m", 5, "20.00"),  // 5 units, $100
          li("ev-bshort-10x-m", 1, "200.00"), // 2 units (after decompose), $200
        ],
        { tax: "30.00" },
      ),
    ];
    expect(aggregateToDailySales(orders)).toEqual([
      { sku: "ev-bshort-5x-m", salesDate: "2026-04-22", unitsSold: 7, netSalesUsd: 330 },
    ]);
  });

  it("ancillary on order with no tracked SKUs is dropped (order is no-op)", () => {
    const orders = [
      orderWith(
        "2026-04-22T10:00:00Z",
        [li("gift-card", 1, "50.00"), li(null, 1, "10.00")],
        { tax: "5.00", shipping: "5.00" },
      ),
    ];
    // No ev- SKUs → entire order skipped, ancillary disappears (no row to host it).
    expect(aggregateToDailySales(orders)).toEqual([]);
  });
});
