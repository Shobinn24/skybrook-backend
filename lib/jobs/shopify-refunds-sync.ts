import { eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { shopifyRefundLines } from "@/lib/db/schema";
import { getShopifyAccessToken } from "@/lib/sources/shopify-auth";
import { logger } from "@/lib/logger";
import { labelFromProductTitle, sizeFromVariantTitle } from "@/lib/sizing/mapper";

// Refund lines straight from Shopify refund objects (Scott 2026-07-16:
// the API beats the CS sheet, and a refund is a refund regardless of
// which button CS pressed — the refund-vs-cancel labeling ambiguity
// disappears). Refund-id grain: re-seeing a refund replaces its rows,
// so both the backfill and the daily incremental are idempotent.
//
// Refunds hang off ORDERS. The backfill ranges over order-CREATED
// months; the daily cron ranges over order-UPDATED days (a new refund
// updates its order), so late refunds on old orders are still caught.

const STORES: Array<{ label: "main" | "intl"; env: string }> = [
  { label: "main", env: "SHOPIFY_US_STORE" },
  { label: "intl", env: "SHOPIFY_INTL_STORE" },
];
const PAGE_DELAY_MS = 250;
// 2026-only analysis (Scott 2026-07-16); refunds before this are ignored.
export const REFUNDS_SINCE = "2026-01-01";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type OrdersPage = {
  data?: {
    orders: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: Array<{
        refunds: Array<{
          id: string;
          createdAt: string;
          refundLineItems: {
            nodes: Array<{
              quantity: number;
              subtotalSet: { shopMoney: { amount: string } } | null;
              lineItem: {
                title: string;
                variantTitle: string | null;
                product: { title: string } | null;
              } | null;
            }>;
          };
        }>;
      }>;
    };
  };
  errors?: unknown;
};

export type RefundsSyncResult = {
  store: string;
  query: string;
  orders: number;
  refunds: number;
  lines: number;
  error?: string;
};

async function walkOrders(
  storeLabel: "main" | "intl",
  orderQuery: string,
): Promise<RefundsSyncResult> {
  const r: RefundsSyncResult = { store: storeLabel, query: orderQuery, orders: 0, refunds: 0, lines: 0 };
  const domain = process.env[STORES.find((s) => s.label === storeLabel)!.env]?.trim();
  if (!domain) {
    r.error = "store not configured";
    return r;
  }

  try {
    const token = await getShopifyAccessToken(domain);
    let cursor: string | null = null;

    for (let page = 0; page < 4000; page++) {
      const query = `{ orders(first: 250, query: "${orderQuery}"${cursor ? `, after: "${cursor}"` : ""}) {
        pageInfo { hasNextPage endCursor }
        nodes { refunds {
          id
          createdAt
          refundLineItems(first: 30) { nodes {
            quantity
            subtotalSet { shopMoney { amount } }
            lineItem { title variantTitle product { title } }
          } }
        } } } }`;

      let resp: OrdersPage | null = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          resp = (await fetch(`https://${domain}/admin/api/2025-10/graphql.json`, {
            method: "POST",
            headers: { "content-type": "application/json", "X-Shopify-Access-Token": token },
            body: JSON.stringify({ query }),
            signal: AbortSignal.timeout(45_000),
          }).then((x) => x.json())) as OrdersPage;
          if (resp.data) break;
          throw new Error(`no data: ${JSON.stringify(resp.errors).slice(0, 150)}`);
        } catch (e) {
          if (attempt === 3) throw e;
          await sleep(2000 * attempt);
        }
      }
      if (!resp?.data) throw new Error("orders query failed after retries");

      // rows for this page, grouped by refund id so replacement is exact
      const byRefund = new Map<string, (typeof shopifyRefundLines.$inferInsert)[]>();
      for (const o of resp.data.orders.nodes) {
        r.orders += 1;
        for (const refund of o.refunds ?? []) {
          const refundDate = refund.createdAt.slice(0, 10);
          if (refundDate < REFUNDS_SINCE) continue;
          r.refunds += 1;
          const acc = new Map<string, { units: number; amount: number }>();
          for (const li of refund.refundLineItems?.nodes ?? []) {
            const item = li.lineItem;
            if (!item) continue;
            const label = labelFromProductTitle(item.product?.title ?? item.title);
            if (!label) continue;
            const size = (item.variantTitle ? sizeFromVariantTitle(item.variantTitle) : null) ?? "";
            const key = `${label}|${size}`;
            const cur = acc.get(key) ?? { units: 0, amount: 0 };
            cur.units += li.quantity ?? 0;
            cur.amount += parseFloat(li.subtotalSet?.shopMoney?.amount ?? "0") || 0;
            acc.set(key, cur);
          }
          byRefund.set(
            refund.id,
            [...acc.entries()].map(([key, v]) => {
              const [label, size] = key.split("|");
              return {
                refundId: refund.id,
                store: storeLabel,
                refundDate,
                label,
                size,
                units: v.units,
                amountUsd: v.amount.toFixed(2),
              };
            }),
          );
        }
      }

      const refundIds = [...byRefund.keys()];
      const rows = [...byRefund.values()].flat();
      if (refundIds.length > 0) {
        await db.transaction(async (tx) => {
          await tx.delete(shopifyRefundLines).where(inArray(shopifyRefundLines.refundId, refundIds));
          if (rows.length > 0) await tx.insert(shopifyRefundLines).values(rows);
        });
        r.lines += rows.length;
      }

      if (!resp.data.orders.pageInfo.hasNextPage) break;
      cursor = resp.data.orders.pageInfo.endCursor;
      await sleep(PAGE_DELAY_MS);
    }
  } catch (e) {
    r.error = e instanceof Error ? e.message.slice(0, 200) : String(e);
    logger.error("shopify_refunds.walk_failed", { ...r });
  }

  logger.info("shopify_refunds.walk.done", { ...r });
  return r;
}

/** Backfill: orders CREATED in [from, to) — used by the one-shot script. */
export async function syncShopifyRefundsWindow(
  storeLabel: "main" | "intl",
  from: string,
  to: string,
): Promise<RefundsSyncResult> {
  return walkOrders(storeLabel, `created_at:>=${from} created_at:<${to}`);
}

/** Cron: orders UPDATED in the last 3 days catch every new/edited refund. */
export async function syncShopifyRefundsRecent(): Promise<RefundsSyncResult[]> {
  const since = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const out: RefundsSyncResult[] = [];
  for (const s of STORES) {
    if (!process.env[s.env]?.trim()) continue;
    out.push(await walkOrders(s.label, `updated_at:>=${since}`));
  }
  return out;
}
