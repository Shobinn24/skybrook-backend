import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { fbAdSpendDaily, fbAdUrlMap, fbProductMap, rawPulls } from "@/lib/db/schema";
import { evaluateFbUrlCoverage, unmappedFbUrlSpend } from "@/lib/jobs/fb-url-coverage-check";
import "dotenv/config";

async function truncate() {
  await db.execute(sql`TRUNCATE TABLE raw_pulls CASCADE`);
}
async function seedPull(): Promise<string> {
  const [row] = await db
    .insert(rawPulls)
    .values({ source: "shopify_us", pullBatchId: randomUUID(), payload: {}, rowCount: 0, schemaFingerprint: "fp" })
    .returning({ id: rawPulls.id });
  return row.id;
}

describe("evaluateFbUrlCoverage", () => {
  beforeAll(() => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set");
  });
  beforeEach(truncate);

  it("fires on an unmapped URL with real spend; silent for mapped / sub-threshold / social", async () => {
    const pull = await seedPull();
    // anchor date
    await db.insert(fbAdSpendDaily).values([
      { adNumber: "1", adName: "x", adNameRaw: "(9055) Ad 1", adPrefix: "9055", adLink: null, marketers: [], spendDate: "2026-06-20", costUsd: "10", sourcePullId: pull },
    ]);
    await db.insert(fbProductMap).values([
      { normalizedUrl: "everdries.com/comfortplus", rawUrl: "https://everdries.com/comfortplus", region: "US", productLabel: "9055", sourcePullId: pull },
      { normalizedUrl: "everdries.com/lavender", rawUrl: "https://everdries.com/lavender", region: "US", productLabel: "Other (NA)", sourcePullId: pull },
    ]);
    await db.insert(fbAdUrlMap).values([
      // mapped -> silent even with big spend
      { adId: "a1", adName: "(9055) Ad 1", destUrl: "https://everdries.com/comfortplus", costUsd: "9000", sourcePullId: pull },
      // NA is still IN the sheet -> silent
      { adId: "a2", adName: "(NA) Ad 2", destUrl: "https://everdries.com/lavender", costUsd: "9000", sourcePullId: pull },
      // unmapped, >= threshold -> FIRES
      { adId: "a3", adName: "(9055) Ad 3", destUrl: "https://everdries.com/brand-new-funnel", costUsd: "800", sourcePullId: pull },
      // unmapped but sub-threshold -> silent
      { adId: "a4", adName: "(9055) Ad 4", destUrl: "https://everdries.com/tiny-test", costUsd: "100", sourcePullId: pull },
      // social permalink -> not a landing page -> silent
      { adId: "a5", adName: "(9055) Ad 5", destUrl: "https://www.facebook.com/reel/55", costUsd: "9000", sourcePullId: pull },
    ]);

    const checks = await evaluateFbUrlCoverage();
    expect(checks).toHaveLength(1);
    expect(checks[0].dedupKey).toBe("fb_url_unmapped:everdries_com_brand_new_funnel");
    expect(checks[0].severity).toBe("p2");
    expect(checks[0].fields.spendUsd).toBe(800);

    // raw helper surfaces both unmapped URLs (page section), sorted by spend.
    const all = await unmappedFbUrlSpend();
    expect(all.map((u) => u.url)).toEqual([
      "everdries.com/brand-new-funnel",
      "everdries.com/tiny-test",
    ]);
  });
});
