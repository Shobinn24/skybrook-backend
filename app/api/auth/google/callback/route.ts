import { NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  checkAccess,
  createSessionToken,
  decodeIdToken,
  exchangeCodeForTokens,
  parseAllowedEmails,
  verifyOAuthStateToken,
} from "@/lib/auth";

export const runtime = "nodejs";

function callbackUrl(req: Request): string {
  const override = process.env.APP_URL;
  const origin = override ? override.replace(/\/$/, "") : new URL(req.url).origin;
  return `${origin}/api/auth/google/callback`;
}

function errorRedirect(req: Request, code: string): NextResponse {
  const url = new URL("/login", req.url);
  url.searchParams.set("error", code);
  return NextResponse.redirect(url);
}

export async function GET(req: Request) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const sessionSecret = process.env.SESSION_SECRET;
  const workspaceDomain = process.env.GOOGLE_WORKSPACE_DOMAIN;
  const allowedEmails = parseAllowedEmails(process.env.ALLOWED_EMAILS);
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

  const result = checkAccess(claims, { workspaceDomain, allowedEmails });
  if (!result.ok) return errorRedirect(req, result.reason);

  const token = await createSessionToken(sessionSecret, result.email);
  const dest = statePayload.next.startsWith("/") ? statePayload.next : "/inventory";
  const res = NextResponse.redirect(new URL(dest, req.url));
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
