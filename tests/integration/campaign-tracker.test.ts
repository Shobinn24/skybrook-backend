import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { campaignTrackerNotes, fbCampaignDaily, rawPulls } from "@/lib/db/schema";
import { getCampaignTracker } from "@/lib/queries/campaign-tracker";
import { resetDb } from "@/tests/fixtures/seed";

// /campaign-tracker rollup. Mirrors the operator's hand-built sheet exactly:
// rows are days grouped into Mon–Sun weeks; each tracked bucket shows 1D
// spend + ROAS; weekly (7D) values are the Mon–Sun sums with spend-weighted
// ROAS; US/INTL Total columns are derived (CC + BAU per region). Verified
// conventions 2026-07-06: totals = sum, total ROAS = sum(value)/sum(spend).
describe("getCampaignTracker", () => {
  beforeAll(() => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set in test env");
  });
  beforeEach(async () => {
    await resetDb();
  });

  async function seed(campaignName: string, spendDate: string, cost: number, value: number) {
    const [raw] = await db
      .insert(rawPulls)
      .values({
        source: "sheets_fb_campaigns",
        pullBatchId: randomUUID(),
        payload: {},
        rowCount: 1,
        schemaFingerprint: "fp",
      })
      .returning({ id: rawPulls.id });
    await db.insert(fbCampaignDaily).values({
      campaignName,
      spendDate,
      costUsd: cost.toFixed(4),
      purchaseValueUsd: value.toFixed(4),
      sourcePullId: raw.id,
    });
  }

  it("groups days into Mon–Sun weeks with per-bucket 1D cells and weighted weekly aggregates", async () => {
    // Week of Mon 2026-06-29. Two buckets + one untracked campaign.
    await seed("Cost Cap Campaign", "2026-06-29", 100, 300); // roas 3
    await seed("Cost Cap Campaign", "2026-06-30", 300, 300); // roas 1
    await seed("US BAU CBO IA Campaign", "2026-06-29", 50, 25); // roas 0.5
    await seed("Men's Campaign", "2026-06-29", 999, 999); // untracked — must not leak

    const res = await getCampaignTracker({ startDate: "2026-06-29" });
    expect(res.weeks).toHaveLength(1);
    const week = res.weeks[0];
    expect(week.weekStart).toBe("2026-06-29");

    const mon = week.days.find((d) => d.date === "2026-06-29")!;
    expect(mon.buckets.us_cc).toEqual({ spendUsd: 100, purchaseValueUsd: 300, roas: 3 });
    expect(mon.buckets.us_bau).toEqual({ spendUsd: 50, purchaseValueUsd: 25, roas: 0.5 });
    // Untracked campaign is not a bucket cell.
    expect(Object.keys(mon.buckets)).not.toContain("Men's Campaign");

    // Weekly aggregate: us_cc spend 400, value 600 → weighted roas 1.5
    // (NOT the average of 3 and 1, which would be 2).
    expect(week.weekly.buckets.us_cc).toEqual({ spendUsd: 400, purchaseValueUsd: 600, roas: 1.5 });
  });

  it("derives US and INTL totals as CC+BAU with spend-weighted ROAS", async () => {
    await seed("Cost Cap Campaign", "2026-07-01", 100, 200);
    await seed("US BAU CBO IA Campaign", "2026-07-01", 100, 400);
    await seed("INTL Cost Cap Campaign", "2026-07-01", 10, 30);
    await seed("INTL BAU CBO IA Campaign", "2026-07-01", 30, 30);
    // CC CBO / Partnership / Zombie do NOT roll into either total.
    await seed("Partnership Campaign", "2026-07-01", 5000, 5000);

    const res = await getCampaignTracker({ startDate: "2026-06-29" });
    const day = res.weeks[0].days.find((d) => d.date === "2026-07-01")!;
    expect(day.usTotal).toEqual({ spendUsd: 200, purchaseValueUsd: 600, roas: 3 });
    expect(day.intlTotal).toEqual({ spendUsd: 40, purchaseValueUsd: 60, roas: 1.5 });
  });

  it("returns zero cells with null ROAS for bucket-days with no spend", async () => {
    await seed("Cost Cap Campaign", "2026-07-01", 100, 200);
    const res = await getCampaignTracker({ startDate: "2026-06-29" });
    const day = res.weeks[0].days.find((d) => d.date === "2026-07-01")!;
    expect(day.buckets.zombie).toEqual({ spendUsd: 0, purchaseValueUsd: 0, roas: null });
  });

  it("spans every date from startDate through the max ingested date, even ones with no rows", async () => {
    await seed("Cost Cap Campaign", "2026-06-29", 1, 1);
    await seed("Cost Cap Campaign", "2026-07-02", 1, 1);
    const res = await getCampaignTracker({ startDate: "2026-06-29" });
    const dates = res.weeks.flatMap((w) => w.days.map((d) => d.date));
    expect(dates).toEqual(["2026-06-29", "2026-06-30", "2026-07-01", "2026-07-02"]);
    expect(res.asOfDate).toBe("2026-07-02");
  });

  it("attaches the weekly note when one exists", async () => {
    await seed("Cost Cap Campaign", "2026-06-29", 1, 1);
    await db.insert(campaignTrackerNotes).values({
      weekStart: "2026-06-29",
      note: "scaled CC hard this week",
      updatedBy: "ops",
    });
    const res = await getCampaignTracker({ startDate: "2026-06-29" });
    expect(res.weeks[0].note).toBe("scaled CC hard this week");
  });

  it("returns an empty result when the table is empty", async () => {
    const res = await getCampaignTracker({ startDate: "2026-06-29" });
    expect(res.weeks).toEqual([]);
    expect(res.asOfDate).toBeNull();
  });
});

describe("upsertCampaignTrackerNote", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("inserts a new weekly note and updates it on subsequent saves", async () => {
    const { upsertCampaignTrackerNote } = await import("@/lib/queries/campaign-tracker");
    await upsertCampaignTrackerNote({ weekStart: "2026-06-29", note: "first pass", updatedBy: "ops" });
    await upsertCampaignTrackerNote({ weekStart: "2026-06-29", note: "revised after weekend", updatedBy: "ops" });

    const rows = await db.select().from(campaignTrackerNotes);
    expect(rows).toHaveLength(1);
    expect(rows[0].note).toBe("revised after weekend");
    expect(rows[0].weekStart).toBe("2026-06-29");
  });

  it("rejects a weekStart that is not a Monday", async () => {
    const { upsertCampaignTrackerNote } = await import("@/lib/queries/campaign-tracker");
    await expect(
      upsertCampaignTrackerNote({ weekStart: "2026-07-01", note: "x", updatedBy: "ops" }),
    ).rejects.toThrow(/monday/i);
  });
});
