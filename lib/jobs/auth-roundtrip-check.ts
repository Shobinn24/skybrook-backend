// Auth round-trip self-check: signs a session token in the Node runtime and
// fetches the protected /api/auth/selfcheck route with it, so the request
// passes through the REAL middleware (Edge sandbox) verify path. An
// in-process verifySessionToken call would NOT catch the 2026-07-01 outage
// class — that bug only manifested across the Node-sign → Edge-verify realm
// boundary (raw ArrayBuffers failing WebCrypto instanceof checks in the
// sandbox on some Node versions). Crossing the boundary via a real HTTP
// request is the point of this check.
//
// Status semantics (mirrors the whatsapp_bridge warn pattern, but escalates
// to "fail" on a definitive auth break):
// - "fail"  → the round trip definitively shows the login gate is broken:
//             a freshly signed cookie bounced, or a garbage cookie was let
//             through. Every dashboard page is unusable/unprotected — page-
//             worthy, so this flips overall → HTTP 503 → healthchecks.io red.
// - "warn"  → the probe could not run (secret unset, self-fetch unreachable
//             or odd status). Infra noise, not proof of an auth break; keep
//             the endpoint 200 like the bridge's "unreachable" case.
import { createSessionToken, SESSION_COOKIE } from "@/lib/auth";

export type AuthRoundTripResult = {
  name: "auth_round_trip";
  status: "pass" | "fail" | "warn";
  detail: string;
};

const NAME = "auth_round_trip" as const;

export async function checkAuthRoundTrip(opts?: {
  baseUrl?: string;
  timeoutMs?: number;
}): Promise<AuthRoundTripResult> {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    return { name: NAME, status: "warn", detail: "not configured (SESSION_SECRET unset)" };
  }

  // Loop back to this same server: the middleware runs in-process, so
  // loopback crosses the sandbox realm boundary without depending on the
  // public edge / external DNS. PORT is set by Railway; 3000 = next default.
  const base =
    opts?.baseUrl ?? `http://127.0.0.1:${process.env.PORT ?? 3000}`;
  const timeoutMs = opts?.timeoutMs ?? 5000;
  const target = `${base.replace(/\/$/, "")}/api/auth/selfcheck`;

  const probe = (cookieValue: string) =>
    fetch(target, {
      headers: { cookie: `${SESSION_COOKIE}=${cookieValue}` },
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });

  try {
    const token = await createSessionToken(secret, "auth-selfcheck@internal.invalid");
    const valid = await probe(token);

    if (valid.status >= 300 && valid.status < 400) {
      const loc = valid.headers.get("location") ?? "?";
      return {
        name: NAME,
        status: "fail",
        detail: `middleware bounced a freshly signed session (HTTP ${valid.status} -> ${loc})`.slice(0, 160),
      };
    }
    if (valid.status !== 200) {
      return {
        name: NAME,
        status: "warn",
        detail: `unexpected HTTP ${valid.status} from selfcheck route`,
      };
    }

    // Negative control: a garbage cookie must bounce. If it reaches the
    // route, the middleware isn't gating at all (e.g. matcher regression or
    // the selfcheck path accidentally added to PUBLIC_PATHS).
    const garbage = await probe("not.a-real-token");
    if (garbage.status === 200) {
      return {
        name: NAME,
        status: "fail",
        detail: "middleware not gating: garbage cookie reached the selfcheck route",
      };
    }

    return {
      name: NAME,
      status: "pass",
      detail: "signed cookie verified through middleware; garbage cookie bounced",
    };
  } catch (e) {
    return {
      name: NAME,
      status: "warn",
      detail: `unreachable: ${e instanceof Error ? e.message : String(e)}`.slice(0, 120),
    };
  }
}
