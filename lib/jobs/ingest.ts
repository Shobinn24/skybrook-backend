import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { dataPulls, rawPulls } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { postAlert, resolveAlert } from "@/lib/notifications/slack";
import { runSourceWithRetry } from "./ingest-retry";

export type SourceKey =
  | "sheets_inventory"
  | "sheets_incoming"
  | "sheets_ad_spend"
  | "sheets_fb_ads"
  | "sheets_fb_campaigns"
  | "sheets_applovin"
  | "sheets_fb_geo"
  | "sheets_fb_url_map"
  | "sheets_fb_product_map"
  | "shopify_us"
  | "shopify_intl";

export type SourceRunResult = {
  ok: true;
  rowCount: number;
  rawPayload: unknown;
  schemaFingerprint: string;
  // Optional list of per-source data-quality issues detected during the
  // run but NOT severe enough to fail the whole source. Today this is
  // Supermetrics inline error rows (license lapse, quota exhaustion,
  // connector auth expired) — the source pull "succeeded" in that good
  // rows landed, but a subset of tabs returned error strings instead of
  // data. Each entry triggers a P1 Slack alert with a stable dedup key
  // so the same upstream error doesn't re-page on every cron.
  sourceErrors?: Array<{
    tab: string;
    signature: string;
    sample: string;
  }>;
  normalize: (rawId: string) => Promise<void>;
};

export type SourceRunner = (batchId: string) => Promise<SourceRunResult>;

export type RunIngestResult = {
  batchId: string;
  // Counts of Slack alert side-effects fired during this batch. Captured
  // so the cron summary log can show whether the alert path actually
  // worked — without these the only way to verify a fire is to query
  // alert_events directly (cost real diagnosis time on 2026-05-17 incident).
  alertsFired: number;
  alertsResolved: number;
  // True when another ingest already held the advisory lock and this run
  // bailed without touching anything.
  skipped?: boolean;
};

// Single advisory-lock key shared by every ingest entry point (daily cron,
// GH Actions fallback, sheet-poll trigger, refresh-ad-spend, manual GET).
// Two delete-then-insert ingests overlapping under READ COMMITTED can both
// insert (B's DELETE can't see rows A committed after B's statement
// snapshot) — daily_sales/ad_spend_daily survive via composite PKs, but
// incoming_shipments would silently double its PO quantities. The lock
// makes overlap impossible; the unique index on incoming_shipments is the
// belt-and-suspenders.
const INGEST_ADVISORY_LOCK_KEY = 815_001;

export async function runIngest(input: {
  sources: Partial<Record<SourceKey, SourceRunner>>;
}): Promise<RunIngestResult> {
  const batchId = randomUUID();
  // Transaction-scoped advisory lock (pg_try_advisory_xact_lock) instead of
  // a session lock: with a pooled driver, lock and unlock could land on
  // different connections, leaking the session lock until the pool recycles.
  // The wrapper transaction does nothing but hold the lock — every write
  // inside the sources still commits in its own transaction, so failure
  // isolation between sources is unchanged.
  return await db.transaction(async (lockTx) => {
    const lockRows = await lockTx.execute(
      sql`select pg_try_advisory_xact_lock(${INGEST_ADVISORY_LOCK_KEY}) as locked`,
    );
    const locked = Boolean(
      (lockRows as unknown as Array<{ locked: boolean }>)[0]?.locked,
    );
    if (!locked) {
      logger.warn("ingest.skipped_lock_held", { batchId });
      return { batchId, alertsFired: 0, alertsResolved: 0, skipped: true };
    }
    return runIngestLocked(batchId, input);
  });
}

