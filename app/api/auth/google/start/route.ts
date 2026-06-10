import { NextResponse } from "next/server";
import { appOrigin, createOAuthStateToken } from "@/lib/auth";

export const runtime = "nodejs";

const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";

function safeNext(raw: string | null): string {
  if (!raw) return "/inventory";
  // Must be an in-app path — reject protocol-relative and absolute URLs.
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/inventory";
  return raw;
}

function callbackUrl(req: Request): string {
  return `${appOrigin(req)}/api/auth/google/callback`;
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
  // Deliberately NO `hd` hint: it made Google pre-fill
  // "@<workspace-domain>" on the sign-in screen, which read as
  // "workspace email required" to the external media buyers (owner
  // report 2026-06-10). It was never a security control — the callback
  // validates hd + the allowlists regardless — so dropping it only
  // neutralizes the account picker.

  return NextResponse.redirect(authUrl.toString());
}
