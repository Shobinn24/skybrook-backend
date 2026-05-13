import { randomUUID } from "node:crypto";
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
  | "shopify_us"
  | "shopify_intl";

export type SourceRunResult = {
  ok: true;
  rowCount: number;
  rawPayload: unknown;
  schemaFingerprint: string;
  normalize: (rawId: string) => Promise<void>;
};

export type SourceRunner = (batchId: string) => Promise<SourceRunResult>;

export async function runIngest(input: {
  sources: Partial<Record<SourceKey, SourceRunner>>;
}): Promise<string> {
  const batchId = randomUUID();
  logger.info("ingest.start", { batchId });

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
        void resolveAlert(`ingest.source.failed:${source}`).catch((e) => {
          logger.warn("alert.resolve.threw", {
            source,
            error: e instanceof Error ? e.message : String(e),
          });
        });
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
        void postAlert({
          severity: "p1",
          title: `${source} ingest failed`,
          dedupKey: `ingest.source.failed:${source}`,
          fields: { source, batchId, error: message.slice(0, 500) },
        }).catch((e) => {
          logger.warn("alert.post.threw", {
            source,
            error: e instanceof Error ? e.message : String(e),
          });
        });
      }
    })
  );

  logger.info("ingest.end", { batchId });
  return batchId;
}
