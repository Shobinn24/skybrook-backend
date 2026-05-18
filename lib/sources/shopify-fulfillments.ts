/**
 * Shopify orders iterator for the Shipping Performance checks.
 *
 * Different field set than `lib/sources/shopify.ts` (which pulls only
 * what's needed to aggregate daily_sales). Here we need:
 *   - fulfillment status + cancellation/refund/test flags so we can
 *     filter scope per spec §3.3
 *   - shipping country to scope to US orders
 *   - line items (sku, quantity) for the OOS-join exclusion
 *   - full fulfillment objects (createdAt, deliveredAt, events) to
 *     compute SLA + transit-time + the stats panel
 *
 * Reuses the token-mint logic from `shopify-auth.ts`. Pulls from the
 * US store only (the spec's scope is US-only fulfilment SLA — the INTL
 * store has separate logistics and would need a different SLA rule).
 *
 * Spec: docs/shipping-checks-spec/ops-shipping-checks-spec.md
 */

import { getShopifyAccessToken } from "@/lib/sources/shopify-auth";

const API_VERSION = "2025-01";
const ORDERS_PAGE_SIZE = 50;
const LINE_ITEMS_PER_ORDER = 50;
// Throttle backoff: when Shopify says <2000 points remain, sleep
// briefly so we don't burn the bucket on a chain of 429s.
const THROTTLE_MIN_HEADROOM = 2000;
const THROTTLE_SLEEP_MS = 3000;
const MAX_THROTTLE_RETRIES = 6;

export type FulfilmentLineItem = {
  sku: string | null;
  name: string | null;
  quantity: number;
  fulfillableQuantity: number;
};

export type FulfilmentEvent = {
  status: string;
  happenedAt: string;
};

export type FulfilmentRecord = {
  createdAt: string;
  deliveredAt: string | null;
  inTransitAt: string | null;
  status: string;
  trackingInfo: Array<{
    number: string | null;
    company: string | null;
    url: string | null;
  }>;
  events: FulfilmentEvent[];
};

export type OrderRecord = {
  id: string;
  name: string;
  createdAt: string;
  cancelledAt: string | null;
  test: boolean;
  displayFinancialStatus: string;
  displayFulfillmentStatus: string;
  shippingAddress: {
    countryCodeV2: string | null;
    provinceCode: string | null;
  } | null;
  // Customer display name surfaces in the flag table when populated.
  // The "Ops Internal Tool" app currently lacks `read_customers`
  // scope, so we always pass null today. If Scott / Jasper enable the
  // scope, restore the GraphQL selection below.
  customer: { displayName: string | null } | null;
  lineItems: FulfilmentLineItem[];
  fulfillments: FulfilmentRecord[];
};

type GraphQLResponse = {
  data?: {
    orders?: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: OrderRecord[];
    };
  };
  errors?: Array<{ message: string }>;
  extensions?: {
    cost?: { throttleStatus?: { currentlyAvailable: number } };
  };
};

const ORDERS_QUERY = `
  query ShippingOrders($cursor: String, $q: String!) {
    orders(first: ${ORDERS_PAGE_SIZE}, after: $cursor, query: $q, sortKey: CREATED_AT) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        name
        createdAt
        cancelledAt
        test
        displayFinancialStatus
        displayFulfillmentStatus
        shippingAddress { countryCodeV2 provinceCode }
        lineItems(first: ${LINE_ITEMS_PER_ORDER}) {
          nodes { sku name quantity fulfillableQuantity }
        }
        fulfillments {
          createdAt
          deliveredAt
          inTransitAt
          status
          trackingInfo { number company url }
          events(first: 50, sortKey: HAPPENED_AT) {
            edges { node { status happenedAt } }
          }
        }
      }
    }
  }
`;

type RawOrder = Omit<OrderRecord, "lineItems" | "fulfillments" | "customer"> & {
  lineItems: { nodes: FulfilmentLineItem[] };
  fulfillments: Array<
    Omit<FulfilmentRecord, "events"> & {
      events: { edges: Array<{ node: FulfilmentEvent }> };
    }
  >;
};

function flatten(o: RawOrder): OrderRecord {
  return {
    ...o,
    // Customer is not selected in the GraphQL query today (Ops Internal
    // Tool app is missing `read_customers` scope). Populate as null so
    // downstream code that touches `customer.displayName` still works.
    customer: null,
    lineItems: o.lineItems.nodes,
    fulfillments: o.fulfillments.map((f) => ({
      ...f,
      events: f.events.edges.map((e) => e.node),
    })),
  };
}

/**
 * Pull all US-store orders with `createdAt >= since` (ISO 8601 with
 * timezone offset). Returns a flat array — for a 30-35d window this is
 * a few thousand orders at most, comfortably in-memory.
 *
 * Caller is expected to pass the cutoff in store-local TZ so the
 * Shopify search picks the right calendar boundary. Example for ET:
 *   sinceIso = "2026-04-13T00:00:00-04:00"
 */
export async function fetchOrdersSince(opts: {
  store: string;
  sinceIso: string;
}): Promise<OrderRecord[]> {
  const token = await getShopifyAccessToken(opts.store);
  const url = `https://${opts.store}/admin/api/${API_VERSION}/graphql.json`;
  const filterQuery = `created_at:>='${opts.sinceIso}' status:any`;

  const out: OrderRecord[] = [];
  let cursor: string | null = null;

  while (true) {
    let json: GraphQLResponse | null = null;
    for (let attempt = 0; attempt < MAX_THROTTLE_RETRIES; attempt++) {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: ORDERS_QUERY,
          variables: { cursor, q: filterQuery },
        }),
      });

      if (res.status === 429) {
        // Exponential backoff: 2s, 4s, 8s, …
        await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
        continue;
      }
      if (!res.ok) {
        throw new Error(
          `shopify ${opts.store}: HTTP ${res.status} ${await res.text()}`,
        );
      }
      json = (await res.json()) as GraphQLResponse;

      if (json.errors?.length) {
        const throttled = json.errors.some((e) =>
          /THROTTLED/i.test(e.message),
        );
        if (throttled && attempt < MAX_THROTTLE_RETRIES - 1) {
          await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
          continue;
        }
        throw new Error(
          `shopify ${opts.store}: ${json.errors.map((e) => e.message).join("; ")}`,
        );
      }
      break;
    }

    const page = json?.data?.orders;
    if (!page) {
      throw new Error(`shopify ${opts.store}: empty orders response`);
    }

    for (const node of page.nodes) {
      out.push(flatten(node as unknown as RawOrder));
    }

    if (!page.pageInfo.hasNextPage) break;
    cursor = page.pageInfo.endCursor;

    const available =
      json?.extensions?.cost?.throttleStatus?.currentlyAvailable ?? Infinity;
    if (available < THROTTLE_MIN_HEADROOM) {
      await new Promise((r) => setTimeout(r, THROTTLE_SLEEP_MS));
    }
  }

  return out;
}

/**
 * Walks fulfillment events for the first `status == "DELIVERED"`. Used
 * as a fallback when Shopify's top-level `deliveredAt` field is null —
 * some carriers report delivery via events without populating
 * `deliveredAt` directly.
 */
export function findDeliveredAt(f: FulfilmentRecord): string | null {
  if (f.deliveredAt) return f.deliveredAt;
  for (const e of f.events) {
    if (e.status.toUpperCase() === "DELIVERED") return e.happenedAt;
  }
  return null;
}
