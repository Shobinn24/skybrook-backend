import { createHash } from "node:crypto";
import { and, eq, gte, like, lte, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { dailySales } from "@/lib/db/schema";
import type { SourceRunner } from "@/lib/jobs/ingest";
import { decomposePackSku, PACK_SKU_DB_PATTERNS } from "@/lib/domain/sku-pack";
import { getShopifyAccessToken } from "@/lib/sources/shopify-auth";
import { toEstDate } from "@/lib/tz";
import { routeOrder, type Location } from "@/lib/domain/warehouse-routing";

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
  // Per-unit price AFTER both line-item AND order-level discounts.
  // Scott 2026-05-07: switched from `discountedUnitPriceSet` (line-only)
  // to `discountedUnitPriceAfterAllDiscountsSet` after diagnostic showed
  // the previous field counted manual $0 draft orders + site-wide promo
  // codes at full retail. ~$2,200/30d over-count on US store alone.
  discountedUnitPriceAfterAllDiscountsSet: { shopMoney: { amount: string } } | null;
};

type MoneySet = { shopMoney: { amount: string } } | null;

type OrderNode = {
  createdAt: string;
  lineItems: { nodes: LineItemNode[] };
  // Order-level ancillary amounts pro-rated to SKUs (Scott 2026-05-07).
  // Optional in the type so existing test fixtures and any minimal
  // OrderNode constructions still typecheck — null/missing → $0 ancillary,
  // which preserves prior per-line-item-only semantics.
  totalTaxSet?: MoneySet;
  totalShippingPriceSet?: MoneySet;
  totalTipReceivedSet?: MoneySet;
  // ISO-3166 alpha-2 country code from the order's shipping address
  // (Scott 2026-05-12). Used to route US-store orders that shipped
  // outside the US into the CN warehouse bucket. Optional because
  // legacy / minimal OrderNode test fixtures may omit it — missing or
  // null falls back to the store's default routing (US store → US,
  // INTL store → CN) via `routeOrder`.
  shippingAddress?: { countryCode: string | null } | null;
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
  // Warehouse the order shipped from. Derived from (channel, ship-to
  // country) via `routeOrder`. US-store orders with non-US ship-to
  // get bucketed as "CN" so per-warehouse velocity reflects what
  // actually leaves each warehouse (Scott 2026-05-12).
  routedLocation: Location;
  salesDate: string; // YYYY-MM-DD in EST (matches Shopify's created_at filter)
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
                  discountedUnitPriceAfterAllDiscountsSet { shopMoney { amount } }
                }
              }
              totalTaxSet { shopMoney { amount } }
              totalShippingPriceSet { shopMoney { amount } }
              totalTipReceivedSet { shopMoney { amount } }
              shippingAddress { countryCode }
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
 * Scott 2026-05-07: include tax + shipping + tips in revenue, pro-rated
 * to tracked SKUs by line-item revenue share within the order. Matches
 * Shopify's "Total sales" column semantics, which is what the daily-
 * report agency pulls. When line-item revenue is 0 (e.g., promo orders
 * with all line items free but a real shipping charge), ancillary is
 * split evenly across tracked SKUs in the order.
 *
 * Null SKUs (gift cards, custom items without variants) are skipped —
 * they don't map to our inventory-tracked catalog. Ancillary is
 * pro-rated only across tracked SKUs (post-`ev-*` filter), which means
 * a small fraction of tax on mixed orders containing a gift card is
 * effectively allocated to the tracked SKUs rather than dropped.
 *
 * Per-line revenue uses `discountedUnitPriceAfterAllDiscountsSet.shopMoney.amount`
 * × quantity. This field captures BOTH line-item and order-level
 * discounts, so manual $0 draft orders and site-wide promo codes track
 * at the actual paid amount instead of full retail.
 * Shop currency is USD on both stores (verified live 2026-04-24), so
 * shopMoney is directly comparable across channels.
 */
