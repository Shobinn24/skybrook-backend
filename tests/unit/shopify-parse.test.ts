import { describe, it, expect } from "vitest";
import { parseDailySales } from "@/lib/sources/shopify";

describe("parseDailySales", () => {
  it("maps ShopifyQL TableResponse rows into daily sales entries", () => {
    const tr = {
      data: {
        shopifyqlQuery: {
          __typename: "TableResponse" as const,
          tableData: {
            columns: [
              { name: "product_variant_sku" },
              { name: "day" },
              { name: "units_sold" },
              { name: "net_sales" },
            ],
            rowData: [
              ["ev-bshort-5x-m", "2026-04-22", 27, 540.5],
              ["ev-bshort-5x-l", "2026-04-22", 33, 660.25],
            ],
          },
        },
      },
    };

    const result = parseDailySales(tr);
    expect(result).toEqual([
      { sku: "ev-bshort-5x-m", salesDate: "2026-04-22", unitsSold: 27, netSalesUsd: 540.5 },
      { sku: "ev-bshort-5x-l", salesDate: "2026-04-22", unitsSold: 33, netSalesUsd: 660.25 },
    ]);
  });

  it("handles alternate column names (variant_sku / net_items_sold / total_sales)", () => {
    const tr = {
      data: {
        shopifyqlQuery: {
          __typename: "TableResponse" as const,
          tableData: {
            columns: [
              { name: "variant_sku" },
              { name: "day" },
              { name: "net_items_sold" },
              { name: "total_sales" },
            ],
            rowData: [["ev-a", "2026-04-22", "7", "100"]],
          },
        },
      },
    };
    expect(parseDailySales(tr)).toEqual([
      { sku: "ev-a", salesDate: "2026-04-22", unitsSold: 7, netSalesUsd: 100 },
    ]);
  });

  it("throws a meaningful error on ParseError response", () => {
    const tr = {
      data: {
        shopifyqlQuery: {
          __typename: "ParseError" as const,
          parseErrors: [{ message: "unknown column: foo" }],
        },
      },
    };
    expect(() => parseDailySales(tr)).toThrow(/unknown column: foo/);
  });

  it("throws when required columns are missing", () => {
    const tr = {
      data: {
        shopifyqlQuery: {
          __typename: "TableResponse" as const,
          tableData: {
            columns: [{ name: "day" }, { name: "total_sales" }],
            rowData: [["2026-04-22", 100]],
          },
        },
      },
    };
    expect(() => parseDailySales(tr)).toThrow(/missing expected columns/);
  });

  it("skips rows with missing sku or non-finite units", () => {
    const tr = {
      data: {
        shopifyqlQuery: {
          __typename: "TableResponse" as const,
          tableData: {
            columns: [
              { name: "product_variant_sku" },
              { name: "day" },
              { name: "units_sold" },
              { name: "net_sales" },
            ],
            rowData: [
              ["", "2026-04-22", 5, 100],
              ["ev-b", "2026-04-22", "NaN", 0],
              ["ev-c", "2026-04-22", 3, 60],
            ],
          },
        },
      },
    };
    expect(parseDailySales(tr)).toEqual([
      { sku: "ev-c", salesDate: "2026-04-22", unitsSold: 3, netSalesUsd: 60 },
    ]);
  });
});
