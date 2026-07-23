import { createHash } from "node:crypto";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { looxProducts, looxReviews } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import {
  fetchLooxReviewsPage,
  handleFromProductUrl,
  looxApiStores,
  type LooxApiReview,
  type LooxStoreConfig,
} from "@/lib/sources/loox/api";

// Sync reviews from the Loox Merchant API into loox_reviews, both stores.
//
// Scott bulk-imports main-store reviews into the intl store and Loox gives
// the copies NEW ids, so cross-store dedup can't use the review id. Instead
// every row carries a content fingerprint (`dedupKey`) with a unique index;
// the main store syncs FIRST each run, so when the intl copy arrives its
// insert conflicts and is skipped — the main-store copy wins. Verified
// 2026-07-13 on 500 recent reviews/store: all 305 cross-store pairs shared
// email+date exactly (identical rating and body), zero fingerprint
// collisions within a store.
//
// Incremental: each store resumes from its own max(reviewedAt) minus a
// 3-day overlap (re-inserts are conflict no-ops). The first run has no rows
// and therefore walks the full history — backfill and steady-state are the
// same code path, and a run that dies mid-walk self-heals next run. Pages
// are sorted date-asc so appends never shift earlier pages.
//
// Moderation drift: Loox filters on review DATE only, so a weeks-old review
// that gets published/unpublished later never re-enters the incremental
// window. Rows the insert skips get a guarded status/rating/body update
// instead, and `runLooxApiSync({ full: true })` re-walks all history to
// catch drift outside the overlap — cheap enough to run weekly.

const PAGE_DELAY_MS = 600; // ~100 req/min, under Loox's 120/min per-store cap
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function looxDedupKey(r: LooxApiReview): string {
  const email = r.reviewer?.email?.trim().toLowerCase();
  if (email) return `${email}|${r.date}`;
  // No email (older reviews / imports): name + date + body hash.
  const bodyHash = createHash("sha256")
    .update(r.body ?? "")
    .digest("hex")
    .slice(0, 16);
  return `${(r.reviewer?.name ?? "").trim().toLowerCase()}|${r.date}|${bodyHash}`;
}

// "NEW: Leakproof High Waisted (Heavy Absorbency Bundles)" -> display name
// the KPI table shows. Every trailing parenthetical is a listing variant of
// the same garment (bundles, packs, colors, heavy absorbency), and so are
// bare pack-size suffixes ("... 10-Pack" — Scott 2026-07-14: fold those
// into the base product too). The Std/Heavy split lives in `line`, not the
// name. The mapping row stays editable in the DB.
export function displayNameForProduct(name: string): string {
  const stripped = name
    .replace(/^new:\s*/i, "")
    .replace(/\s*\([^)]*\)\s*$/, "")
    .replace(/[\s-]*\d+[\s-]?packs?(?:[\s-]*\d+)?\s*$/i, "")
    .trim();
  return stripped.length > 0 ? stripped : name.trim();
}

export function lineForProduct(name: string, handle: string | null): "std" | "heavy" {
  return /heavy/i.test(`${name} ${handle ?? ""}`) ? "heavy" : "std";
}

export type LooxApiSyncResult = {
  configured: boolean;
  stores: {
    store: string;
    pages: number;
    seen: number;
    inserted: number;
    skipped: number;
    updated: number;
    error?: string;
  }[];
};

export async function runLooxApiSync(opts?: { full?: boolean }): Promise<LooxApiSyncResult> {
  const stores = looxApiStores();
  if (stores.length === 0) return { configured: false, stores: [] };

  const results: LooxApiSyncResult["stores"] = [];
  for (const store of stores) {
    const r = await syncStore(store, opts?.full ?? false);
    results.push(r);
    // Main must fully land before intl runs, or an intl copy of a brand-new
    // main review would win the dedup race with the wrong product handle.
    if (store.label === "main" && r.error) {
      logger.error("loox.api_sync.main_failed_skipping_intl", { error: r.error });
      break;
    }
  }

  // Rename auto-merge + noise rules over the product mapping. Best-effort:
  // a unify hiccup must not fail the sync that feeds it.
  try {
    const { unifyLooxProducts } = await import("@/lib/jobs/loox-product-unify");
    await unifyLooxProducts();
  } catch (e) {
    logger.error("loox.unify.failed", { error: e instanceof Error ? e.message : String(e) });
  }

  logger.info("loox.api_sync.done", { stores: results });
  return { configured: true, stores: results };
}

