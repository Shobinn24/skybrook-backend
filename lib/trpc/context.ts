// tRPC context. Auth is enforced at the HTTP layer by middleware.ts —
// any request reaching a procedure has already cleared the session
// gate. We additionally extract the signed-in email from the session
// cookie so mutating procedures can attribute writes (e.g.
// updated_by on sku_family_overrides).

import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth";

export type TrpcContext = {
  email: string | null;
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
  if (!secret || !token) return { email: null };
  const payload = await verifySessionToken(secret, token);
  return { email: payload?.email ?? null };
}