export function aggregateToDailySales(
  orders: OrderNode[],
  channel: Channel,
): ShopifyDailySale[] {
  const agg = new Map<string, { units: number; net: number }>();
  for (const order of orders) {
    // Bucket by EST calendar date — matches Shopify's `created_at:>=YYYY-MM-DD`
    // filter (which Shopify interprets in shop timezone) and aligns with
    // the rest of Skybrook's reporting cadence (10am-ET cron, EST as_of
    // dates, Scott's velocity sheet). Pre-fix this used createdAt UTC date,
    // which split orders near the EST midnight boundary into different
    // buckets than the live Shopify filter pulled — root cause of the
    // persistent ~$695 May-6 INTL DB-vs-live divergence (issue #6).
    const day = toEstDate(new Date(order.createdAt)); // YYYY-MM-DD in EST

    // Resolve ship-to country → warehouse. Default to the store's
    // implied location when the shippingAddress is missing or has no
    // country code (digital-only / pickup orders, vault-tokenized
    // legacy orders). Matches `routeOrder` semantics: US store → US,
    // INTL store → CN, but US store + non-US ship-to → CN.
    const shipToCountry = order.shippingAddress?.countryCode ?? "";
    const routedLocation: Location = routeOrder({
      channel,
      shipToCountry,
    });

    // Pass 1: collect tracked SKU rows for this order. We need the full
    // set before allocating ancillary because share = lineNet / orderRev.
    type Tracked = { skuKey: string; units: number; lineNet: number };
    const tracked: Tracked[] = [];
    let orderTrackedRev = 0;
    for (const li of order.lineItems.nodes) {
      if (!li.sku) continue; // skip gift cards / custom items
      if (!Number.isFinite(li.quantity) || li.quantity <= 0) continue;

      // Lowercase first — Shopify mixes cases (`EV-hw-l` vs `ev-hw-l`)
      // for the same product, and Postgres `=` is case-sensitive, so
      // mixed-case rows wouldn't match the lowercase skus catalog.
      const skuLower = li.sku.toLowerCase();
      // Skip non-inventory SKUs. Inventory follows the `ev-*` convention;
      // anything else is a digital good, gift card, sample, or one-off
      // (e.g. `7-ways-ebook-1` — Scott 2026-04-29: "Ignore this"). These
      // would otherwise show up as orphanSalesSkus on every audit.
      if (!skuLower.startsWith("ev-")) continue;
      // Pack-SKU normalization: 10-pack and 15-pack SKUs come out of
      // 5-pack inventory. Multiply units by the pack factor and key
      // the row under the canonical 5-pack SKU. Per-line revenue stays
      // at the actual order amount (no multiplier).
      const decomposed = decomposePackSku(skuLower);
      const skuKey = decomposed?.canonicalSku ?? skuLower;
      const unitsContributed = li.quantity * (decomposed?.multiplier ?? 1);

      const unitPrice = li.discountedUnitPriceAfterAllDiscountsSet?.shopMoney?.amount;
      const priceNum = unitPrice != null ? Number(unitPrice) : 0;
      const lineNet = Number.isFinite(priceNum) ? priceNum * li.quantity : 0;
      tracked.push({ skuKey, units: unitsContributed, lineNet });
      orderTrackedRev += lineNet;
    }

    if (tracked.length === 0) continue;

    // Pass 2: pro-rate ancillary across tracked rows.
    const ancillary =
      parseMoneyAmount(order.totalTaxSet) +
      parseMoneyAmount(order.totalShippingPriceSet) +
      parseMoneyAmount(order.totalTipReceivedSet);
    for (const t of tracked) {
      let share: number;
      if (orderTrackedRev > 0) {
        share = t.lineNet / orderTrackedRev;
      } else {
        // All tracked lines are $0 (e.g., entirely-free promo with paid
        // shipping). Even-split keeps the ancillary $ on the books
        // instead of dropping it.
        share = 1 / tracked.length;
      }
      const itemTotal = t.lineNet + share * ancillary;
      const key = `${t.skuKey}|${day}|${routedLocation}`;
      const prev = agg.get(key) ?? { units: 0, net: 0 };
      prev.units += t.units;
      prev.net += itemTotal;
      agg.set(key, prev);
    }
  }
  const out: ShopifyDailySale[] = [];
  for (const [key, { units, net }] of agg) {
    const [sku, salesDate, routedLocation] = key.split("|");
    out.push({
      sku,
      routedLocation: routedLocation as Location,
      salesDate,
      unitsSold: units,
      netSalesUsd: Number(net.toFixed(4)),
    });
  }
  // Deterministic ordering for snapshot-friendliness and easier diffs.
  out.sort((a, b) => {
    if (a.salesDate !== b.salesDate) return a.salesDate.localeCompare(b.salesDate);
    if (a.routedLocation !== b.routedLocation)
      return a.routedLocation.localeCompare(b.routedLocation);
    return a.sku.localeCompare(b.sku);
  });
  return out;
}

