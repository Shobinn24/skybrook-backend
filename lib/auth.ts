// Session + OAuth helpers. Edge-runtime compatible (Web Crypto only) so the
// middleware session check runs on the edge. Google token exchange itself runs
// on the Node runtime (it's in a route handler) because it uses `fetch` against
// external URLs and needs reliable TLS + env access.

export const SESSION_COOKIE = "skybrook_session";
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days
export const OAUTH_STATE_MAX_AGE_SECONDS = 10 * 60; // 10 minutes

/**
 * Resolves the public-facing origin for redirect URL construction.
 *
 * On Railway (and most reverse-proxy setups) `new URL(req.url).origin`
 * reports the internal upstream URL — e.g. `http://localhost:8080` or
 * the container's internal hostname — not the public URL Grace's
 * browser is using. Constructing redirects from that yields links
 * the browser can't follow. Symptom: "localhost refused to connect"
 * mid-OAuth, with the session cookie applied so refreshing on the
 * correct URL works.
 *
 * `APP_URL` should be set in production to the public-facing origin
 * (e.g. `https://skybrook-backend-production.up.railway.app`). When
 * unset (local dev), we fall back to `req.url`'s origin which is
 * accurate for direct-served requests.
 */
export function appOrigin(req: Request): string {
  const override = process.env.APP_URL;
  if (override) return override.replace(/\/$/, "");
  return new URL(req.url).origin;
}

export type SessionPayload = {
  email: string;
  iat: number; // seconds since epoch, issued-at
};

export type OAuthStatePayload = {
  next: string; // post-login redirect path
  iat: number;
  nonce: string;
};

const enc = new TextEncoder();
const dec = new TextDecoder();

function toBase64url(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let str = "";
  for (let i = 0; i < u8.length; i++) str += String.fromCharCode(u8[i]);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function fromBase64url(s: string): ArrayBuffer {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
}

function encodeAb(s: string): ArrayBuffer {
  const bytes = enc.encode(s);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function jsonToAb(obj: unknown): ArrayBuffer {
  return encodeAb(JSON.stringify(obj));
}

function abToString(ab: ArrayBuffer): string {
  return dec.decode(new Uint8Array(ab));
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

async function signPayload(secret: string, payloadAb: ArrayBuffer): Promise<string> {
  const key = await importHmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, payloadAb);
  return `${toBase64url(payloadAb)}.${toBase64url(sig)}`;
}

async function verifyAndDecodePayload<T>(
  secret: string,
  token: string
): Promise<T | null> {
  const [payloadB64, sigB64] = token.split(".");
  if (!payloadB64 || !sigB64) return null;
  let payloadAb: ArrayBuffer;
  let sigAb: ArrayBuffer;
  try {
    payloadAb = fromBase64url(payloadB64);
    sigAb = fromBase64url(sigB64);
  } catch {
    return null;
  }
  const key = await importHmacKey(secret);
  let ok = false;
  try {
    ok = await crypto.subtle.verify("HMAC", key, sigAb, payloadAb);
  } catch {
    return null;
  }
  if (!ok) return null;
  try {
    return JSON.parse(abToString(payloadAb)) as T;
  } catch {
    return null;
  }
}

export async function createSessionToken(
  secret: string,
  email: string
): Promise<string> {
  const payload: SessionPayload = { email, iat: Math.floor(Date.now() / 1000) };
  return signPayload(secret, jsonToAb(payload));
}

export async function verifySessionToken(
  secret: string,
  token: string
): Promise<SessionPayload | null> {
  const payload = await verifyAndDecodePayload<SessionPayload>(secret, token);
  if (!payload || typeof payload.email !== "string" || typeof payload.iat !== "number") {
    return null;
  }
  const ageSec = Math.floor(Date.now() / 1000) - payload.iat;
  if (ageSec < 0 || ageSec > SESSION_MAX_AGE_SECONDS) return null;
  return payload;
}

export async function createOAuthStateToken(
  secret: string,
  next: string
): Promise<string> {
  const nonceBytes = new Uint8Array(16);
  crypto.getRandomValues(nonceBytes);
  const payload: OAuthStatePayload = {
    next,
    iat: Math.floor(Date.now() / 1000),
    nonce: toBase64url(nonceBytes),
  };
  return signPayload(secret, jsonToAb(payload));
}

export async function verifyOAuthStateToken(
  secret: string,
  token: string
): Promise<OAuthStatePayload | null> {
  const payload = await verifyAndDecodePayload<OAuthStatePayload>(secret, token);
  if (!payload || typeof payload.next !== "string" || typeof payload.iat !== "number") {
    return null;
  }
  const ageSec = Math.floor(Date.now() / 1000) - payload.iat;
  if (ageSec < 0 || ageSec > OAUTH_STATE_MAX_AGE_SECONDS) return null;
  return payload;
}

// --- Google OAuth -----------------------------------------------------------
// These run in Node runtime (route handlers), not the edge middleware.

export type GoogleIdTokenClaims = {
  iss: string;
  aud: string;
  sub: string;
  email?: string;
  email_verified?: boolean;
  hd?: string; // hosted domain (Google Workspace)
  name?: string;
  exp: number;
  iat: number;
};

export type GoogleTokenResponse = {
  access_token?: string;
  id_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
  error?: string;
  error_description?: string;
};

export async function exchangeCodeForTokens(params: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}): Promise<GoogleTokenResponse> {
  const body = new URLSearchParams({
    code: params.code,
    client_id: params.clientId,
    client_secret: params.clientSecret,
    redirect_uri: params.redirectUri,
    grant_type: "authorization_code",
  });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  return (await res.json()) as GoogleTokenResponse;
}

// Decode (not verify) the ID token payload. We trust the token because it was
// returned to us directly over TLS from Google's token endpoint using our
// client secret — standard server-side auth-code flow. Full JWKS verification
// is only required when the token arrives from an untrusted channel.
export function decodeIdToken(idToken: string): GoogleIdTokenClaims | null {
  const parts = idToken.split(".");
  if (parts.length !== 3) return null;
  try {
    const json = abToString(fromBase64url(parts[1]));
    return JSON.parse(json) as GoogleIdTokenClaims;
  } catch {
    return null;
  }
}

export type AccessCheck =
  | { ok: true; email: string }
  | { ok: false; reason: "no_email" | "email_unverified" | "bad_domain" | "not_allowed" };

export function checkAccess(
  claims: GoogleIdTokenClaims,
  opts: {
    workspaceDomain: string;
    allowedEmails?: string[];
    /** Emails outside the workspace domain that are still allowed in.
     *  Skips the `hd` + suffix check for these specific addresses; still
     *  requires email_verified. Use for external collaborators whose
     *  gmail/other-workspace logins shouldn't require a workspace seat. */
    externalAllowedEmails?: string[];
  }
): AccessCheck {
  const email = claims.email?.toLowerCase();
  if (!email) return { ok: false, reason: "no_email" };
  if (claims.email_verified !== true) return { ok: false, reason: "email_unverified" };

  const externalAllow = (opts.externalAllowedEmails ?? [])
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (externalAllow.includes(email)) {
    // External collaborator — bypass workspace hd/suffix check. Still
    // gated by email_verified above and the OAuth code-exchange flow
    // (only the email's owner can complete the Google login).
    return { ok: true, email };
  }

  const domain = opts.workspaceDomain.toLowerCase();
  // `hd` is the authoritative Workspace-domain claim. Falling back to the email
  // suffix alone would let consumer @gmail aliases through if the hd check is
  // skipped, so require both to match.
  const hdOk = (claims.hd ?? "").toLowerCase() === domain;
  const suffixOk = email.endsWith("@" + domain);
  if (!hdOk || !suffixOk) return { ok: false, reason: "bad_domain" };

  if (opts.allowedEmails && opts.allowedEmails.length > 0) {
    const normalized = opts.allowedEmails.map((e) => e.trim().toLowerCase()).filter(Boolean);
    if (!normalized.includes(email)) return { ok: false, reason: "not_allowed" };
  }

  return { ok: true, email };
}

export function parseAllowedEmails(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0);
}