async function syncStore(store: LooxStoreConfig, full: boolean) {
  const result = {
    store: store.label,
    pages: 0,
    seen: 0,
    inserted: 0,
    skipped: 0,
    updated: 0,
  } as LooxApiSyncResult["stores"][number];
  try {
    let fromDate: string | undefined;
    if (!full) {
      const newest = await db
        .select({ max: sql<string | null>`max(${looxReviews.reviewedAt})` })
        .from(looxReviews)
        .where(and(eq(looxReviews.store, store.label), isNotNull(looxReviews.reviewedAt)));
      if (newest[0]?.max) {
        fromDate = new Date(new Date(newest[0].max).getTime() - 3 * 24 * 3600 * 1000)
          .toISOString()
          .slice(0, 10);
      }
    }

    let page = 1;
    let total: number | undefined;
    for (;;) {
      const data = await fetchLooxReviewsPage(store, { page, fromDate, total });
      result.pages += 1;
      total = data.pagination.total;
      result.seen += data.reviews.length;

      const values = data.reviews.map((review) => ({
        externalId: review.id,
        source: "api" as const,
        store: store.label,
        dedupKey: looxDedupKey(review),
        receivedAt: new Date(review.createdAt ?? review.date),
        reviewedAt: new Date(review.date),
        productTitle: review.product?.name ?? null,
        productHandle: handleFromProductUrl(review.product?.url),
        productId: review.product?.id ?? null,
        rating: review.rating,
        reviewerName: review.reviewer?.nickname ?? review.reviewer?.name ?? null,
        reviewerEmail: review.reviewer?.email ?? null,
        reviewText: review.body,
        verified: review.verified,
        status: review.status,
        looxOrderId: review.orderId != null ? String(review.orderId) : null,
        parsed: true,
      }));

      if (values.length > 0) {
        const inserted = await db
          .insert(looxReviews)
          .values(values)
          .onConflictDoNothing()
          .returning({ externalId: looxReviews.externalId });
        result.inserted += inserted.length;
        result.skipped += values.length - inserted.length;

        // Rows that already exist for THIS store may have drifted in Loox
        // (moderation status, edited text) or in Shopify (product renamed —
        // the API always returns the CURRENT product name/handle, and the
        // unify pass derives each group's canonical name from its newest
        // snapshot, so refreshing these here makes a ?full=1 re-walk a
        // complete rename-refresher). Guarded update, no-op when equal.
        const freshIds = new Set(inserted.map((r) => r.externalId));
        for (const v of values) {
          if (freshIds.has(v.externalId)) continue;
          const res = await db
            .update(looxReviews)
            .set({
              rating: v.rating,
              reviewText: v.reviewText,
              verified: v.verified,
              status: v.status,
              productTitle: v.productTitle,
              productHandle: v.productHandle,
              productId: v.productId,
              // Backfills order links onto rows that predate the column;
              // Loox only sets orderId on newer reviews, so this is
              // write-once in practice.
              looxOrderId: v.looxOrderId,
            })
            .where(
              and(
                eq(looxReviews.store, store.label),
                eq(looxReviews.externalId, v.externalId),
                sql`(${looxReviews.status} is distinct from ${v.status}
                  or ${looxReviews.rating} is distinct from ${v.rating}
                  or ${looxReviews.reviewText} is distinct from ${v.reviewText}
                  or ${looxReviews.verified} is distinct from ${v.verified}
                  or ${looxReviews.productTitle} is distinct from ${v.productTitle}
                  or ${looxReviews.productHandle} is distinct from ${v.productHandle}
                  or ${looxReviews.productId} is distinct from ${v.productId})`,
              ),
            )
            .returning({ id: looxReviews.id });
          result.updated += res.length;
        }

        // Seed the product mapping from handles seen this page; existing
        // rows keep any manual edits (conflict no-op).
        const prods = new Map<string, { displayName: string; line: "std" | "heavy" }>();
        for (const review of data.reviews) {
          const handle = handleFromProductUrl(review.product?.url);
          const name = review.product?.name;
          if (handle && name && !prods.has(handle)) {
            prods.set(handle, {
              displayName: displayNameForProduct(name),
              line: lineForProduct(name, handle),
            });
          }
        }
        if (prods.size > 0) {
          await db
            .insert(looxProducts)
            .values([...prods].map(([handle, p]) => ({ handle, ...p })))
            .onConflictDoNothing();
        }
      }

      if (!data.pagination.hasMore) break;
      page += 1;
      await sleep(PAGE_DELAY_MS);
    }
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
    logger.error("loox.api_sync.store_failed", { store: store.label, error: result.error });
  }
  return result;
}
