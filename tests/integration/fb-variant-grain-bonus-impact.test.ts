import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { bonusAwards, fbAdSpendDaily, rawPulls } from "@/lib/db/schema";
import { detectAndInsertBonusCrossings } from "@/lib/jobs/bonus-crossings";
import { getBonusTracker } from "@/lib/queries/bonus-tracker";
import { getAllProductsRollup } from "@/lib/queries/performance";
import "dotenv/config";

// Variant-grain proof + bonus-impact guard.
//
// Real ad 1631 ("Craig x Dan Navarra") runs under BOTH (9055 CC) and
// (HOME US BAU) — the exact case that drove the HOME undercount. With
// variant grain it's stored as separate rows per prefix, so:
//   - product attribution SPLITS spend correctly (9055 vs Brand/Homepage)
//   - the bonus pipeline, which groups by ad_number, must see the SAME
//     summed total it always did — not doubled, not split per prefix.
//
// We use ad number 2631 (above every marketer's bonus floor, incl. Dan's
// 1944) so both marketers are eligible and the two-marketer attribution is
// visible; the shape is otherwise identical to 1631.

const ADNUM = "2631";
const CANON_RAW = "(9055 CC) Ad 2631 - DN - Craig x Dan Navarra";

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

// One ad_number, two prefixes. Identity (name + marketers) is the
// canonical (higher-spend 9055) variant, repeated on BOTH prefix rows —
// exactly what the ingest writes. 9055 = $8k, HOME = $6k, total $14k.
async function seedVariantGrainAd(pull: string) {
  const base = {
    adNumber: ADNUM,
    adName: "Craig x Dan Navarra",
    adNameRaw: CANON_RAW,
    adLink: null,
    marketers: ["Craig", "Dan"],
    sourcePullId: pull,
  };
  await db.insert(fbAdSpendDaily).values([
    { ...base, adPrefix: "9055 CC", spendDate: "2026-04-01", costUsd: "4000" },
    { ...base, adPrefix: "9055 CC", spendDate: "2026-04-02", costUsd: "4000" },
    { ...base, adPrefix: "HOME US BAU", spendDate: "2026-04-01", costUsd: "3000" },
    { ...base, adPrefix: "HOME US BAU", spendDate: "2026-04-02", costUsd: "3000" },
  ]);
}

describe("FB variant grain — product split + bonus invariance", () => {
  beforeAll(() => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set");
  });
  beforeEach(async () => {
    await db.execute(
      sql`TRUNCATE TABLE raw_pulls, fb_ad_spend_daily, bonus_awards, daily_sales, skus CASCADE`,
    );
  });

  it("splits spend across prefixes so HOME is not absorbed into 9055", async () => {
    const pull = await makeRawPull();
    await seedVariantGrainAd(pull);

    // Window 2026-03-04..2026-04-02 covers both seed dates.
    const res = await getAllProductsRollup({ today: "2026-04-03", rangeDays: 30 });
    const spendOf = (p: string) => res.rows.find((r) => r.product === p)?.spendUsd ?? 0;

    expect(spendOf("9055")).toBe(8000); // product portion only
    expect(spendOf("Brand / Homepage")).toBe(6000); // homepage NOT hidden in 9055
    expect(res.totalSpendUsd).toBe(14000); // total preserved
  });

  it("bonus crossings see the FULL ad spend summed across prefixes (not doubled, not split)", async () => {
    const pull = await makeRawPull();
    await seedVariantGrainAd(pull);

    const result = await detectAndInsertBonusCrossings({ asOfDate: "2026-05-13" });

    // $14k total > $13k T1, < $65k → exactly one T1 award per eligible
    // marketer (Craig, Dan). Two awards, NOT four (would mean per-prefix),
    // NOT a T2 (would mean the $14k got doubled to $28k).
    expect(result.inserted).toBe(2);
    const rows = await db.select().from(bonusAwards);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.adNumber === ADNUM)).toBe(true);
    expect(rows.every((r) => r.tier === "tier1")).toBe(true);
    expect(new Set(rows.map((r) => r.marketer))).toEqual(new Set(["Craig", "Dan"]));
    // Cumulative across all four rows by date: 04-01=$7k, 04-02=$14k →
    // crosses $13k on 04-02 (grain-invariant because firstCrossingDate sums).
    expect(rows.every((r) => r.crossedAt === "2026-04-02")).toBe(true);
  });

  it("bonus tracker shows the ad once per marketer with the summed lifetime spend", async () => {
    const pull = await makeRawPull();
    await seedVariantGrainAd(pull);

    const tracker = await getBonusTracker({ now: () => new Date("2026-05-13T12:00:00Z") });
    const craig = tracker.sections.find((s) => s.marketer === "Craig");
    const craigRows = craig?.rows.filter((r) => r.adNumber === ADNUM) ?? [];

    // Appears ONCE (not once per prefix), with the full $14k lifetime.
    expect(craigRows).toHaveLength(1);
    expect(craigRows[0].lifetimeSpendUsd).toBe(14000);
    expect(craigRows[0].marketers).toEqual(["Craig", "Dan"]);
    // Canonical identity is preserved (the 9055 variant name).
    expect(craigRows[0].adNameRaw).toBe(CANON_RAW);
  });
});