// --- Role-based scoping ----------------------------------------------------
// Scott 2026-05-15: marketing team should see only Launches, Ad spend
// tracker, Bonus tracker, and Performance — Ops keeps full access.
//
// Defensible defaults (Shobinn 2026-05-17): the role is a per-email tag
// pulled from env at request time, not a DB column. Adding/removing a
// teammate from the marketing group is a one-line env change, redeploy,
// done. When the marketing email list grows past ~10 people or anyone
// needs more than two role categories, promote this to a `users.role`
// column and an admin UI.

export type Role = "ops" | "marketing";

/** Returns the role for a signed-in email. Marketing membership is
 * controlled by `SKYBROOK_MARKETING_EMAILS` (comma-separated, normalized
 * to lowercase). When the env var is empty or unset, no one is in the
 * marketing group — everyone defaults to `ops` (full access). */
export function getUserRole(
  email: string | null | undefined,
  marketingEmailsRaw?: string,
): Role {
  if (!email) return "ops";
  const raw = marketingEmailsRaw ?? process.env.SKYBROOK_MARKETING_EMAILS;
  const list = parseAllowedEmails(raw);
  if (list.length === 0) return "ops";
  return list.includes(email.toLowerCase()) ? "marketing" : "ops";
}

/** Cashflow is sensitive (company cash position) so it is gated to an
 * explicit allowlist (`SKYBROOK_CASHFLOW_EMAILS`), independent of the
 * ops/marketing role split. Fail-closed: empty/unset list = nobody. */
export function isCashflowAllowed(
  email: string | null | undefined,
  cashflowEmailsRaw?: string,
): boolean {
  if (!email) return false;
  const list = parseAllowedEmails(cashflowEmailsRaw ?? process.env.SKYBROOK_CASHFLOW_EMAILS);
  return list.includes(email.toLowerCase());
}

// URL prefixes a marketing user is permitted to load. Anything else
// redirects to MARKETING_LANDING_PATH. tRPC procedure paths
// (/api/trpc/*) are intentionally NOT narrowed here because every page
// — marketing and ops — calls into the same `inventory` router; a
// prefix gate would block legitimate marketing reads too. Phase 2
// follow-up: per-procedure allowlist in a tRPC middleware, with the
// router's procedure name as the key (default-deny for marketing).
const MARKETING_ALLOWED_PREFIXES: ReadonlyArray<string> = [
  "/launches",
  "/fb-ads",
  "/bonus-tracker",
  "/performance",
];

export const MARKETING_LANDING_PATH = "/performance";

/** True when a marketing user is allowed to navigate to `pathname`.
 * Auth/OAuth, the dev-bypass route, the health endpoint, tRPC paths,
 * and Next internals are all permitted (the middleware separately
 * handles the public-paths list before reaching this check). */
export function isMarketingAllowedPath(pathname: string): boolean {
  for (const prefix of MARKETING_ALLOWED_PREFIXES) {
    if (pathname === prefix || pathname.startsWith(prefix + "/")) return true;
  }
  // tRPC: allow Phase 1; narrow in Phase 2.
  if (pathname.startsWith("/api/trpc/")) return true;
  return false;
}
