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
  adPrefix: "HW",
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

  it("BLOCKS the write and leaves data intact when a month total collapses", async () => {
    const seedPull = await makeRawPull();
    // Material May already in the DB ($100k, above the $50k floor).
    await db.insert(fbAdSpendDaily).values([
      { adNumber: "200", adName: "live", adNameRaw: "(HW) live", adLink: null, marketers: [], spendDate: "2026-05-01", costUsd: "100000", sourcePullId: seedPull },
    ]);

    // A hollow pull for the same month ($1k) — would wipe May if allowed.
    const alertCalls: Array<{ severity: string; dedupKey: string }> = [];
    const spyAlert = async (input: { severity: string; dedupKey: string }) => {
      alertCalls.push(input);
      return { fired: true as const };
    };

    await replaceFbAdSpendLiveWindow(
      [ad("200", "hollow", [["2026-05-01", 1000]])],
      await makeRawPull(),
      { alert: spyAlert as never },
    );

    // DB untouched — still the original $100k, not the hollow $1k.
    const may = await db.select({ t: sql<number>`coalesce(sum(cost_usd),0)::float` }).from(fbAdSpendDaily);
    expect(may[0].t).toBe(100000);
    // A single P1 collapse alert fired.
    expect(alertCalls).toHaveLength(1);
    expect(alertCalls[0].severity).toBe("p1");
    expect(alertCalls[0].dedupKey).toBe("anomaly:fb_ad_spend_month_collapse");
  });

  it("writes normally when a re-pull is healthy (no false block)", async () => {
    const seedPull = await makeRawPull();
    await db.insert(fbAdSpendDaily).values([
      { adNumber: "200", adName: "live", adNameRaw: "(HW) live", adLink: null, marketers: [], spendDate: "2026-05-01", costUsd: "100000", sourcePullId: seedPull },
    ]);

    const alertCalls: unknown[] = [];
    await replaceFbAdSpendLiveWindow(
      [ad("200", "fresh", [["2026-05-01", 95000]])],
      await makeRawPull(),
      { alert: (async (i: unknown) => { alertCalls.push(i); return { fired: true }; }) as never },
    );

    // Overwrote with the fresh (healthy) value; no alert.
    const may = await db.select({ t: sql<number>`coalesce(sum(cost_usd),0)::float` }).from(fbAdSpendDaily);
    expect(may[0].t).toBe(95000);
    expect(alertCalls).toHaveLength(0);
  });
});
