import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { variantSalesMonthly } from "@/lib/db/schema";
import { getShopifyAccessToken } from "@/lib/sources/shopify-auth";
import { logger } from "@/lib/logger";
import { labelFromProductTitle, sizeFromVariantTitle } from "@/lib/sizing/mapper";

// Units sold per product label × size × month, from Shopify order line
// items — the denominator for sales-weighted exchange rates (and refund
// rates) in the sizing analysis. currentQuantity approximates the manual
// export's "Net items sold" (it drops removed/refunded items).
//
// Ranged windows + page retries: one hung page killed two 2-hour walks
// on 2026-07-15; every long Shopify walk since is sliced and retried.

const STORES: Array<{ label: "main" | "intl"; env: string }> = [
  { label: "main", env: "SHOPIFY_US_STORE" },
  { label: "intl", env: "SHOPIFY_INTL_STORE" },
];
const PAGE_DELAY_MS = 250;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type OrdersPage = {
  data?: {
    orders: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: Array<{
        createdAt: string;
        lineItems: {
          nodes: Array<{
            title: string;
            variantTitle: string | null;
            currentQuantity: number;
            quantity: number;
            product: { title: string } | null;
          }>;
        };
      }>;
    };
  };
  errors?: unknown;
};

export type VariantSalesSyncResult = {
  store: string;
  from: string;
  to: string;
  orders: number;
  cells: number;
  error?: string;
};

/**
 * Walk one store's orders in [from, to) and upsert label×size×month
 * unit counts. Cells for months inside the window are recomputed from
 * scratch (accumulated in memory, then upserted with an overwrite), so
 * re-running a window is idempotent.
 */
export async function syncVariantSales(
  storeLabel: "main" | "intl",
  from: string,
  to: string,
): Promise<VariantSalesSyncResult> {
  const r: VariantSalesSyncResult = { store: storeLabel, from, to, orders: 0, cells: 0 };
  const domain = process.env[STORES.find((s) => s.label === storeLabel)!.env]?.trim();
  if (!domain) {
    r.error = "store not configured";
    return r;
  }

  try {
    const token = await getShopifyAccessToken(domain);
    // label|size|month -> units
    const acc = new Map<string, number>();
    let cursor: string | null = null;

    for (let page = 0; page < 4000; page++) {
      const query = `{ orders(first: 250, query: "created_at:>=${from} created_at:<${to}"${cursor ? `, after: "${cursor}"` : ""}) {
        pageInfo { hasNextPage endCursor }
        nodes { createdAt lineItems(first: 30) { nodes { title variantTitle currentQuantity quantity product { title } } } } } }`;

      // Page-level retries — transient hangs/502s must not kill the walk.
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

      for (const o of resp.data.orders.nodes) {
        r.orders += 1;
        const month = `${o.createdAt.slice(0, 7)}-01`;
        for (const li of o.lineItems.nodes) {
          const label = labelFromProductTitle(li.product?.title ?? li.title);
          if (!label) continue;
          const size = li.variantTitle ? sizeFromVariantTitle(li.variantTitle) : null;
          if (!size) continue;
          const units = li.currentQuantity ?? li.quantity ?? 0;
          if (units <= 0) continue;
          const key = `${label}|${size}|${month}`;
          acc.set(key, (acc.get(key) ?? 0) + units);
        }
      }
      if (!resp.data.orders.pageInfo.hasNextPage) break;
      cursor = resp.data.orders.pageInfo.endCursor;
      await sleep(PAGE_DELAY_MS);
    }

    const rows = [...acc.entries()].map(([key, units]) => {
      const [label, size, month] = key.split("|");
      return { store: storeLabel, label, size, month, units };
    });
    r.cells = rows.length;

    for (let i = 0; i < rows.length; i += 1000) {
      const batch = rows.slice(i, i + 1000);
      await db
        .insert(variantSalesMonthly)
        .values(batch)
        .onConflictDoUpdate({
          target: [
            variantSalesMonthly.store,
            variantSalesMonthly.month,
            variantSalesMonthly.label,
            variantSalesMonthly.size,
          ],
          set: { units: sql`excluded.units`, updatedAt: sql`now()` },
        });
    }
  } catch (e) {
    r.error = e instanceof Error ? e.message.slice(0, 200) : String(e);
    logger.error("variant_sales.window_failed", { ...r });
  }

  logger.info("variant_sales.window.done", { ...r });
  return r;
}

/** Cron entry: refresh the current and previous month for both stores. */
export async function syncVariantSalesRecent(): Promise<VariantSalesSyncResult[]> {
  const now = new Date();
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const prevMonth = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, "0")}-01`;
  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const to = `${nextMonth.getFullYear()}-${String(nextMonth.getMonth() + 1).padStart(2, "0")}-01`;

  const out: VariantSalesSyncResult[] = [];
  for (const s of STORES) {
    if (!process.env[s.env]?.trim()) continue;
    out.push(await syncVariantSales(s.label, prevMonth, to));
  }
  return out;
}
