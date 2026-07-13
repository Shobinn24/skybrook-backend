import Anthropic from "@anthropic-ai/sdk";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { looxReviewAnalyses, looxReviews } from "@/lib/db/schema";
import { logger } from "@/lib/logger";

// Claude analysis over each product's Loox reviews (Scott 2026-07-13: "use
// claude to analyze the reviews and display the analysis and some KPIs. I do
// this manually"). Runs per product, only when new reviews landed since the
// product's last analysis, so cost scales with review volume (fractions of a
// cent per run) and re-running the cron is free when nothing changed.
//
// KPIs (count / average rating) are computed in SQL and frozen onto the
// analysis row; Claude only does what SQL can't — themes, complaints,
// improvement ideas, quotes. Dormant without ANTHROPIC_API_KEY.

export const LOOX_ANALYSIS_MODEL = "claude-opus-4-8";

export type LooxAnalysis = {
  summary: string;
  themes: string[];
  complaints: string[];
  improvement_ideas: string[];
  standout_quotes: string[];
};

// Injectable for tests: (system, user) -> raw model text.
export type AnalysisTransport = (system: string, user: string) => Promise<string>;

function defaultTransport(): AnalysisTransport | null {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) return null;
  const client = new Anthropic({ apiKey: key });
  return async (system, user) => {
    const msg = await client.messages.create({
      model: LOOX_ANALYSIS_MODEL,
      max_tokens: 2000,
      thinking: { type: "adaptive" },
      system,
      messages: [{ role: "user", content: user }],
    });
    return msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");
  };
}

const SYSTEM = `You analyze customer reviews for a leakproof underwear brand's
newly launched products. You receive every review for ONE product. Reply with
ONLY a JSON object (no markdown fence, no prose) with exactly these keys:
"summary" (2-3 plain sentences on how the product is landing),
"themes" (3-6 short strings, most-mentioned aspects, positive or negative),
"complaints" (0-5 short strings, concrete recurring problems; empty if none),
"improvement_ideas" (0-5 short strings, actionable product/marketing ideas
grounded in what reviewers actually said — never invent),
"standout_quotes" (0-3 verbatim short quotes worth reading).
Be specific and concrete. If reviews conflict, say so in the summary.`;

function extractJson(raw: string): LooxAnalysis | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const obj = JSON.parse(match[0]);
    const arr = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 6) : [];
    if (typeof obj.summary !== "string") return null;
    return {
      summary: obj.summary,
      themes: arr(obj.themes),
      complaints: arr(obj.complaints),
      improvement_ideas: arr(obj.improvement_ideas),
      standout_quotes: arr(obj.standout_quotes),
    };
  } catch {
    return null;
  }
}

export type LooxAnalysisResult = {
  configured: boolean;
  productsAnalyzed: number;
  productsSkipped: number;
  errors: string[];
};

export async function runLooxAnalysis(opts?: {
  transport?: AnalysisTransport;
}): Promise<LooxAnalysisResult> {
  const transport = opts?.transport ?? defaultTransport();
  if (!transport) {
    return { configured: false, productsAnalyzed: 0, productsSkipped: 0, errors: [] };
  }

  // Products with parsed reviews, plus their latest analysis timestamp.
  const products = await db
    .select({
      productTitle: looxReviews.productTitle,
      reviewCount: sql<number>`count(*)::int`,
      avgRating: sql<string>`round(avg(${looxReviews.rating})::numeric, 2)`,
      newestReview: sql<string>`max(${looxReviews.createdAt})`,
    })
    .from(looxReviews)
    .where(and(isNotNull(looxReviews.productTitle), eq(looxReviews.parsed, true)))
    .groupBy(looxReviews.productTitle);

  let productsAnalyzed = 0;
  let productsSkipped = 0;
  const errors: string[] = [];

  for (const p of products) {
    if (!p.productTitle) continue;
    const latest = await db
      .select({ generatedAt: looxReviewAnalyses.generatedAt })
      .from(looxReviewAnalyses)
      .where(eq(looxReviewAnalyses.productTitle, p.productTitle))
      .orderBy(desc(looxReviewAnalyses.generatedAt))
      .limit(1);
    // raw-sql max() arrives as a string — compare as Dates or the >= is NaN
    if (latest[0] && latest[0].generatedAt >= new Date(p.newestReview)) {
      productsSkipped += 1;
      continue; // nothing new since the last analysis
    }

    const reviews = await db
      .select({
        rating: looxReviews.rating,
        reviewerName: looxReviews.reviewerName,
        reviewText: looxReviews.reviewText,
        receivedAt: looxReviews.receivedAt,
      })
      .from(looxReviews)
      .where(and(eq(looxReviews.productTitle, p.productTitle), eq(looxReviews.parsed, true)))
      .orderBy(desc(looxReviews.receivedAt))
      .limit(200);

    const user =
      `Product: ${p.productTitle}\n` +
      `Reviews (newest first, ${reviews.length} of ${p.reviewCount}):\n\n` +
      reviews
        .map(
          (r, i) =>
            `${i + 1}. [${r.rating ?? "?"}/5] ${r.reviewerName ?? "anonymous"} (${r.receivedAt.toISOString().slice(0, 10)}): ${r.reviewText ?? "(no text)"}`,
        )
        .join("\n");

    try {
      const raw = await transport(SYSTEM, user);
      const analysis = extractJson(raw);
      if (!analysis) {
        errors.push(`${p.productTitle}: model returned unparseable analysis`);
        continue;
      }
      await db.insert(looxReviewAnalyses).values({
        productTitle: p.productTitle,
        reviewCount: p.reviewCount,
        avgRating: p.avgRating,
        analysis,
        model: LOOX_ANALYSIS_MODEL,
      });
      productsAnalyzed += 1;
    } catch (e) {
      errors.push(`${p.productTitle}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  logger.info("loox.analysis.done", { productsAnalyzed, productsSkipped, errors: errors.length });
  return { configured: true, productsAnalyzed, productsSkipped, errors };
}

// Used by the freshness/readiness surfaces: is the pipeline configured?
export function looxConfigured(): { imap: boolean; anthropic: boolean } {
  return {
    imap: !!(process.env.LOOX_IMAP_USER?.trim() && process.env.LOOX_IMAP_PASSWORD?.trim()),
    anthropic: !!process.env.ANTHROPIC_API_KEY?.trim(),
  };
}

