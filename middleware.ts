import { NextRequest, NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  getUserRole,
  isMarketingAllowedPath,
  MARKETING_LANDING_PATH,
  verifySessionToken,
} from "@/lib/auth";

const PUBLIC_PATHS = [
  "/login",
  "/api/auth/google",
  "/api/auth/logout",
  // Dev bypass route — internally gated by NODE_ENV + SKYBROOK_DEV_BYPASS.
  // Safe to list here unconditionally because the handler itself returns 404
  // in production.
  "/api/auth/dev-login",
  // Health endpoint is read-only ops state for external pingers
  // (healthchecks.io, Slack integrations) and on-demand operators. Must
  // be reachable without a session cookie. Surfaces only non-sensitive
  // freshness state (per-source last status + table max-dates).
  "/api/health",
];

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Public routes: login page + the login/logout handlers.
  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"))) {
    return NextResponse.next();
  }

  // Cron + admin endpoints authenticate via CRON_SECRET bearer header,
  // not session cookies. Each handler enforces its own auth.
  if (pathname.startsWith("/api/cron/") || pathname.startsWith("/api/admin/")) {
    return NextResponse.next();
  }

  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    // Dev safety — if misconfigured, show a clear error instead of redirect loop.
    return new NextResponse("SESSION_SECRET is not set", { status: 500 });
  }

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const session = token ? await verifySessionToken(secret, token) : null;
  if (session) {
    // Role-based scoping (Scott 2026-05-15): marketing users only see
    // /launches, /fb-ads, /bonus-tracker, /performance. Any other page
    // path silently redirects to MARKETING_LANDING_PATH. tRPC routes
    // stay open to marketing in Phase 1 — see isMarketingAllowedPath.
    const role = getUserRole(session.email);
    if (role === "marketing" && !isMarketingAllowedPath(pathname)) {
      const url = req.nextUrl.clone();
      url.pathname = MARKETING_LANDING_PATH;
      url.search = "";
      return NextResponse.redirect(url);
    }
    return NextResponse.next();
  }

  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.searchParams.set("next", pathname);
  return NextResponse.redirect(url);
}

export const config = {
  // Skip Next internals + favicon. Everything else (pages + /api) is gated.
  // The ".*\\..*" exclusion used earlier accidentally skipped tRPC paths like
  // /api/trpc/inventory.getInventoryRows — do NOT reintroduce it.
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico).*)"],
};
