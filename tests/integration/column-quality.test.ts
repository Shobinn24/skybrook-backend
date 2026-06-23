import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { fbAdSpendDaily, rawPulls } from "@/lib/db/schema";
import { evaluateColumnQuality } from "@/lib/jobs/column-quality";
import type { EvaluatedCheck } from "@/lib/jobs/freshness-check";
import "dotenv/config";

let seededRawPullId = "";

async function truncate() {
  await db.execute(sql`TRUNCATE TABLE fb_ad_spend_daily, raw_pulls CASCADE`);
}

async function seedRawPull() {
  const [row] = await db
    .insert(rawPulls)
    .values({
      source: "sheets_fb_ads",
      pullBatchId: randomUUID(),
      payload: {},
      rowCount: 0,
      schemaFingerprint: "test",
    })
    .returning({ id: rawPulls.id });
  seededRawPullId = row.id;
}

// PK is (adNumber, spendDate) — vary adNumber to make many rows on one day.
async function seedFbRow(
  adNumber: string,
  spendDate: string,
  marketers: string[],
) {
  await db.insert(fbAdSpendDaily).values({
    adNumber,
    adName: `Ad ${adNumber}`,
    adNameRaw: `Ad ${adNumber} raw`,
    marketers,
    spendDate,
    costUsd: "10.0",
    sourcePullId: seededRawPullId,
  });
}

const finder = (name: string) => (checks: EvaluatedCheck[]) =>
  checks.find((c) => c.name === name);

describe("evaluateColumnQuality", () => {
  beforeAll(() => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set");
  });

  beforeEach(async () => {
    await truncate();
    await seedRawPull();
  });

  const mkCheck = finder("column_quality.fb_marketer_attribution");

  it("passes the marketer check when most recent ads have a matched marketer", async () => {
    for (let i = 0; i < 30; i++) {
      await seedFbRow(`A${i}`, "2026-06-20", ["Craig"]);
    }
    const c = mkCheck(await evaluateColumnQuality());
    expect(c?.status).toBe("pass");
    expect(c?.fields.ratePct).toBe(0);
  });

  it("fails the marketer check when the empty-marketer rate crosses the threshold", async () => {
    // 24 of 30 recent rows have NO marketer (80% > 50% threshold).
    for (let i = 0; i < 24; i++) await seedFbRow(`E${i}`, "2026-06-20", []);
    for (let i = 0; i < 6; i++) await seedFbRow(`M${i}`, "2026-06-20", ["Nate"]);
    const c = mkCheck(await evaluateColumnQuality());
    expect(c?.status).toBe("fail");
    expect(c?.fields.empty).toBe(24);
    expect(c?.fields.total).toBe(30);
    expect(c?.fields.ratePct).toBe(80);
    expect(c?.severity).toBe("p2");
  });

  it("does NOT fail the marketer check below the minimum row volume", async () => {
    // Only 5 rows, all empty — high rate, but too little volume to judge.
    for (let i = 0; i < 5; i++) await seedFbRow(`E${i}`, "2026-06-20", []);
    const c = mkCheck(await evaluateColumnQuality());
    expect(c?.status).toBe("pass");
  });

  it("only counts empties inside the recent window (old empties don't trip it)", async () => {
    // 30 fresh good rows + a pile of OLD empty rows outside the 14d window.
    for (let i = 0; i < 30; i++) await seedFbRow(`G${i}`, "2026-06-20", ["Craig"]);
    for (let i = 0; i < 50; i++) await seedFbRow(`O${i}`, "2026-01-01", []);
    const c = mkCheck(await evaluateColumnQuality());
    // Window anchors on max date 2026-06-20, so Jan rows are excluded.
    expect(c?.status).toBe("pass");
    expect(c?.fields.total).toBe(30);
  });

  it("emits no marketer check when fb_ad_spend_daily is empty", async () => {
    const checks = await evaluateColumnQuality();
    expect(mkCheck(checks)).toBeUndefined();
  });
});
