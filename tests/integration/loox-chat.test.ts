import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, like } from "drizzle-orm";
import { db } from "@/lib/db";
import { looxProducts, looxReviews } from "@/lib/db/schema";
import { runLooxChat } from "@/lib/jobs/loox-chat";

// Real DB, fake Claude. Rows are marked with a TESTLOOXCHAT prefix and
// removed afterwards.

const PRODUCT = "TESTLOOXCHAT Product";
const HANDLE = "testlooxchat-product";

beforeAll(async () => {
  await db.insert(looxProducts).values({ handle: HANDLE, displayName: PRODUCT, line: "std" }).onConflictDoNothing();
  await db.insert(looxReviews).values(
    [
      { rating: 5, text: "TESTLOOXCHAT absolutely love these", status: "published" },
      { rating: 2, text: "TESTLOOXCHAT waistband rolls down", status: "published" },
      { rating: 1, text: "TESTLOOXCHAT should stay hidden", status: "unpublished" },
    ].map((r, i) => ({
      externalId: `TESTLOOXCHAT-${i}`,
      source: "api",
      store: "main",
      dedupKey: `TESTLOOXCHAT-${i}`,
      receivedAt: new Date(`2026-01-0${i + 1}T00:00:00Z`),
      reviewedAt: new Date(`2026-01-0${i + 1}T00:00:00Z`),
      productTitle: PRODUCT,
      productHandle: HANDLE,
      rating: r.rating,
      reviewerName: `Tester ${i}`,
      reviewText: r.text,
      status: r.status,
      parsed: true,
    })),
  );
});

afterAll(async () => {
  await db.delete(looxReviews).where(like(looxReviews.externalId, "TESTLOOXCHAT-%"));
  await db.delete(looxProducts).where(eq(looxProducts.handle, HANDLE));
});

describe("runLooxChat", () => {
  it("reports unconfigured without a transport or api key", async () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const r = await runLooxChat({ displayName: PRODUCT, mode: "marketing", messages: [{ role: "user", content: "hi" }] });
    if (prev !== undefined) process.env.ANTHROPIC_API_KEY = prev;
    expect(r.configured).toBe(false);
  });

  it("puts only published reviews in context, numbered", async () => {
    let seenSystem = "";
    const r = await runLooxChat({
      displayName: PRODUCT,
      mode: "product",
      messages: [{ role: "user", content: "what do customers complain about?" }],
      transport: async (system) => {
        seenSystem = system;
        return "The waistband rolls down for some customers.";
      },
    });
    expect(r.configured).toBe(true);
    expect(r.reviewCount).toBe(2);
    expect(seenSystem).toContain("absolutely love these");
    expect(seenSystem).toContain("waistband rolls down");
    expect(seenSystem).not.toContain("should stay hidden"); // unpublished
    expect(seenSystem).toContain("#1");
    expect(r.answer).toContain("waistband");
    expect(r.verbatim).toHaveLength(0);
  });

  it("resolves a <review-ids> tag into verbatim reviews from the DB", async () => {
    const r = await runLooxChat({
      displayName: PRODUCT,
      mode: "marketing",
      messages: [{ role: "user", content: "show all 5 star reviews in full" }],
      transport: async () => "Here they are.\n<review-ids>1, 99</review-ids>",
    });
    expect(r.answer).toBe("Here they are.");
    expect(r.verbatim).toHaveLength(1); // 99 is out of range and dropped
    expect(r.verbatim[0]?.reviewText).toContain("absolutely love these");
  });

  it("respects the date range filter", async () => {
    const r = await runLooxChat({
      displayName: PRODUCT,
      mode: "marketing",
      messages: [{ role: "user", content: "count?" }],
      from: new Date("2026-01-02T00:00:00Z"),
      transport: async () => "ok",
    });
    expect(r.reviewCount).toBe(1); // only the Jan 2 published review
  });
});
