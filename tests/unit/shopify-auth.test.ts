import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetTokenCacheForTests,
  fetchAccessToken,
  getShopifyAccessToken,
} from "@/lib/sources/shopify-auth";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.SHOPIFY_API_KEY = "test_client_id";
  process.env.SHOPIFY_API_SECRET = "test_client_secret";
  _resetTokenCacheForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  process.env = { ...ORIGINAL_ENV };
});

describe("fetchAccessToken", () => {
  it("posts form-encoded client_credentials and returns the parsed body", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch" as never).mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "shpat_abc123",
          scope: "read_inventory,read_products,read_reports",
          expires_in: 86399,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      ) as never
    );

    const out = await fetchAccessToken("everdries.myshopify.com");

    expect(out.access_token).toBe("shpat_abc123");
    expect(out.expires_in).toBe(86399);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [calledUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe("https://everdries.myshopify.com/admin/oauth/access_token");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({
      grant_type: "client_credentials",
      client_id: "test_client_id",
      client_secret: "test_client_secret",
    });
  });

  it("throws with status + body on non-OK response", async () => {
    vi.spyOn(globalThis, "fetch" as never).mockResolvedValue(
      new Response("invalid_client", { status: 401 }) as never
    );
    await expect(fetchAccessToken("bad.myshopify.com")).rejects.toThrow(/HTTP 401/);
  });

  it("throws when env credentials are missing", async () => {
    delete process.env.SHOPIFY_API_KEY;
    await expect(fetchAccessToken("x.myshopify.com")).rejects.toThrow(/SHOPIFY_API_KEY/);
  });
});

describe("getShopifyAccessToken caching", () => {
  it("caches per-store and only hits the network once within TTL", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch" as never).mockResolvedValue(
      new Response(
        JSON.stringify({ access_token: "tok_1", scope: "x", expires_in: 86399 }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      ) as never
    );

    const a = await getShopifyAccessToken("a.myshopify.com");
    const b = await getShopifyAccessToken("a.myshopify.com");
    expect(a).toBe("tok_1");
    expect(b).toBe("tok_1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("caches separately per store", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch" as never)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ access_token: "tok_us", scope: "x", expires_in: 86399 }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        ) as never
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ access_token: "tok_intl", scope: "x", expires_in: 86399 }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        ) as never
      );

    const us = await getShopifyAccessToken("us.myshopify.com");
    const intl = await getShopifyAccessToken("intl.myshopify.com");
    expect(us).toBe("tok_us");
    expect(intl).toBe("tok_intl");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("refreshes when the cached token is past expiry (with 60s safety margin)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-23T12:00:00Z"));
    const fetchMock = vi
      .spyOn(globalThis, "fetch" as never)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ access_token: "tok_v1", scope: "x", expires_in: 60 }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        ) as never
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ access_token: "tok_v2", scope: "x", expires_in: 86399 }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        ) as never
      );

    // First call: stores tok_v1 with expiresAt = now + (60_000 - 60_000) = now → already expired.
    const v1 = await getShopifyAccessToken("a.myshopify.com");
    expect(v1).toBe("tok_v1");
    // Advance 1 ms past expiry → next call refreshes.
    vi.setSystemTime(new Date("2026-04-23T12:00:00.001Z"));
    const v2 = await getShopifyAccessToken("a.myshopify.com");
    expect(v2).toBe("tok_v2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects empty store argument", async () => {
    await expect(getShopifyAccessToken("")).rejects.toThrow(/store URL required/);
  });
});
