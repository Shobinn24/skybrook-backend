export type Channel = "shopify_us" | "shopify_intl";
export type Location = "US" | "CN";

/**
 * Resolve which warehouse an order ships from.
 *
 * Primary signal is the order's `shipToCountry` (ISO-3166 alpha-2):
 *   - "US"               → US warehouse (Paradise)
 *   - any other country  → CN warehouse (Antwerp)
 *
 * When the ship-to country is missing or unknown — digital-only orders,
 * pickup orders, vault-tokenized legacy orders without a stored shipping
 * address — fall back to the CHANNEL's default warehouse:
 *   - shopify_us   → US  (the US store ships overwhelmingly to US)
 *   - shopify_intl → CN  (the INTL store is 100% non-US by design)
 *
 * This fallback matches the pre-2026-05-12 `channelToLocation` heuristic
 * so removing-or-adding the ship-to signal doesn't shift historical
 * routing for orders where the field is genuinely absent.
 */
export function routeOrder(input: {
  channel: Channel;
  shipToCountry: string | null | undefined;
}): Location {
  // INTL store is 100% non-US by design — no US warehouse leakage even
  // if a stray order comes through with a US ship-to. The split-by-
  // ship-to logic only matters on the US store.
  if (input.channel === "shopify_intl") return "CN";

  const country = (input.shipToCountry ?? "").trim().toUpperCase();
  if (country === "US") return "US";
  if (country.length > 0) return "CN";
  // Country missing on US store → fall back to US (matches the prior
  // `channelToLocation('shopify_us') = US` heuristic for digital /
  // pickup / vault-tokenized orders without a shipping address).
  return "US";
}
