import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, like, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { looxProducts, looxReviews, orderEmails } from "@/lib/db/schema";
import { unifyLooxProducts } from "@/lib/jobs/loox-product-unify";
import { verifyReviewPurchases } from "@/lib/jobs/shopify-order-emails";

// Real DB, TESTUNIFY-prefixed rows, cleaned up afterwards.
//
// Scenario: product id P1 was renamed — old handle carries the old name
// snapshot, a newer review on a second handle carries the new name. The
// unify pass must snap both handles to the new name. A pinned handle with
// the same product id must be left alone. A "Mystery Gift" mapping and a
// 2-review group must be excluded; a 3-review group must stay included.
// Then purchase verification stamps: reviewer A bought the product family
// before reviewing (verified), reviewer B never ordered (unverified), and
// a review older than order coverage is unknown.

const P1 = "TESTUNIFY-pid-1";

const review = (over: {
  externalId: string;
  handle: string;
  title: string;
  productId?: string;
  email?: string | null;
  reviewedAt: string;
  status?: string;
}) => ({
  externalId: over.externalId,
  source: "api",
  store: "main",
  dedupKey: over.externalId,
  receivedAt: new Date(over.reviewedAt),
  reviewedAt: new Date(over.reviewedAt),
  productTitle: over.title,
  productHandle: over.handle,
  productId: over.productId ?? null,
  rating: 5,
  reviewerName: "Tester",
  reviewerEmail: over.email === undefined ? "testunify-a@example.com" : over.email,
  reviewText: "TESTUNIFY body",
  status: over.status ?? "published",
  parsed: true,
});

beforeAll(async () => {
  await db.insert(looxProducts).values([
    { handle: "testunify-old", displayName: "TESTUNIFY Old Name", line: "std" },
    { handle: "testunify-new", displayName: "TESTUNIFY Shaping Brief", line: "std" },
    { handle: "testunify-pinned", displayName: "TESTUNIFY Hand Merged", line: "std", pinned: true },
    { handle: "testunify-gift", displayName: "TESTUNIFY Mystery Gift", line: "std" },
    { handle: "testunify-small", displayName: "TESTUNIFY Small Product", line: "std" },
  ]);
  await db.insert(looxReviews).values([
    // P1 rename: older review on old handle, newest on new handle
    review({ externalId: "TESTUNIFY-1", handle: "testunify-old", title: "TESTUNIFY Shapewear", productId: P1, reviewedAt: "2026-07-01T00:00:00Z" }),
    review({ externalId: "TESTUNIFY-2", handle: "testunify-new", title: "TESTUNIFY Shaping Brief", productId: P1, reviewedAt: "2026-07-10T00:00:00Z", email: "testunify-b@example.com" }),
    review({ externalId: "TESTUNIFY-3", handle: "testunify-pinned", title: "TESTUNIFY Shaping Brief", productId: P1, reviewedAt: "2026-07-09T00:00:00Z", email: null }),
    // gift product with plenty of reviews — still excluded
    review({ externalId: "TESTUNIFY-4", handle: "testunify-gift", title: "TESTUNIFY Mystery Gift", productId: "TESTUNIFY-pid-2", reviewedAt: "2026-07-08T00:00:00Z" }),
    review({ externalId: "TESTUNIFY-5", handle: "testunify-gift", title: "TESTUNIFY Mystery Gift", productId: "TESTUNIFY-pid-2", reviewedAt: "2026-07-08T01:00:00Z" }),
    review({ externalId: "TESTUNIFY-6", handle: "testunify-gift", title: "TESTUNIFY Mystery Gift", productId: "TESTUNIFY-pid-2", reviewedAt: "2026-07-08T02:00:00Z" }),
    // 2-review product — excluded until it reaches 3
    review({ externalId: "TESTUNIFY-7", handle: "testunify-small", title: "TESTUNIFY Small Product", productId: "TESTUNIFY-pid-3", reviewedAt: "2026-07-05T00:00:00Z" }),
    review({ externalId: "TESTUNIFY-8", handle: "testunify-small", title: "TESTUNIFY Small Product", productId: "TESTUNIFY-pid-3", reviewedAt: "2026-07-05T01:00:00Z" }),
    // pre-coverage review for verification 'unknown'
    review({ externalId: "TESTUNIFY-9", handle: "testunify-new", title: "TESTUNIFY Shaping Brief", productId: P1, reviewedAt: "2020-01-01T00:00:00Z" }),
  ]);
  await db.insert(orderEmails).values([
    // reviewer A bought the family (via the OLD listing's product id) before reviewing
    { store: "main", email: "testunify-a@example.com", productId: P1, orderDate: "2026-06-20" },
  ]);
});

afterAll(async () => {
  await db.delete(looxReviews).where(like(looxReviews.externalId, "TESTUNIFY-%"));
  await db.delete(looxProducts).where(like(looxProducts.handle, "testunify-%"));
  await db.delete(orderEmails).where(like(orderEmails.email, "testunify-%"));
});

describe("unifyLooxProducts", () => {
  it("merges renamed listings onto the current name, honors pinned + noise rules", async () => {
    await unifyLooxProducts();
    const rows = await db
      .select()
      .from(looxProducts)
      .where(like(looxProducts.handle, "testunify-%"));
    const byHandle = new Map(rows.map((r) => [r.handle, r]));

    // both unpinned P1 handles snap to the newest title's display name
    expect(byHandle.get("testunify-old")?.displayName).toBe("TESTUNIFY Shaping Brief");
    expect(byHandle.get("testunify-new")?.displayName).toBe("TESTUNIFY Shaping Brief");
    // the pinned row keeps its hand-set name
    expect(byHandle.get("testunify-pinned")?.displayName).toBe("TESTUNIFY Hand Merged");
    // gift excluded despite 3 published reviews; 2-review group excluded;
    // the merged group has >=3 published reviews and stays included
    expect(byHandle.get("testunify-gift")?.include).toBe(false);
    expect(byHandle.get("testunify-small")?.include).toBe(false);
    expect(byHandle.get("testunify-new")?.include).toBe(true);
  });
});

describe("verifyReviewPurchases", () => {
  it("stamps verified / unverified / unknown correctly", async () => {
    await verifyReviewPurchases();
    const rows = await db
      .select({ ext: looxReviews.externalId, pv: looxReviews.purchaseVerified })
      .from(looxReviews)
      .where(like(looxReviews.externalId, "TESTUNIFY-%"));
    const byExt = new Map(rows.map((r) => [r.ext, r.pv]));

    // A bought the family via the old listing; the review sits on the new
    // handle — family-level match must still verify it.
    expect(byExt.get("TESTUNIFY-1")).toBe("verified");
    // B never ordered
    expect(byExt.get("TESTUNIFY-2")).toBe("unverified");
    // no email
    expect(byExt.get("TESTUNIFY-3")).toBe("unknown");
    // predates order coverage
    expect(byExt.get("TESTUNIFY-9")).toBe("unknown");
  });
});
