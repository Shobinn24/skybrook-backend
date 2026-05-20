import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { db } from "@/lib/db";
import { fbAdSpendDaily, rawPulls } from "@/lib/db/schema";
import { getBonusTracker } from "@/lib/queries/bonus-tracker";
import { resetDb } from "@/tests/fixtures/seed";
import { toEstDate } from "@/lib/tz";

// Date-only arithmetic mirroring lib/queries/bonus-tracker.ts so the
// 7d-window tests stay in sync with the production calculation.
function addDays(ymd: string, days: number): string {
  const dt = new Date(`${ymd}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/** Seed N daily-spend rows that sum to `totalCostUsd` for one ad. */
async function seedAdSpend(opts: {
  adNumber: string;
  adName: string;
  marketers: string[];
  totalCostUsd: number;
  adLink?: string | null;
  sourcePullId: string;
}) {
  const { adNumber, adName, marketers, totalCostUsd, sourcePullId } = opts;
  await db.insert(fbAdSpendDaily).values([
    {
      adNumber,
      adName,
      adNameRaw: adName,
      adLink: opts.adLink ?? null,
      marketers,
      spendDate: "2026-04-01",
      costUsd: (totalCostUsd / 2).toFixed(4),
      sourcePullId,
    },
    {
      adNumber,
      adName,
      adNameRaw: adName,
      adLink: opts.adLink ?? null,
      marketers,
      spendDate: "2026-04-02",
      costUsd: (totalCostUsd / 2).toFixed(4),
      sourcePullId,
    },
  ]);
}

describe("getBonusTracker", () => {
  beforeAll(() => {
    if (!process.env.DATABASE_URL)
      throw new Error("DATABASE_URL not set in test env");
  });

  beforeEach(async () => {
    // resetDb truncates raw_pulls CASCADE, which sweeps fb_ad_spend_daily
    // via its source_pull_id FK.
    await resetDb();
  });

  it("returns one section per bonus marketer in roster order", async () => {
    const result = await getBonusTracker();
    expect(result.sections.map((s) => s.marketer)).toEqual([
      "Craig",
      "Raul",
      "Tyler",
      "Jacob",
      "Dan",
      "JW",
    ]);
  });

  it("sums lifetime spend across all spend_date rows and sorts desc", async () => {
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

    await seedAdSpend({
      adNumber: "100",
      adName: "Craig Big Ad",
      marketers: ["Craig"],
      totalCostUsd: 20_000,
      sourcePullId: raw.id,
    });
    await seedAdSpend({
      adNumber: "101",
      adName: "Craig Small Ad",
      marketers: ["Craig"],
      totalCostUsd: 5_000,
      sourcePullId: raw.id,
    });

    const result = await getBonusTracker();
    const craig = result.sections.find((s) => s.marketer === "Craig")!;
    expect(craig.rows.map((r) => r.adNumber)).toEqual(["100", "101"]);
    expect(craig.rows[0].lifetimeSpendUsd).toBeCloseTo(20_000, 2);
    expect(craig.rows[1].lifetimeSpendUsd).toBeCloseTo(5_000, 2);
  });

  it("places multi-marketer ads in every matching marketer's section with full spend", async () => {
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

    await seedAdSpend({
      adNumber: "200",
      adName: "Craig + Raul Collab",
      marketers: ["Craig", "Raul"],
      totalCostUsd: 30_000,
      sourcePullId: raw.id,
    });

    const result = await getBonusTracker();
    const craig = result.sections.find((s) => s.marketer === "Craig")!;
    const raul = result.sections.find((s) => s.marketer === "Raul")!;
    expect(craig.rows).toHaveLength(1);
    expect(raul.rows).toHaveLength(1);
    expect(craig.rows[0].lifetimeSpendUsd).toBeCloseTo(30_000, 2);
    expect(raul.rows[0].lifetimeSpendUsd).toBeCloseTo(30_000, 2);
  });

  it("excludes Nate and Scotty even though they're in the FB roster", async () => {
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

    await seedAdSpend({
      adNumber: "300",
      adName: "Scotty Solo Ad",
      marketers: ["Scotty"],
      totalCostUsd: 70_000,
      sourcePullId: raw.id,
    });
    await seedAdSpend({
      adNumber: "301",
      adName: "Nate Solo Ad",
      marketers: ["Nate"],
      totalCostUsd: 70_000,
      sourcePullId: raw.id,
    });

    const result = await getBonusTracker();
    expect(result.sections.map((s) => s.marketer)).not.toContain("Scotty");
    expect(result.sections.map((s) => s.marketer)).not.toContain("Nate");
    for (const s of result.sections) expect(s.rows).toHaveLength(0);
  });

  it("excludes unassigned ads (empty marketers array)", async () => {
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

    await seedAdSpend({
      adNumber: "400",
      adName: "Mystery Ad",
      marketers: [],
      totalCostUsd: 50_000,
      sourcePullId: raw.id,
    });

    const result = await getBonusTracker();
    for (const s of result.sections) expect(s.rows).toHaveLength(0);
  });

  describe("BONUS_AD_FLOOR display filter (Scott 2026-05-20)", () => {
    it("excludes Jacob ads strictly below 1896 from Jacob's section", async () => {
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

      await seedAdSpend({
        adNumber: "1895",
        adName: "Jacob Below Floor",
        marketers: ["Jacob"],
        totalCostUsd: 25_000,
        sourcePullId: raw.id,
      });
      await seedAdSpend({
        adNumber: "1896",
        adName: "Jacob At Floor",
        marketers: ["Jacob"],
        totalCostUsd: 14_000,
        sourcePullId: raw.id,
      });

      const result = await getBonusTracker();
      const jacob = result.sections.find((s) => s.marketer === "Jacob")!;
      expect(jacob.rows.map((r) => r.adNumber)).toEqual(["1896"]);
    });

    it("does not affect Craig (floor 0) — keeps below-floor ad numbers", async () => {
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

      await seedAdSpend({
        adNumber: "1",
        adName: "Craig Very Old Ad",
        marketers: ["Craig"],
        totalCostUsd: 15_000,
        sourcePullId: raw.id,
      });

      const result = await getBonusTracker();
      const craig = result.sections.find((s) => s.marketer === "Craig")!;
      expect(craig.rows).toHaveLength(1);
    });

    it("on multi-marketer ad below Jacob floor: shows in Craig but not Jacob", async () => {
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

      await seedAdSpend({
        adNumber: "1500",
        adName: "Old Collab",
        marketers: ["Craig", "Jacob"],
        totalCostUsd: 20_000,
        sourcePullId: raw.id,
      });

      const result = await getBonusTracker();
      const craig = result.sections.find((s) => s.marketer === "Craig")!;
      const jacob = result.sections.find((s) => s.marketer === "Jacob")!;
      expect(craig.rows).toHaveLength(1);
      expect(jacob.rows).toHaveLength(0);
    });
  });

  describe("past7dSpendUsd field", () => {
    it("sums spend within [today-6, today] EST inclusive; excludes older spend", async () => {
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

      const todayEst = toEstDate(new Date());
      const sixDaysAgo = addDays(todayEst, -6);
      const sevenDaysAgo = addDays(todayEst, -7);

      // 3 rows: today (in window), 6 days ago (window edge), 7 days ago (just outside)
      await db.insert(fbAdSpendDaily).values([
        {
          adNumber: "900",
          adName: "Spendy Ad",
          adNameRaw: "Spendy Ad",
          adLink: null,
          marketers: ["Craig"],
          spendDate: todayEst,
          costUsd: "1000.0000",
          sourcePullId: raw.id,
        },
        {
          adNumber: "900",
          adName: "Spendy Ad",
          adNameRaw: "Spendy Ad",
          adLink: null,
          marketers: ["Craig"],
          spendDate: sixDaysAgo,
          costUsd: "500.0000",
          sourcePullId: raw.id,
        },
        {
          adNumber: "900",
          adName: "Spendy Ad",
          adNameRaw: "Spendy Ad",
          adLink: null,
          marketers: ["Craig"],
          spendDate: sevenDaysAgo,
          costUsd: "9999.0000",
          sourcePullId: raw.id,
        },
      ]);

      const result = await getBonusTracker();
      const craig = result.sections.find((s) => s.marketer === "Craig")!;
      const row = craig.rows.find((r) => r.adNumber === "900")!;
      expect(row.lifetimeSpendUsd).toBeCloseTo(11_499, 2);
      // 7d window: today + 6-days-ago = 1000 + 500 = 1500. 7-days-ago is excluded.
      expect(row.past7dSpendUsd).toBeCloseTo(1_500, 2);
    });

    it("returns 0 when an ad has no recent spend", async () => {
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

      // All spend is on a far-past date, well outside the 7d window.
      await seedAdSpend({
        adNumber: "901",
        adName: "Dormant Ad",
        marketers: ["Craig"],
        totalCostUsd: 30_000,
        sourcePullId: raw.id,
      });

      const result = await getBonusTracker();
      const craig = result.sections.find((s) => s.marketer === "Craig")!;
      const row = craig.rows.find((r) => r.adNumber === "901")!;
      expect(row.lifetimeSpendUsd).toBeCloseTo(30_000, 2);
      expect(row.past7dSpendUsd).toBe(0);
    });
  });
});
