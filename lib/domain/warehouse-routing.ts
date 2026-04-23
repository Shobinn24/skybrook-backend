export type Channel = "shopify_us" | "shopify_intl";
export type Location = "US" | "CN";

export function routeOrder(input: {
  channel: Channel;
  shipToCountry: string;
}): Location {
  return input.shipToCountry.trim().toUpperCase() === "US" ? "US" : "CN";
}
