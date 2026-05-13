import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runIngest, type SourceRunner } from "@/lib/jobs/ingest";
import { db } from "@/lib/db";
import { alertEvents, dataPulls, rawPulls } from "@/lib/db/schema";
import { sql } from "drizzle-orm";
import * as slackModule from "@/lib/notifications/slack";
import "dotenv/config";

const successRunner: SourceRunner = async (_batch) => ({
  ok: true,
  rowCount: 3,
  rawPayload: { rows: [{ sku: "A" }] },
  schemaFingerprint: "fp-1",
  normalize: async () => {},
});

const failingRunner: SourceRunner = async (_batch) => {
  throw new Error("boom");
};

describe("runIngest orchestrator", () => {
  beforeAll(() => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set in test env");
  });

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE TABLE data_pulls, raw_pulls, alert_events CASCADE`);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs a success data_pulls row for a successful source", async () => {
    const batch = await runIngest({ sources: { sheets_inventory: successRunner } });
    const rows = await db.select().from(dataPulls);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("success");
    expect(rows[0].rowCount).toBe(3);
    expect(rows[0].pullBatchId).toBe(batch);
  });

  it("logs a failed data_pulls row with error message when source throws", async () => {
    await runIngest({ sources: { sheets_inventory: failingRunner } });
    const rows = await db.select().from(dataPulls);
    expect(rows[0].status).toBe("failed");
    expect(rows[0].errorMessage).toContain("boom");
  });

  it("continues other sources when one source throws", async () => {
    await runIngest({ sources: { sheets_inventory: failingRunner, shopify_us: successRunner } });
    const rows = await db.select().from(dataPulls);
    expect(rows).toHaveLength(2);
    const statuses = rows.map((r) => r.status).sort();
    expect(statuses).toEqual(["failed", "success"]);
  });

  it("writes a raw_pulls row for each successful source", async () => {
    await runIngest({ sources: { sheets_inventory: successRunner } });
    const raw = await db.select().from(rawPulls);
    expect(raw).toHaveLength(1);
    expect(raw[0].source).toBe("sheets_inventory");
    expect(raw[0].schemaFingerprint).toBe("fp-1");
  });

  it("fires postAlert when a source fails and resolves it on next success", async () => {
    const postSpy = vi.spyOn(slackModule, "postAlert");
    const resolveSpy = vi.spyOn(slackModule, "resolveAlert");

    await runIngest({ sources: { shopify_intl: failingRunner } });
    // Fire-and-forget — wait one microtask + macrotask cycle for the
    // postAlert promise to be invoked.
    await new Promise((r) => setTimeout(r, 0));

    expect(postSpy).toHaveBeenCalledTimes(1);
    expect(postSpy.mock.calls[0][0]).toMatchObject({
      severity: "p1",
      dedupKey: "ingest.source.failed:shopify_intl",
    });

    await runIngest({ sources: { shopify_intl: successRunner } });
    await new Promise((r) => setTimeout(r, 0));

    expect(resolveSpy).toHaveBeenCalledWith("ingest.source.failed:shopify_intl");
  });
});
