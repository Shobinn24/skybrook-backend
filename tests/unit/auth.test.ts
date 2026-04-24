import { describe, it, expect } from "vitest";
import {
  checkAccess,
  createOAuthStateToken,
  createSessionToken,
  decodeIdToken,
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
