import { z } from "zod";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { looxReviewAnalyses, looxReviews } from "@/lib/db/schema";
import { runLooxAnalysis, looxConfigured } from "@/lib/jobs/loox-analysis";
import { runLooxIngest } from "@/lib/jobs/loox-ingest";
import { opsProcedure, router } from "@/lib/trpc/server";

// Loox review monitor (Scott 2026-07-13). Ops-tier like the rest of the
// dashboards; the review feed names customers, so it stays off the
// marketer-scoped tiers until Scott says otherwise.
export const reviewsRouter = router({
  overview: opsProcedure.query(async () => {
    const products = await db
      .select({
        productTitle: looxReviews.productTitle,
        reviewCount: sql<number>`count(*)::int`,
        avgRating: sql<string | null>`round(avg(${looxReviews.rating})::numeric, 2)`,
        latestReviewAt: sql<Date>`max(${looxReviews.receivedAt})`,
        recentCount: sql<number>`count(*) filter (where ${looxReviews.receivedAt} > now() - interval '14 days')::int`,
      })
      .from(looxReviews)
      .where(and(isNotNull(looxReviews.productTitle), eq(looxReviews.parsed, true)))
      .groupBy(looxReviews.productTitle)
      .orderBy(desc(sql`max(${looxReviews.receivedAt})`));

    const [unparsedRow] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(looxReviews)
      .where(eq(looxReviews.parsed, false));

    return {
      products,
      unparsedCount: unparsedRow?.n ?? 0,
      configured: looxConfigured(),
    };
  }),

  product: opsProcedure
    .input(z.object({ productTitle: z.string().min(1).max(200) }))
    .query(async ({ input }) => {
      const reviews = await db
        .select({
          id: looxReviews.id,
          receivedAt: looxReviews.receivedAt,
          rating: looxReviews.rating,
          reviewerName: looxReviews.reviewerName,
          reviewText: looxReviews.reviewText,
        })
        .from(looxReviews)
        .where(
          and(
            eq(looxReviews.productTitle, input.productTitle),
            eq(looxReviews.parsed, true),
          ),
        )
        .orderBy(desc(looxReviews.receivedAt))
        .limit(300);

      const [analysis] = await db
        .select()
        .from(looxReviewAnalyses)
        .where(eq(looxReviewAnalyses.productTitle, input.productTitle))
        .orderBy(desc(looxReviewAnalyses.generatedAt))
        .limit(1);

      return { reviews, analysis: analysis ?? null };
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

  // Manual "check now" — pulls the inbox and re-analyzes anything new.
  refresh: opsProcedure.mutation(async () => {
    const ingest = await runLooxIngest();
    const analysis = ingest.configured ? await runLooxAnalysis() : null;
    return { ingest, analysis };
  }),
});
