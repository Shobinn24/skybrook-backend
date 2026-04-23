import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import { runIngest, type SourceRunner } from "@/lib/jobs/ingest";
import { db } from "@/lib/db";
import { dataPulls, rawPulls } from "@/lib/db/schema";
import { sql } from "drizzle-orm";
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
    await db.execute(sql`TRUNCATE TABLE data_pulls, raw_pulls CASCADE`);
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
});
