import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, gte, lte, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { looxProducts, looxReviews } from "@/lib/db/schema";
import { runLooxApiSync } from "@/lib/jobs/loox-api-sync";
import { looxConfigured, runLooxChat } from "@/lib/jobs/loox-chat";
import { runLooxIngest } from "@/lib/jobs/loox-ingest";
import { resolveBoughtSizes, type SizeSource } from "@/lib/queries/review-sizes";
import { opsProcedure, reviewsProcedure, router } from "@/lib/trpc/server";

// Loox reviews tool, v2 (Scott 2026-07-13). Reviews from both stores land
// deduped in loox_reviews; everything here groups them by the display name
// in loox_products (handle-mapped, falling back to the raw product title
// for email rows), splits Std vs Heavy, and serves the KPI table, the
// per-product feed, and the on-demand Claude chat. All KPIs are plain SQL —
// deterministic, free, no model involved. Ops-tier like the rest of the
// dashboards; the review feed names customers, so it stays off the
// marketer-scoped tiers until Scott says otherwise.

const dateRange = z.object({
  // YYYY-MM-DD, inclusive; `to` is treated as end-of-day UTC.
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  // Loox moderation filter. Per Scott 2026-07-15 the tool shows ALL
  // reviews (the UI no longer exposes this filter; enum kept for API compat).
  status: z.enum(["published", "pending", "all"]).default("all"),
  // Purchase verification filter (Scott 2026-07-14): `verified` narrows to
  // reviewers whose email actually ordered this product family before the
  // review. Order coverage is full store history since the read_all_orders
  // grant (2026-07-15).
  buyers: z.enum(["all", "verified"]).default("all"),
});

export type LooxStatusFilter = z.infer<typeof dateRange>["status"];

// Email-fallback rows have no status and count as published.
export function statusCond(status: LooxStatusFilter) {
  if (status === "published")
    return or(eq(looxReviews.status, "published"), sql`${looxReviews.status} is null`);
  if (status === "pending") return eq(looxReviews.status, "pending");
  return undefined; // 'all' — drizzle's and() drops undefined conditions
}
const reviewedAt = sql`coalesce(${looxReviews.reviewedAt}, ${looxReviews.receivedAt})`;
const groupName = sql<string>`coalesce(${looxProducts.displayName}, ${looxReviews.productTitle}, 'Unknown product')`;
// The same base product exists in Std and Heavy variants with the same
// display name, so every grouping and lookup keys on (name, line) pairs.
const groupLine = sql<string>`coalesce(${looxProducts.line}, 'std')`;
const included = sql`coalesce(${looxProducts.include}, true)`;

function rangeConds(input: { from?: string; to?: string; buyers?: "all" | "verified" }) {
  // ISO strings, not Date objects: inside a raw sql`` fragment the driver
  // can't infer the param type and refuses to serialize a Date.
  const conds = [];
  if (input.from) conds.push(gte(reviewedAt, `${input.from}T00:00:00.000Z`));
  if (input.to) conds.push(lte(reviewedAt, `${input.to}T23:59:59.999Z`));
  if (input.buyers === "verified") conds.push(eq(looxReviews.purchaseVerified, "verified"));
  return conds;
}

