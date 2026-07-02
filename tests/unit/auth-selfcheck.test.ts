import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "@/middleware";
import { createSessionToken, SESSION_COOKIE } from "@/lib/auth";

const ORIGINAL_ENV = { ...process.env };
const SECRET = "unit-test-session-secret";

function req(path: string, cookie?: string) {
  return new NextRequest(`https://app.example${path}`, {
    headers: cookie ? { cookie } : {},
  });
}

describe("auth self-check route + middleware gating", () => {
  beforeEach(() => {
    process.env.SESSION_SECRET = SECRET;
  });
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("GET /api/auth/selfcheck returns 200 ok:true (no DB, no side effects)", async () => {
    const { GET } = await import("@/app/api/auth/selfcheck/route");
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("middleware gates /api/auth/selfcheck: no cookie bounces to /login", async () => {
    const res = await middleware(req("/api/auth/selfcheck"));
    expect(res!.status).toBe(307);
    expect(res!.headers.get("location")).toContain("/login");
  });

  it("middleware gates /api/auth/selfcheck: garbage cookie bounces to /login", async () => {
    const res = await middleware(
      req("/api/auth/selfcheck", `${SESSION_COOKIE}=not.a-real-token`)
    );
    expect(res!.status).toBe(307);
    expect(res!.headers.get("location")).toContain("/login");
  });

  it("middleware passes /api/auth/selfcheck through for a freshly signed session", async () => {
    const token = await createSessionToken(SECRET, "auth-selfcheck@internal.invalid");
    const res = await middleware(
      req("/api/auth/selfcheck", `${SESSION_COOKIE}=${token}`)
    );
    expect(res!.status).toBe(200);
    expect(res!.headers.get("location")).toBeNull();
  });
});
