import type { SourceKey, SourceRunResult, SourceRunner } from "./ingest";
import { logger } from "@/lib/logger";

// Backoff schedule between attempts. Length = number of retries; total
// attempts = length + 1. Tuned to absorb a single transient 5xx or
// network blip from Shopify (Cloudflare-fronted) or Sheets without
// blowing the cron's overall time budget. Concrete trigger: 2026-05-13
// 14:03 UTC shopify_intl HTTP 502 from Cloudflare — INTL went stale for
// the day until manual re-trigger.
const RETRY_DELAYS_MS: ReadonlyArray<number> = [15_000, 30_000];

// Match upstream 5xx (anywhere in the message), plus 401/403 from Shopify
// (their Cloudflare-fronted edge has briefly returned 401 "Invalid API key
// or access token" on tokens it had just legitimately minted — see
// 2026-05-17 09:03 UTC incident where both shopify_us + shopify_intl
// 401'd simultaneously on freshly-issued tokens, then succeeded on the
// next call ~12h later with no credential change), plus the common
// node/undici network failure signatures. We still do NOT retry on
// 404 (resource-shape problem) or 429 (rate limit — needs Retry-After
// honoring, not blind 15s retry) — those don't fix themselves.
const TRANSIENT_HTTP_PATTERN = /\bHTTP (?:5\d\d|401|403)\b/;
const TRANSIENT_NETWORK_PATTERNS: ReadonlyArray<RegExp> = [
  /ECONNRESET/,
  /ETIMEDOUT/,
  /ECONNREFUSED/,
  /EAI_AGAIN/,
  /socket hang up/i,
  /network (?:error|timeout)/i,
  /fetch failed/i,
];

export function isTransientSourceError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (TRANSIENT_HTTP_PATTERN.test(msg)) return true;
  return TRANSIENT_NETWORK_PATTERNS.some((p) => p.test(msg));
}

/**
 * Wrap a source runner with bounded retry on transient errors. Each
 * retry is logged so the recovery is visible alongside the eventual
 * `ingest.source.success` (or final `ingest.source.failed`).
 */
export async function runSourceWithRetry(opts: {
  source: SourceKey;
  runner: SourceRunner;
  batchId: string;
  delaysMs?: ReadonlyArray<number>;
  sleep?: (ms: number) => Promise<void>;
}): Promise<SourceRunResult> {
  const delays = opts.delaysMs ?? RETRY_DELAYS_MS;
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  let lastErr: unknown;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return await opts.runner(opts.batchId);
    } catch (err) {
      lastErr = err;
      const isLast = attempt >= delays.length;
      const transient = isTransientSourceError(err);
      if (isLast || !transient) {
        if (attempt > 0) {
          // Retried but ultimately failed — log final state with
          // attempts taken so the operator can tell exhausted-retry
          // from never-retried.
          const message = err instanceof Error ? err.message : String(err);
          logger.warn("ingest.source.retry.exhausted", {
            source: opts.source,
            batchId: opts.batchId,
            attempts: attempt + 1,
            error: message.slice(0, 500),
          });
        }
        throw err;
      }
      const delay = delays[attempt];
      const message = err instanceof Error ? err.message : String(err);
      logger.warn("ingest.source.retry", {
        source: opts.source,
        batchId: opts.batchId,
        attempt: attempt + 1,
        nextAttemptInMs: delay,
        error: message.slice(0, 500),
      });
      await sleep(delay);
    }
  }
  // Unreachable — loop always either returns or throws — but TS
  // doesn't know that without an explicit fallthrough.
  throw lastErr;
}
