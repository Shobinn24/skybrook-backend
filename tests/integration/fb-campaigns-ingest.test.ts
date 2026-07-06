import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { asc } from "drizzle-orm";
import { db } from "@/lib/db";
import { fbCampaignDaily, rawPulls } from "@/lib/db/schema";
import { replaceCampaignDailyWindow } from "@/lib/sources/sheets/fb-campaigns";
import { resetDb } from "@/tests/fixtures/seed";

// Windowed delete-replace semantics for campaign-level FB spend. The source
// query is a rolling last-14-days window and FB restates the trailing ~2
// days, so a re-pull must replace everything from the earliest pulled date
// while leaving older (frozen) history untouched — and an empty pull must
// never wipe the table.
describe("replaceCampaignDailyWindow", () => {
  beforeAll(() => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set in test env");
  });
  beforeEach(async () => {
    await resetDb();
  });

  async function seedRawPull(): Promise<string> {
    const [raw] = await db
      .insert(rawPulls)
      .values({
        source: "sheets_fb_campaigns",
        pullBatchId: randomUUID(),
        payload: {},
        rowCount: 0,
        schemaFingerprint: "fp",
      })
      .returning({ id: rawPulls.id });
    return raw.id;
  }

  async function allRows() {
    return db
      .select({
        campaignName: fbCampaignDaily.campaignName,
        spendDate: fbCampaignDaily.spendDate,
        costUsd: fbCampaignDaily.costUsd,
        purchaseValueUsd: fbCampaignDaily.purchaseValueUsd,
      })
      .from(fbCampaignDaily)
      .orderBy(asc(fbCampaignDaily.spendDate), asc(fbCampaignDaily.campaignName));
  }

  it("inserts pulled rows with 4dp money precision", async () => {
    const rawId = await seedRawPull();
    await replaceCampaignDailyWindow(
      [
        { campaignName: "Cost Cap Campaign", spendDate: "2026-07-01", costUsd: 5657.51, purchaseValueUsd: 12694.5537 },
        { campaignName: "Zombie Campaign US", spendDate: "2026-07-01", costUsd: 350.61, purchaseValueUsd: 0 },
      ],
      rawId,
    );
    expect(await allRows()).toEqual([
      { campaignName: "Cost Cap Campaign", spendDate: "2026-07-01", costUsd: "5657.5100", purchaseValueUsd: "12694.5537" },
      { campaignName: "Zombie Campaign US", spendDate: "2026-07-01", costUsd: "350.6100", purchaseValueUsd: "0.0000" },
    ]);
  });

  it("replaces restated values inside the pulled window and preserves frozen history", async () => {
    const rawA = await seedRawPull();
    await replaceCampaignDailyWindow(
      [
        // frozen history (older than the next pull's window)
        { campaignName: "Cost Cap Campaign", spendDate: "2026-06-20", costUsd: 100, purchaseValueUsd: 200 },
        // will be restated by the next pull
        { campaignName: "Cost Cap Campaign", spendDate: "2026-07-04", costUsd: 11458.44, purchaseValueUsd: 26910.31 },
        // campaign that disappears from the next pull entirely (deleted in FB)
        { campaignName: "Old Test Campaign", spendDate: "2026-07-04", costUsd: 5, purchaseValueUsd: 0 },
      ],
      rawA,
    );
    const rawB = await seedRawPull();
    await replaceCampaignDailyWindow(
      [
        { campaignName: "Cost Cap Campaign", spendDate: "2026-07-04", costUsd: 11459.19, purchaseValueUsd: 26912.02 },
        { campaignName: "Cost Cap Campaign", spendDate: "2026-07-05", costUsd: 13200.9, purchaseValueUsd: 30930.03 },
      ],
      rawB,
    );
    expect(await allRows()).toEqual([
      { campaignName: "Cost Cap Campaign", spendDate: "2026-06-20", costUsd: "100.0000", purchaseValueUsd: "200.0000" },
      { campaignName: "Cost Cap Campaign", spendDate: "2026-07-04", costUsd: "11459.1900", purchaseValueUsd: "26912.0200" },
      { campaignName: "Cost Cap Campaign", spendDate: "2026-07-05", costUsd: "13200.9000", purchaseValueUsd: "30930.0300" },
    ]);
  });

  it("treats an empty pull as a no-op instead of wiping the table", async () => {
    const rawId = await seedRawPull();
    await replaceCampaignDailyWindow(
      [{ campaignName: "Cost Cap Campaign", spendDate: "2026-07-01", costUsd: 1, purchaseValueUsd: 2 }],
      rawId,
    );
    await replaceCampaignDailyWindow([], rawId);
    expect(await allRows()).toHaveLength(1);
  });
});
