import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { orderEmails, orderLineSizes } from "@/lib/db/schema";
import { getShopifyAccessToken } from "@/lib/sources/shopify-auth";
import { logger } from "@/lib/logger";
import { normalizedTitleSql } from "@/lib/queries/product-title-sql";

// Purchase-verification pipeline (Scott 2026-07-14). Two halves:
//
// 1. syncOrderEmails — pulls (buyer email, product id, order date) rows
//    from both Shopify stores into order_emails. Incremental from the
//    newest stored order date minus a 2-day overlap. read_all_orders was
//    granted 2026-07-15, so a fresh/full walk covers complete store
//    history back to the earliest review (2022-05); pass
//    { fullHistory: true } to force that walk.
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
// Predates the earliest review (2022-05-31); nothing older can verify.
const FULL_HISTORY_START = "2022-05-01";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type OrdersPage = {
  data?: {
    orders: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: Array<{
        id: string; // gid://shopify/Order/<numeric>
        email: string | null;
        createdAt: string;
        lineItems: {
          nodes: Array<{
            product: { id: string; title: string | null } | null;
            variantTitle: string | null;
          }>;
        };
      }>;
    };
  };
  errors?: unknown;
};

export type OrderEmailSyncResult = {
  configured: boolean;
  stores: Array<{ store: string; orders: number; inserted: number; error?: string }>;
};

export type OrderSyncOpts = {
  fullHistory?: boolean;
  /** explicit created_at window (yyyy-mm-dd); used by gap backfills so a
   * dropped DB connection costs one slice, not a multi-hour walk */
  from?: string;
  toExclusive?: string;
  /** limit to specific stores (gap windows differ per store) */
  stores?: Array<"main" | "intl">;
};

