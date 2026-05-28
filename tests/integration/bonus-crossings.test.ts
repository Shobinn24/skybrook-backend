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
      adNumber: "1900", // above Jacob's BONUS_AD_FLOOR of 1896
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

  describe("BONUS_AD_FLOOR filter (Scott 2026-05-20)", () => {
    it("skips Jacob ad numbers strictly below 1896 even when spend crosses T1", async () => {
      const rawId = await makeRawPull();
      await seedFbAdSpend({
        adNumber: "1895",
        marketers: ["Jacob"],
        totalCostUsd: 20_000, // above T1 but below floor
        sourcePullId: rawId,
      });

      const result = await detectAndInsertBonusCrossings();
      expect(result.inserted).toBe(0);

      const rows = await db.select().from(bonusAwards);
      expect(rows).toHaveLength(0);
    });

    it("includes Jacob ad numbers at or above 1896", async () => {
      const rawId = await makeRawPull();
      await seedFbAdSpend({
        adNumber: "1896",
        marketers: ["Jacob"],
        totalCostUsd: 20_000,
        sourcePullId: rawId,
      });

      const result = await detectAndInsertBonusCrossings();
      expect(result.inserted).toBe(1);

      const rows = await db.select().from(bonusAwards);
      expect(rows[0].marketer).toBe("Jacob");
      expect(rows[0].adNumber).toBe("1896");
    });

    it("skips JW below 1907 and Dan below 1944", async () => {
      const rawId = await makeRawPull();
      await seedFbAdSpend({
        adNumber: "1906",
        marketers: ["JW"],
        totalCostUsd: 20_000,
        sourcePullId: rawId,
      });
      await seedFbAdSpend({
        adNumber: "1943",
        marketers: ["Dan"],
        totalCostUsd: 20_000,
        sourcePullId: rawId,
      });

      const result = await detectAndInsertBonusCrossings();
      expect(result.inserted).toBe(0);

      const rows = await db.select().from(bonusAwards);
      expect(rows).toHaveLength(0);
    });

    it("on a multi-marketer ad, includes Craig (no floor) but skips Jacob (below floor)", async () => {
      const rawId = await makeRawPull();
      await seedFbAdSpend({
        adNumber: "1500", // below Jacob's floor, but Craig has no floor
        marketers: ["Craig", "Jacob"],
        totalCostUsd: 20_000,
        sourcePullId: rawId,
      });

      const result = await detectAndInsertBonusCrossings();
      expect(result.inserted).toBe(1); // only Craig

      const rows = await db.select().from(bonusAwards);
      expect(rows[0].marketer).toBe("Craig");
    });
  });

  // Phantom-crossing guard (Scott 2026-05-28): the FB 3-year history
  // import landed 130k rows of 2023-2025 spend in one shot; the next
  // cron summed lifetime spend and created 14 fake pending awards on
  // ads that had crossed thresholds years ago. `lookbackDays` requires
  // the threshold to actually be crossed during the window — pre-window
  // spend alone doesn't fire a row.
  describe("lookbackDays phantom-crossing guard", () => {
    async function seedSplit(opts: {
      adNumber: string;
      marketers: string[];
      beforeWindowUsd: number;
      withinWindowUsd: number;
      sourcePullId: string;
    }) {
      const rows = [];
      if (opts.beforeWindowUsd > 0) {
        rows.push({
          adNumber: opts.adNumber,
          adName: `Ad ${opts.adNumber}`,
          adNameRaw: `Ad ${opts.adNumber}`,
          adLink: null,
          marketers: opts.marketers,
          spendDate: "2025-06-01", // well before any lookback window we test
          costUsd: opts.beforeWindowUsd.toFixed(4),
          sourcePullId: opts.sourcePullId,
        });
      }
      if (opts.withinWindowUsd > 0) {
        rows.push({
          adNumber: opts.adNumber,
          adName: `Ad ${opts.adNumber}`,
          adNameRaw: `Ad ${opts.adNumber}`,
          adLink: null,
          marketers: opts.marketers,
          spendDate: "2026-05-25", // within a 14-day window ending 2026-05-28
          costUsd: opts.withinWindowUsd.toFixed(4),
          sourcePullId: opts.sourcePullId,
        });
      }
      if (rows.length) await db.insert(fbAdSpendDaily).values(rows);
    }

    it("skips tier1 when threshold was already exceeded before the window", async () => {
      const rawId = await makeRawPull();
      await seedSplit({
        adNumber: "204", // mirrors the real 2026-05-28 phantom
        marketers: ["Craig"],
        beforeWindowUsd: 100_000, // way past both tiers, all historical
        withinWindowUsd: 0,
        sourcePullId: rawId,
      });

      const result = await detectAndInsertBonusCrossings({
        asOfDate: "2026-05-28",
        lookbackDays: 14,
      });
      expect(result.inserted).toBe(0);
      expect(result.phantomSkipped).toBe(2); // both tier1 and tier2 dropped
      expect(await db.select().from(bonusAwards)).toHaveLength(0);
    });

    it("fires on a genuine in-window crossing", async () => {
      const rawId = await makeRawPull();
      await seedSplit({
        adNumber: "300",
        marketers: ["Craig"],
        beforeWindowUsd: 10_000, // below tier1 pre-window
        withinWindowUsd: 5_000, // pushes lifetime to $15k → just crossed tier1
        sourcePullId: rawId,
      });

      const result = await detectAndInsertBonusCrossings({
        asOfDate: "2026-05-28",
        lookbackDays: 14,
      });
      expect(result.inserted).toBe(1);
      expect(result.phantomSkipped).toBe(0);

      const rows = await db.select().from(bonusAwards);
      expect(rows[0].tier).toBe("tier1");
      expect(rows[0].adNumber).toBe("300");
    });

    it("skips tier2 but fires tier1 when pre-window crossed only tier1", async () => {
      const rawId = await makeRawPull();
      await seedSplit({
        adNumber: "974",
        marketers: ["Craig"],
        beforeWindowUsd: 30_000, // above tier1 ($13k) but below tier2 ($65k)
        withinWindowUsd: 40_000, // lifetime $70k — tier2 newly crossed
        sourcePullId: rawId,
      });

      const result = await detectAndInsertBonusCrossings({
        asOfDate: "2026-05-28",
        lookbackDays: 14,
      });
      expect(result.inserted).toBe(1); // tier2 only (tier1 was pre-crossed)
      expect(result.phantomSkipped).toBe(1);

      const rows = await db.select().from(bonusAwards);
      expect(rows[0].tier).toBe("tier2");
    });

    it("no filter when lookbackDays is omitted (legacy behavior preserved)", async () => {
      const rawId = await makeRawPull();
      await seedSplit({
        adNumber: "999",
        marketers: ["Craig"],
        beforeWindowUsd: 100_000,
        withinWindowUsd: 0,
        sourcePullId: rawId,
      });

      const result = await detectAndInsertBonusCrossings({
        asOfDate: "2026-05-28",
        // lookbackDays intentionally unset
      });
      expect(result.inserted).toBe(2);
      expect(result.phantomSkipped).toBe(0);
    });
  });
});
