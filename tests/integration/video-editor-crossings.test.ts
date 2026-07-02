import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { bonusAwards, fbAdSpendDaily, rawPulls } from "@/lib/db/schema";
import {
  detectAndInsertBonusCrossings,
  detectAndInsertVideoEditorCrossings,
} from "@/lib/jobs/bonus-crossings";
import { resetDb } from "@/tests/fixtures/seed";

async function makeRawPull(): Promise<string> {
  const [raw] = await db
    .insert(rawPulls)
    .values({
      source: "sheets_fb_ads",
      pullBatchId: randomUUID(),
      payload: {},
      rowCount: 0,
      schemaFingerprint: "fp",
    })
    .returning({ id: rawPulls.id });
  return raw.id;
}

/** Seed daily spend rows for one ad with an explicit raw name. */
async function seedAd(opts: {
  adNumber: string;
  adNameRaw: string;
  marketers?: string[];
  days: Array<{ spendDate: string; costUsd: number }>;
  sourcePullId: string;
}) {
  await db.insert(fbAdSpendDaily).values(
    opts.days.map((d) => ({
      adNumber: opts.adNumber,
      adName: opts.adNameRaw,
      adNameRaw: opts.adNameRaw,
      adLink: null,
      marketers: opts.marketers ?? [],
      spendDate: d.spendDate,
      costUsd: d.costUsd.toFixed(4),
      sourcePullId: opts.sourcePullId,
    })),
  );
}

