// tRPC context. The middleware (middleware.ts) guarantees a valid
// session exists before any /api/trpc request reaches a procedure, but
// AUTHORIZATION happens here + in lib/trpc/server.ts: the context
// carries the session email, its access tier, and the cashflow
// allowlist flag, and every procedure is built from a tier-scoped
// builder that rejects under-privileged sessions. Never trust a
// client-supplied identity field — attribute writes to ctx.email.

import {
  SESSION_COOKIE,
  verifySessionToken,
  getAccessTier,
  isCashflowAllowed,
  type AccessTier,
} from "@/lib/auth";

export type TrpcContext = {
  email: string | null;
  tier: AccessTier;
  cashflowAllowed: boolean;
};

function parseCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

export async function createContext(opts?: {
  req?: Request;
}): Promise<TrpcContext> {
  const secret = process.env.SESSION_SECRET;
  const cookieHeader = opts?.req?.headers.get("cookie") ?? null;
  const token = parseCookie(cookieHeader, SESSION_COOKIE);
  const payload =
    secret && token ? await verifySessionToken(secret, token) : null;
  const email = payload?.email ?? null;
  return {
    email,
    tier: getAccessTier(email),
    cashflowAllowed: isCashflowAllowed(email),
  };
}
