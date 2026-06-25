import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { fbAdSpendDaily, rawPulls } from "@/lib/db/schema";
import { evaluateFbPrefixCoverage } from "@/lib/jobs/fb-prefix-check";
import "dotenv/config";

async function truncate() {
  await db.execute(sql`TRUNCATE TABLE raw_pulls, fb_ad_spend_daily CASCADE`);
}

async function seedPull(): Promise<string> {
  const [row] = await db
    .insert(rawPulls)
    .values({
      source: "sheets_fb_ads",
      pullBatchId: randomUUID(),
      payload: {},
      rowCount: 0,
      schemaFingerprint: "test-fp",
    })
    .returning({ id: rawPulls.id });
  return row.id;
}

const D = "2026-06-20"; // anchor date; window is last 14d from max spendDate

describe("evaluateFbPrefixCoverage", () => {
  beforeAll(() => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set");
  });
  beforeEach(truncate);

  it("flags an unmapped prefix that accrues >= threshold over the window", async () => {
    const pull = await seedPull();
    await db.insert(fbAdSpendDaily).values([
      // unmapped typo prefix, two rows summing to $600 (>= $500 threshold)
      { adNumber: "1", adName: "a", adNameRaw: "(Botshort CC) Ad 1 - typo", adPrefix: "Botshort CC", adLink: "https://fb/1", marketers: [], spendDate: D, costUsd: "350", sourcePullId: pull },
      { adNumber: "2", adName: "b", adNameRaw: "(Botshort CC) Ad 2 - typo", adPrefix: "Botshort CC", adLink: null, marketers: [], spendDate: D, costUsd: "250", sourcePullId: pull },
      // mapped prefix with high spend -> never flagged
      { adNumber: "3", adName: "c", adNameRaw: "(9055 CC) Ad 3 - x", adPrefix: "9055 CC", adLink: null, marketers: [], spendDate: D, costUsd: "5000", sourcePullId: pull },
      // unmapped but below threshold -> not flagged
      { adNumber: "4", adName: "d", adNameRaw: "(LAV) Ad 4 - color only", adPrefix: "LAV", adLink: null, marketers: [], spendDate: D, costUsd: "100", sourcePullId: pull },
    ]);

    const checks = await evaluateFbPrefixCoverage();

    // exactly one check, for the Botshort prefix
    expect(checks).toHaveLength(1);
    const c = checks[0];
    expect(c.status).toBe("fail");
    expect(c.severity).toBe("p2");
    expect(c.dedupKey).toBe("fb_prefix:botshort_cc");
    expect(c.title).toContain("Botshort CC");
    expect(c.fields.spendUsd).toBe(600);
    expect(c.fields.sampleAd).toBe("(Botshort CC) Ad 1 - typo");
  });

  it("returns nothing when all spend maps to known products/buckets", async () => {
    const pull = await seedPull();
    await db.insert(fbAdSpendDaily).values([
      { adNumber: "1", adName: "a", adNameRaw: "(9055 CC) Ad 1 - x", adPrefix: "9055 CC", adLink: null, marketers: [], spendDate: D, costUsd: "5000", sourcePullId: pull },
      { adNumber: "2", adName: "b", adNameRaw: "(HOME US BAU) Ad 2 - y", adPrefix: "HOME US BAU", adLink: null, marketers: [], spendDate: D, costUsd: "3000", sourcePullId: pull },
      { adNumber: "3", adName: "c", adNameRaw: "(Clearance US BAU) Ad 3 - z", adPrefix: "Clearance US BAU", adLink: null, marketers: [], spendDate: D, costUsd: "2000", sourcePullId: pull },
    ]);
    const checks = await evaluateFbPrefixCoverage();
    expect(checks).toEqual([]);
  });

  it("excludes spend outside the recent window", async () => {
    const pull = await seedPull();
    await db.insert(fbAdSpendDaily).values([
      // anchor (recent)
      { adNumber: "1", adName: "a", adNameRaw: "(9055 CC) Ad 1 - x", adPrefix: "9055 CC", adLink: null, marketers: [], spendDate: D, costUsd: "10", sourcePullId: pull },
      // old unmapped, well outside 14d window -> ignored
      { adNumber: "2", adName: "b", adNameRaw: "(Botshort CC) Ad 2 - typo", adPrefix: "Botshort CC", adLink: null, marketers: [], spendDate: "2026-01-01", costUsd: "9999", sourcePullId: pull },
    ]);
    const checks = await evaluateFbPrefixCoverage();
    expect(checks).toEqual([]);
  });
});
