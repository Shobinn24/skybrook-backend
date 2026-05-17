import { describe, it, expect, vi } from "vitest";
import {
  isTransientSourceError,
  runSourceWithRetry,
} from "@/lib/jobs/ingest-retry";
import type { SourceRunResult, SourceRunner } from "@/lib/jobs/ingest";

const FAKE_RESULT: SourceRunResult = {
  ok: true,
  rowCount: 1,
  rawPayload: {},
  schemaFingerprint: "fp",
  normalize: async () => {},
};

describe("isTransientSourceError", () => {
  it("treats Shopify HTTP 502/503/504 as transient", () => {
    expect(
      isTransientSourceError(
        new Error("shopify everdries-international.myshopify.com: HTTP 502 <!DOCTYPE html>..."),
      ),
    ).toBe(true);
    expect(isTransientSourceError(new Error("HTTP 503 Service Unavailable"))).toBe(true);
    expect(isTransientSourceError(new Error("HTTP 504 gateway timeout"))).toBe(true);
  });

  it("treats common network failure signatures as transient", () => {
    expect(isTransientSourceError(new Error("ECONNRESET"))).toBe(true);
    expect(isTransientSourceError(new Error("ETIMEDOUT"))).toBe(true);
    expect(isTransientSourceError(new Error("ECONNREFUSED"))).toBe(true);
    expect(isTransientSourceError(new Error("EAI_AGAIN getaddrinfo"))).toBe(true);
    expect(isTransientSourceError(new Error("socket hang up"))).toBe(true);
    expect(isTransientSourceError(new Error("fetch failed"))).toBe(true);
    expect(isTransientSourceError(new Error("Network error: read timeout"))).toBe(true);
  });

  it("treats Shopify HTTP 401/403 as transient (edge auth blips — see 2026-05-17 incident)", () => {
    expect(
      isTransientSourceError(
        new Error(
          'shopify everdries-international.myshopify.com: HTTP 401 {"errors":"[API] Invalid API key or access token (unrecognized login or wrong password)"}',
        ),
      ),
    ).toBe(true);
    expect(isTransientSourceError(new Error("HTTP 401 Unauthorized"))).toBe(true);
    expect(isTransientSourceError(new Error("HTTP 403 Forbidden"))).toBe(true);
  });

  it("does NOT treat 404 or 429 as transient — those don't fix themselves on blind retry", () => {
    expect(isTransientSourceError(new Error("HTTP 404 Not Found"))).toBe(false);
    expect(isTransientSourceError(new Error("HTTP 429 Too Many Requests"))).toBe(false);
  });

  it("does NOT treat parser / schema / shape errors as transient", () => {
    expect(isTransientSourceError(new Error("empty orders response"))).toBe(false);
    expect(
      isTransientSourceError(
        new Error("shopify everdries.myshopify.com: Field 'foo' doesn't exist on type 'Bar'"),
      ),
    ).toBe(false);
  });

  it("handles non-Error throws gracefully", () => {
    expect(isTransientSourceError("HTTP 502 Bad Gateway")).toBe(true);
    expect(isTransientSourceError("Unknown problem")).toBe(false);
    expect(isTransientSourceError(undefined)).toBe(false);
  });
});

describe("runSourceWithRetry", () => {
  it("returns the runner's first result when it succeeds on attempt 1", async () => {
    const runner: SourceRunner = vi.fn().mockResolvedValueOnce(FAKE_RESULT);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const result = await runSourceWithRetry({
      source: "shopify_us",
      runner,
      batchId: "batch-1",
      sleep,
    });
    expect(result).toBe(FAKE_RESULT);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries a transient 5xx until a subsequent attempt succeeds", async () => {
    const runner: SourceRunner = vi
      .fn()
      .mockRejectedValueOnce(new Error("shopify intl: HTTP 502 bad gateway"))
      .mockResolvedValueOnce(FAKE_RESULT);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const result = await runSourceWithRetry({
      source: "shopify_intl",
      runner,
      batchId: "batch-1",
      delaysMs: [10, 20],
      sleep,
    });
    expect(result).toBe(FAKE_RESULT);
    expect(runner).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(10);
  });

  it("exhausts all retries and rethrows the last error when transient errors keep happening", async () => {
    const runner: SourceRunner = vi
      .fn()
      .mockRejectedValue(new Error("shopify intl: HTTP 502 bad gateway"));
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(
      runSourceWithRetry({
        source: "shopify_intl",
        runner,
        batchId: "batch-1",
        delaysMs: [10, 20],
        sleep,
      }),
    ).rejects.toThrow(/HTTP 502/);
    // 1 initial + 2 retries = 3 attempts
    expect(runner).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 10);
    expect(sleep).toHaveBeenNthCalledWith(2, 20);
  });

  it("fails fast on non-transient errors — no retry, no sleep", async () => {
    const runner: SourceRunner = vi
      .fn()
      .mockRejectedValue(new Error("shopify intl: HTTP 422 Unprocessable Entity"));
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(
      runSourceWithRetry({
        source: "shopify_intl",
        runner,
        batchId: "batch-1",
        delaysMs: [10, 20],
        sleep,
      }),
    ).rejects.toThrow(/HTTP 422/);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("recovers a Shopify HTTP 401 (edge auth blip) on second attempt", async () => {
    const runner: SourceRunner = vi
      .fn()
      .mockRejectedValueOnce(
        new Error(
          'shopify everdries-international.myshopify.com: HTTP 401 {"errors":"[API] Invalid API key or access token (unrecognized login or wrong password)"}',
        ),
      )
      .mockResolvedValueOnce(FAKE_RESULT);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const result = await runSourceWithRetry({
      source: "shopify_intl",
      runner,
      batchId: "batch-1",
      delaysMs: [10, 20],
      sleep,
    });
    expect(result).toBe(FAKE_RESULT);
    expect(runner).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(10);
  });

  it("recovers a sheets source from a transient network error", async () => {
    const runner: SourceRunner = vi
      .fn()
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockResolvedValueOnce(FAKE_RESULT);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const result = await runSourceWithRetry({
      source: "sheets_inventory",
      runner,
      batchId: "batch-1",
      delaysMs: [10, 20],
      sleep,
    });
    expect(result).toBe(FAKE_RESULT);
    expect(runner).toHaveBeenCalledTimes(2);
  });
});
