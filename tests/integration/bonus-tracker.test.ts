import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  bonusAwards,
  bonusNotificationBatches,
  fbAdSpendDaily,
  rawPulls,
} from "@/lib/db/schema";
import {
  BONUS_COUNT_TYPES,
  BONUS_SUMMARY_MARKETER_ORDER,
  getBonusCountSummary,
  getBonusSummary,
  getBonusTracker,
  getPendingApprovals,
  getVideoEditorCountSummary,
  previewNotification,
} from "@/lib/queries/bonus-tracker";
import { VIDEO_EDITORS } from "@/lib/domain/video-editors";
import {
  detectAndInsertBonusCrossings,
  detectAndInsertVideoEditorCrossings,
} from "@/lib/jobs/bonus-crossings";
import { approveBonus, sendNotification } from "@/lib/jobs/bonus-mutations";
import { resetDb } from "@/tests/fixtures/seed";
import { toEstDate } from "@/lib/tz";
import { appRouter } from "@/lib/trpc/routers";

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

      // Pin "now" so the 7-day window is deterministic regardless of the
      // machine clock (the window anchors on the latest populated spend
      // date, so this test only ever passed when the real clock happened
      // to sit before the seeded dates).
      const now = () => new Date("2026-05-13T12:00:00Z");

      // The dormant ad's only spend is on far-past dates (2026-04-01/02
      // via seedAdSpend), well outside a window ending 2026-05-13.
      await seedAdSpend({
        adNumber: "901",
        adName: "Dormant Ad",
        marketers: ["Craig"],
        totalCostUsd: 30_000,
        sourcePullId: raw.id,
      });

      // A fresh anchor row from an unrelated, unattributed ad pushes the
      // latest-populated-date (and thus windowEnd) to 2026-05-13 — the
      // realistic case where newer ads keep the feed current while this
      // ad has gone quiet. Empty marketers → excluded from all sections,
      // so it never appears in the assertions below.
      await db.insert(fbAdSpendDaily).values({
        adNumber: "999",
        adName: "Fresh Anchor",
        adNameRaw: "Fresh Anchor",
        marketers: [],
        spendDate: "2026-05-13",
        costUsd: "1.0000",
        sourcePullId: raw.id,
      });

      const result = await getBonusTracker({ now });
      const craig = result.sections.find((s) => s.marketer === "Craig")!;
      const row = craig.rows.find((r) => r.adNumber === "901")!;
      expect(row.lifetimeSpendUsd).toBeCloseTo(30_000, 2);
      expect(row.past7dSpendUsd).toBe(0);
      // Sanity: the window really does end on the fresh anchor date.
      expect(result.past7dWindow.end).toBe("2026-05-13");
    });
  });

  describe("videoEditors section + unknownInitials (client 2026-07-02)", () => {
    beforeEach(async () => {
      await db.execute(sql`TRUNCATE TABLE bonus_awards CASCADE`);
    });

    async function makePull(): Promise<string> {
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

    it("groups AIAD ads under their editor in roster order, with award status per tier", async () => {
      const rawId = await makePull();
      await seedAdSpend({
        adNumber: "2077",
        adName: "(Mens CC) Ad 2077 - AIad - SR - UGC remix",
        marketers: [],
        totalCostUsd: 20_000,
        sourcePullId: rawId,
      });
      await seedAdSpend({
        adNumber: "2078",
        adName: "(Mens CC) Ad 2078 - AIad - SR - small one",
        marketers: [],
        totalCostUsd: 5_000,
        sourcePullId: rawId,
      });
      await seedAdSpend({
        adNumber: "2100",
        adName: "(Boyshort) Ad 2100 - AIad - PL - remix",
        marketers: [],
        totalCostUsd: 14_000,
        sourcePullId: rawId,
      });
      // Non-AIAD ad must not appear in any editor section.
      await seedAdSpend({
        adNumber: "999",
        adName: "Craig Mens VID 2",
        marketers: ["Craig"],
        totalCostUsd: 20_000,
        sourcePullId: rawId,
      });
      await detectAndInsertVideoEditorCrossings();

      const result = await getBonusTracker();
      expect(result.videoEditors.map((s) => s.editor)).toEqual([
        "Greg",
        "Ryan",
        "Sebastian",
        "Job",
        "Cristian",
        "Phat Lee",
      ]);

      const sebastian = result.videoEditors.find(
        (s) => s.editor === "Sebastian",
      )!;
      // Sorted by lifetime spend desc, includes below-threshold ads.
      expect(sebastian.rows.map((r) => r.adNumber)).toEqual(["2077", "2078"]);
      expect(sebastian.rows[0].lifetimeSpendUsd).toBeCloseTo(20_000, 2);
      expect(sebastian.rows[0].awards.tier1?.status).toBe("pending");
      expect(sebastian.rows[0].awards.tier2).toBeNull();
      expect(sebastian.rows[1].awards.tier1).toBeNull();

      const phatLee = result.videoEditors.find((s) => s.editor === "Phat Lee")!;
      expect(phatLee.rows.map((r) => r.adNumber)).toEqual(["2100"]);
      expect(phatLee.rows[0].awards.tier1?.amountUsd).toBe(200);

      // The marketer sections are untouched by the editor grouping.
      const craig = result.sections.find((s) => s.marketer === "Craig")!;
      expect(craig.rows.map((r) => r.adNumber)).toEqual(["999"]);
      for (const s of result.videoEditors) {
        expect(s.rows.map((r) => r.adNumber)).not.toContain("999");
      }
    });

    it("dual credit: an AIAD ad with a marketer name shows in BOTH the marketer section and the editor section", async () => {
      const rawId = await makePull();
      await seedAdSpend({
        adNumber: "2200",
        adName: "(Mens CC) Ad 2200 - AIad - GA - Craig remix",
        marketers: ["Craig"],
        totalCostUsd: 15_000,
        sourcePullId: rawId,
      });

      const result = await getBonusTracker();
      const craig = result.sections.find((s) => s.marketer === "Craig")!;
      const greg = result.videoEditors.find((s) => s.editor === "Greg")!;
      expect(craig.rows.map((r) => r.adNumber)).toEqual(["2200"]);
      expect(greg.rows.map((r) => r.adNumber)).toEqual(["2200"]);
    });

    it("aggregates unknown initials with example ad, spend and count — excluded initials stay off the list", async () => {
      const rawId = await makePull();
      await seedAdSpend({
        adNumber: "3001",
        adName: "(A) Ad 3001 - AIad - XY - contractor v1",
        marketers: [],
        totalCostUsd: 12_000,
        sourcePullId: rawId,
      });
      await seedAdSpend({
        adNumber: "3002",
        adName: "(A) Ad 3002 - AIad - XY - contractor v2",
        marketers: [],
        totalCostUsd: 2_000,
        sourcePullId: rawId,
      });
      await seedAdSpend({
        adNumber: "3003",
        adName: "(B) Ad 3003 - AIad - ZZ - other",
        marketers: [],
        totalCostUsd: 500,
        sourcePullId: rawId,
      });
      // Excluded (client-ruled non-editors) and known editors never
      // reach the unknown surface.
      await seedAdSpend({
        adNumber: "3004",
        adName: "(C) Ad 3004 - AIad - SJ - ruled out",
        marketers: [],
        totalCostUsd: 50_000,
        sourcePullId: rawId,
      });
      await seedAdSpend({
        adNumber: "3005",
        adName: "(C) Ad 3005 - AIad - Scotty - ruled out",
        marketers: [],
        totalCostUsd: 50_000,
        sourcePullId: rawId,
      });
      await seedAdSpend({
        adNumber: "3006",
        adName: "(D) Ad 3006 - AIad - RC - known",
        marketers: [],
        totalCostUsd: 50_000,
        sourcePullId: rawId,
      });

      const result = await getBonusTracker();
      expect(result.unknownInitials.map((u) => u.initials)).toEqual([
        "XY",
        "ZZ",
      ]); // spend desc
      const xy = result.unknownInitials[0];
      expect(xy.adCount).toBe(2);
      expect(xy.totalLifetimeSpendUsd).toBeCloseTo(14_000, 2);
      // Example = the highest-spend ad for those initials.
      expect(xy.exampleAdName).toBe("(A) Ad 3001 - AIad - XY - contractor v1");
    });

    it("returns empty videoEditors rows and unknownInitials when there are no AIAD ads", async () => {
      const result = await getBonusTracker();
      expect(result.videoEditors.every((s) => s.rows.length === 0)).toBe(true);
      expect(result.unknownInitials).toEqual([]);
    });
  });

  describe("getPendingApprovals — video editor awards", () => {
    beforeEach(async () => {
      await db.execute(sql`TRUNCATE TABLE bonus_awards CASCADE`);
    });

    it("includes editor pendings with flat default/half amounts", async () => {
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
        adNumber: "2077",
        adName: "(Mens CC) Ad 2077 - AIad - SR - UGC remix",
        marketers: [],
        totalCostUsd: 20_000,
        sourcePullId: raw.id,
      });
      await detectAndInsertVideoEditorCrossings();

      const pending = await getPendingApprovals();
      expect(pending).toHaveLength(1);
      expect(pending[0].marketer).toBe("Sebastian");
      expect(pending[0].tier).toBe("tier1");
      expect(pending[0].defaultAmountUsd).toBe(200);
      expect(pending[0].halfAmountUsd).toBe(100);
    });
  });

  describe("getPendingApprovals marketer filter (Jasper 2026-05-20)", () => {
    beforeEach(async () => {
      // bonus_awards has no FK to raw_pulls so resetDb misses it.
      await db.execute(sql`TRUNCATE TABLE bonus_awards CASCADE`);
    });

    async function seedPending(
      adNumber: string,
      marketers: string[],
      totalUsd: number,
    ) {
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
        adNumber,
        adName: `Ad ${adNumber}`,
        marketers,
        totalCostUsd: totalUsd,
        sourcePullId: raw.id,
      });
      await detectAndInsertBonusCrossings({ asOfDate: "2026-05-13" });
    }

    it("returns all pending when marketer filter is omitted", async () => {
      await seedPending("100", ["Craig"], 14_000);
      await seedPending("101", ["Raul"], 14_000);

      const all = await getPendingApprovals();
      expect(all.map((p) => p.marketer).sort()).toEqual(["Craig", "Raul"]);
    });

    it("filters to a single marketer when specified", async () => {
      await seedPending("200", ["Craig"], 14_000);
      await seedPending("201", ["Raul"], 14_000);
      await seedPending("1900", ["Jacob"], 14_000); // above Jacob's floor

      const craigOnly = await getPendingApprovals({ marketer: "Craig" });
      expect(craigOnly).toHaveLength(1);
      expect(craigOnly[0].marketer).toBe("Craig");
      expect(craigOnly[0].adNumber).toBe("200");

      const jacobOnly = await getPendingApprovals({ marketer: "Jacob" });
      expect(jacobOnly).toHaveLength(1);
      expect(jacobOnly[0].marketer).toBe("Jacob");
    });

    it("returns empty when filtered marketer has no pending", async () => {
      await seedPending("300", ["Craig"], 14_000);

      const tylerOnly = await getPendingApprovals({ marketer: "Tyler" });
      expect(tylerOnly).toHaveLength(0);
    });
  });

  describe("previewNotification rich body (Jasper 2026-05-20)", () => {
    beforeEach(async () => {
      await db.execute(sql`TRUNCATE TABLE bonus_awards CASCADE`);
      await db.execute(sql`TRUNCATE TABLE bonus_notification_batches CASCADE`);
    });

    it("includes per-award detail with adName + adLink", async () => {
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
      await db.insert(fbAdSpendDaily).values({
        adNumber: "1389",
        adName: "Craig x Cat Brief 14",
        adNameRaw: "(9055) Ad 1389 - Craig x Cat Brief 14",
        adLink: "https://facebook.com/ads/library/?id=1389",
        marketers: ["Craig"],
        spendDate: "2026-04-01",
        costUsd: "70000.0000",
        sourcePullId: raw.id,
      });

      await detectAndInsertBonusCrossings({ asOfDate: "2026-05-13" });
      const awards = await db.select().from(bonusAwards);
      for (const a of awards) {
        await approveBonus({
          awardId: a.id,
          approval: "approved_full",
          approvedBy: "jasper",
        });
      }

      const preview = await previewNotification({ periodLabel: "April 2026" });
      expect(preview.awards.length).toBe(2); // T1 + T2 both approved
      const t1 = preview.awards.find((a) => a.tier === "tier1")!;
      expect(t1.adName).toBe("Craig x Cat Brief 14");
      expect(t1.adLink).toBe("https://facebook.com/ads/library/?id=1389");
      expect(t1.amountUsd).toBe(500);

      expect(preview.messageBody).toContain("*April 2026 Bonuses*");
      expect(preview.messageBody).toContain("*Craig*");
      expect(preview.messageBody).toContain("1x 13k bonus");
      expect(preview.messageBody).toContain("1x 65k bonus");
      expect(preview.messageBody).toContain("Total: $3,500"); // $500 + $3000
      expect(preview.messageBody).toContain("*13k tier*");
      expect(preview.messageBody).toContain("*65k tier*");
      expect(preview.messageBody).toContain("Ad 1389 - Craig x Cat Brief 14");
      expect(preview.messageBody).toContain("- https://facebook.com/ads/library/?id=1389");
    });

    it("labels half-rate awards with (half) marker", async () => {
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
      await db.insert(fbAdSpendDaily).values({
        adNumber: "500",
        adName: "Craig Rehook",
        adNameRaw: "Craig Rehook",
        adLink: null,
        marketers: ["Craig"],
        spendDate: "2026-04-01",
        costUsd: "14000.0000",
        sourcePullId: raw.id,
      });
      await detectAndInsertBonusCrossings({ asOfDate: "2026-05-13" });
      const [award] = await db.select().from(bonusAwards);
      await approveBonus({
        awardId: award.id,
        approval: "approved_half",
        approvedBy: "jasper",
      });

      const preview = await previewNotification({ periodLabel: "April 2026" });
      expect(preview.messageBody).toContain("1x 13k 50% bonus");
      expect(preview.messageBody).toContain("*13k 50% tier*");
      expect(preview.messageBody).toContain("Ad 500 - Craig Rehook");
      expect(preview.messageBody).toContain("Total: $250"); // half of $500
    });

    it("emits Jasper's native multi-marketer format (all roster, JW before Dan)", async () => {
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
      // Craig: 1× $13k (ad 2037) + 1× $65k (ad 1366); Raul: 1× $13k (ad 1758).
      await db.insert(fbAdSpendDaily).values([
        {
          adNumber: "2037",
          adName: "Craig Boyshort new colors Vid 2",
          adNameRaw: "Craig Boyshort new colors Vid 2",
          adLink: "https://facebook.com/2037",
          marketers: ["Craig"],
          spendDate: "2026-04-01",
          costUsd: "14000.0000",
          sourcePullId: raw.id,
        },
        {
          adNumber: "1366",
          adName: "Craig x Meg Drawer Vid 1 B",
          adNameRaw: "Craig x Meg Drawer Vid 1 B",
          adLink: "https://facebook.com/1366",
          marketers: ["Craig"],
          spendDate: "2026-04-01",
          costUsd: "70000.0000",
          sourcePullId: raw.id,
        },
        {
          adNumber: "1758",
          adName: "Raul - Long Primary Copy + IMG Carol",
          adNameRaw: "Raul - Long Primary Copy + IMG Carol",
          adLink: "https://facebook.com/1758",
          marketers: ["Raul"],
          spendDate: "2026-04-01",
          costUsd: "14000.0000",
          sourcePullId: raw.id,
        },
      ]);
      await detectAndInsertBonusCrossings({ asOfDate: "2026-05-13" });
      for (const a of await db.select().from(bonusAwards)) {
        await approveBonus({
          awardId: a.id,
          approval: "approved_full",
          approvedBy: "jasper",
        });
      }

      const preview = await previewNotification({ periodLabel: "May 2026" });
      const body = preview.messageBody;
      // Print the real rendered message for eyeballing against Jasper's format.
      console.log("\n----- rendered notification -----\n" + body + "\n---------------------------------\n");

      // Header is bold.
      expect(body).toContain("*May 2026 Bonuses*");
      // Craig: ad 1366 ($70k) crosses BOTH tiers → a $13k award + a $65k
      // award, plus ad 2037's $13k → 2x 13k + 1x 65k, $4,000 total.
      expect(body).toContain("*Craig*\n2x 13k bonus\n1x 65k bonus\nTotal: $4,000");
      // 13k section lists both ads, sorted by ad number ascending (1366 < 2037).
      expect(body).toContain(
        "*13k tier*\nAd 1366 - Craig x Meg Drawer Vid 1 B\n- https://facebook.com/1366\n\nAd 2037 - Craig Boyshort new colors Vid 2\n- https://facebook.com/2037",
      );
      expect(body).toContain("*65k tier*\nAd 1366 - Craig x Meg Drawer Vid 1 B\n- https://facebook.com/1366");
      // Raul section present.
      expect(body).toContain("*Raul*\n1x 13k bonus\nTotal: $500");
      // $0 marketers still listed, and JW comes before Dan.
      expect(body).toContain("*Tyler*\nTotal: $0");
      expect(body).toContain("*JW*\nTotal: $0");
      expect(body).toContain("*Dan*\nTotal: $0");
      expect(body.indexOf("*JW*")).toBeLessThan(body.indexOf("*Dan*"));
      // Roster order overall: Craig → Raul → Tyler → Jacob → JW → Dan.
      const order = ["Craig", "Raul", "Tyler", "Jacob", "JW", "Dan"].map(
        (m) => body.indexOf(`*${m}*`),
      );
      expect(order).toEqual([...order].sort((a, b) => a - b));
      expect(order.every((i) => i >= 0)).toBe(true);
    });

    it("appends editor sections after the marketer roster; \$0 editors are omitted (client 2026-07-02)", async () => {
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
      // One marketer award (Craig) + one editor award (Sebastian) on
      // different ads; the editor ad also dual-credits Craig — but here
      // we keep them separate to assert the message structure simply.
      await db.insert(fbAdSpendDaily).values([
        {
          adNumber: "2037",
          adName: "Craig Boyshort new colors Vid 2",
          adNameRaw: "Craig Boyshort new colors Vid 2",
          adLink: "https://facebook.com/2037",
          marketers: ["Craig"],
          spendDate: "2026-04-01",
          costUsd: "14000.0000",
          sourcePullId: raw.id,
        },
        {
          adNumber: "2077",
          adName: "(Mens CC) Ad 2077 - AIad - SR - UGC remix",
          adNameRaw: "(Mens CC) Ad 2077 - AIad - SR - UGC remix",
          adLink: "https://facebook.com/2077",
          marketers: [],
          spendDate: "2026-04-01",
          costUsd: "14000.0000",
          sourcePullId: raw.id,
        },
      ]);
      await detectAndInsertBonusCrossings({ asOfDate: "2026-05-13" });
      await detectAndInsertVideoEditorCrossings();
      for (const a of await db.select().from(bonusAwards)) {
        await approveBonus({
          awardId: a.id,
          approval: "approved_full",
          approvedBy: "jasper",
        });
      }

      const preview = await previewNotification({ periodLabel: "June 2026" });
      const body = preview.messageBody;

      // Marketer roster unchanged: all six appear, in order.
      for (const m of ["Craig", "Raul", "Tyler", "Jacob", "JW", "Dan"]) {
        expect(body).toContain(`*${m}*`);
      }
      // Sebastian's editor section appears AFTER the marketer roster,
      // with the editor amount.
      expect(body).toContain("*Sebastian*\n1x 13k bonus\nTotal: $200");
      expect(body.indexOf("*Sebastian*")).toBeGreaterThan(body.indexOf("*Dan*"));
      expect(body).toContain("Ad 2077 - (Mens CC) Ad 2077 - AIad - SR - UGC remix");
      // Editors with no awards are NOT listed (unlike $0 marketers).
      expect(body).not.toContain("*Greg*");
      expect(body).not.toContain("*Phat Lee*");

      // Both awards ship in the batch, and the editor bucket lands in
      // the persisted totals.
      expect(preview.awardIds).toHaveLength(2);
      expect(preview.grandTotalUsd).toBe(700); // $500 Craig + $200 Sebastian
      const sebastianTotal = preview.totals.find(
        (t) => t.marketer === "Sebastian",
      );
      expect(sebastianTotal?.totalUsd).toBe(200);
      expect(sebastianTotal?.tier1FullCount).toBe(1);
    });

    it("handles empty batch gracefully", async () => {
      const preview = await previewNotification({ periodLabel: "May 2026" });
      expect(preview.awards).toEqual([]);
      expect(preview.messageBody).toContain("May 2026 Bonuses");
      expect(preview.messageBody).toContain("(no approved bonuses this period)");
    });
  });

  describe("fb_ads_only read access via tRPC (client 2026-07-02)", () => {
    beforeEach(async () => {
      await db.execute(sql`TRUNCATE TABLE bonus_awards CASCADE`);
      await db.execute(sql`TRUNCATE TABLE bonus_notification_batches CASCADE`);
    });

    it("an fb_ads_only session can call the bonus-tracker read queries", async () => {
      const c = appRouter.createCaller({
        email: "buyer@example.com",
        tier: "fb_ads_only",
        cashflowAllowed: false,
      });
      const tracker = await c.inventory.getBonusTracker();
      expect(tracker.sections.map((s) => s.marketer)).toContain("Craig");
      expect(tracker.videoEditors.map((s) => s.editor)).toContain("Sebastian");

      const summary = await c.inventory.getBonusCountSummary();
      expect(summary.marketers.length).toBeGreaterThan(0);

      const editorSummary =
        await c.inventory.getVideoEditorBonusCountSummary();
      expect(editorSummary.marketers).toEqual(VIDEO_EDITORS);

      const history = await c.inventory.getBonusNotificationHistory();
      expect(Array.isArray(history)).toBe(true);
    });
  });

  describe("getBonusSummary scoreboard (Jasper 2026-05-20)", () => {
    beforeEach(async () => {
      await db.execute(sql`TRUNCATE TABLE bonus_awards CASCADE`);
      await db.execute(sql`TRUNCATE TABLE bonus_notification_batches CASCADE`);
    });

    async function approveAndSend(opts: {
      adNumber: string;
      marketer: string;
      totalUsd: number;
      sentAt: Date;
      periodLabel?: string;
    }) {
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
      await db.insert(fbAdSpendDaily).values({
        adNumber: opts.adNumber,
        adName: `Ad ${opts.adNumber}`,
        adNameRaw: `Ad ${opts.adNumber}`,
        adLink: null,
        marketers: [opts.marketer],
        spendDate: "2026-04-01",
        costUsd: opts.totalUsd.toFixed(4),
        sourcePullId: raw.id,
      });
      await detectAndInsertBonusCrossings({ asOfDate: "2026-05-13" });
      const awards = await db
        .select()
        .from(bonusAwards)
        .where(sql`${bonusAwards.adNumber} = ${opts.adNumber}`);
      for (const a of awards) {
        await approveBonus({
          awardId: a.id,
          approval: "approved_full",
          approvedBy: "jasper",
        });
      }
      const result = await sendNotification({
        sentBy: "jasper",
        periodLabel: opts.periodLabel ?? "test",
        sendWhatsApp: async () => ({ ok: true }),
      });
      if (result.skipped) {
        throw new Error(`sendNotification skipped: ${result.reason}`);
      }
      // Backdate ONLY the batch we just created — earlier batches must
      // keep their original sent_at so multi-month aggregation works.
      await db
        .update(bonusNotificationBatches)
        .set({ sentAt: opts.sentAt })
        .where(sql`${bonusNotificationBatches.id} = ${result.batchId}`);
    }

    it("returns empty months/rows when nothing has been sent", async () => {
      const summary = await getBonusSummary();
      expect(summary.months).toEqual([]);
      expect(summary.grandTotal).toBe(0);
      // Roster preserved — each marketer has a row with zero total.
      expect(summary.rows.map((r) => r.marketer)).toEqual([
        "Craig",
        "Raul",
        "Tyler",
        "Jacob",
        "Dan",
        "JW",
      ]);
      expect(summary.rows.every((r) => r.total === 0)).toBe(true);
    });

    it("aggregates totals per (marketer, month)", async () => {
      // Craig: April batch + May batch
      await approveAndSend({
        adNumber: "100",
        marketer: "Craig",
        totalUsd: 14_000, // T1 → $500
        sentAt: new Date("2026-04-30T12:00:00Z"),
      });
      await approveAndSend({
        adNumber: "101",
        marketer: "Craig",
        totalUsd: 14_000, // another T1 → $500
        sentAt: new Date("2026-05-15T12:00:00Z"),
      });
      // Raul: only April
      await approveAndSend({
        adNumber: "200",
        marketer: "Raul",
        totalUsd: 70_000, // T1 + T2 → $500 + $3000
        sentAt: new Date("2026-04-25T12:00:00Z"),
      });

      const summary = await getBonusSummary();
      expect(summary.months).toEqual(["2026-05", "2026-04"]); // newest first
      const craig = summary.rows.find((r) => r.marketer === "Craig")!;
      expect(craig.cells["2026-04"]).toBe(500);
      expect(craig.cells["2026-05"]).toBe(500);
      expect(craig.total).toBe(1000);
      const raul = summary.rows.find((r) => r.marketer === "Raul")!;
      expect(raul.cells["2026-04"]).toBe(3500);
      expect(raul.total).toBe(3500);
      expect(summary.monthTotals["2026-04"]).toBe(4000); // Craig 500 + Raul 3500
      expect(summary.monthTotals["2026-05"]).toBe(500);
      expect(summary.grandTotal).toBe(4500);
    });

    it("buckets by the intended payout month (period_label), not when it was sent", async () => {
      // Real-world case: the May payout is reconciled and sent on June 1.
      // Labelled "May 2026" but sent_at is in June. It must show under May.
      await approveAndSend({
        adNumber: "300",
        marketer: "Craig",
        totalUsd: 14_000, // T1 → $500
        periodLabel: "May 2026",
        sentAt: new Date("2026-06-01T17:49:00Z"), // June 1, 1:49pm EDT
      });

      const summary = await getBonusSummary();
      expect(summary.months).toEqual(["2026-05"]); // NOT 2026-06
      const craig = summary.rows.find((r) => r.marketer === "Craig")!;
      expect(craig.cells["2026-05"]).toBe(500);
      expect(craig.cells["2026-06"]).toBeUndefined();
      expect(summary.monthTotals["2026-05"]).toBe(500);
    });

    it("falls back to sent_at month for non-month labels (e.g. historical backfill)", async () => {
      await approveAndSend({
        adNumber: "301",
        marketer: "Craig",
        totalUsd: 14_000,
        periodLabel: "Historical backfill 2026-05-21",
        sentAt: new Date("2026-05-27T20:59:00Z"), // → 2026-05 via sent_at
      });

      const summary = await getBonusSummary();
      expect(summary.months).toEqual(["2026-05"]);
      const craig = summary.rows.find((r) => r.marketer === "Craig")!;
      expect(craig.cells["2026-05"]).toBe(500);
    });
  });

  describe("getBonusCountSummary (Jasper 2026-05-28 redesign)", () => {
    beforeEach(async () => {
      await db.execute(sql`TRUNCATE TABLE bonus_awards CASCADE`);
      await db.execute(sql`TRUNCATE TABLE bonus_notification_batches CASCADE`);
    });

    async function awardWith(opts: {
      adNumber: string;
      marketer: string;
      totalUsd: number;
      approval?: "approved_full" | "approved_half";
      sentAt: Date;
      periodLabel?: string;
    }) {
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
      await db.insert(fbAdSpendDaily).values({
        adNumber: opts.adNumber,
        adName: `Ad ${opts.adNumber}`,
        adNameRaw: `Ad ${opts.adNumber}`,
        adLink: null,
        marketers: [opts.marketer],
        spendDate: "2026-04-01",
        costUsd: opts.totalUsd.toFixed(4),
        sourcePullId: raw.id,
      });
      await detectAndInsertBonusCrossings({ asOfDate: "2026-05-13" });
      const awards = await db
        .select()
        .from(bonusAwards)
        .where(sql`${bonusAwards.adNumber} = ${opts.adNumber}`);
      for (const a of awards) {
        await approveBonus({
          awardId: a.id,
          approval: opts.approval ?? "approved_full",
          approvedBy: "jasper",
        });
      }
      const result = await sendNotification({
        sentBy: "jasper",
        periodLabel: opts.periodLabel ?? "test",
        sendWhatsApp: async () => ({ ok: true }),
      });
      if (result.skipped) {
        throw new Error(`sendNotification skipped: ${result.reason}`);
      }
      await db
        .update(bonusNotificationBatches)
        .set({ sentAt: opts.sentAt })
        .where(sql`${bonusNotificationBatches.id} = ${result.batchId}`);
    }

    it("buckets by payout month (period label), not sent_at: May cycle sent in June lands in 2026-05; June cycle sent in July lands in 2026-06", async () => {
      // The real bug (Jasper 2026-06-30): the May payout was generated June 1-2,
      // so bucketing by sent_at put the whole May cycle in the 2026-06 column.
      await awardWith({
        adNumber: "500",
        marketer: "Craig",
        totalUsd: 14_000,
        approval: "approved_full",
        sentAt: new Date("2026-06-02T14:00:00Z"), // sent in June...
        periodLabel: "May 2026", // ...but it is the MAY cycle
      });
      // And next month's cycle, generated a day into July, must land in June.
      await awardWith({
        adNumber: "501",
        marketer: "Raul",
        totalUsd: 14_000,
        approval: "approved_full",
        sentAt: new Date("2026-07-01T14:00:00Z"), // sent July 1...
        periodLabel: "June 2026", // ...June cycle
      });

      const summary = await getBonusCountSummary();
      const months = [...new Set(summary.rows.map((r) => r.month))];
      // Old bug bucketed by sent_at: May->2026-06, June->2026-07. Now both
      // land in their payout month and nothing leaks into 2026-07.
      expect(months).not.toContain("2026-07");
      expect(months.sort()).toEqual(["2026-05", "2026-06"]);
      // Craig's 13K award sits in 2026-05, Raul's in 2026-06.
      const may13k = summary.rows.find((r) => r.month === "2026-05" && r.type === "13K");
      const jun13k = summary.rows.find((r) => r.month === "2026-06" && r.type === "13K");
      expect(may13k?.counts.Craig).toBe(1);
      expect(jun13k?.counts.Raul).toBe(1);
    }, 30_000);

    it("returns empty rows when nothing has been sent for May 2026 onwards", async () => {
      const summary = await getBonusCountSummary();
      expect(summary.rows).toEqual([]);
      expect(summary.grandTotal).toBe(0);
      expect(summary.marketers).toEqual(BONUS_SUMMARY_MARKETER_ORDER);
    });

    it("uses Jasper's column order (Craig, Raul, Tyler, Jacob, JW, Dan) — JW BEFORE Dan", async () => {
      const summary = await getBonusCountSummary();
      expect(summary.marketers).toEqual([
        "Craig", "Raul", "Tyler", "Jacob", "JW", "Dan",
      ]);
    });

    it("buckets awards into the 4 types (13K / 13K 50% / 65K / 65K 50%) and counts per marketer", async () => {
      // Craig: 1× T1 full + 1× T1 half
      await awardWith({
        adNumber: "100",
        marketer: "Craig",
        totalUsd: 14_000,
        approval: "approved_full",
        sentAt: new Date("2026-05-15T12:00:00Z"),
      });
      await awardWith({
        adNumber: "101",
        marketer: "Craig",
        totalUsd: 14_000,
        approval: "approved_half",
        sentAt: new Date("2026-05-16T12:00:00Z"),
      });
      // Raul: 1× ad crosses T1 + T2 → 2 award rows from the detector
      await awardWith({
        adNumber: "200",
        marketer: "Raul",
        totalUsd: 70_000,
        approval: "approved_full",
        sentAt: new Date("2026-05-20T12:00:00Z"),
      });

      const summary = await getBonusCountSummary();

      // Single month seeded → 4 rows (one per type).
      expect(summary.rows).toHaveLength(4);
      expect(summary.rows.map((r) => r.type)).toEqual([
        ...BONUS_COUNT_TYPES,
      ]);
      expect(summary.rows.every((r) => r.month === "2026-05")).toBe(true);

      const byType = Object.fromEntries(
        summary.rows.map((r) => [r.type, r]),
      );
      expect(byType["13K"].counts.Craig).toBe(1);
      expect(byType["13K"].counts.Raul).toBe(1);
      expect(byType["13K"].total).toBe(2);
      expect(byType["13K 50%"].counts.Craig).toBe(1);
      expect(byType["13K 50%"].total).toBe(1);
      expect(byType["65K"].counts.Raul).toBe(1);
      expect(byType["65K"].total).toBe(1);
      expect(byType["65K 50%"].total).toBe(0);
      expect(summary.grandTotal).toBe(4);
    });

    it("emits monthly sections in ASCENDING order with all 4 type rows per month (spec: append new section below)", async () => {
      await awardWith({
        adNumber: "300",
        marketer: "Tyler",
        totalUsd: 14_000,
        sentAt: new Date("2026-06-15T12:00:00Z"),
      });
      await awardWith({
        adNumber: "301",
        marketer: "Tyler",
        totalUsd: 14_000,
        sentAt: new Date("2026-05-15T12:00:00Z"),
      });

      const summary = await getBonusCountSummary();
      // Oldest month first; newest month appended BELOW. May 2026 (the
      // requirement floor) lands at the top, then June below it.
      expect(summary.rows.map((r) => r.month)).toEqual([
        "2026-05", "2026-05", "2026-05", "2026-05",
        "2026-06", "2026-06", "2026-06", "2026-06",
      ]);
      // The 4-row visual section is guaranteed regardless of which
      // types had actual data this month.
      const types = summary.rows.map((r) => r.type);
      expect(types.slice(0, 4)).toEqual([...BONUS_COUNT_TYPES]);
      expect(types.slice(4, 8)).toEqual([...BONUS_COUNT_TYPES]);
    });

    it("excludes batches sent before 2026-05-01 (the May 2026 onwards cutoff)", async () => {
      await awardWith({
        adNumber: "400",
        marketer: "Craig",
        totalUsd: 14_000,
        sentAt: new Date("2026-04-28T12:00:00Z"), // April — excluded
      });
      await awardWith({
        adNumber: "401",
        marketer: "Craig",
        totalUsd: 14_000,
        sentAt: new Date("2026-05-01T16:00:00Z"), // May 1 EST — included
      });

      const summary = await getBonusCountSummary();
      expect(summary.rows.every((r) => r.month === "2026-05")).toBe(true);
      expect(summary.grandTotal).toBe(1);
    });
  });

  describe("getVideoEditorCountSummary (editor Summary tab)", () => {
    beforeEach(async () => {
      await db.execute(sql`TRUNCATE TABLE bonus_awards CASCADE`);
      await db.execute(sql`TRUNCATE TABLE bonus_notification_batches CASCADE`);
    });

    /** Seed an AIAD ad, detect the editor crossing, approve every
     * resulting award, ship a batch, and backdate it — the editor
     * mirror of `awardWith` above. */
    async function editorAwardWith(opts: {
      adNumber: string;
      initials: string;
      totalUsd: number;
      approval?: "approved_full" | "approved_half";
      sentAt: Date;
      periodLabel?: string;
    }) {
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
      const adNameRaw = `(Product) Ad ${opts.adNumber} - AIad - ${opts.initials} - v1`;
      await db.insert(fbAdSpendDaily).values({
        adNumber: opts.adNumber,
        adName: adNameRaw,
        adNameRaw,
        adLink: null,
        marketers: [],
        spendDate: "2026-05-10",
        costUsd: opts.totalUsd.toFixed(4),
        sourcePullId: raw.id,
      });
      await detectAndInsertVideoEditorCrossings();
      const awards = await db
        .select()
        .from(bonusAwards)
        .where(sql`${bonusAwards.adNumber} = ${opts.adNumber} AND ${bonusAwards.status} = 'pending'`);
      for (const a of awards) {
        await approveBonus({
          awardId: a.id,
          approval: opts.approval ?? "approved_full",
          approvedBy: "jasper",
        });
      }
      const result = await sendNotification({
        sentBy: "jasper",
        periodLabel: opts.periodLabel ?? "test",
        sendWhatsApp: async () => ({ ok: true }),
      });
      if (result.skipped) {
        throw new Error(`sendNotification skipped: ${result.reason}`);
      }
      await db
        .update(bonusNotificationBatches)
        .set({ sentAt: opts.sentAt })
        .where(sql`${bonusNotificationBatches.id} = ${result.batchId}`);
    }

    it("returns empty rows and the editor roster when nothing has been sent", async () => {
      const summary = await getVideoEditorCountSummary();
      expect(summary.rows).toEqual([]);
      expect(summary.grandTotal).toBe(0);
      expect(summary.marketers).toEqual(VIDEO_EDITORS);
    });

    it("buckets editor awards by payout month (period label) with editor columns", async () => {
      // The May cycle is reconciled and sent June 2 — must land in 2026-05
      // (same month-attribution rule as the marketer summary).
      await editorAwardWith({
        adNumber: "2077",
        initials: "SR",
        totalUsd: 14_000, // T1
        sentAt: new Date("2026-06-02T14:00:00Z"),
        periodLabel: "May 2026",
      });

      const summary = await getVideoEditorCountSummary();
      const months = [...new Set(summary.rows.map((r) => r.month))];
      expect(months).toEqual(["2026-05"]);
      // 4-row month section in type order, like the marketer summary.
      expect(summary.rows.map((r) => r.type)).toEqual([...BONUS_COUNT_TYPES]);
      const t1 = summary.rows.find((r) => r.type === "13K")!;
      expect(t1.counts.Sebastian).toBe(1);
      expect(t1.total).toBe(1);
      expect(summary.grandTotal).toBe(1);
    });

    it("splits full and half approvals into 13K / 13K 50% rows for editors", async () => {
      await editorAwardWith({
        adNumber: "2101",
        initials: "GA",
        totalUsd: 14_000,
        approval: "approved_full",
        sentAt: new Date("2026-05-15T12:00:00Z"),
      });
      await editorAwardWith({
        adNumber: "2102",
        initials: "PL",
        totalUsd: 14_000,
        approval: "approved_half",
        sentAt: new Date("2026-05-16T12:00:00Z"),
      });

      const summary = await getVideoEditorCountSummary();
      const byType = Object.fromEntries(summary.rows.map((r) => [r.type, r]));
      expect(byType["13K"].counts.Greg).toBe(1);
      expect(byType["13K 50%"].counts["Phat Lee"]).toBe(1);
      expect(byType["65K"].total).toBe(0);
      expect(summary.grandTotal).toBe(2);
    });

    it("marketer awards never leak into the editor summary, and editor awards never leak into the marketer summary — even inside ONE mixed batch", async () => {
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
      // One marketer ad + one editor AIAD ad, approved together and
      // shipped in a single batch (the real monthly flow — one batch
      // covers both programs).
      await db.insert(fbAdSpendDaily).values([
        {
          adNumber: "100",
          adName: "Craig Mens VID 2",
          adNameRaw: "Craig Mens VID 2",
          adLink: null,
          marketers: ["Craig"],
          spendDate: "2026-05-10",
          costUsd: "14000.0000",
          sourcePullId: raw.id,
        },
        {
          adNumber: "2077",
          adName: "(Mens CC) Ad 2077 - AIad - SR - remix",
          adNameRaw: "(Mens CC) Ad 2077 - AIad - SR - remix",
          adLink: null,
          marketers: [],
          spendDate: "2026-05-10",
          costUsd: "14000.0000",
          sourcePullId: raw.id,
        },
      ]);
      await detectAndInsertBonusCrossings({ asOfDate: "2026-05-13" });
      await detectAndInsertVideoEditorCrossings();
      for (const a of await db.select().from(bonusAwards)) {
        await approveBonus({
          awardId: a.id,
          approval: "approved_full",
          approvedBy: "jasper",
        });
      }
      const result = await sendNotification({
        sentBy: "jasper",
        periodLabel: "May 2026",
        sendWhatsApp: async () => ({ ok: true }),
      });
      if (result.skipped) throw new Error("send skipped");
      await db
        .update(bonusNotificationBatches)
        .set({ sentAt: new Date("2026-06-02T14:00:00Z") })
        .where(sql`${bonusNotificationBatches.id} = ${result.batchId}`);

      const editorSummary = await getVideoEditorCountSummary();
      const editor13k = editorSummary.rows.find((r) => r.type === "13K")!;
      expect(editor13k.counts.Sebastian).toBe(1);
      expect(
        (editor13k.counts as Record<string, number | undefined>).Craig,
      ).toBeUndefined();
      expect(editorSummary.grandTotal).toBe(1);

      const marketerSummary = await getBonusCountSummary();
      const marketer13k = marketerSummary.rows.find((r) => r.type === "13K")!;
      expect(marketer13k.counts.Craig).toBe(1);
      expect(
        (marketer13k.counts as Record<string, number | undefined>).Sebastian,
      ).toBeUndefined();
      expect(marketerSummary.grandTotal).toBe(1);
    });

    it("applies the same May-2026-onwards sent-date cutoff as the marketer summary", async () => {
      await editorAwardWith({
        adNumber: "2201",
        initials: "RC",
        totalUsd: 14_000,
        sentAt: new Date("2026-04-28T12:00:00Z"), // April — excluded
      });
      await editorAwardWith({
        adNumber: "2202",
        initials: "RC",
        totalUsd: 14_000,
        sentAt: new Date("2026-05-01T16:00:00Z"), // May 1 EST — included
      });

      const summary = await getVideoEditorCountSummary();
      expect(summary.rows.every((r) => r.month === "2026-05")).toBe(true);
      expect(summary.grandTotal).toBe(1);
    });
  });
});