export async function syncOrderEmails(opts?: OrderSyncOpts): Promise<OrderEmailSyncResult> {
  const results: OrderEmailSyncResult["stores"] = [];
  let anyConfigured = false;
  // ~250k orders live in full history: the page cap must not truncate it.
  const maxPages = opts?.fullHistory || opts?.from ? 4000 : 200;

  for (const s of STORES) {
    if (opts?.stores && !opts.stores.includes(s.label)) continue;
    const domain = process.env[s.env]?.trim();
    if (!domain) continue;
    anyConfigured = true;
    const r = { store: s.label, orders: 0, inserted: 0 } as OrderEmailSyncResult["stores"][number];
    try {
      const [newest] = await db
        .select({ max: sql<string | null>`max(${orderEmails.orderDate})` })
        .from(orderEmails)
        .where(eq(orderEmails.store, s.label));
      const fromStr =
        opts?.from ??
        (opts?.fullHistory || !newest?.max
          ? FULL_HISTORY_START
          : new Date(new Date(newest.max).getTime() - 2 * 24 * 3600 * 1000).toISOString().slice(0, 10));
      const rangeCond = `created_at:>=${fromStr}${opts?.toExclusive ? ` created_at:<${opts.toExclusive}` : ""}`;

      const token = await getShopifyAccessToken(domain);
      let cursor: string | null = null;
      for (let page = 0; page < maxPages; page++) {
        const query = `{ orders(first: 250, query: "${rangeCond}"${cursor ? `, after: "${cursor}"` : ""}) {
          pageInfo { hasNextPage endCursor }
          nodes { id email createdAt lineItems(first: 20) { nodes { product { id title } variantTitle } } } } }`;
        // One slow page must not kill a multi-hour walk: 3 attempts,
        // fresh 60s abort signal each, short backoff (7/15: both stores'
        // first full-history walks died on a single page timeout).
        let resp: OrdersPage | undefined;
        for (let attempt = 1; ; attempt++) {
          try {
            resp = (await fetch(`https://${domain}/admin/api/2025-10/graphql.json`, {
              method: "POST",
              headers: { "content-type": "application/json", "X-Shopify-Access-Token": token },
              body: JSON.stringify({ query }),
              signal: AbortSignal.timeout(60_000),
            }).then((x) => x.json())) as OrdersPage;
            break;
          } catch (err) {
            if (attempt >= 3) throw err;
            logger.warn("order_emails.page_retry", { store: s.label, page, attempt });
            await sleep(5_000 * attempt);
          }
        }
        if (!resp.data) throw new Error(`orders query failed: ${JSON.stringify(resp.errors).slice(0, 200)}`);

        const rows: Array<{ store: string; email: string; productId: string; orderDate: string }> = [];
        // Variant grain for size-per-review + purchase history (2026-07-23):
        // same walk, second table. Kept separate so order_emails' dedup
        // grain stays untouched. Orders WITHOUT an email still land here —
        // the exact-order path (loox_order_id) does not need one.
        const lineRows: Array<{
          store: string;
          shopifyOrderId: string;
          email: string | null;
          productId: string;
          productTitle: string | null;
          variantTitle: string;
          orderDate: string;
        }> = [];
        for (const o of resp.data.orders.nodes) {
          r.orders += 1;
          const email = o.email?.trim().toLowerCase() || null;
          const orderDate = o.createdAt.slice(0, 10);
          // gid://shopify/Order/6191776623847 -> 6191776623847
          const shopifyOrderId = o.id.split("/").pop()!;
          for (const li of o.lineItems.nodes) {
            const gid = li.product?.id;
            if (!gid) continue;
            // gid://shopify/Product/8258900983882 -> 8258900983882
            const productId = gid.split("/").pop()!;
            if (email) rows.push({ store: s.label, email, productId, orderDate });
            const variantTitle = li.variantTitle?.trim();
            if (variantTitle) {
              lineRows.push({
                store: s.label,
                shopifyOrderId,
                email,
                productId,
                productTitle: li.product?.title?.trim() || null,
                variantTitle,
                orderDate,
              });
            }
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
        if (lineRows.length > 0) {
          await db.insert(orderLineSizes).values(lineRows).onConflictDoNothing();
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

  // 'verified', strongest signal first:
  //   1. The review carries the Shopify order id Loox recorded when it
  //      sent the review request, and that order exists in our order
  //      history — direct review->order proof, no email needed.
  //   2. An order_emails row with the same email whose product id belongs
  //      to the review's display-name family (any listing of the same
  //      product counts — bundles, packs, renames), on/before the review.
  //      Family membership goes review.handle -> display_name -> all
  //      handles -> all product ids seen on those handles' reviews.
  //   3. Same-email order line whose TITLE normalizes to the family's
  //      display name — catches listings that never received a review
  //      (their product ids are absent from the review-derived family).
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
      when r.loox_order_id is not null and exists (
        select 1 from order_line_sizes ols
        where ols.shopify_order_id = r.loox_order_id
          and (r.store is null or ols.store = r.store)
      ) then 'verified'
      when r.reviewer_email is null then 'unknown'
      when coalesce(r.reviewed_at, r.received_at) < ${coverageFloor}::timestamptz then 'unknown'
      when exists (
        select 1 from order_emails oe
        join loox_products lp on lp.handle = r.product_handle
        join family f on f.display_name = lp.display_name and f.product_id = oe.product_id
        where oe.email = lower(r.reviewer_email)
          and oe.order_date <= coalesce(r.reviewed_at, r.received_at)::date
      ) then 'verified'
      when exists (
        select 1 from order_line_sizes ols
        join loox_products lp on lp.handle = r.product_handle
        where ols.email = lower(r.reviewer_email)
          and (r.store is null or ols.store = r.store)
          and ols.order_date <= coalesce(r.reviewed_at, r.received_at)::date
          and ols.product_title is not null
          and ${normalizedTitleSql(sql`ols.product_title`)} = lower(btrim(lp.display_name))
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
export async function runPurchaseVerification(opts?: { fullHistory?: boolean }): Promise<{
  sync: OrderEmailSyncResult;
  verify: VerifyResult;
}> {
  const syncResult = await syncOrderEmails(opts);
  const verify = syncResult.configured
    ? await verifyReviewPurchases()
    : { verified: 0, unverified: 0, unknown: 0 };
  return { sync: syncResult, verify };
}
