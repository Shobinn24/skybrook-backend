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
  shippingAddress?: { countryCode: string | null } | null;
};

function orderShippedTo(
  createdAt: string,
  lines: LineItem[],
  shipToCountry: string | null,
): Order {
  return {
    createdAt,
    lineItems: { nodes: lines },
    shippingAddress: shipToCountry === null ? null : { countryCode: shipToCountry },
  };
}

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

// Build an expected row. net defaults to product+ancillary so the common
// (no-ancillary) case stays terse: row(sku, units, product).
function row(
  sku: string,
  routedLocation: "US" | "CN",
  salesDate: string,
  unitsSold: number,
  productSalesUsd: number,
  ancillaryUsd = 0,
  netSalesUsd = productSalesUsd + ancillaryUsd,
) {
  return { sku, routedLocation, salesDate, unitsSold, netSalesUsd, productSalesUsd, ancillaryUsd };
}

describe("aggregateToDailySales", () => {
  it("sums quantity and net_sales per (sku, day) across orders", () => {
    const orders = [
      order("2026-04-22T10:00:00Z", [li("ev-bshort-5x-m", 2, "20.00")]),
      order("2026-04-22T14:30:00Z", [li("ev-bshort-5x-m", 3, "20.00")]),
      order("2026-04-22T18:00:00Z", [li("ev-bshort-5x-l", 1, "22.00")]),
    ];
    expect(aggregateToDailySales(orders, "shopify_us")).toEqual([
      row("ev-bshort-5x-l", "US", "2026-04-22", 1, 22),
      row("ev-bshort-5x-m", "US", "2026-04-22", 5, 100),
    ]);
  });

  it("buckets createdAt by EST calendar date for salesDate", () => {
    const orders = [
      order("2026-04-22T23:59:59Z", [li("ev-a", 1, "10.00")]),
      order("2026-04-23T00:00:01Z", [li("ev-a", 1, "10.00")]),
    ];
    expect(aggregateToDailySales(orders, "shopify_us")).toEqual([
      row("ev-a", "US", "2026-04-22", 2, 20),
    ]);
  });

  it("EST midnight boundary splits orders correctly", () => {
    const orders = [
      order("2026-04-23T03:59:00Z", [li("ev-a", 1, "10.00")]),
      order("2026-04-23T04:01:00Z", [li("ev-a", 1, "10.00")]),
    ];
    expect(aggregateToDailySales(orders, "shopify_us")).toEqual([
      row("ev-a", "US", "2026-04-22", 1, 10),
      row("ev-a", "US", "2026-04-23", 1, 10),
    ]);
  });

  it("skips line items with null sku (gift cards, custom items)", () => {
    const orders = [
      order("2026-04-22T10:00:00Z", [li(null, 1, "50.00"), li("ev-real", 2, "20.00")]),
    ];
    expect(aggregateToDailySales(orders, "shopify_us")).toEqual([
      row("ev-real", "US", "2026-04-22", 2, 40),
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
    expect(aggregateToDailySales(orders, "shopify_us")).toEqual([
      row("ev-ok", "US", "2026-04-22", 3, 60),
    ]);
  });

  it("treats null unit price as $0 net sales but still counts units", () => {
    const orders = [order("2026-04-22T10:00:00Z", [li("ev-free", 4, null)])];
    expect(aggregateToDailySales(orders, "shopify_us")).toEqual([
      row("ev-free", "US", "2026-04-22", 4, 0),
    ]);
  });

  it("counts cancelled/refunded orders in the sum (Scott 2026-04-23)", () => {
    const orders = [
      order("2026-04-22T10:00:00Z", [li("ev-x", 5, "20.00")]),
      order("2026-04-22T11:00:00Z", [li("ev-x", 2, "20.00")]),
    ];
    expect(aggregateToDailySales(orders, "shopify_us")).toEqual([
      row("ev-x", "US", "2026-04-22", 7, 140),
    ]);
  });

  it("returns results sorted by date then sku for stable snapshots", () => {
    const orders = [
      order("2026-04-23T10:00:00Z", [li("ev-z", 1, "20.00")]),
      order("2026-04-22T10:00:00Z", [li("ev-b", 1, "20.00")]),
      order("2026-04-22T10:00:00Z", [li("ev-a", 1, "20.00")]),
    ];
    const result = aggregateToDailySales(orders, "shopify_us");
    expect(result.map((r) => `${r.salesDate}|${r.sku}`)).toEqual([
      "2026-04-22|ev-a",
      "2026-04-22|ev-b",
      "2026-04-23|ev-z",
    ]);
  });

  it("rounds revenue to 4 decimal places (numeric(14,4) db column)", () => {
    const orders = [order("2026-04-22T10:00:00Z", [li("ev-a", 3, "19.995")])];
    expect(aggregateToDailySales(orders, "shopify_us")).toEqual([
      row("ev-a", "US", "2026-04-22", 3, 59.985),
    ]);
  });

  it("returns empty for empty orders input", () => {
    expect(aggregateToDailySales([], "shopify_us")).toEqual([]);
  });

  it("decomposes 10-pack SKUs into 5-pack equivalents (units × 2, net unchanged)", () => {
    const orders = [order("2026-04-22T10:00:00Z", [li("ev-9055-10x-l", 1, "200.00")])];
    expect(aggregateToDailySales(orders, "shopify_us")).toEqual([
      row("ev-9055-5x-l", "US", "2026-04-22", 2, 200),
    ]);
  });

  it("decomposes 15-pack SKUs into 5-pack equivalents (units × 3)", () => {
    const orders = [order("2026-04-22T10:00:00Z", [li("ev-9055-15x-l", 1, "300.00")])];
    expect(aggregateToDailySales(orders, "shopify_us")).toEqual([
      row("ev-9055-5x-l", "US", "2026-04-22", 3, 300),
    ]);
  });

  it("rolls up 5-pack and 10-pack sales of the same garment into one row", () => {
    const orders = [
      order("2026-04-22T10:00:00Z", [li("ev-9055-5x-l", 4, "100.00")]),
      order("2026-04-22T11:00:00Z", [li("ev-9055-10x-l", 2, "200.00")]),
    ];
    expect(aggregateToDailySales(orders, "shopify_us")).toEqual([
      row("ev-9055-5x-l", "US", "2026-04-22", 8, 800),
    ]);
  });

  it("does not decompose 1-pack SKUs (separate inventory)", () => {
    const orders = [order("2026-04-22T10:00:00Z", [li("ev-og-1x-beige-l", 3, "30.00")])];
    expect(aggregateToDailySales(orders, "shopify_us")).toEqual([
      row("ev-og-1x-beige-l", "US", "2026-04-22", 3, 90),
    ]);
  });

  it("lowercases SKUs at ingest so mixed-case Shopify SKUs match the lowercase catalog", () => {
    const orders = [
      order("2026-04-22T10:00:00Z", [
        li("EV-hw-l", 2, "20.00"),
        li("ev-hw-l", 1, "20.00"),
        li("EV-HW-L", 3, "20.00"),
      ]),
    ];
    expect(aggregateToDailySales(orders, "shopify_us")).toEqual([
      row("ev-hw-l", "US", "2026-04-22", 6, 120),
    ]);
  });

  it("decomposes Shopify's dash-form pack tokens (EV-hw-10-l → ev-hw-l × 2)", () => {
    const orders = [order("2026-04-22T10:00:00Z", [li("EV-hw-10-l", 1, "200.00")])];
    expect(aggregateToDailySales(orders, "shopify_us")).toEqual([
      row("ev-hw-l", "US", "2026-04-22", 2, 200),
    ]);
  });

  it("decomposes HF-in-family pack SKUs (EV-9055-HF-10-xl)", () => {
    const orders = [order("2026-04-22T10:00:00Z", [li("EV-9055-HF-10-xl", 1, "200.00")])];
    expect(aggregateToDailySales(orders, "shopify_us")).toEqual([
      row("ev-9055-hf-5x-xl", "US", "2026-04-22", 2, 200),
    ]);
  });

  // ---- Tax / shipping / tips: product vs ancillary split (2026-05-07 + split 2026-06-25) ----

  it("adds tax + shipping + tips to revenue; product vs ancillary split out", () => {
    const orders = [
      orderWith("2026-04-22T10:00:00Z", [li("ev-a", 1, "100.00")], {
        tax: "8.00",
        shipping: "5.00",
        tip: "2.00",
      }),
    ];
    expect(aggregateToDailySales(orders, "shopify_us")).toEqual([
      // product 100, ancillary 8+5+2 = 15, net 115
      row("ev-a", "US", "2026-04-22", 1, 100, 15, 115),
    ]);
  });

  it("pro-rates ancillary across multiple SKUs by line-item revenue share", () => {
    const orders = [
      orderWith(
        "2026-04-22T10:00:00Z",
        [li("ev-a", 1, "75.00"), li("ev-b", 1, "25.00")],
        { tax: "10.00", shipping: "10.00" }, // 20 total ancillary
      ),
    ];
    expect(aggregateToDailySales(orders, "shopify_us")).toEqual([
      // ev-a: product 75, ancillary 0.75*20 = 15, net 90
      row("ev-a", "US", "2026-04-22", 1, 75, 15, 90),
      // ev-b: product 25, ancillary 0.25*20 = 5, net 30
      row("ev-b", "US", "2026-04-22", 1, 25, 5, 30),
    ]);
  });

  it("falls back to even split when tracked line revenue is 0 (free-promo with shipping)", () => {
    const orders = [
      orderWith("2026-04-22T10:00:00Z", [li("ev-a", 1, "0.00"), li("ev-b", 1, "0.00")], {
        shipping: "10.00",
      }),
    ];
    expect(aggregateToDailySales(orders, "shopify_us")).toEqual([
      row("ev-a", "US", "2026-04-22", 1, 0, 5, 5),
      row("ev-b", "US", "2026-04-22", 1, 0, 5, 5),
    ]);
  });

  it("ancillary is fully attributed to tracked SKUs even when order also has gift cards", () => {
    const orders = [
      orderWith(
        "2026-04-22T10:00:00Z",
        [li("ev-real", 1, "50.00"), li("gift-card", 1, "50.00")],
        { tax: "5.00" },
      ),
    ];
    expect(aggregateToDailySales(orders, "shopify_us")).toEqual([
      row("ev-real", "US", "2026-04-22", 1, 50, 5, 55),
    ]);
  });

  it("missing ancillary fields default to 0 (existing behavior preserved)", () => {
    const orders = [orderWith("2026-04-22T10:00:00Z", [li("ev-a", 1, "100.00")], {})];
    expect(aggregateToDailySales(orders, "shopify_us")).toEqual([
      row("ev-a", "US", "2026-04-22", 1, 100, 0, 100),
    ]);
  });

  it("ancillary distributes correctly across pack-SKU lines after decomposition", () => {
    const orders = [
      orderWith(
        "2026-04-22T10:00:00Z",
        [li("ev-bshort-5x-m", 5, "20.00"), li("ev-bshort-10x-m", 1, "200.00")],
        { tax: "30.00" },
      ),
    ];
    // both fold to ev-bshort-5x-m: product 100+200=300, ancillary 10+20=30, net 330
    expect(aggregateToDailySales(orders, "shopify_us")).toEqual([
      row("ev-bshort-5x-m", "US", "2026-04-22", 7, 300, 30, 330),
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
    expect(aggregateToDailySales(orders, "shopify_us")).toEqual([]);
  });

  // ---- US-store international order routing (Scott 2026-05-12) ------------

  it("routes US-store + US ship-to to the US warehouse", () => {
    const orders = [orderShippedTo("2026-04-22T10:00:00Z", [li("ev-a", 1, "20.00")], "US")];
    expect(aggregateToDailySales(orders, "shopify_us")).toEqual([
      row("ev-a", "US", "2026-04-22", 1, 20),
    ]);
  });

  it("routes US-store + non-US ship-to to the CN warehouse (the bug Scott reported)", () => {
    const orders = [orderShippedTo("2026-04-22T10:00:00Z", [li("ev-a", 1, "20.00")], "GB")];
    expect(aggregateToDailySales(orders, "shopify_us")).toEqual([
      row("ev-a", "CN", "2026-04-22", 1, 20),
    ]);
  });

  it("routes INTL-store to the CN warehouse regardless of ship-to", () => {
    const orders = [
      orderShippedTo("2026-04-22T10:00:00Z", [li("ev-a", 1, "20.00")], "DE"),
      orderShippedTo("2026-04-22T11:00:00Z", [li("ev-b", 1, "20.00")], "US"),
    ];
    expect(aggregateToDailySales(orders, "shopify_intl")).toEqual([
      row("ev-a", "CN", "2026-04-22", 1, 20),
      row("ev-b", "CN", "2026-04-22", 1, 20),
    ]);
  });

  it("splits a mixed-routing day for the same SKU into two rows", () => {
    const orders = [
      orderShippedTo("2026-04-22T10:00:00Z", [li("ev-a", 2, "20.00")], "US"),
      orderShippedTo("2026-04-22T11:00:00Z", [li("ev-a", 1, "20.00")], "GB"),
    ];
    expect(aggregateToDailySales(orders, "shopify_us")).toEqual([
      row("ev-a", "CN", "2026-04-22", 1, 20),
      row("ev-a", "US", "2026-04-22", 2, 40),
    ]);
  });

  it("falls back to channel default when shippingAddress is missing", () => {
    const orders = [order("2026-04-22T10:00:00Z", [li("ev-a", 1, "20.00")])];
    expect(aggregateToDailySales(orders, "shopify_us")).toEqual([
      row("ev-a", "US", "2026-04-22", 1, 20),
    ]);
    expect(aggregateToDailySales(orders, "shopify_intl")).toEqual([
      row("ev-a", "CN", "2026-04-22", 1, 20),
    ]);
  });

  it("falls back to channel default when shippingAddress is present but countryCode is null", () => {
    const orders = [orderShippedTo("2026-04-22T10:00:00Z", [li("ev-a", 1, "20.00")], null)];
    expect(aggregateToDailySales(orders, "shopify_us")).toEqual([
      row("ev-a", "US", "2026-04-22", 1, 20),
    ]);
  });

  it("is case-insensitive on the country code", () => {
    const orders = [orderShippedTo("2026-04-22T10:00:00Z", [li("ev-a", 1, "20.00")], "us")];
    expect(aggregateToDailySales(orders, "shopify_us")).toEqual([
      row("ev-a", "US", "2026-04-22", 1, 20),
    ]);
  });
});
