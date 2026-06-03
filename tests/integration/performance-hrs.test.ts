import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { adSpendDaily, rawPulls } from "@/lib/db/schema";
import { getPerformanceRollup } from "@/lib/queries/performance";
import { resetDb } from "@/tests/fixtures/seed";

// HRS launched EV INTL and began spending 2026-06-02, but the /performance
// "High Rise Short" card read $0 because hrshort had no spend tabs wired and
// "HRS" wasn't ingested. Once an HRS tab feeds ad_spend_daily, the card must
// roll it up like every other product.
describe("getPerformanceRollup — High Rise Short", () => {
  beforeAll(() => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set in test env");
  });
  beforeEach(async () => {
    await resetDb();
  });

  it("rolls HRS-tab spend into the High Rise Short card", async () => {
    const [raw] = await db
      .insert(rawPulls)
      .values({
        source: "sheets_ad_spend",
        pullBatchId: randomUUID(),
        payload: {},
        rowCount: 1,
        schemaFingerprint: "fp",
      })
      .returning({ id: rawPulls.id });
    await db.insert(adSpendDaily).values({
      product: "HRS",
      spendDate: "2026-06-02",
      costUsd: "732.72",
      sourcePullId: raw.id,
    });

    const res = await getPerformanceRollup({ today: "2026-06-03", rangeDays: 7 });
    const hrs = res.rows.find((r) => r.key === "hrshort");

    expect(hrs).toBeDefined();
    expect(hrs!.spendUsd).toBeCloseTo(732.72, 2);
    expect(hrs!.spendByTab).toEqual([
      expect.objectContaining({ tab: "HRS", spendUsd: 732.72 }),
    ]);
  });
});
