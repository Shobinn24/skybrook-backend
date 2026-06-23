import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { dataPulls } from "@/lib/db/schema";
import { evaluateVolume } from "@/lib/jobs/volume-check";
import "dotenv/config";

type Source =
  | "sheets_inventory"
  | "sheets_incoming"
  | "sheets_ad_spend"
  | "sheets_fb_ads"
  | "shopify_us"
  | "shopify_intl";

async function truncate() {
  await db.execute(sql`TRUNCATE TABLE data_pulls CASCADE`);
}

// Insert one pull. `order` controls recency: HIGHER order = MORE recent
// (newest startedAt). Status defaults to success.
async function seedPull(
  source: Source,
  rowCount: number,
  order: number,
  status: "success" | "failed" | "partial" = "success",
) {
  // Anchor well in the past and step forward by `order` minutes so the
  // relative ordering is deterministic regardless of wall-clock.
  const startedAt = new Date(Date.UTC(2026, 0, 1, 0, order, 0));
  await db.insert(dataPulls).values({
    pullBatchId: randomUUID(),
    source,
    startedAt,
    finishedAt: startedAt,
    status,
    rowCount,
  });
}

// Seed a baseline of `n` successful pulls all at `rows`, oldest first,
// leaving `order` slots above for a later "latest" pull.
async function seedBaseline(source: Source, rows: number, n: number) {
  for (let i = 0; i < n; i++) await seedPull(source, rows, i + 1);
}

describe("evaluateVolume", () => {
  beforeAll(() => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set");
  });

  beforeEach(async () => {
    await truncate();
  });

  it("emits no check when history is below minHistory (no track record yet)", async () => {
    // minHistory is 5 → fewer than 6 successful pulls means we can't judge.
    await seedBaseline("sheets_inventory", 1100, 3);
    const checks = await evaluateVolume();
    expect(checks.find((c) => c.name === "volume.sheets_inventory")).toBeUndefined();
  });

  it("passes when the latest pull is in line with the baseline", async () => {
    await seedBaseline("sheets_inventory", 1100, 6); // orders 1..6
    await seedPull("sheets_inventory", 1108, 100); // newest, ~baseline
    const checks = await evaluateVolume();
    const c = checks.find((c) => c.name === "volume.sheets_inventory");
    expect(c?.status).toBe("pass");
  });

  it("fails on a ~50% volume drop — the region-split trap (1108 -> 554)", async () => {
    await seedBaseline("sheets_inventory", 1108, 6); // orders 1..6
    await seedPull("sheets_inventory", 554, 100); // newest = half the rows
    const checks = await evaluateVolume();
    const c = checks.find((c) => c.name === "volume.sheets_inventory");
    expect(c?.status).toBe("fail");
    expect(c?.severity).toBe("p2");
    expect(c?.dedupKey).toBe("volume:sheets_inventory");
    expect(c?.fields.latestRowCount).toBe(554);
    expect(c?.fields.baselineMedian).toBe(1108);
    // 554/1108 = 50%, below the 70% inventory floor → fires.
    expect(c?.fields.ratioPct).toBe(50);
  });

  it("excludes failed pulls from both the baseline and the 'latest' slot", async () => {
    await seedBaseline("sheets_inventory", 1100, 6); // orders 1..6 (success)
    // A failed pull with a tiny row_count is the NEWEST by time — it must
    // be ignored, so the latest *successful* pull (1100) is what's judged.
    await seedPull("sheets_inventory", 12, 100, "failed");
    const checks = await evaluateVolume();
    const c = checks.find((c) => c.name === "volume.sheets_inventory");
    expect(c?.status).toBe("pass");
    expect(c?.fields.latestRowCount).toBe(1100);
  });

  it("emits no check when the baseline median is zero (degenerate)", async () => {
    await seedBaseline("sheets_inventory", 0, 6);
    await seedPull("sheets_inventory", 0, 100);
    const checks = await evaluateVolume();
    expect(checks.find((c) => c.name === "volume.sheets_inventory")).toBeUndefined();
  });

  it("does not monitor shopify channels in v1 (high daily variance, excluded)", async () => {
    await seedBaseline("shopify_us", 800, 6);
    await seedPull("shopify_us", 50, 100); // big drop, but shopify is excluded
    const checks = await evaluateVolume();
    expect(checks.find((c) => c.name === "volume.shopify_us")).toBeUndefined();
  });

  it("honors a per-source floor: ad_spend (0.5) tolerates a dip inventory (0.7) would flag", async () => {
    // A drop to 60% of median: passes ad_spend's 0.5 floor, would fail
    // inventory's 0.7 floor. Proves the floor is read per-source.
    await seedBaseline("sheets_ad_spend", 100, 6);
    await seedPull("sheets_ad_spend", 60, 100);
    await seedBaseline("sheets_inventory", 100, 6);
    await seedPull("sheets_inventory", 60, 100);
    const checks = await evaluateVolume();
    expect(checks.find((c) => c.name === "volume.sheets_ad_spend")?.status).toBe("pass");
    expect(checks.find((c) => c.name === "volume.sheets_inventory")?.status).toBe("fail");
  });
});
