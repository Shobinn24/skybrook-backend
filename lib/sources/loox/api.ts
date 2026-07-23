// Thin client for the Loox Merchant API (released June 2026).
// Docs: https://developers.loox.app — GET /api/v1/store/{publicStoreId}/product-reviews
// Auth is a per-store secret in the X-Api-Secret-Key header; rate limit is
// 120 req/min per store, pages cap at limit=250.

export type LooxStoreConfig = {
  /** Our label for the store: 'main' | 'intl'. Sync order matters — main
   * first, so the main-store copy of a cross-store duplicate wins. */
  label: string;
  publicStoreId: string;
  secret: string;
};

export type LooxApiReview = {
  id: string;
  rating: number;
  body: string | null;
  date: string; // ISO, when the customer left the review
  createdAt: string;
  verified: boolean;
  status: string; // 'published' | 'unpublished' | 'pending'
  reviewer: {
    name: string | null;
    firstName: string | null;
    lastName: string | null;
    nickname: string | null;
    email: string | null;
  };
  /** Shopify order numeric id the review request was tied to. Populated
   * on reviews created since ~mid-2026 (93% of new reviews sampled
   * 2026-07-23); null on the back catalog. */
  orderId: string | null;
  product: {
    id: string | null;
    name: string | null;
    url: string | null;
  } | null;
};

export type LooxReviewsPage = {
  reviews: LooxApiReview[];
  pagination: { total: number; page: number; limit: number; hasMore: boolean };
};

/** Store configs from env, main store first. Empty when not configured. */
export function looxApiStores(): LooxStoreConfig[] {
  const stores: LooxStoreConfig[] = [];
  const mainId = process.env.LOOX_MAIN_STORE_ID?.trim();
  const mainSecret = process.env.LOOX_MAIN_SECRET?.trim();
  if (mainId && mainSecret) stores.push({ label: "main", publicStoreId: mainId, secret: mainSecret });
  const intlId = process.env.LOOX_INTL_STORE_ID?.trim();
  const intlSecret = process.env.LOOX_INTL_SECRET?.trim();
  if (intlId && intlSecret) stores.push({ label: "intl", publicStoreId: intlId, secret: intlSecret });
  return stores;
}

export async function fetchLooxReviewsPage(
  store: LooxStoreConfig,
  opts: { page: number; fromDate?: string; total?: number },
): Promise<LooxReviewsPage> {
  const params = new URLSearchParams({
    status: "all",
    sort: "date",
    direction: "asc", // stable pagination: new reviews append at the end
    limit: "250",
    page: String(opts.page),
  });
  if (opts.fromDate) params.set("from_date", opts.fromDate);
  // Passing the previous response's total back skips a count query on their end.
  if (opts.total !== undefined) params.set("total", String(opts.total));

  // Transient-failure retry, same shape as the Shopify order walk: a
  // single ECONNRESET killed a 124-page full re-walk at page 37
  // (2026-07-23). 3 attempts, fresh timeout each, short backoff.
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(
        `https://api.loox.io/api/v1/store/${store.publicStoreId}/product-reviews?${params}`,
        {
          headers: { "X-Api-Secret-Key": store.secret },
          signal: AbortSignal.timeout(30_000),
        },
      );
      if (!res.ok) {
        throw new Error(`loox api ${store.label} page ${opts.page}: HTTP ${res.status}`);
      }
      return (await res.json()) as LooxReviewsPage;
    } catch (err) {
      lastErr = err;
      if (attempt < 3) await new Promise((r) => setTimeout(r, 4_000 * attempt));
    }
  }
  throw lastErr;
}

/** Shopify handle from the product url ("https://.../products/<handle>"). */
export function handleFromProductUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = url.match(/\/products\/([^/?#]+)/);
  return m ? m[1] : null;
}
