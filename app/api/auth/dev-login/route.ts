import { NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  appOrigin,
  createSessionToken,
} from "@/lib/auth";

export const runtime = "nodejs";

/**
 * Dev-only bypass: issues a session cookie for a hardcoded email so we can
 * click around the dashboard without going through Google OAuth. Useful when
 * the test-users list on the OAuth client doesn't include the developer.
 *
 * Gated by BOTH:
 *   - NODE_ENV !== "production"  (Next sets this to "production" for `next start`)
 *   - SKYBROOK_DEV_BYPASS === "1" (must be explicitly opted in)
 *
 * If either check fails the route returns 404 so its existence is not
 * discoverable in production.
 */
export async function GET(req: Request) {
  if (process.env.NODE_ENV === "production" || process.env.SKYBROOK_DEV_BYPASS !== "1") {
    return new NextResponse(null, { status: 404 });
  }

  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "SESSION_SECRET not set" }, { status: 500 });
  }

  const email = process.env.SKYBROOK_DEV_EMAIL ?? "dev@localhost";
  const token = await createSessionToken(secret, email);
  const res = NextResponse.redirect(new URL("/inventory", appOrigin(req)));
  res.cookies.set({
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    sameSite: "lax",
    secure: false, // dev uses http://localhost
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
  return res;
}
