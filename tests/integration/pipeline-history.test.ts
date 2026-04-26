import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { db } from "@/lib/db";
import { dataPulls, rawPulls } from "@/lib/db/schema";
import {
  getPullHistoryAllSources,
  getPullHistoryForSource,
} from "@/lib/queries/pipeline";
import { resetDb } from "@/tests/fixtures/seed";

/**
 * Pipeline status page (SPEC §3.6) needs per-source history with success
 * / failure rows in newest-first order. These tests pin the contract
 * so the page never silently shows wrong order or skips a source that
 * has zero pulls.
 */

async function insertRawPull(): Promise<string> {
  const [r] = await db
    .insert(rawPulls)
    .values({
      source: "sheets_inventory",
      pullBatchId: randomUUID(),
      payload: {},
      rowCount: 0,
      schemaFingerprint: "fp",
    })
    .returning({ id: rawPulls.id });
  return r.id;
}

async function insertPull(opts: {
  source: typeof dataPulls.$inferSelect.source;
  startedAt: Date;
  finishedAt?: Date | null;
  status: "success" | "failed" | "partial";
  rowCount?: number;
  errorMessage?: string | null;
}): Promise<string> {
  const rawId = await insertRawPull();
  const [r] = await db
    .insert(dataPulls)
    .values({
      pullBatchId: randomUUID(),
      source: opts.source,
      startedAt: opts.startedAt,
      finishedAt: opts.finishedAt ?? null,
      status: opts.status,
      rowCount: opts.rowCount ?? 0,
      errorMessage: opts.errorMessage ?? null,
      rawPullId: rawId,
    })
    .returning({ id: dataPulls.id });
  return r.id;
}

describe("pipeline pull history", () => {
  beforeAll(() => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set in test env");
  });

  beforeEach(async () => {
    await resetDb();
  });

  it("getPullHistoryForSource returns rows newest-first capped at limit", async () => {
    const base = new Date("2026-04-20T10:00:00Z").getTime();
    for (let i = 0; i < 5; i++) {
      await insertPull({
        source: "shopify_us",
        startedAt: new Date(base + i * 60_000),
        finishedAt: new Date(base + i * 60_000 + 5_000),
        status: "success",
        rowCount: 100 + i,
      });
    }

    const rows = await getPullHistoryForSource("shopify_us", 3);
    expect(rows).toHaveLength(3);
    // Newest first → row[0].rowCount should be the last-inserted (104).
    expect(rows[0].rowCount).toBe(104);
    expect(rows[1].rowCount).toBe(103);
    expect(rows[2].rowCount).toBe(102);
  });

  it("getPullHistoryForSource clamps limits above the safety ceiling", async () => {
    await insertPull({
      source: "shopify_intl",
      startedAt: new Date("2026-04-22T10:00:00Z"),
      status: "success",
    });

    const rows = await getPullHistoryForSource("shopify_intl", 50_000);
    expect(rows).toHaveLength(1);
  });

  it("getPullHistoryAllSources includes every known source even when empty", async () => {
    await insertPull({
      source: "sheets_incoming",
      startedAt: new Date("2026-04-22T10:00:00Z"),
      status: "success",
    });

    const result = await getPullHistoryAllSources();
    expect(Object.keys(result).sort()).toEqual([
      "sheets_incoming",
      "sheets_inventory",
      "shopify_intl",
      "shopify_us",
    ]);
    expect(result.sheets_incoming).toHaveLength(1);
    expect(result.sheets_inventory).toEqual([]);
    expect(result.shopify_us).toEqual([]);
    expect(result.shopify_intl).toEqual([]);
  });

  it("preserves failed pulls with error messages so the UI can surface them", async () => {
    await insertPull({
      source: "shopify_us",
      startedAt: new Date("2026-04-22T10:00:00Z"),
      finishedAt: new Date("2026-04-22T10:00:30Z"),
      status: "failed",
      rowCount: 0,
      errorMessage: "Shopify returned 503 on page 3",
    });

    const rows = await getPullHistoryForSource("shopify_us");
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("failed");
    expect(rows[0].errorMessage).toContain("503");
  });
});
