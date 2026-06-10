import { NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  appOrigin,
  checkAccess,
  createSessionToken,
  decodeIdToken,
  exchangeCodeForTokens,
  parseAllowedEmails,
  verifyOAuthStateToken,
} from "@/lib/auth";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";

function callbackUrl(req: Request): string {
  return `${appOrigin(req)}/api/auth/google/callback`;
}

function errorRedirect(req: Request, code: string): NextResponse {
  const url = new URL("/login", appOrigin(req));
  url.searchParams.set("error", code);
  return NextResponse.redirect(url);
}

export async function GET(req: Request) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const sessionSecret = process.env.SESSION_SECRET;
  const workspaceDomain = process.env.GOOGLE_WORKSPACE_DOMAIN;
  const allowedEmails = parseAllowedEmails(process.env.ALLOWED_EMAILS);
  const externalAllowedEmails = parseAllowedEmails(process.env.EXTERNAL_ALLOWED_EMAILS);
  if (!clientId || !clientSecret || !sessionSecret || !workspaceDomain) {
    return NextResponse.json(
      { error: "Google SSO is not configured on the server" },
      { status: 500 }
    );
  }

  const url = new URL(req.url);
  if (url.searchParams.get("error")) {
    return errorRedirect(req, "google_denied");
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return errorRedirect(req, "missing_params");

  const statePayload = await verifyOAuthStateToken(sessionSecret, state);
  if (!statePayload) return errorRedirect(req, "bad_state");

  const tokens = await exchangeCodeForTokens({
    clientId,
    clientSecret,
    code,
    redirectUri: callbackUrl(req),
  });
  if (tokens.error || !tokens.id_token) {
    return errorRedirect(req, "token_exchange_failed");
  }

  const claims = decodeIdToken(tokens.id_token);
  if (!claims) return errorRedirect(req, "bad_id_token");

  const result = checkAccess(claims, { workspaceDomain, allowedEmails, externalAllowedEmails });
  if (!result.ok) {
    // Log WHO bounced and why, so "some people can't log in" reports can
    // be resolved by reading the logs instead of guessing which email
    // each person tried (2026-06-10). Note: anyone rejected by Google's
    // own consent screen (OAuth app in Testing mode + not a test user)
    // never reaches this handler — that denial only shows in GCP.
    logger.warn("auth.access_denied", {
      email: claims.email ?? "(none)",
      reason: result.reason,
      hd: claims.hd ?? null,
    });
    return errorRedirect(req, result.reason);
  }

  const token = await createSessionToken(sessionSecret, result.email);
  const dest = statePayload.next.startsWith("/") ? statePayload.next : "/inventory";
  const res = NextResponse.redirect(new URL(dest, appOrigin(req)));
  res.cookies.set({
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
  return res;
}
