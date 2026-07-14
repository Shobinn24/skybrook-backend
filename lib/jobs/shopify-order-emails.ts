import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { orderEmails } from "@/lib/db/schema";
import { getShopifyAccessToken } from "@/lib/sources/shopify-auth";
import { logger } from "@/lib/logger";

// Purchase-verification pipeline (Scott 2026-07-14). Two halves:
//
// 1. syncOrderEmails — pulls (buyer email, product id, order date) rows
//    from both Shopify stores into order_emails. Incremental from the
//    newest stored order date minus a 2-day overlap; the first run walks
//    the full ~60 days the standard read_orders scope allows. Deeper
//    history needs a read_all_orders grant from Shopify.
//
// 2. verifyReviewPurchases — stamps loox_reviews.purchase_verified:
//    'verified' when the reviewer's email ordered the SAME PRODUCT FAMILY
//    (any listing whose handle maps to the review's display name — bundle
//    and pack listings count) on or before the review date; 'unverified'
//    when order coverage exists for the review's date but no matching
//    purchase; 'unknown' when the review predates coverage or has no
//    email. Pilot result that motivated this: 0 of 5 reviews on the
//    just-launched cotton product came from a cotton buyer.

const STORES: Array<{ label: "main" | "intl"; env: string }> = [
  { label: "main", env: "SHOPIFY_US_STORE" },
  { label: "intl", env: "SHOPIFY_INTL_STORE" },
];
const PAGE_DELAY_MS = 300;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type OrdersPage = {
  data?: {
    orders: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: Array<{
        email: string | null;
        createdAt: string;
        lineItems: { nodes: Array<{ product: { id: string } | null }> };
      }>;
    };
  };
  errors?: unknown;
};

export type OrderEmailSyncResult = {
  configured: boolean;
  stores: Array<{ store: string; orders: number; inserted: number; error?: string }>;
};

export async function syncOrderEmails(): Promise<OrderEmailSyncResult> {
  const results: OrderEmailSyncResult["stores"] = [];
  let anyConfigured = false;

  for (const s of STORES) {
    const domain = process.env[s.env]?.trim();
    if (!domain) continue;
    anyConfigured = true;
    const r = { store: s.label, orders: 0, inserted: 0 } as OrderEmailSyncResult["stores"][number];
    try {
      const [newest] = await db
        .select({ max: sql<string | null>`max(${orderEmails.orderDate})` })
        .from(orderEmails)
        .where(eq(orderEmails.store, s.label));
      const from = newest?.max
        ? new Date(new Date(newest.max).getTime() - 2 * 24 * 3600 * 1000)
        : new Date(Date.now() - 59 * 24 * 3600 * 1000);
      const fromStr = from.toISOString().slice(0, 10);

      const token = await getShopifyAccessToken(domain);
      let cursor: string | null = null;
      for (let page = 0; page < 200; page++) {
        const query = `{ orders(first: 250, query: "created_at:>=${fromStr}"${cursor ? `, after: "${cursor}"` : ""}) {
          pageInfo { hasNextPage endCursor }
          nodes { email createdAt lineItems(first: 20) { nodes { product { id } } } } } }`;
        const resp = (await fetch(`https://${domain}/admin/api/2025-10/graphql.json`, {
          method: "POST",
          headers: { "content-type": "application/json", "X-Shopify-Access-Token": token },
          body: JSON.stringify({ query }),
          signal: AbortSignal.timeout(30_000),
        }).then((x) => x.json())) as OrdersPage;
        if (!resp.data) throw new Error(`orders query failed: ${JSON.stringify(resp.errors).slice(0, 200)}`);

        const rows: Array<{ store: string; email: string; productId: string; orderDate: string }> = [];
        for (const o of resp.data.orders.nodes) {
          r.orders += 1;
          const email = o.email?.trim().toLowerCase();
          if (!email) continue;
          const orderDate = o.createdAt.slice(0, 10);
          for (const li of o.lineItems.nodes) {
            const gid = li.product?.id;
            if (!gid) continue;
            // gid://shopify/Product/8258900983882 -> 8258900983882
            const productId = gid.split("/").pop()!;
            rows.push({ store: s.label, email, productId, orderDate });
          }
        }
        if (rows.length > 0) {
          const inserted = await db
            .insert(orderEmails)
            .values(rows)
            .onConflictDoNothing()
            .returning({ id: orderEmails.id });
          r.inserted += inserted.length;
        }
        if (!resp.data.orders.pageInfo.hasNextPage) break;
        cursor = resp.data.orders.pageInfo.endCursor;
        await sleep(PAGE_DELAY_MS);
      }
    } catch (e) {
      r.error = e instanceof Error ? e.message.slice(0, 200) : String(e);
      logger.error("order_emails.store_failed", { store: s.label, error: r.error });
    }
    results.push(r);
  }

  logger.info("order_emails.sync.done", { stores: results });
  return { configured: anyConfigured, stores: results };
}

export type VerifyResult = { verified: number; unverified: number; unknown: number };

export async function verifyReviewPurchases(): Promise<VerifyResult> {
  // Coverage floor: reviews dated before the earliest order we hold can
  // never be checked — they stay 'unknown'. A small buffer avoids edge
  // flapping right at the boundary.
  const [floorRow] = await db
    .select({ min: sql<string | null>`min(${orderEmails.orderDate})` })
    .from(orderEmails);
  if (!floorRow?.min) return { verified: 0, unverified: 0, unknown: 0 };
  const coverageFloor = `${floorRow.min}T00:00:00Z`;

  // 'verified': an order_emails row with the same email, whose product id
  // belongs to the review's display-name family (any listing of the same
  // product counts — bundles, packs, renames), dated on/before the review.
  // Family membership goes review.handle -> display_name -> all handles ->
  // all product ids seen on those handles' reviews.
  const updated = (await db.execute(sql`
    with family as (
      select lp2.display_name, r2.product_id
      from loox_products lp2
      join loox_reviews r2 on r2.product_handle = lp2.handle
      where r2.product_id is not null
      group by 1, 2
    )
    update loox_reviews r
    set purchase_verified = case
      when r.reviewer_email is null then 'unknown'
      when coalesce(r.reviewed_at, r.received_at) < ${coverageFloor}::timestamptz then 'unknown'
      when exists (
        select 1 from order_emails oe
        join loox_products lp on lp.handle = r.product_handle
        join family f on f.display_name = lp.display_name and f.product_id = oe.product_id
        where oe.email = lower(r.reviewer_email)
          and oe.order_date <= coalesce(r.reviewed_at, r.received_at)::date
      ) then 'verified'
      else 'unverified'
    end
    where r.parsed = true
    returning r.purchase_verified`)) as unknown as Array<{ purchase_verified: string }>;

  const out: VerifyResult = { verified: 0, unverified: 0, unknown: 0 };
  for (const row of updated) {
    if (row.purchase_verified === "verified") out.verified += 1;
    else if (row.purchase_verified === "unverified") out.unverified += 1;
    else out.unknown += 1;
  }
  logger.info("order_emails.verify.done", out);
  return out;
}

// One call for the crons: pull fresh orders, then restamp.
export async function runPurchaseVerification(): Promise<{
  sync: OrderEmailSyncResult;
  verify: VerifyResult;
}> {
  const syncResult = await syncOrderEmails();
  const verify = syncResult.configured
    ? await verifyReviewPurchases()
    : { verified: 0, unverified: 0, unknown: 0 };
  return { sync: syncResult, verify };
}