export const reviewsRouter = router({
  overview: reviewsProcedure.input(dateRange).query(async ({ input }) => {
    const products = await db
      .select({
        displayName: groupName,
        line: groupLine,
        n: sql<number>`count(*)::int`,
        avgRating: sql<string | null>`round(avg(${looxReviews.rating})::numeric, 2)`,
        r5: sql<number>`count(*) filter (where ${looxReviews.rating} = 5)::int`,
        r4: sql<number>`count(*) filter (where ${looxReviews.rating} = 4)::int`,
        r3: sql<number>`count(*) filter (where ${looxReviews.rating} = 3)::int`,
        r2: sql<number>`count(*) filter (where ${looxReviews.rating} = 2)::int`,
        r1: sql<number>`count(*) filter (where ${looxReviews.rating} = 1)::int`,
        latestReviewAt: sql<Date | null>`max(${reviewedAt})`,
      })
      .from(looxReviews)
      .leftJoin(looxProducts, eq(looxProducts.handle, looxReviews.productHandle))
      .where(
        and(eq(looxReviews.parsed, true), statusCond(input.status), included, ...rangeConds(input)),
      )
      .groupBy(groupName, groupLine)
      .orderBy(desc(sql`count(*)`));

    const [unparsedRow] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(looxReviews)
      .where(eq(looxReviews.parsed, false));

    const [lastSync] = await db
      .select({ at: sql<Date | null>`max(${looxReviews.createdAt})` })
      .from(looxReviews)
      .where(eq(looxReviews.source, "api"));

    return {
      products,
      unparsedCount: unparsedRow?.n ?? 0,
      lastSyncAt: lastSync?.at ?? null,
      configured: looxConfigured(),
    };
  }),

  product: reviewsProcedure
    .input(
      dateRange.extend({
        displayName: z.string().min(1).max(300),
        line: z.enum(["std", "heavy"]).default("std"),
        page: z.number().int().min(1).default(1),
      }),
    )
    .query(async ({ input }) => {
      const PAGE = 100;
      const conds = and(
        eq(looxReviews.parsed, true),
        statusCond(input.status),
        sql`${groupName} = ${input.displayName}`,
        sql`${groupLine} = ${input.line}`,
        ...rangeConds(input),
      );

      const rows = await db
        .select({
          id: looxReviews.id,
          reviewedAt: sql<Date>`${reviewedAt}`,
          rating: looxReviews.rating,
          reviewerName: looxReviews.reviewerName,
          reviewText: looxReviews.reviewText,
          verified: looxReviews.verified,
          purchaseVerified: looxReviews.purchaseVerified,
          store: looxReviews.store,
          source: looxReviews.source,
          // Server-side only, for the size lookups below — stripped before
          // the rows leave the procedure.
          looxOrderId: looxReviews.looxOrderId,
        })
        .from(looxReviews)
        .leftJoin(looxProducts, eq(looxProducts.handle, looxReviews.productHandle))
        .where(conds)
        .orderBy(desc(reviewedAt))
        .limit(PAGE)
        .offset((input.page - 1) * PAGE);

      // Size-per-review (Scott 2026-07-23): what size did this reviewer
      // buy, and what else have they ordered? Three set-based queries per
      // page keyed on the page's review ids — never one query per review.
      // order_line_sizes may be empty (pre-first-sync); every path below
      // just yields no sizes then. Family membership reuses the exact CTE
      // from verifyReviewPurchases: handle -> display_name -> the product
      // ids seen on that family's reviews.
      const ids = rows.map((r) => r.id);
      // postgres-js via drizzle serializes a JS array param as a record,
      // not a Postgres array, so `= any($1)` breaks — bind each id as its
      // own param in an IN list instead (max 100 per page).
      const idList = sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      );
      const familyCte = sql`
        family as (
          select lp2.display_name, r2.product_id
          from loox_products lp2
          join loox_reviews r2 on r2.product_handle = lp2.handle
          where r2.product_id is not null
          group by 1, 2
        )`;

      // (a) EXACT — reviews Loox linked to an order: every line of that
      // order, flagged whether its product id is in the review's family
      // (resolveBoughtSizes prefers family lines, falls back to all —
      // a bundle listing might not be in the family map).
      const exactRows =
        ids.length === 0
          ? []
          : ((await db.execute(sql`
              with ${familyCte}
              select r.id::text as review_id, ols.variant_title,
                bool_or(exists (
                  select 1 from loox_products lp
                  join family f on f.display_name = lp.display_name
                  where lp.handle = r.product_handle
                    and f.product_id = ols.product_id
                )) as in_family
              from loox_reviews r
              join order_line_sizes ols on ols.shopify_order_id = r.loox_order_id
              where r.id in (${idList})
              group by r.id, ols.variant_title`)) as unknown as Array<{
              review_id: string;
              variant_title: string;
              in_family: boolean;
            }>);

      // (b) FALLBACK — unlinked reviews with an email: distinct family
      // sizes that email bought on/before the review date, newest first
      // (resolveBoughtSizes caps the list).
      const historyRows =
        ids.length === 0
          ? []
          : ((await db.execute(sql`
              with ${familyCte}
              select r.id::text as review_id, ols.variant_title
              from loox_reviews r
              join loox_products lp on lp.handle = r.product_handle
              join family f on f.display_name = lp.display_name
              join order_line_sizes ols
                on ols.product_id = f.product_id
               and ols.email = lower(r.reviewer_email)
               and (r.store is null or ols.store = r.store)
              where r.id in (${idList})
                and r.loox_order_id is null
                and r.reviewer_email is not null
                and ols.order_date <= coalesce(r.reviewed_at, r.received_at)::date
              group by r.id, ols.variant_title
              order by r.id, max(ols.order_date) desc`)) as unknown as Array<{
              review_id: string;
              variant_title: string;
            }>);

      // The reviewer's other purchase lines (any product, same store when
      // known, excluding the review's own order), newest first, 8 per
      // review via the window rank.
      const pastRows =
        ids.length === 0
          ? []
          : ((await db.execute(sql`
              select review_id, order_date, product_title, variant_title
              from (
                select r.id::text as review_id, ols.order_date::text as order_date,
                  ols.product_title, ols.variant_title,
                  row_number() over (
                    partition by r.id
                    order by ols.order_date desc, ols.product_title nulls last, ols.variant_title
                  ) as rn
                from loox_reviews r
                join order_line_sizes ols
                  on ols.email = lower(r.reviewer_email)
                 and (r.store is null or ols.store = r.store)
                where r.id in (${idList})
                  and r.reviewer_email is not null
                  and ols.order_date <= coalesce(r.reviewed_at, r.received_at)::date
                  and (r.loox_order_id is null or ols.shopify_order_id <> r.loox_order_id)
              ) ranked
              where rn <= 8
              order by review_id, rn`)) as unknown as Array<{
              review_id: string;
              order_date: string;
              product_title: string | null;
              variant_title: string;
            }>);

      const exactByReview = new Map<string, Array<{ variantTitle: string; inFamily: boolean }>>();
      for (const row of exactRows) {
        const list = exactByReview.get(row.review_id) ?? [];
        list.push({ variantTitle: row.variant_title, inFamily: row.in_family });
        exactByReview.set(row.review_id, list);
      }
      const historyByReview = new Map<string, string[]>();
      for (const row of historyRows) {
        const list = historyByReview.get(row.review_id) ?? [];
        list.push(row.variant_title);
        historyByReview.set(row.review_id, list);
      }
      const pastByReview = new Map<
        string,
        Array<{ orderDate: string; productTitle: string | null; variantTitle: string }>
      >();
      for (const row of pastRows) {
        const list = pastByReview.get(row.review_id) ?? [];
        list.push({
          orderDate: row.order_date,
          productTitle: row.product_title,
          variantTitle: row.variant_title,
        });
        pastByReview.set(row.review_id, list);
      }

      const reviews = rows.map(({ looxOrderId, ...rest }) => {
        const { boughtSizes, sizeSource } = resolveBoughtSizes(
          looxOrderId,
          exactByReview.get(rest.id) ?? [],
          historyByReview.get(rest.id) ?? [],
        );
        return {
          ...rest,
          boughtSizes,
          sizeSource: sizeSource as SizeSource,
          pastOrders: pastByReview.get(rest.id) ?? [],
        };
      });

      const [totals] = await db
        .select({
          n: sql<number>`count(*)::int`,
          avgRating: sql<string | null>`round(avg(${looxReviews.rating})::numeric, 2)`,
        })
        .from(looxReviews)
        .leftJoin(looxProducts, eq(looxProducts.handle, looxReviews.productHandle))
        .where(conds);

      return {
        reviews,
        total: totals?.n ?? 0,
        avgRating: totals?.avgRating ?? null,
        page: input.page,
        pageSize: PAGE,
      };
    }),

  chat: reviewsProcedure
    .input(
      dateRange.extend({
        displayName: z.string().min(1).max(300),
        line: z.enum(["std", "heavy"]).default("std"),
        mode: z.enum(["marketing", "product"]),
        messages: z
          .array(
            z.object({
              role: z.enum(["user", "assistant"]),
              content: z.string().min(1).max(20_000),
            }),
          )
          .min(1)
          .max(40),
      }),
    )
    .mutation(async ({ input }) => {
      const result = await runLooxChat({
        displayName: input.displayName,
        line: input.line,
        mode: input.mode,
        status: input.status,
        buyers: input.buyers,
        messages: input.messages,
        from: input.from ? new Date(`${input.from}T00:00:00.000Z`) : undefined,
        to: input.to ? new Date(`${input.to}T23:59:59.999Z`) : undefined,
      });
      if (!result.configured) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Chat is not configured — ANTHROPIC_API_KEY is not set on the server.",
        });
      }
      return result;
    }),

  unparsed: opsProcedure.query(() =>
    db
      .select({
        id: looxReviews.id,
        receivedAt: looxReviews.receivedAt,
        rawText: looxReviews.rawText,
      })
      .from(looxReviews)
      .where(eq(looxReviews.parsed, false))
      .orderBy(desc(looxReviews.receivedAt))
      .limit(50),
  ),

  // Manual "check now" — API sync on both stores, the inbox fallback, then
  // a purchase-verification restamp so fresh reviews get their flag.
  refresh: opsProcedure.mutation(async () => {
    const apiSync = await runLooxApiSync();
    const ingest = await runLooxIngest();
    const { runPurchaseVerification } = await import("@/lib/jobs/shopify-order-emails");
    const purchase = await runPurchaseVerification().catch(() => null);
    return { apiSync, ingest, purchase };
  }),
});