function parseMoneyAmount(set: MoneySet | undefined): number {
  const amount = set?.shopMoney?.amount;
  if (amount == null) return 0;
  const n = Number(amount);
  return Number.isFinite(n) ? n : 0;
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
    const sales = aggregateToDailySales(allOrders, channel);

    // Stable fingerprint reflects the QUERY SHAPE — channel + API
    // version + entity. The since/today window is intentionally NOT
    // mixed in: we want the fingerprint to stay constant across daily
    // pulls so schema-drift detection in /pipeline can flag genuine
    // changes (channel rename, API version bump) instead of false-
    // positiving every day.
    const fingerprint = createHash("sha256")
      .update(`${channel}|${API_VERSION}|orders`)
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
        // Delete-and-replace inside a transaction over the cron's date
        // window. Replaces the previous upsert pattern, which left rows
        // from prior aggregation logic untouched whenever a SKU's
        // canonical key changed (the upsert key never matched, so old
        // rows persisted forever). Concrete bug it fixes: the EST-vs-UTC
        // bucketing migration would otherwise leave UTC-bucketed rows
        // alongside the new EST-bucketed rows for the same orders.
        //
        // Atomic: if the insert fails, the existing data stays. Idempotent
        // on re-runs — subsequent runs delete the rows they just wrote and
        // re-insert identical values.
        await db.transaction(async (tx) => {
          await tx
            .delete(dailySales)
            .where(
              and(
                eq(dailySales.channel, channel),
                gte(dailySales.salesDate, since),
                lte(dailySales.salesDate, today),
              ),
            );
          if (sales.length > 0) {
            // Chunk inserts to stay under Postgres' MAX_PARAMETERS limit
            // (65,534 per parameterized statement). daily_sales has 6
            // columns per row, so the single-shot insert blew up at
            // ~10,920 rows. shopify_us crossed that threshold on
            // 2026-05-10 (~12,800 rows for the trailing-N-day window),
            // and the entire normalize transaction rolled back, so
            // /performance under-reported US revenue for 2 days.
            // 1,000-row chunks = 6,000 params, well under the cap with
            // room for future schema growth.
            const CHUNK = 1000;
            const rows = sales.map((s) => ({
              channel,
              routedLocation: s.routedLocation,
              sku: s.sku,
              salesDate: s.salesDate,
              unitsSold: s.unitsSold,
              netSalesUsd: String(s.netSalesUsd),
              sourcePullId: rawId,
            }));
            for (let i = 0; i < rows.length; i += CHUNK) {
              await tx.insert(dailySales).values(rows.slice(i, i + CHUNK));
            }
          }
        });
        // Belt-and-suspenders purge of legacy rows OUTSIDE the cron's
        // window (e.g. salesDate < since) that earlier ingests may have
        // written under aggregation rules that no longer apply:
        //   - mixed-case SKUs       (now lowercased at aggregation)
        //   - non-`ev-` SKUs        (now skipped at aggregation — gift
        //                            cards, ebooks, custom items)
        //   - 10/15-pack rows       (now decomposed to 5x form)
        //   - mens/cb 6/9/12-pack   (now decomposed to 3x form)
        //   - hw bare-size 5x rows  (now collapsed to ev-hw-{size})
        // Idempotent — subsequent runs match nothing.
        await db.delete(dailySales).where(
          and(
            eq(dailySales.channel, channel),
            or(
              sql`${dailySales.sku} <> LOWER(${dailySales.sku})`,
              sql`${dailySales.sku} NOT LIKE 'ev-%'`,
              // Bare-size HW 5x rows: ev-hw-5x-{single-segment-size}.
              // Excludes ev-hw-5x-black-l etc. (those keep their pack
              // token because colored 5-packs are separate inventory).
              sql`${dailySales.sku} ~ '^ev-hw-5x-[^-]+$'`,
              ...PACK_SKU_DB_PATTERNS.map((p) => like(dailySales.sku, p))
            )!
          )
        );
      },
    };
  };
}

export const shopifyUsRunner: SourceRunner = makeRunner("shopify_us");
export const shopifyIntlRunner: SourceRunner = makeRunner("shopify_intl");
