import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { dailySales } from "@/lib/db/schema";
import type { SourceRunner } from "@/lib/jobs/ingest";
import { getShopifyAccessToken } from "@/lib/sources/shopify-auth";

// Shopify Admin GraphQL API version — bump when needed.
const API_VERSION = "2025-01";

// Orders pulled per page. Shopify caps `orders(first:)` at 250.
const ORDERS_PAGE_SIZE = 250;
// Line items pulled per order. Most Everdries orders have 1-5 lines;
// 50 is generous headroom. Orders with >50 line items are vanishingly
// rare in this catalog; if one shows up it'll truncate silently, which
// is acceptable for the velocity signal we're computing.
const LINE_ITEMS_PER_ORDER = 50;
// Throttle backoff: if Shopify says <2000 points remain after a page,
// sleep until the bucket recovers enough for the next page (at 1000/s
// restore on Plus, ~3s for another 3000 points headroom).
const THROTTLE_MIN_HEADROOM = 2000;
const THROTTLE_SLEEP_MS = 3000;

type Channel = "shopify_us" | "shopify_intl";

type LineItemNode = {
  sku: string | null;
  quantity: number;
  discountedUnitPriceSet: { shopMoney: { amount: string } } | null;
};

type OrderNode = {
  createdAt: string;
  lineItems: { nodes: LineItemNode[] };
};

type OrdersPageResponse = {
  data?: {
    orders?: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: OrderNode[];
    };
  };
  errors?: { message: string }[];
  extensions?: {
    cost?: {
      throttleStatus?: { currentlyAvailable: number };
    };
  };
};

export type ShopifyDailySale = {
  sku: string;
  salesDate: string; // YYYY-MM-DD (UTC slice of order createdAt)
  unitsSold: number;
  netSalesUsd: number;
};

/**
 * Paginate through every order in [since, until]. Yields one page (array
 * of orders) at a time so callers can aggregate incrementally instead of
 * buffering the full backfill in memory. Handles throttle backoff when
 * Shopify's cost bucket runs low.
 *
 * Scope required: `read_orders`. Default window is 60 days; backfills
 * deeper than that need `read_all_orders` (Shopify approval required).
 */
