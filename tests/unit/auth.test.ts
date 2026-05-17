import { describe, it, expect, afterEach } from "vitest";
import {
  appOrigin,
  checkAccess,
  createOAuthStateToken,
  createSessionToken,
  decodeIdToken,
  getUserRole,
  isMarketingAllowedPath,
  parseAllowedEmails,
  verifyOAuthStateToken,
  verifySessionToken,
  type GoogleIdTokenClaims,
} from "@/lib/auth";

const SECRET = "test-secret-never-use-in-prod";

// Build a minimal unsigned JWT so decodeIdToken has a real payload to parse.
// decodeIdToken does not verify the signature (see comment in lib/auth.ts),
// so we only need a syntactically valid 3-segment token.
function fakeJwt(claims: Record<string, unknown>): string {
  const b64 = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=/g, "");
  return `${b64({ alg: "RS256" })}.${b64(claims)}.sig`;
}

function baseClaims(overrides: Partial<GoogleIdTokenClaims> = {}): GoogleIdTokenClaims {
  return {
    iss: "https://accounts.google.com",
    aud: "client-id",
    sub: "123",
    email: "scott@everdries.com",
    email_verified: true,
    hd: "everdries.com",
    exp: Math.floor(Date.now() / 1000) + 3600,
    iat: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

describe("session tokens", () => {
  it("round-trips email through a signed session cookie", async () => {
    const token = await createSessionToken(SECRET, "scott@everdries.com");
    const payload = await verifySessionToken(SECRET, token);
    expect(payload?.email).toBe("scott@everdries.com");
    expect(typeof payload?.iat).toBe("number");
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await createSessionToken(SECRET, "scott@everdries.com");
    expect(await verifySessionToken("wrong-secret", token)).toBeNull();
  });

  it("rejects a malformed token", async () => {
    expect(await verifySessionToken(SECRET, "not-a-token")).toBeNull();
    expect(await verifySessionToken(SECRET, "")).toBeNull();
    expect(await verifySessionToken(SECRET, "a.b.c")).toBeNull();
  });
});

describe("oauth state tokens", () => {
  it("round-trips the next-path through a signed state token", async () => {
    const token = await createOAuthStateToken(SECRET, "/sustainability");
    const payload = await verifyOAuthStateToken(SECRET, token);
    expect(payload?.next).toBe("/sustainability");
    expect(payload?.nonce).toBeTruthy();
  });

  it("rejects a tampered state token", async () => {
    const token = await createOAuthStateToken(SECRET, "/inventory");
    // Flip a char in the payload segment.
    const [payload, sig] = token.split(".");
    const tampered = `${payload.slice(0, -1)}${payload.endsWith("A") ? "B" : "A"}.${sig}`;
    expect(await verifyOAuthStateToken(SECRET, tampered)).toBeNull();
  });
});

describe("decodeIdToken", () => {
  it("extracts claims from a well-formed JWT payload", () => {
    const token = fakeJwt({ email: "user@everdries.com", hd: "everdries.com" });
    const claims = decodeIdToken(token);
    expect(claims?.email).toBe("user@everdries.com");
    expect(claims?.hd).toBe("everdries.com");
  });

  it("returns null for a non-JWT string", () => {
    expect(decodeIdToken("not.a.jwt-style-thing-maybe")).toBeNull();
    expect(decodeIdToken("onlytwo.parts")).toBeNull();
  });
});

describe("checkAccess", () => {
  const opts = { workspaceDomain: "everdries.com" };

  it("allows a verified workspace user", () => {
    const result = checkAccess(baseClaims(), opts);
    expect(result).toEqual({ ok: true, email: "scott@everdries.com" });
  });

  it("rejects when email is missing", () => {
    const result = checkAccess(baseClaims({ email: undefined }), opts);
    expect(result).toEqual({ ok: false, reason: "no_email" });
  });

  it("rejects when email is not verified", () => {
    const result = checkAccess(baseClaims({ email_verified: false }), opts);
    expect(result).toEqual({ ok: false, reason: "email_unverified" });
  });

  it("rejects when hd claim does not match workspace domain", () => {
    const result = checkAccess(
      baseClaims({ hd: "attacker.com", email: "scott@attacker.com" }),
      opts
    );
    expect(result).toEqual({ ok: false, reason: "bad_domain" });
  });

  it("rejects when hd is missing even if email suffix looks right", () => {
    // Consumer gmail accounts never have `hd` — this guards against spoofing.
    const result = checkAccess(baseClaims({ hd: undefined }), opts);
    expect(result).toEqual({ ok: false, reason: "bad_domain" });
  });

  it("rejects when email suffix and hd disagree", () => {
    const result = checkAccess(
      baseClaims({ email: "scott@other.com", hd: "everdries.com" }),
      opts
    );
    expect(result).toEqual({ ok: false, reason: "bad_domain" });
  });

  it("allowlist: lets listed emails through", () => {
    const result = checkAccess(baseClaims(), {
      ...opts,
      allowedEmails: ["scott@everdries.com", "jasper@everdries.com"],
    });
    expect(result.ok).toBe(true);
  });

  it("allowlist: blocks emails not on the list even if hd matches", () => {
    const result = checkAccess(baseClaims({ email: "intern@everdries.com" }), {
      ...opts,
      allowedEmails: ["scott@everdries.com"],
    });
    expect(result).toEqual({ ok: false, reason: "not_allowed" });
  });

  it("allowlist: case-insensitive match", () => {
    const result = checkAccess(baseClaims({ email: "Scott@Everdries.COM" }), {
      ...opts,
      allowedEmails: ["SCOTT@everdries.com"],
    });
    expect(result.ok).toBe(true);
  });

  // External-allowlist: 2026-05-09 — let collaborators outside the
  // workspace domain in (Shobinn's gmail). Bypasses hd/suffix check
  // for explicitly listed addresses; still requires email_verified.
  it("external allowlist: lets a non-workspace email through (no hd claim, gmail.com suffix)", () => {
    const result = checkAccess(
      baseClaims({ email: "shobinn24@gmail.com", hd: undefined }),
      { ...opts, externalAllowedEmails: ["shobinn24@gmail.com"] },
    );
    expect(result).toEqual({ ok: true, email: "shobinn24@gmail.com" });
  });

  it("external allowlist: case-insensitive match", () => {
    const result = checkAccess(
      baseClaims({ email: "Shobinn24@GMAIL.com", hd: undefined }),
      { ...opts, externalAllowedEmails: ["SHOBINN24@gmail.com"] },
    );
    expect(result.ok).toBe(true);
  });

  it("external allowlist: still requires email_verified", () => {
    const result = checkAccess(
      baseClaims({ email: "shobinn24@gmail.com", hd: undefined, email_verified: false }),
      { ...opts, externalAllowedEmails: ["shobinn24@gmail.com"] },
    );
    expect(result).toEqual({ ok: false, reason: "email_unverified" });
  });

  it("external allowlist: non-listed gmail still blocked by bad_domain", () => {
    const result = checkAccess(
      baseClaims({ email: "stranger@gmail.com", hd: undefined }),
      { ...opts, externalAllowedEmails: ["shobinn24@gmail.com"] },
    );
    expect(result).toEqual({ ok: false, reason: "bad_domain" });
  });

  it("external allowlist: empty list preserves original workspace-only behavior", () => {
    const result = checkAccess(
      baseClaims({ email: "shobinn24@gmail.com", hd: undefined }),
      { ...opts, externalAllowedEmails: [] },
    );
    expect(result).toEqual({ ok: false, reason: "bad_domain" });
  });
});

describe("parseAllowedEmails", () => {
  it("returns an empty list for undefined or empty", () => {
    expect(parseAllowedEmails(undefined)).toEqual([]);
    expect(parseAllowedEmails("")).toEqual([]);
    expect(parseAllowedEmails("   ")).toEqual([]);
  });

  it("trims, lowercases, and filters empties", () => {
    expect(parseAllowedEmails("Scott@Everdries.com, ,Jasper@everdries.com")).toEqual([
      "scott@everdries.com",
      "jasper@everdries.com",
    ]);
  });
});

describe("appOrigin", () => {
  // appOrigin powers all auth-flow redirects. The bug it fixes: on
  // Railway/proxied deploys, `req.url` reports an internal upstream
  // origin (often `http://localhost:<port>`), so any redirect built
  // from it sends the browser to an unreachable URL. APP_URL gives us
  // a deterministic public origin that survives the proxy hop.

  const ORIGINAL_APP_URL = process.env.APP_URL;
  afterEach(() => {
    if (ORIGINAL_APP_URL === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = ORIGINAL_APP_URL;
  });

  function reqOf(url: string): Request {
    return new Request(url);
  }

  it("uses APP_URL when set, ignoring the request URL", () => {
    process.env.APP_URL = "https://skybrook-backend-production.up.railway.app";
    expect(appOrigin(reqOf("http://localhost:8080/api/auth/google/callback?code=x"))).toBe(
      "https://skybrook-backend-production.up.railway.app"
    );
  });

  it("strips a trailing slash from APP_URL so URL composition works", () => {
    process.env.APP_URL = "https://skybrook.example.com/";
    expect(appOrigin(reqOf("http://localhost:8080/anything"))).toBe(
      "https://skybrook.example.com"
    );
  });

  it("falls back to the request URL origin when APP_URL is unset (local dev)", () => {
    delete process.env.APP_URL;
    expect(appOrigin(reqOf("http://localhost:3000/api/auth/google/callback"))).toBe(
      "http://localhost:3000"
    );
  });

  it("composes a usable redirect URL with new URL(path, appOrigin(req))", () => {
    process.env.APP_URL = "https://skybrook.example.com";
    const redirect = new URL("/inventory", appOrigin(reqOf("http://localhost:8080/api/auth/google/callback?code=x")));
    expect(redirect.toString()).toBe("https://skybrook.example.com/inventory");
  });
});

describe("getUserRole (Scott 2026-05-15 marketing scoping)", () => {
  afterEach(() => {
    delete process.env.SKYBROOK_MARKETING_EMAILS;
  });

  it("defaults to ops when SKYBROOK_MARKETING_EMAILS is unset", () => {
    expect(getUserRole("anyone@everdries.com")).toBe("ops");
  });

  it("defaults to ops when SKYBROOK_MARKETING_EMAILS is empty", () => {
    process.env.SKYBROOK_MARKETING_EMAILS = "";
    expect(getUserRole("anyone@everdries.com")).toBe("ops");
  });

  it("returns marketing when the email is in the env list (case-insensitive)", () => {
    process.env.SKYBROOK_MARKETING_EMAILS = "Craig@everdries.com,nate@everdries.com";
    expect(getUserRole("craig@everdries.com")).toBe("marketing");
    expect(getUserRole("NATE@everdries.com")).toBe("marketing");
  });

  it("returns ops when the email is signed in but not on the marketing list", () => {
    process.env.SKYBROOK_MARKETING_EMAILS = "craig@everdries.com";
    expect(getUserRole("scott@everdries.com")).toBe("ops");
  });

  it("treats null / undefined / empty email as ops (no signed-in user yet)", () => {
    process.env.SKYBROOK_MARKETING_EMAILS = "craig@everdries.com";
    expect(getUserRole(null)).toBe("ops");
    expect(getUserRole(undefined)).toBe("ops");
    expect(getUserRole("")).toBe("ops");
  });

  it("accepts an explicit override list (bypasses env read)", () => {
    process.env.SKYBROOK_MARKETING_EMAILS = "scott@everdries.com";
    // Override should win — scott is ops here because the explicit list
    // doesn't include him.
    expect(getUserRole("scott@everdries.com", "craig@everdries.com")).toBe("ops");
    expect(getUserRole("craig@everdries.com", "craig@everdries.com")).toBe("marketing");
  });
});

describe("isMarketingAllowedPath", () => {
  it("allows the 4 marketing pages and their subpaths", () => {
    expect(isMarketingAllowedPath("/launches")).toBe(true);
    expect(isMarketingAllowedPath("/launches/sku/X")).toBe(true);
    expect(isMarketingAllowedPath("/fb-ads")).toBe(true);
    expect(isMarketingAllowedPath("/fb-ads/anything")).toBe(true);
    expect(isMarketingAllowedPath("/bonus-tracker")).toBe(true);
    expect(isMarketingAllowedPath("/performance")).toBe(true);
  });

  it("allows all tRPC paths (Phase 1 leaves per-procedure gating to follow-up)", () => {
    expect(isMarketingAllowedPath("/api/trpc/inventory.getPerformance")).toBe(true);
    expect(isMarketingAllowedPath("/api/trpc/inventory.getBonusTracker")).toBe(true);
    // Phase 1 known gap: ops-only procedures aren't blocked at this layer.
    expect(isMarketingAllowedPath("/api/trpc/inventory.getInventoryRows")).toBe(true);
  });

  it("blocks ops-only pages", () => {
    expect(isMarketingAllowedPath("/inventory")).toBe(false);
    expect(isMarketingAllowedPath("/incoming")).toBe(false);
    expect(isMarketingAllowedPath("/sustainability")).toBe(false);
    expect(isMarketingAllowedPath("/overstock")).toBe(false);
    expect(isMarketingAllowedPath("/stock-value")).toBe(false);
    expect(isMarketingAllowedPath("/admin/product-names")).toBe(false);
    expect(isMarketingAllowedPath("/pipeline")).toBe(false);
    expect(isMarketingAllowedPath("/sku/EV-OG-5X-XS")).toBe(false);
    expect(isMarketingAllowedPath("/")).toBe(false);
  });

  it("does not match a similarly-prefixed path (no false positives)", () => {
    // "/launches-history" must NOT match "/launches" — only exact path or
    // path + "/" subroutes count.
    expect(isMarketingAllowedPath("/launches-history")).toBe(false);
    expect(isMarketingAllowedPath("/performance-old")).toBe(false);
  });
});
