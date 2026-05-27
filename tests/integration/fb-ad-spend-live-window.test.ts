import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { fbAdSpendDaily, rawPulls } from "@/lib/db/schema";
import { replaceFbAdSpendLiveWindow } from "@/lib/sources/sheets";
import "dotenv/config";

// Provenance row to satisfy fb_ad_spend_daily.source_pull_id FK.
async function makeRawPull(): Promise<string> {
  const [row] = await db
    .insert(rawPulls)
    .values({
      source: "sheets_fb_ads",
      pullBatchId: crypto.randomUUID(),
      payload: {},
      rowCount: 0,
      schemaFingerprint: "test-fp",
    })
    .returning({ id: rawPulls.id });
  return row.id;
}

const ad = (
  adNumber: string,
  adName: string,
  daily: Array<[string, number]>,
) => ({
  adNumber,
  adName,
  adNameRaw: `(HW) ${adName}`,
  adLink: null,
  dailySpend: daily.map(([spendDate, costUsd]) => ({ spendDate, costUsd })),
});

describe("replaceFbAdSpendLiveWindow", () => {
  beforeAll(() => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set in test env");
  });

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE TABLE fb_ad_spend_daily, raw_pulls CASCADE`);
  });

  it("preserves pre-window history and refreshes only the live window", async () => {
    const seedPull = await makeRawPull();
    await db.insert(fbAdSpendDaily).values([
      // imported history — below the live window, must survive
      { adNumber: "100", adName: "old", adNameRaw: "(HW) old", adLink: null, marketers: [], spendDate: "2024-03-01", costUsd: "500", sourcePullId: seedPull },
      { adNumber: "100", adName: "old", adNameRaw: "(HW) old", adLink: null, marketers: [], spendDate: "2025-11-15", costUsd: "250", sourcePullId: seedPull },
      // a stale current-year row that today's pull should overwrite
      { adNumber: "200", adName: "stale", adNameRaw: "(HW) stale", adLink: null, marketers: [], spendDate: "2026-01-05", costUsd: "10", sourcePullId: seedPull },
    ]);

    const livePull = await makeRawPull();
    // Live pull = current year only; earliest date 2026-01-05 = window floor.
    await replaceFbAdSpendLiveWindow(
      [ad("200", "fresh", [["2026-01-05", 99], ["2026-02-01", 50]])],
      livePull,
    );

    const rows = await db
      .select({ adNumber: fbAdSpendDaily.adNumber, spendDate: fbAdSpendDaily.spendDate, costUsd: fbAdSpendDaily.costUsd })
      .from(fbAdSpendDaily)
      .orderBy(fbAdSpendDaily.spendDate);

    expect(rows).toEqual([
      { adNumber: "100", spendDate: "2024-03-01", costUsd: "500.0000" },
      { adNumber: "100", spendDate: "2025-11-15", costUsd: "250.0000" },
      { adNumber: "200", spendDate: "2026-01-05", costUsd: "99.0000" },
      { adNumber: "200", spendDate: "2026-02-01", costUsd: "50.0000" },
    ]);
  });

  it("is a no-op on an empty pull (never wipes existing data)", async () => {
    const seedPull = await makeRawPull();
    await db.insert(fbAdSpendDaily).values([
      { adNumber: "100", adName: "old", adNameRaw: "(HW) old", adLink: null, marketers: [], spendDate: "2024-03-01", costUsd: "500", sourcePullId: seedPull },
      { adNumber: "200", adName: "live", adNameRaw: "(HW) live", adLink: null, marketers: [], spendDate: "2026-01-05", costUsd: "10", sourcePullId: seedPull },
    ]);

    await replaceFbAdSpendLiveWindow([], await makeRawPull());

    const count = await db.select({ n: sql<number>`count(*)::int` }).from(fbAdSpendDaily);
    expect(count[0].n).toBe(2);
  });
});
