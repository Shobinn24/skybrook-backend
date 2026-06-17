/**
 * Shopify Admin API access-token cache using the OAuth client_credentials grant.
 *
 * Why: Shopify retired the legacy custom-app `shpat_*` static tokens on
 * 2026-01-01. Apps installed via the Dev Dashboard now exchange the app's
 * Client ID + Client Secret for short-lived (24h) per-store access tokens
 * via the client_credentials grant. We cache them in-memory per store and
 * refresh ~60s before expiry.
 *
 * Endpoint (JSON body — Shopify docs claim form-encoded, but on
 * actual stores form-encoded gets intercepted by the admin web layer
 * and returns HTML; JSON returns the proper OAuth JSON error format
 * including {"error":"app_not_installed",...} which is essential for
 * debugging install issues. Verified live 2026-04-23):
 *
 *   POST https://{store}/admin/oauth/access_token
 *   Content-Type: application/json
 *   { grant_type: "client_credentials", client_id, client_secret }
 *
 * Response:
 *   { access_token, scope, expires_in }   // expires_in in seconds (86399)
 *
 * Common error responses:
 *   { "error": "app_not_installed", "error_description": "..." }
 *   { "error": "invalid_client", "error_description": "..." }
 */

type CachedToken = {
  token: string;
  expiresAtMs: number; // unix ms
};

const tokenCache: Map<string, CachedToken> = new Map();
const REFRESH_SAFETY_MS = 60_000; // refresh 60s before stated expiry

function readClientCreds(): { clientId: string; clientSecret: string } {
  const clientId = process.env.SHOPIFY_API_KEY?.trim();
  const clientSecret = process.env.SHOPIFY_API_SECRET?.trim();
  if (!clientId) throw new Error("shopify_auth: missing SHOPIFY_API_KEY");
  if (!clientSecret) throw new Error("shopify_auth: missing SHOPIFY_API_SECRET");
  return { clientId, clientSecret };
}

export type FetchTokenResponse = {
  access_token: string;
  scope: string;
  expires_in: number;
};

export async function fetchAccessToken(store: string): Promise<FetchTokenResponse> {
  const { clientId, clientSecret } = readClientCreds();
  const url = `https://${store}/admin/oauth/access_token`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    // Surface Shopify's structured OAuth errors verbatim — error code +
    // description tell us exactly why (app_not_installed / invalid_client /
    // etc.) so debugging install or credential issues stays self-evident.
    throw new Error(`shopify_auth ${store}: HTTP ${res.status} ${text}`);
  }
  const data = (await res.json()) as Partial<FetchTokenResponse>;
  if (typeof data.access_token !== "string" || typeof data.expires_in !== "number") {
    throw new Error(`shopify_auth ${store}: malformed response ${JSON.stringify(data)}`);
  }
  return data as FetchTokenResponse;
}

/** Returns a non-expired access token for the given store. Cached per-store. */
export async function getShopifyAccessToken(store: string): Promise<string> {
  if (!store) throw new Error("shopify_auth: store URL required");
  const cached = tokenCache.get(store);
  const now = Date.now();
  if (cached && cached.expiresAtMs > now) {
    return cached.token;
  }
  const fetched = await fetchAccessToken(store);
  const expiresAtMs = now + Math.max(fetched.expires_in * 1000 - REFRESH_SAFETY_MS, 0);
  tokenCache.set(store, { token: fetched.access_token, expiresAtMs });
  return fetched.access_token;
}

/**
 * Drop a single store's cached token so the next call refetches a fresh one.
 * Call this when the Admin API rejects a cached token with HTTP 401: Shopify
 * can invalidate a previously-issued client_credentials token when a newer one
 * is issued for the same store, so two jobs/processes fetching independently
 * can invalidate each other's cached token. Clearing + refetching on 401 makes
 * callers self-heal against that race.
 */
export function invalidateShopifyToken(store: string): void {
  tokenCache.delete(store);
}

/** Test-only: clear the in-memory token cache. */
export function _resetTokenCacheForTests(): void {
  tokenCache.clear();
}
