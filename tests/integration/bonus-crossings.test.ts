import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { db } from "@/lib/db";
import { bonusAwards, dataPulls, fbAdSpendDaily, rawPulls } from "@/lib/db/schema";
import { detectAndInsertBonusCrossings } from "@/lib/jobs/bonus-crossings";
import { resetDb } from "@/tests/fixtures/seed";
import { sql } from "drizzle-orm";

async function seedFbAdSpend(opts: {
  adNumber: string;
  marketers: string[];
  totalCostUsd: number;
  sourcePullId: string;
}) {
  // Split into 2 daily rows so the aggregation path is exercised.
  await db.insert(fbAdSpendDaily).values([
    {
      adNumber: opts.adNumber,
      adName: `Ad ${opts.adNumber}`,
      adNameRaw: `Ad ${opts.adNumber}`,
      adLink: null,
      marketers: opts.marketers,
      spendDate: "2026-04-01",
      costUsd: (opts.totalCostUsd / 2).toFixed(4),
      sourcePullId: opts.sourcePullId,
    },
    {
      adNumber: opts.adNumber,
      adName: `Ad ${opts.adNumber}`,
      adNameRaw: `Ad ${opts.adNumber}`,
      adLink: null,
      marketers: opts.marketers,
      spendDate: "2026-04-02",
      costUsd: (opts.totalCostUsd / 2).toFixed(4),
      sourcePullId: opts.sourcePullId,
    },
  ]);
}

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

describe("detectAndInsertBonusCrossings", () => {
  beforeAll(() => {
    if (!process.env.DATABASE_URL)
      throw new Error("DATABASE_URL not set in test env");
  });

  beforeEach(async () => {
    // resetDb wipes raw_pulls CASCADE → also clears bonus_awards rows
    // via no FK, so clean it explicitly. data_pulls + bonus_notification_batches
    // similarly need explicit truncation.
    await resetDb();
    await db.execute(sql`TRUNCATE TABLE bonus_awards CASCADE`);
    await db.execute(sql`TRUNCATE TABLE data_pulls CASCADE`);
  });

  it("inserts a pending T1 award when lifetime spend crosses $13k", async () => {
    const rawId = await makeRawPull();
    await seedFbAdSpend({
      adNumber: "100",
      marketers: ["Craig"],
      totalCostUsd: 15_000, // > $13k, < $65k → T1 only
      sourcePullId: rawId,
    });

    const result = await detectAndInsertBonusCrossings({ asOfDate: "2026-05-13" });
    expect(result.inserted).toBe(1);
    expect(result.alreadyExisted).toBe(0);

    const rows = await db.select().from(bonusAwards);
    expect(rows).toHaveLength(1);
    expect(rows[0].adNumber).toBe("100");
    expect(rows[0].marketer).toBe("Craig");
    expect(rows[0].tier).toBe("tier1");
    expect(rows[0].status).toBe("pending");
    expect(Number(rows[0].amountUsd)).toBe(500); // Craig (main) T1 = $500
    expect(rows[0].crossedAt).toBe("2026-05-13");
  });

  it("inserts both T1 and T2 awards when lifetime spend crosses $65k", async () => {
    const rawId = await makeRawPull();
    await seedFbAdSpend({
      adNumber: "200",
      marketers: ["Craig"],
      totalCostUsd: 70_000,
      sourcePullId: rawId,
    });

    const result = await detectAndInsertBonusCrossings();
    expect(result.inserted).toBe(2);

    const rows = await db
      .select()
      .from(bonusAwards)
      .orderBy(bonusAwards.tier);
    expect(rows.map((r) => r.tier)).toEqual(["tier1", "tier2"]);
    const amounts = rows.map((r) => Number(r.amountUsd)).sort((a, b) => a - b);
    expect(amounts).toEqual([500, 3000]); // Craig main: T1 $500 + T2 $3000
  });

  it("uses secondary marketer rates for Jacob / Dan / JW", async () => {
    const rawId = await makeRawPull();
    await seedFbAdSpend({
      adNumber: "300",
      marketers: ["Jacob"],
      totalCostUsd: 70_000,
      sourcePullId: rawId,
    });

    await detectAndInsertBonusCrossings();

    const rows = await db.select().from(bonusAwards).orderBy(bonusAwards.tier);
    const amounts = rows.map((r) => Number(r.amountUsd)).sort((a, b) => a - b);
    expect(amounts).toEqual([250, 1500]); // Jacob secondary: T1 $250 + T2 $1500
  });

  it("creates a separate award for each marketer on multi-marketer ads", async () => {
    const rawId = await makeRawPull();
    await seedFbAdSpend({
      adNumber: "400",
      marketers: ["Craig", "Raul"],
      totalCostUsd: 20_000, // T1 only
      sourcePullId: rawId,
    });

    const result = await detectAndInsertBonusCrossings();
    expect(result.inserted).toBe(2);

    const marketers = (await db.select().from(bonusAwards))
      .map((r) => r.marketer)
      .sort();
    expect(marketers).toEqual(["Craig", "Raul"]);
  });

  it("excludes non-bonus marketers (Nate, Scotty)", async () => {
    const rawId = await makeRawPull();
    await seedFbAdSpend({
      adNumber: "500",
      marketers: ["Scotty"],
      totalCostUsd: 80_000,
      sourcePullId: rawId,
    });
    await seedFbAdSpend({
      adNumber: "501",
      marketers: ["Nate", "Craig"], // Craig still counts
      totalCostUsd: 20_000,
      sourcePullId: rawId,
    });

    const result = await detectAndInsertBonusCrossings();
    expect(result.inserted).toBe(1); // only Craig from ad 501

    const rows = await db.select().from(bonusAwards);
    expect(rows[0].marketer).toBe("Craig");
    expect(rows[0].adNumber).toBe("501");
  });

  it("is idempotent — re-running skips existing crossings", async () => {
    const rawId = await makeRawPull();
    await seedFbAdSpend({
      adNumber: "600",
      marketers: ["Craig"],
      totalCostUsd: 14_000,
      sourcePullId: rawId,
    });

    const first = await detectAndInsertBonusCrossings();
    expect(first.inserted).toBe(1);

    const second = await detectAndInsertBonusCrossings();
    expect(second.inserted).toBe(0);
    expect(second.alreadyExisted).toBe(1);

    const rows = await db.select().from(bonusAwards);
    expect(rows).toHaveLength(1);
  });

  it("preserves a previously-rejected award and does not re-insert", async () => {
    const rawId = await makeRawPull();
    await seedFbAdSpend({
      adNumber: "700",
      marketers: ["Craig"],
      totalCostUsd: 14_000,
      sourcePullId: rawId,
    });

    await detectAndInsertBonusCrossings();
    await db.update(bonusAwards).set({ status: "rejected" }).where(sql`true`);

    const second = await detectAndInsertBonusCrossings();
    expect(second.inserted).toBe(0);

    const rows = await db.select().from(bonusAwards);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("rejected"); // unchanged
  });

  it("ignores ads with zero lifetime spend or no bonus marketers", async () => {
    const rawId = await makeRawPull();
    await seedFbAdSpend({
      adNumber: "800",
      marketers: ["Craig"],
      totalCostUsd: 5_000, // below T1
      sourcePullId: rawId,
    });
    await seedFbAdSpend({
      adNumber: "801",
      marketers: [], // unassigned
      totalCostUsd: 50_000,
      sourcePullId: rawId,
    });

    const result = await detectAndInsertBonusCrossings();
    expect(result.inserted).toBe(0);
    expect(result.scanned).toBe(0);
  });
});
