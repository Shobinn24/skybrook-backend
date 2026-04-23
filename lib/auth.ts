// Shared-password auth (MVP). One APP_PASSWORD env var, HMAC-signed session cookie.
// Edge-runtime compatible — uses Web Crypto, no Node APIs.

export const SESSION_COOKIE = "skybrook_session";
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days

const enc = new TextEncoder();

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
  // Slice gives a concrete ArrayBuffer (not ArrayBufferLike) for SubtleCrypto type-compat.
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
}

function encodeAb(s: string): ArrayBuffer {
  const bytes = enc.encode(s);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
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

export async function createSessionToken(secret: string): Promise<string> {
  const ts = Date.now().toString();
  const key = await importHmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, encodeAb(ts));
  return `${ts}.${toBase64url(sig)}`;
}

export async function verifySessionToken(secret: string, token: string): Promise<boolean> {
  const [ts, sig] = token.split(".");
  if (!ts || !sig) return false;
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) return false;
  if (Date.now() - tsNum > SESSION_MAX_AGE_SECONDS * 1000) return false;
  const key = await importHmacKey(secret);
  try {
    return await crypto.subtle.verify("HMAC", key, fromBase64url(sig), encodeAb(ts));
  } catch {
    return false;
  }
}

// Constant-time string compare to avoid leaking timing info on password mismatch.
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