describe("detectAndInsertVideoEditorCrossings", () => {
  beforeAll(() => {
    if (!process.env.DATABASE_URL)
      throw new Error("DATABASE_URL not set in test env");
  });

  beforeEach(async () => {
    await resetDb();
    await db.execute(sql`TRUNCATE TABLE bonus_awards CASCADE`);
    await db.execute(sql`TRUNCATE TABLE data_pulls CASCADE`);
  });

  it("inserts a pending editor award when an AIAD ad crosses \$13k, idempotent on re-run", async () => {
    const rawId = await makeRawPull();
    await seedAd({
      adNumber: "2077",
      adNameRaw: "(Mens CC) Ad 2077 - AIad - SR - UGC hook remix",
      days: [
        { spendDate: "2026-06-01", costUsd: 7_000 },
        { spendDate: "2026-06-02", costUsd: 8_000 }, // cumulative crosses 13k here
      ],
      sourcePullId: rawId,
    });

    const first = await detectAndInsertVideoEditorCrossings();
    expect(first.inserted).toBe(1);
    expect(first.alreadyExisted).toBe(0);

    const rows = await db.select().from(bonusAwards);
    expect(rows).toHaveLength(1);
    expect(rows[0].adNumber).toBe("2077");
    expect(rows[0].marketer).toBe("Sebastian");
    expect(rows[0].tier).toBe("tier1");
    expect(rows[0].status).toBe("pending");
    expect(Number(rows[0].amountUsd)).toBe(200);
    expect(rows[0].crossedAt).toBe("2026-06-02"); // real crossing date, not run date

    const second = await detectAndInsertVideoEditorCrossings();
    expect(second.inserted).toBe(0);
    expect(second.alreadyExisted).toBe(1);
    expect(await db.select().from(bonusAwards)).toHaveLength(1);
  });

  it("inserts both tiers at \$200/\$800 when an AIAD ad crosses \$65k", async () => {
    const rawId = await makeRawPull();
    await seedAd({
      adNumber: "2088",
      adNameRaw: "(Boyshort) Ad 2088 - AIad - GA - remix",
      days: [
        { spendDate: "2026-05-01", costUsd: 14_000 },
        { spendDate: "2026-05-20", costUsd: 60_000 },
      ],
      sourcePullId: rawId,
    });

    const result = await detectAndInsertVideoEditorCrossings();
    expect(result.inserted).toBe(2);

    const rows = await db.select().from(bonusAwards).orderBy(bonusAwards.tier);
    expect(rows.map((r) => r.tier)).toEqual(["tier1", "tier2"]);
    expect(rows.map((r) => Number(r.amountUsd))).toEqual([200, 800]);
    expect(rows.every((r) => r.marketer === "Greg")).toBe(true);
    expect(rows[0].crossedAt).toBe("2026-05-01");
    expect(rows[1].crossedAt).toBe("2026-05-20");
  });

  it("includes historical AIAD ads: first spend before 2026-03-01 still inserts (client amendment 2026-07-02)", async () => {
    const rawId = await makeRawPull();
    await seedAd({
      adNumber: "1550",
      adNameRaw: "(Mens) Ad 1550 - AIad - RC - old runner",
      days: [
        { spendDate: "2026-01-10", costUsd: 10_000 },
        { spendDate: "2026-02-05", costUsd: 6_000 }, // crossed 13k pre-March
      ],
      sourcePullId: rawId,
    });

    const result = await detectAndInsertVideoEditorCrossings();
    expect(result.inserted).toBe(1);

    const rows = await db.select().from(bonusAwards);
    expect(rows[0].marketer).toBe("Ryan");
    expect(rows[0].status).toBe("pending");
    expect(rows[0].crossedAt).toBe("2026-02-05");
  });

  it("dual credit: one ad yields BOTH a marketer award and an editor award", async () => {
    const rawId = await makeRawPull();
    await seedAd({
      adNumber: "2200",
      adNameRaw: "(Mens CC) Ad 2200 - AIad - PL - Craig remix hook",
      marketers: ["Craig"],
      days: [
        { spendDate: "2026-06-01", costUsd: 9_000 },
        { spendDate: "2026-06-02", costUsd: 6_000 },
      ],
      sourcePullId: rawId,
    });

    const marketerPass = await detectAndInsertBonusCrossings({
      asOfDate: "2026-06-10",
    });
    const editorPass = await detectAndInsertVideoEditorCrossings();
    expect(marketerPass.inserted).toBe(1);
    expect(editorPass.inserted).toBe(1);

    const rows = await db.select().from(bonusAwards);
    const byName = Object.fromEntries(
      rows.map((r) => [r.marketer, Number(r.amountUsd)]),
    );
    expect(byName).toEqual({ Craig: 500, "Phat Lee": 200 });
  });

  it("PHL and PL both credit Phat Lee; two different ads = two award rows", async () => {
    const rawId = await makeRawPull();
    await seedAd({
      adNumber: "2301",
      adNameRaw: "(A) Ad 2301 - AIad - PHL - v1",
      days: [{ spendDate: "2026-06-01", costUsd: 14_000 }],
      sourcePullId: rawId,
    });
    await seedAd({
      adNumber: "2302",
      adNameRaw: "(B) Ad 2302 - AIad - PL - v2",
      days: [{ spendDate: "2026-06-01", costUsd: 14_000 }],
      sourcePullId: rawId,
    });

    const result = await detectAndInsertVideoEditorCrossings();
    expect(result.inserted).toBe(2);
    const rows = await db.select().from(bonusAwards);
    expect(rows.every((r) => r.marketer === "Phat Lee")).toBe(true);
    expect(rows.map((r) => r.adNumber).sort()).toEqual(["2301", "2302"]);
  });

  it("inserts nothing for excluded initials, unknown initials, or non-AIAD ads", async () => {
    const rawId = await makeRawPull();
    await seedAd({
      adNumber: "2401",
      adNameRaw: "(A) Ad 2401 - AIad - SJ - ruled out",
      days: [{ spendDate: "2026-06-01", costUsd: 70_000 }],
      sourcePullId: rawId,
    });
    await seedAd({
      adNumber: "2402",
      adNameRaw: "(B) Ad 2402 - AIad - XY - unknown contractor",
      days: [{ spendDate: "2026-06-01", costUsd: 70_000 }],
      sourcePullId: rawId,
    });
    await seedAd({
      adNumber: "2403",
      adNameRaw: "Ad 2403 - Craig Mens VID 2",
      marketers: ["Craig"],
      days: [{ spendDate: "2026-06-01", costUsd: 70_000 }],
      sourcePullId: rawId,
    });

    const result = await detectAndInsertVideoEditorCrossings();
    expect(result.inserted).toBe(0);
    expect(await db.select().from(bonusAwards)).toHaveLength(0);
  });

  it("ignores AIAD ads below the \$13k threshold", async () => {
    const rawId = await makeRawPull();
    await seedAd({
      adNumber: "2500",
      adNameRaw: "(A) Ad 2500 - AIad - CE - small",
      days: [{ spendDate: "2026-06-01", costUsd: 5_000 }],
      sourcePullId: rawId,
    });

    const result = await detectAndInsertVideoEditorCrossings();
    expect(result.inserted).toBe(0);
    expect(result.scanned).toBe(0);
  });

  it("does not re-insert over a previously-rejected editor award", async () => {
    const rawId = await makeRawPull();
    await seedAd({
      adNumber: "2600",
      adNameRaw: "(A) Ad 2600 - AIad - JM - v1",
      days: [{ spendDate: "2026-06-01", costUsd: 14_000 }],
      sourcePullId: rawId,
    });

    await detectAndInsertVideoEditorCrossings();
    await db.update(bonusAwards).set({ status: "rejected" }).where(sql`true`);

    const second = await detectAndInsertVideoEditorCrossings();
    expect(second.inserted).toBe(0);

    const rows = await db.select().from(bonusAwards);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("rejected");
  });
});
