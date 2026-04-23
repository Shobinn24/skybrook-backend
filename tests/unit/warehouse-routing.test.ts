import { describe, it, expect } from "vitest";
import { routeOrder } from "@/lib/domain/warehouse-routing";

describe("routeOrder", () => {
  it("routes US-destined Shopify orders to US", () => {
    expect(routeOrder({ channel: "shopify_us", shipToCountry: "US" })).toBe("US");
  });

  it("routes non-US orders to CN regardless of store", () => {
    expect(routeOrder({ channel: "shopify_us", shipToCountry: "CA" })).toBe("CN");
    expect(routeOrder({ channel: "shopify_intl", shipToCountry: "GB" })).toBe("CN");
    expect(routeOrder({ channel: "shopify_intl", shipToCountry: "DE" })).toBe("CN");
  });

  it("treats missing or blank country as non-US (defensive)", () => {
    expect(routeOrder({ channel: "shopify_us", shipToCountry: "" })).toBe("CN");
  });

  it("is case-insensitive for country code", () => {
    expect(routeOrder({ channel: "shopify_us", shipToCountry: "us" })).toBe("US");
  });
});
