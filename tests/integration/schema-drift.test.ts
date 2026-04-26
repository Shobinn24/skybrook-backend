import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { db } from "@/lib/db";
import { dataPulls, rawPulls } from "@/lib/db/schema";
import {
  annotateDrift,
  getPullHistoryWithDriftForSource,
  type PullHistoryRow,
} from "@/lib/queries/pipeline";
import { resetDb } from "@/tests/fixtures/seed";

/**
 * Schema drift detection lives entirely in `annotateDrift` — comparing
 * each successful pull's fingerprint to the prior successful pull's
 * fingerprint for the same source. These tests pin the rules so a
 * future refactor can't silently break drift surfacing on /pipeline.
 *
 * Rules:
 *   1. First pull is never marked drifted (no prior to compare).
 *   2. A successful pull whose fingerprint matches the prior successful
 *      pull is NOT drifted.
 *   3. A successful pull whose fingerprint differs IS drifted, and the
 *      prior fingerprint is recorded for "changed from X to Y" tooltips.
 *   4. Failed pulls don't reset the comparison baseline (so a fingerprint
 *      change while a fail is sandwiched between two successes still
 *      detects correctly).
 *   5. Pulls with null fingerprint (legacy or pre-rawPull failure) never
 *      mark drift in either direction.
 */

function makeRow(opts: {
  id?: string;
  startedAt: Date;
  status: "success" | "failed" | "partial";
  fingerprint: string | null;
}): PullHistoryRow & { fingerprint: string | null } {
  return {
    id: opts.id ?? randomUUID(),
    pullBatchId: randomUUID(),
    source: "sheets_inventory",
    startedAt: opts.startedAt,
    finishedAt: opts.startedAt,
    status: opts.status,
    rowCount: 0,
    errorMessage: null,
    rawPullId: null,
    fingerprint: opts.fingerprint,
  };
}

describe("annotateDrift (pure)", () => {
  it("never marks the first pull drifted", () => {
    const result = annotateDrift([
      makeRow({ startedAt: new Date("2026-04-22T10:00:00Z"), status: "success", fingerprint: "abc" }),
    ]);
    expect(result[0].schemaDrifted).toBe(false);
    expect(result[0].priorFingerprint).toBeNull();
  });

  it("does not mark drift when consecutive successful pulls share the fingerprint", () => {
    // Newest first (the order the page receives).
    const result = annotateDrift([
      makeRow({ startedAt: new Date("2026-04-23T10:00:00Z"), status: "success", fingerprint: "abc" }),
      makeRow({ startedAt: new Date("2026-04-22T10:00:00Z"), status: "success", fingerprint: "abc" }),
    ]);
    expect(result.every((r) => r.schemaDrifted === false)).toBe(true);
  });

  it("marks drift when the fingerprint changes between successful pulls", () => {
    const result = annotateDrift([
      makeRow({ startedAt: new Date("2026-04-24T10:00:00Z"), status: "success", fingerprint: "xyz" }),
      makeRow({ startedAt: new Date("2026-04-23T10:00:00Z"), status: "success", fingerprint: "abc" }),
    ]);
    // Newest first → result[0] is the drifted row.
    expect(result[0].schemaDrifted).toBe(true);
    expect(result[0].priorFingerprint).toBe("abc");
    expect(result[1].schemaDrifted).toBe(false);
  });

  it("does not let a failed pull reset the drift comparison baseline", () => {
    // Sequence (oldest → newest): success(abc), failed(null), success(xyz).
    // We want xyz to be flagged drifted vs the original abc — the failure
    // shouldn't make us "forget" what the schema looked like.
    const result = annotateDrift([
      makeRow({ startedAt: new Date("2026-04-24T10:00:00Z"), status: "success", fingerprint: "xyz" }),
      makeRow({ startedAt: new Date("2026-04-23T10:00:00Z"), status: "failed", fingerprint: null }),
      makeRow({ startedAt: new Date("2026-04-22T10:00:00Z"), status: "success", fingerprint: "abc" }),
    ]);
    expect(result[0].schemaDrifted).toBe(true);
    expect(result[0].priorFingerprint).toBe("abc");
  });

  it("never marks drift when fingerprint is null (legacy / pre-raw failure)", () => {
    const result = annotateDrift([
      makeRow({ startedAt: new Date("2026-04-23T10:00:00Z"), status: "success", fingerprint: null }),
      makeRow({ startedAt: new Date("2026-04-22T10:00:00Z"), status: "success", fingerprint: "abc" }),
    ]);
    expect(result[0].schemaDrifted).toBe(false);
  });
});

describe("getPullHistoryWithDriftForSource (integration)", () => {
  beforeAll(() => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set in test env");
  });

  beforeEach(async () => {
    await resetDb();
  });

  async function insertPull(opts: {
    startedAt: Date;
    fingerprint: string;
  }): Promise<void> {
    const [raw] = await db
      .insert(rawPulls)
      .values({
        source: "sheets_inventory",
        pullBatchId: randomUUID(),
        payload: {},
        rowCount: 0,
        schemaFingerprint: opts.fingerprint,
      })
      .returning({ id: rawPulls.id });

    await db.insert(dataPulls).values({
      pullBatchId: randomUUID(),
      source: "sheets_inventory",
      startedAt: opts.startedAt,
      finishedAt: opts.startedAt,
      status: "success",
      rowCount: 0,
      errorMessage: null,
      rawPullId: raw.id,
    });
  }

  it("joins the raw fingerprint and flags drift across DB rows", async () => {
    await insertPull({ startedAt: new Date("2026-04-22T10:00:00Z"), fingerprint: "fp-old" });
    await insertPull({ startedAt: new Date("2026-04-23T10:00:00Z"), fingerprint: "fp-new" });

    const rows = await getPullHistoryWithDriftForSource("sheets_inventory");
    expect(rows).toHaveLength(2);
    // Newest first.
    expect(rows[0].fingerprint).toBe("fp-new");
    expect(rows[0].schemaDrifted).toBe(true);
    expect(rows[0].priorFingerprint).toBe("fp-old");
    expect(rows[1].schemaDrifted).toBe(false);
  });
});
