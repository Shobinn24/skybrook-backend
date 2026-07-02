import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkAuthRoundTrip } from "@/lib/jobs/auth-roundtrip-check";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth";

const ORIGINAL_ENV = { ...process.env };
const SECRET = "unit-test-roundtrip-secret";

type FetchCall = { url: string; cookie: string };

// Cookie-aware fake of the deployed app: /api/auth/selfcheck behind a
// middleware that 200s a verifiable session cookie and 307-bounces anything
// else — the same contract the real middleware implements.
function stubAppFetch(overrides?: {
  validStatus?: number;
  garbageStatus?: number;
}) {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const cookie = String(
        (init?.headers as Record<string, string> | undefined)?.cookie ?? ""
      );
      calls.push({ url: String(url), cookie });
      const m = new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(cookie);
      const session = m ? await verifySessionToken(SECRET, m[1]) : null;
      const status = session
        ? (overrides?.validStatus ?? 200)
        : (overrides?.garbageStatus ?? 307);
      return new Response(status === 200 ? JSON.stringify({ ok: true }) : null, {
        status,
        headers: status === 307 ? { location: "https://app.example/login?next=%2F" } : {},
      });
    })
  );
  return calls;
}

describe("checkAuthRoundTrip", () => {
  beforeEach(() => {
    process.env.SESSION_SECRET = SECRET;
  });
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("warns (not configured) when SESSION_SECRET is unset", async () => {
    delete process.env.SESSION_SECRET;
    const res = await checkAuthRoundTrip();
    expect(res.name).toBe("auth_round_trip");
    expect(res.status).toBe("warn");
    expect(res.detail).toContain("not configured");
  });

  it("passes when a signed cookie gets through and a garbage cookie bounces", async () => {
    stubAppFetch();
    const res = await checkAuthRoundTrip({ baseUrl: "https://app.example" });
    expect(res.status).toBe("pass");
  });

  it("sends a genuinely verifiable session cookie to the selfcheck route", async () => {
    const calls = stubAppFetch();
    await checkAuthRoundTrip({ baseUrl: "https://app.example" });
    const probe = calls.find((c) => c.url === "https://app.example/api/auth/selfcheck");
    expect(probe).toBeDefined();
    const m = new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(probe!.cookie);
    expect(m).not.toBeNull();
    expect(await verifySessionToken(SECRET, m![1])).not.toBeNull();
  });

  it("fails when the middleware bounces a freshly signed session (the 2026-07-01 outage shape)", async () => {
    stubAppFetch({ validStatus: 307 });
    const res = await checkAuthRoundTrip({ baseUrl: "https://app.example" });
    expect(res.status).toBe("fail");
    expect(res.detail).toContain("bounced");
  });

  it("fails when a garbage cookie is accepted (middleware not gating)", async () => {
    stubAppFetch({ garbageStatus: 200 });
    const res = await checkAuthRoundTrip({ baseUrl: "https://app.example" });
    expect(res.status).toBe("fail");
    expect(res.detail).toContain("not gating");
  });

  it("warns (unreachable) when the self-fetch throws, without failing overall health", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")));
    const res = await checkAuthRoundTrip({ baseUrl: "https://app.example" });
    expect(res.status).toBe("warn");
    expect(res.detail).toContain("unreachable");
  });

  it("defaults the base URL to loopback on PORT", async () => {
    process.env.PORT = "8123";
    const calls = stubAppFetch();
    await checkAuthRoundTrip();
    expect(calls[0].url).toBe("http://127.0.0.1:8123/api/auth/selfcheck");
  });
});
