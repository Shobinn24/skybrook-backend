// Session + OAuth helpers. Edge-runtime compatible (Web Crypto only) so the
// middleware session check runs on the edge. Google token exchange itself runs
// on the Node runtime (it's in a route handler) because it uses `fetch` against
// external URLs and needs reliable TLS + env access.

export const SESSION_COOKIE = "skybrook_session";
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days
export const OAUTH_STATE_MAX_AGE_SECONDS = 10 * 60; // 10 minutes

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
  opts: { workspaceDomain: string; allowedEmails?: string[] }
): AccessCheck {
  const email = claims.email?.toLowerCase();
  if (!email) return { ok: false, reason: "no_email" };
  if (claims.email_verified !== true) return { ok: false, reason: "email_unverified" };

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