async function runIngestLocked(
  batchId: string,
  input: { sources: Partial<Record<SourceKey, SourceRunner>> },
): Promise<RunIngestResult> {
  logger.info("ingest.start", { batchId });

  // Track Slack alert side-effects so they show up in cron.ingest.done.
  // Push every postAlert/resolveAlert promise here; we Promise.allSettled
  // them after the source loop so per-source paths stay fire-and-forget
  // (a slow Slack post never delays the source itself) but we still
  // arrive at a deterministic count by the time runIngest returns.
  const alertPromises: Promise<{ kind: "fired" | "resolved" | "noop" }>[] = [];

  const entries = Object.entries(input.sources) as [SourceKey, SourceRunner][];
  await Promise.allSettled(
    entries.map(async ([source, runner]) => {
      const startedAt = new Date();
      try {
        const result = await runSourceWithRetry({ source, runner, batchId });
        const [raw] = await db
          .insert(rawPulls)
          .values({
            source,
            pullBatchId: batchId,
            payload: result.rawPayload as object,
            rowCount: result.rowCount,
            schemaFingerprint: result.schemaFingerprint,
          })
          .returning({ id: rawPulls.id });
        await result.normalize(raw.id);
        await db.insert(dataPulls).values({
          pullBatchId: batchId,
          source,
          startedAt,
          finishedAt: new Date(),
          status: "success",
          rowCount: result.rowCount,
          rawPullId: raw.id,
        });
        logger.info("ingest.source.success", { source, batchId, rowCount: result.rowCount });
        // If this source had been failing in prior runs, the open alert
        // is now stale — close it and post a "resolved" follow-up. No-op
        // when nothing was open. Fire-and-forget: the recovery path must
        // never become flakier than the failure path.
        alertPromises.push(
          resolveAlert(`ingest.source.failed:${source}`)
            .then((r) => ({ kind: r.resolved > 0 ? ("resolved" as const) : ("noop" as const) }))
            .catch((e) => {
              logger.warn("alert.resolve.threw", {
                source,
                error: e instanceof Error ? e.message : String(e),
              });
              return { kind: "noop" as const };
            }),
        );
        // Surface per-tab source errors (Supermetrics inline error rows).
        // Source pull as a whole succeeded — good tabs landed — but one
        // or more tabs returned error strings instead of data. Dedup
        // per (source, tab, signature) so Slack pages once per distinct
        // upstream error, not once per cron tick.
        for (const e of result.sourceErrors ?? []) {
          const dedupKey = `ingest.source.row_error:${source}:${e.tab}:${e.signature.slice(0, 80)}`;
          alertPromises.push(
            postAlert({
              severity: "p1",
              title: `${source} / ${e.tab}: upstream returned an error row`,
              dedupKey,
              fields: {
                source,
                tab: e.tab,
                signature: e.signature,
                sample: e.sample,
                batchId,
              },
            })
              .then((r) => ({ kind: r.fired ? ("fired" as const) : ("noop" as const) }))
              .catch((alertErr) => {
                logger.warn("alert.post.threw", {
                  source,
                  tab: e.tab,
                  error: alertErr instanceof Error ? alertErr.message : String(alertErr),
                });
                return { kind: "noop" as const };
              }),
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await db.insert(dataPulls).values({
          pullBatchId: batchId,
          source,
          startedAt,
          finishedAt: new Date(),
          status: "failed",
          errorMessage: message,
        });
        logger.error("ingest.source.failed", { source, batchId, error: message });
        // Fire-and-forget Slack alert. Dedup key per source prevents
        // every cron tick re-paging the channel about the same broken
        // ingest. Auto-resolves when the source next succeeds.
        alertPromises.push(
          postAlert({
            severity: "p1",
            title: `${source} ingest failed`,
            dedupKey: `ingest.source.failed:${source}`,
            fields: { source, batchId, error: message.slice(0, 500) },
          })
            .then((r) => ({ kind: r.fired ? ("fired" as const) : ("noop" as const) }))
            .catch((e) => {
              logger.warn("alert.post.threw", {
                source,
                error: e instanceof Error ? e.message : String(e),
              });
              return { kind: "noop" as const };
            }),
        );
      }
    })
  );

  logger.info("ingest.end", { batchId });

  // Settle every alert side-effect so the cron summary line shows
  // accurate counts. Per-call postToWebhook already has a 5s timeout
  // (slack.ts), so the worst case here is bounded.
  const settled = await Promise.allSettled(alertPromises);
  let alertsFired = 0;
  let alertsResolved = 0;
  for (const s of settled) {
    if (s.status !== "fulfilled") continue;
    if (s.value.kind === "fired") alertsFired++;
    else if (s.value.kind === "resolved") alertsResolved++;
  }

  return { batchId, alertsFired, alertsResolved };
}
