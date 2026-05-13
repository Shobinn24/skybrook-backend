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

  // Missing/blank ship-to country falls back to the channel default —
  // shopify_us → US, shopify_intl → CN. Matches the pre-2026-05-12
  // `channelToLocation` heuristic so legacy orders without a stored
  // shipping address (digital/pickup/vault-tokenized) keep their prior
  // routing. Empirically zero prod rows hit this path in the trailing
  // 73d after the c00c77e ship-to-country fix; the rule exists for
  // defensive completeness, not for any real volume.
  it("falls back to the channel default for blank or missing country", () => {
    expect(routeOrder({ channel: "shopify_us", shipToCountry: "" })).toBe("US");
    expect(routeOrder({ channel: "shopify_us", shipToCountry: null })).toBe(
      "US",
    );
    expect(
      routeOrder({ channel: "shopify_us", shipToCountry: undefined }),
    ).toBe("US");
    expect(routeOrder({ channel: "shopify_intl", shipToCountry: "" })).toBe(
      "CN",
    );
    expect(routeOrder({ channel: "shopify_intl", shipToCountry: null })).toBe(
      "CN",
    );
  });

  it("trims whitespace and treats whitespace-only as blank", () => {
    expect(routeOrder({ channel: "shopify_us", shipToCountry: "   " })).toBe(
      "US",
    );
    expect(routeOrder({ channel: "shopify_us", shipToCountry: " US " })).toBe(
      "US",
    );
  });

  it("is case-insensitive for country code", () => {
    expect(routeOrder({ channel: "shopify_us", shipToCountry: "us" })).toBe("US");
  });
});
