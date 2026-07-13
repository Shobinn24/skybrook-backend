import { z } from "zod";
import { and, desc, eq, gte, lte, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { looxProducts, looxReviews } from "@/lib/db/schema";
import { runLooxApiSync } from "@/lib/jobs/loox-api-sync";
import { looxConfigured, runLooxChat } from "@/lib/jobs/loox-chat";
import { runLooxIngest } from "@/lib/jobs/loox-ingest";
import { opsProcedure, router } from "@/lib/trpc/server";

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
});

// Published reviews only (email-fallback rows have no status and count).
const published = or(eq(looxReviews.status, "published"), sql`${looxReviews.status} is null`);
const reviewedAt = sql`coalesce(${looxReviews.reviewedAt}, ${looxReviews.receivedAt})`;
const groupName = sql<string>`coalesce(${looxProducts.displayName}, ${looxReviews.productTitle}, 'Unknown product')`;
// The same base product exists in Std and Heavy variants with the same
// display name, so every grouping and lookup keys on (name, line) pairs.
const groupLine = sql<string>`coalesce(${looxProducts.line}, 'std')`;
const included = sql`coalesce(${looxProducts.include}, true)`;

function rangeConds(input: { from?: string; to?: string }) {
  // ISO strings, not Date objects: inside a raw sql`` fragment the driver
  // can't infer the param type and refuses to serialize a Date.
  const conds = [];
  if (input.from) conds.push(gte(reviewedAt, `${input.from}T00:00:00.000Z`));
  if (input.to) conds.push(lte(reviewedAt, `${input.to}T23:59:59.999Z`));
  return conds;
}

export const reviewsRouter = router({
  overview: opsProcedure.input(dateRange).query(async ({ input }) => {
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
      .where(and(eq(looxReviews.parsed, true), published, included, ...rangeConds(input)))
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

  product: opsProcedure
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
        published,
        sql`${groupName} = ${input.displayName}`,
        sql`${groupLine} = ${input.line}`,
        ...rangeConds(input),
      );

      const reviews = await db
        .select({
          id: looxReviews.id,
          reviewedAt: sql<Date>`${reviewedAt}`,
          rating: looxReviews.rating,
          reviewerName: looxReviews.reviewerName,
          reviewText: looxReviews.reviewText,
          verified: looxReviews.verified,
          store: looxReviews.store,
          source: looxReviews.source,
        })
        .from(looxReviews)
        .leftJoin(looxProducts, eq(looxProducts.handle, looxReviews.productHandle))
        .where(conds)
        .orderBy(desc(reviewedAt))
        .limit(PAGE)
        .offset((input.page - 1) * PAGE);

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

  chat: opsProcedure
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
    .mutation(({ input }) =>
      runLooxChat({
        displayName: input.displayName,
        line: input.line,
        mode: input.mode,
        messages: input.messages,
        from: input.from ? new Date(`${input.from}T00:00:00.000Z`) : undefined,
        to: input.to ? new Date(`${input.to}T23:59:59.999Z`) : undefined,
      }),
    ),

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

  // Manual "check now" — API sync on both stores, then the inbox fallback.
  refresh: opsProcedure.mutation(async () => {
    const apiSync = await runLooxApiSync();
    const ingest = await runLooxIngest();
    return { apiSync, ingest };
  }),
});