async function* iterateOrderPages(
  store: string,
  token: string,
  since: string,
  until: string,
): AsyncGenerator<OrderNode[]> {
  const url = `https://${store}/admin/api/${API_VERSION}/graphql.json`;
  let cursor: string | null = null;
  // created_at filter uses Shopify's native query syntax. Inclusive on
  // both ends; UNTIL is whole-day so callers pass tomorrow to include
  // today, or just today to include up-to-midnight UTC.
  const filterQuery = `created_at:>=${since} created_at:<=${until}`;

  while (true) {
    const body = {
      query: `
        query($cursor: String, $q: String!) {
          orders(first: ${ORDERS_PAGE_SIZE}, after: $cursor, query: $q, sortKey: CREATED_AT) {
            pageInfo { hasNextPage endCursor }
            nodes {
              createdAt
              lineItems(first: ${LINE_ITEMS_PER_ORDER}) {
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
      variables: { cursor, q: filterQuery },
    };

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`shopify ${store}: HTTP ${res.status} ${await res.text()}`);
    }

    const json = (await res.json()) as OrdersPageResponse;
    if (json.errors?.length) {
      throw new Error(`shopify ${store}: ${json.errors.map((e) => e.message).join("; ")}`);
    }
    const page = json.data?.orders;
    if (!page) throw new Error(`shopify ${store}: empty orders response`);

    yield page.nodes;

    if (!page.pageInfo.hasNextPage) break;
    cursor = page.pageInfo.endCursor;

    // Back off if the query-cost bucket is running low. Better to wait
    // 3s than get throttled and spend retry budget on 429s.
    const available = json.extensions?.cost?.throttleStatus?.currentlyAvailable ?? Infinity;
    if (available < THROTTLE_MIN_HEADROOM) {
      await new Promise((r) => setTimeout(r, THROTTLE_SLEEP_MS));
    }
  }
}

/**
 * Collapse an orders stream into (sku, day) → {units, net} tuples.
 *
 * Scott 2026-04-23: cancelled + refunded orders both count as sales.
 * We sum raw `lineItem.quantity` and don't filter by order.displayFinancialStatus,
 * matching the old ShopifyQL `units_sold` semantics exactly.
 *
 * Null SKUs (gift cards, custom items without variants) are skipped —
 * they don't map to our inventory-tracked catalog.
 *
 * Net sales uses `discountedUnitPriceSet.shopMoney.amount` × quantity.
 * Shop currency is USD on both stores (verified live 2026-04-24), so
 * shopMoney is directly comparable across channels.
 */
export function aggregateToDailySales(orders: OrderNode[]): ShopifyDailySale[] {
  const agg = new Map<string, { units: number; net: number }>();
  for (const order of orders) {
    const day = order.createdAt.slice(0, 10); // YYYY-MM-DD
    for (const li of order.lineItems.nodes) {
      if (!li.sku) continue; // skip gift cards / custom items
      if (!Number.isFinite(li.quantity) || li.quantity <= 0) continue;
      const unitPrice = li.discountedUnitPriceSet?.shopMoney?.amount;
      const priceNum = unitPrice != null ? Number(unitPrice) : 0;
      const net = Number.isFinite(priceNum) ? priceNum * li.quantity : 0;
      const key = `${li.sku}|${day}`;
      const prev = agg.get(key) ?? { units: 0, net: 0 };
      prev.units += li.quantity;
      prev.net += net;
      agg.set(key, prev);
    }
  }
  const out: ShopifyDailySale[] = [];
  for (const [key, { units, net }] of agg) {
    const [sku, salesDate] = key.split("|");
    out.push({ sku, salesDate, unitsSold: units, netSalesUsd: Number(net.toFixed(4)) });
  }
  // Deterministic ordering for snapshot-friendliness and easier diffs.
  out.sort((a, b) =>
    a.salesDate === b.salesDate ? a.sku.localeCompare(b.sku) : a.salesDate.localeCompare(b.salesDate),
  );
  return out;
}

function makeRunner(channel: Channel): SourceRunner {
  return async (_batchId) => {
    const store =
      channel === "shopify_us" ? process.env.SHOPIFY_US_STORE : process.env.SHOPIFY_INTL_STORE;
    if (!store) throw new Error(`${channel}: missing store URL`);

    // Per-store OAuth access token (24h TTL, fetched + cached on demand).
    // SHOPIFY_API_KEY + SHOPIFY_API_SECRET are read inside getShopifyAccessToken.
    const token = await getShopifyAccessToken(store);

    // Backfill from 2026-03-01 per SPEC §13. Until = today (UTC).
    // read_orders default window is 60 days, which as of 2026-04-24 still
    // covers 2026-03-01 comfortably. If the backfill start ever needs to
    // go earlier than 60 days back, we'd need read_all_orders granted.
    const today = new Date().toISOString().slice(0, 10);
    const since = "2026-03-01";

    // Stream pagination → single flat order list → aggregate.
    const allOrders: OrderNode[] = [];
    let pageCount = 0;
    for await (const page of iterateOrderPages(store, token, since, today)) {
      allOrders.push(...page);
      pageCount++;
    }
    const sales = aggregateToDailySales(allOrders);

    // Stable fingerprint reflects the query shape — not order contents —
    // so the same shop/window produces the same fingerprint across runs.
    const fingerprint = createHash("sha256")
      .update(`${channel}|${API_VERSION}|orders|${since}|${today}`)
      .digest("hex")
      .slice(0, 16);

    // Raw payload for the rawPulls table: the aggregated rows plus meta,
    // not the full orders stream (would bloat the table on big backfills).
    const rawPayload = {
      channel,
      store,
      since,
      until: today,
      apiVersion: API_VERSION,
      pagesFetched: pageCount,
      orderCount: allOrders.length,
      aggregatedRows: sales.length,
      rows: sales,
    };

    return {
      ok: true,
      rowCount: sales.length,
      rawPayload,
      schemaFingerprint: fingerprint,
      async normalize(rawId) {
        for (const s of sales) {
          await db
            .insert(dailySales)
            .values({
              channel,
              sku: s.sku,
              salesDate: s.salesDate,
              unitsSold: s.unitsSold,
              netSalesUsd: String(s.netSalesUsd),
              sourcePullId: rawId,
            })
            .onConflictDoUpdate({
              target: [dailySales.channel, dailySales.sku, dailySales.salesDate],
              set: {
                unitsSold: sql`excluded.units_sold`,
                netSalesUsd: sql`excluded.net_sales_usd`,
                sourcePullId: rawId,
              },
            });
        }
      },
    };
  };
}

export const shopifyUsRunner: SourceRunner = makeRunner("shopify_us");
export const shopifyIntlRunner: SourceRunner = makeRunner("shopify_intl");
