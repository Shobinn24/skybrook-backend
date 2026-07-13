import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { like } from "drizzle-orm";
import { db } from "@/lib/db";
import { looxReviewAnalyses, looxReviews } from "@/lib/db/schema";
import { runLooxAnalysis, type LooxAnalysis } from "@/lib/jobs/loox-analysis";
import "dotenv/config";

// Analysis over seeded reviews with a FAKE transport — no API key, no
// network. Rows carry the test marker so cleanup never touches other data.

const MARK = "TESTLOOX ";

const FAKE: LooxAnalysis = {
  summary: "Reviewers love the softness; sizing runs small for a few.",
  themes: ["softness", "leakproof confidence", "sizing"],
  complaints: ["runs small at the waist"],
  improvement_ideas: ["add a size-up note on the product page"],
  standout_quotes: ["I sleep in these now."],
};

async function cleanup() {
  await db.delete(looxReviewAnalyses).where(like(looxReviewAnalyses.productTitle, `${MARK}%`));
  await db.delete(looxReviews).where(like(looxReviews.emailMessageId, "<testloox-%"));
}

beforeEach(cleanup);
afterEach(cleanup);

async function seedReviews(n: number, product = `${MARK}Cotton Brief`) {
  for (let i = 0; i < n; i++) {
    await db.insert(looxReviews).values({
      emailMessageId: `<testloox-${product}-${i}@t>`,
      receivedAt: new Date(Date.now() - i * 3600_000),
      productTitle: product,
      rating: 4 + (i % 2),
      reviewerName: `Tester ${i}`,
      reviewText: `Review number ${i}: soft, no leaks, would buy again.`,
      rawText: "raw",
      parsed: true,
    });
  }
}

describe("runLooxAnalysis", () => {
  it("is dormant without a key or transport", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const r = await runLooxAnalysis();
    expect(r.configured).toBe(false);
    expect(r.productsAnalyzed).toBe(0);
  });

  it("analyzes products with new reviews, freezes KPIs, and skips unchanged ones", async () => {
    await seedReviews(3);
    const calls: string[] = [];
    const transport = async (_system: string, user: string) => {
      calls.push(user);
      return JSON.stringify(FAKE);
    };

    const first = await runLooxAnalysis({ transport });
    const ours = (n: number) => n; // readability
    expect(first.configured).toBe(true);
    expect(ours(first.productsAnalyzed)).toBeGreaterThanOrEqual(1);
    expect(calls[0]).toContain("Review number 0");

    const rows = await db
      .select()
      .from(looxReviewAnalyses)
      .where(like(looxReviewAnalyses.productTitle, `${MARK}%`));
    expect(rows).toHaveLength(1);
    expect(rows[0].reviewCount).toBe(3);
    expect(Number(rows[0].avgRating)).toBeCloseTo(4.33, 1);
    expect((rows[0].analysis as LooxAnalysis).summary).toContain("softness");

    // second run with nothing new: our product is skipped, not re-billed
    const callsBefore = calls.length;
    const second = await runLooxAnalysis({ transport });
    expect(second.productsSkipped).toBeGreaterThanOrEqual(1);
    const oursAgain = await db
      .select()
      .from(looxReviewAnalyses)
      .where(like(looxReviewAnalyses.productTitle, `${MARK}%`));
    expect(oursAgain).toHaveLength(1);
    expect(calls.length).toBe(callsBefore);
  });

  it("keeps going when the model returns junk for one product", async () => {
    await seedReviews(1, `${MARK}Junk Product`);
    const r = await runLooxAnalysis({ transport: async () => "sorry, I cannot do that" });
    expect(r.errors.some((e) => e.includes("Junk Product"))).toBe(true);
    const rows = await db
      .select()
      .from(looxReviewAnalyses)
      .where(like(looxReviewAnalyses.productTitle, `${MARK}%`));
    expect(rows).toHaveLength(0);
  });
});
