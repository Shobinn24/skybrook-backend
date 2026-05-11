import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { dataPulls, rawPulls } from "@/lib/db/schema";
import { logger } from "@/lib/logger";

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
        const result = await runner(batchId);
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
      }
    })
  );

  logger.info("ingest.end", { batchId });
  return batchId;
}
