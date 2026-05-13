import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { db } from "@/lib/db";
import { fbAdSpendDaily, rawPulls } from "@/lib/db/schema";
import { getBonusTracker } from "@/lib/queries/bonus-tracker";
import { resetDb } from "@/tests/fixtures/seed";

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
});
