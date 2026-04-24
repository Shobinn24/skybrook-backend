import { NextResponse } from "next/server";
import { createOAuthStateToken } from "@/lib/auth";

export const runtime = "nodejs";

const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";

function safeNext(raw: string | null): string {
  if (!raw) return "/inventory";
  // Must be an in-app path — reject protocol-relative and absolute URLs.
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/inventory";
  return raw;
}

function callbackUrl(req: Request): string {
  const override = process.env.APP_URL;
  const origin = override ? override.replace(/\/$/, "") : new URL(req.url).origin;
  return `${origin}/api/auth/google/callback`;
}

export async function GET(req: Request) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const sessionSecret = process.env.SESSION_SECRET;
  const workspaceDomain = process.env.GOOGLE_WORKSPACE_DOMAIN;
  if (!clientId || !sessionSecret || !workspaceDomain) {
    return NextResponse.json(
      { error: "Google SSO is not configured on the server" },
      { status: 500 }
    );
  }

  const url = new URL(req.url);
  const next = safeNext(url.searchParams.get("next"));
  const state = await createOAuthStateToken(sessionSecret, next);

  const authUrl = new URL(GOOGLE_AUTH_ENDPOINT);
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", callbackUrl(req));
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", "openid email profile");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("access_type", "online");
  authUrl.searchParams.set("prompt", "select_account");
  // `hd` hints Google to pre-filter the account picker to Workspace accounts on
  // this domain. Not a security control — the callback re-validates `hd`.
  authUrl.searchParams.set("hd", workspaceDomain);

  return NextResponse.redirect(authUrl.toString());
}
