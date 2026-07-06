import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { applovinAdSpendDaily, fbAdSpendDaily, rawPulls } from "@/lib/db/schema";
import { getPerformanceRollup } from "@/lib/queries/performance";
import { resetDb } from "@/tests/fixtures/seed";

// HRS launched EV INTL and began spending 2026-06-02, but the /performance
// "High Rise Short" card read $0 because the line wasn't wired. HRS spend
// must roll into the High Rise Short card like every other product. Since
// the unified-math change the card reads the shared per-line computation:
// FB ads attributed to "High Rise Short" (URL-first with ad-name fallback,
// "(HRS ...)" prefix) + the AppLovin feed's "High Rise Short" rows.
describe("getPerformanceRollup — High Rise Short", () => {
  beforeAll(() => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set in test env");
  });
  beforeEach(async () => {
    await resetDb();
  });

  it("rolls HRS FB + AppLovin spend into the High Rise Short card", async () => {
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
      adNumber: "500",
      adName: "hrs launch",
      adNameRaw: "(HRS) Ad 500 - hrs launch",
      adPrefix: "HRS",
      adLink: null,
      marketers: [],
      spendDate: "2026-06-02",
      costUsd: "732.72",
      sourcePullId: raw.id,
    });
    await db.insert(applovinAdSpendDaily).values({
      product: "High Rise Short",
      spendDate: "2026-06-02",
      costUsd: "100.00",
      sourcePullId: raw.id,
    });

    const res = await getPerformanceRollup({ today: "2026-06-03", rangeDays: 7 });
    const hrs = res.rows.find((r) => r.key === "hrshort");

    expect(hrs).toBeDefined();
    // Total is FB ($732.72) + AppLovin ($100) = $832.72.
    expect(hrs!.spendUsd).toBeCloseTo(832.72, 2);
    expect(hrs!.spendBySource).toEqual([
      expect.objectContaining({ source: "FB", spendUsd: 732.72 }),
      expect.objectContaining({ source: "AL", spendUsd: 100 }),
    ]);
  });
});
