// Live E2E smoke: pull the last 7 days of orders from INTL and aggregate
// to daily sales. Verifies pagination + aggregation against real data
// without touching the DB. Run: npx tsx scripts/smoke-shopify-orders.ts

import "dotenv/config";
import { getShopifyAccessToken } from "../lib/sources/shopify-auth";
import { aggregateToDailySales } from "../lib/sources/shopify";

const API_VERSION = "2025-01";

// Re-declared locally (iterateOrderPages is module-private in shopify.ts).
// Same query shape as the production runner.
async function* iterateOrderPages(store: string, token: string, since: string, until: string) {
  const url = `https://${store}/admin/api/${API_VERSION}/graphql.json`;
  let cursor: string | null = null;
  const q = `created_at:>=${since} created_at:<=${until}`;

  while (true) {
    const body = {
      query: `
        query($cursor: String, $q: String!) {
          orders(first: 250, after: $cursor, query: $q, sortKey: CREATED_AT) {
            pageInfo { hasNextPage endCursor }
            nodes {
              createdAt
              lineItems(first: 50) {
                nodes {
                  sku
                  quantity
                  discountedUnitPriceSet { shopMoney { amount } }
                }
              }
            }
          }
        }
      `,
      variables: { cursor, q },
    };
    const res = await fetch(url, {
      method: "POST",
      headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as {
      data?: { orders?: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: unknown[] } };
      errors?: { message: string }[];
      extensions?: { cost?: { throttleStatus?: { currentlyAvailable: number } } };
    };
    if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join("; "));
    const page = json.data?.orders;
    if (!page) throw new Error("empty orders response");
    const available = json.extensions?.cost?.throttleStatus?.currentlyAvailable ?? Infinity;
    yield { nodes: page.nodes as Parameters<typeof aggregateToDailySales>[0], available };
    if (!page.pageInfo.hasNextPage) break;
    cursor = page.pageInfo.endCursor;
  }
}

async function main() {
  const store = process.env.SHOPIFY_INTL_STORE;
  if (!store) throw new Error("SHOPIFY_INTL_STORE missing");

  const until = new Date().toISOString().slice(0, 10);
  const sinceDate = new Date(Date.now() - 7 * 86400_000);
  const since = sinceDate.toISOString().slice(0, 10);

  console.log(`→ ${store}  window: ${since} → ${until}`);
  const token = await getShopifyAccessToken(store);

  const allOrders: Parameters<typeof aggregateToDailySales>[0] = [];
  let pages = 0;
  let lastAvailable = 0;
  const t0 = Date.now();
  for await (const { nodes, available } of iterateOrderPages(store, token, since, until)) {
    allOrders.push(...nodes);
    pages++;
    lastAvailable = available;
    process.stdout.write(`  page ${pages}: ${nodes.length} orders (bucket: ${available})\n`);
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n✓ Fetched ${allOrders.length} orders across ${pages} page(s) in ${elapsed}s`);
  console.log(`  throttle bucket at end: ${lastAvailable}`);

  const rows = aggregateToDailySales(allOrders);
  console.log(`✓ Aggregated to ${rows.length} (sku × day) rows`);

  // Top 10 SKUs by units
  const bySku = new Map<string, { units: number; net: number }>();
  for (const r of rows) {
    const prev = bySku.get(r.sku) ?? { units: 0, net: 0 };
    prev.units += r.unitsSold;
    prev.net += r.netSalesUsd;
    bySku.set(r.sku, prev);
  }
  const top = [...bySku.entries()].sort((a, b) => b[1].units - a[1].units).slice(0, 10);
  console.log("\n  top 10 SKUs (7d):");
  for (const [sku, { units, net }] of top) {
    console.log(`    ${units.toString().padStart(6)}  $${net.toFixed(2).padStart(10)}  ${sku}`);
  }

  // Per-day totals
  const byDay = new Map<string, { units: number; net: number }>();
  for (const r of rows) {
    const prev = byDay.get(r.salesDate) ?? { units: 0, net: 0 };
    prev.units += r.unitsSold;
    prev.net += r.netSalesUsd;
    byDay.set(r.salesDate, prev);
  }
  console.log("\n  per-day totals:");
  for (const [day, { units, net }] of [...byDay.entries()].sort()) {
    console.log(`    ${day}  ${units.toString().padStart(6)} units   $${net.toFixed(2)}`);
  }
}

main().catch((e) => {
  console.error("smoke failed:", e);
  process.exit(1);
});
