import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { fbAdSpendDaily, rawPulls } from "@/lib/db/schema";
import { getPerformanceRollup } from "@/lib/queries/performance";
import { resetDb } from "@/tests/fixtures/seed";

// Owner request 2026-07-03: /performance Focus areas gets an extra
// spend-only box for all ads with "infotainment" in the name. No revenue
// and no ROAS can be attributed to these, so the rollup exposes spend only.
// Source is fb_ad_spend_daily (per-ad names); AppLovin has no ad names.
describe("getPerformanceRollup — infotainment spend box", () => {
  beforeAll(() => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set in test env");
  });
  beforeEach(async () => {
    await resetDb();
  });

  async function seedAd(adNumber: string, name: string, date: string, cost: string) {
    const [raw] = await db
      .insert(rawPulls)
      .values({
        source: "sheets_fb_ads",
        pullBatchId: randomUUID(),
        payload: {},
        rowCount: 1,
        schemaFingerprint: "fp",
      })
      .returning({ id: rawPulls.id });
    await db.insert(fbAdSpendDaily).values({
      adNumber,
      adName: name,
      adNameRaw: name,
      marketers: [],
      spendDate: date,
      costUsd: cost,
      sourcePullId: raw.id,
    });
  }

  it("sums in-window infotainment ads case-insensitively, ignoring everything else", async () => {
    await seedAd("3076", "(9055 ICC) Ad 3076 - CAROL - RC - Infotainment VID 478", "2026-07-02", "1000.50");
    await seedAd("3077", "(9055 CC) Ad 3077 - CAROL - RC - INFOTAINMENT VID 475", "2026-07-01", "500.00");
    await seedAd("3038", "(9055) Ad 3038 - CAROL - CJ - Infotainment VID 1", "2026-06-01", "99.00"); // out of window
    await seedAd("2077", "(Mens CC) Ad 2077 - AIad - SR - Men's Product AI Ad", "2026-07-02", "777.00"); // untagged

    const res = await getPerformanceRollup({ today: "2026-07-03", rangeDays: 7 });

    expect(res.infotainment.spendUsd).toBeCloseTo(1500.5, 2);
  });

  it("reports zero when no infotainment ads exist in the window", async () => {
    await seedAd("2077", "(Mens CC) Ad 2077 - AIad - SR - Men's Product AI Ad", "2026-07-02", "777.00");
    const res = await getPerformanceRollup({ today: "2026-07-03", rangeDays: 7 });
    expect(res.infotainment.spendUsd).toBe(0);
  });
});
