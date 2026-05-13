import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import {
  adSpendDaily,
  alertEvents,
  dailySales,
  fbAdSpendDaily,
  rawPulls,
  stockSnapshots,
} from "@/lib/db/schema";
import { runFreshnessCheck } from "@/lib/jobs/freshness-check";
import "dotenv/config";

const ORIGINAL_ENV = { ...process.env };

// Fixed "now" so the threshold is deterministic across runs.
const FAKE_NOW = new Date("2026-05-13T20:00:00Z");
const TODAY_EST = "2026-05-13";
const YESTERDAY_EST = "2026-05-12";
const TWO_DAYS_AGO_EST = "2026-05-11";

const fixedNow = () => FAKE_NOW;

// Most tables FK to raw_pulls.id, so seed one to satisfy the constraint.
let seededRawPullId = "";

async function seedRawPull() {
  const [row] = await db
    .insert(rawPulls)
    .values({
      source: "sheets_inventory",
      pullBatchId: randomUUID(),
      payload: {},
      rowCount: 0,
      schemaFingerprint: "test",
    })
    .returning({ id: rawPulls.id });
  seededRawPullId = row.id;
}

async function truncate() {
  await db.execute(
    sql`TRUNCATE TABLE ad_spend_daily, fb_ad_spend_daily, daily_sales, stock_snapshots, alert_events, raw_pulls CASCADE`,
  );
}

describe("runFreshnessCheck", () => {
  beforeAll(() => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set");
  });

  beforeEach(async () => {
    await truncate();
    await seedRawPull();
    process.env.SLACK_WEBHOOK_ALERTS_URL = "https://hooks.slack.test/alerts";
    // Mock fetch globally so postAlert never POSTs externally during tests.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("ok", { status: 200 })),
    );
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("fails ad_spend_daily and stock_snapshots when both are empty", async () => {
    const result = await runFreshnessCheck({ now: fixedNow });
    expect(result.asOfDate).toBe(TODAY_EST);
    const failedNames = result.checks.filter((c) => c.status === "fail").map((c) => c.name);
    expect(failedNames).toContain("ad_spend_daily");
    expect(failedNames).toContain("stock_snapshots");
    expect(result.alertsFired).toBeGreaterThan(0);
  });

  it("passes ad_spend_daily when max(spend_date) is yesterday EST", async () => {
    await db.insert(adSpendDaily).values({
      product: "test-product",
      spendDate: YESTERDAY_EST,
      costUsd: "10.0",
      sourcePullId: seededRawPullId,
    });
    const result = await runFreshnessCheck({ now: fixedNow });
    const adSpend = result.checks.find((c) => c.name === "ad_spend_daily");
    expect(adSpend?.status).toBe("pass");
  });

  it("fails ad_spend_daily when max(spend_date) is older than yesterday", async () => {
    await db.insert(adSpendDaily).values({
      product: "test-product",
      spendDate: TWO_DAYS_AGO_EST,
      costUsd: "10.0",
      sourcePullId: seededRawPullId,
    });
    const result = await runFreshnessCheck({ now: fixedNow });
    const adSpend = result.checks.find((c) => c.name === "ad_spend_daily");
    expect(adSpend?.status).toBe("fail");
    expect(adSpend?.maxDate).toBe(TWO_DAYS_AGO_EST);
  });

  it("detects cross-channel skew when shopify_us is fresh but shopify_intl lags >1 day", async () => {
    // Simulates the May-6 mixed-time-view bug class.
    await db.insert(dailySales).values([
      {
        channel: "shopify_us",
        routedLocation: "US",
        sku: "test-us",
        salesDate: TODAY_EST,
        unitsSold: 10,
        netSalesUsd: "100",
        sourcePullId: seededRawPullId,
      },
      {
        channel: "shopify_intl",
        routedLocation: "CN",
        sku: "test-intl",
        salesDate: "2026-05-09", // 4 days behind
        unitsSold: 5,
        netSalesUsd: "50",
        sourcePullId: seededRawPullId,
      },
    ]);
    const result = await runFreshnessCheck({ now: fixedNow });
    const skew = result.checks.find((c) => c.name === "daily_sales.cross_channel_skew");
    expect(skew?.status).toBe("fail");
    expect(skew?.detail).toContain("skewDays=4");
  });

  it("does NOT flag skew when channels differ by <=1 day", async () => {
    await db.insert(dailySales).values([
      {
        channel: "shopify_us",
        routedLocation: "US",
        sku: "test-us",
        salesDate: TODAY_EST,
        unitsSold: 10,
        netSalesUsd: "100",
        sourcePullId: seededRawPullId,
      },
      {
        channel: "shopify_intl",
        routedLocation: "CN",
        sku: "test-intl",
        salesDate: YESTERDAY_EST,
        unitsSold: 5,
        netSalesUsd: "50",
        sourcePullId: seededRawPullId,
      },
    ]);
    const result = await runFreshnessCheck({ now: fixedNow });
    const skew = result.checks.find((c) => c.name === "daily_sales.cross_channel_skew");
    expect(skew?.status).toBe("pass");
  });

  it("auto-resolves a previously-fired alert when the table recovers", async () => {
    // Fire it first by leaving the table empty.
    await runFreshnessCheck({ now: fixedNow });
    const openAfterFirst = await db
      .select()
      .from(alertEvents)
      .where(sql`dedup_key = 'freshness:ad_spend_daily' AND resolved_at IS NULL`);
    expect(openAfterFirst.length).toBe(1);

    // Now seed fresh data and re-run.
    await db.insert(adSpendDaily).values({
      product: "test-product",
      spendDate: YESTERDAY_EST,
      costUsd: "10.0",
      sourcePullId: seededRawPullId,
    });
    const result = await runFreshnessCheck({ now: fixedNow });
    expect(result.alertsResolved).toBeGreaterThan(0);

    const openAfterSecond = await db
      .select()
      .from(alertEvents)
      .where(sql`dedup_key = 'freshness:ad_spend_daily' AND resolved_at IS NULL`);
    expect(openAfterSecond.length).toBe(0);
  });

  it("does not fire duplicate alerts for the same stale state across runs", async () => {
    await runFreshnessCheck({ now: fixedNow });
    const firstCount = (await db.select().from(alertEvents)).length;
    await runFreshnessCheck({ now: fixedNow });
    const secondCount = (await db.select().from(alertEvents)).length;
    expect(secondCount).toBe(firstCount);
  });

  it("uses fb_ad_spend_daily separately from ad_spend_daily", async () => {
    await db.insert(fbAdSpendDaily).values({
      adNumber: "999",
      adName: "test ad",
      adNameRaw: "test ad raw",
      adLink: null,
      marketers: [],
      spendDate: YESTERDAY_EST,
      costUsd: "10.0",
      sourcePullId: seededRawPullId,
    });
    const result = await runFreshnessCheck({ now: fixedNow });
    expect(result.checks.find((c) => c.name === "fb_ad_spend_daily")?.status).toBe("pass");
    expect(result.checks.find((c) => c.name === "ad_spend_daily")?.status).toBe("fail");
  });

  it("handles stock_snapshots freshness via snapshot_date", async () => {
    await db.insert(stockSnapshots).values({
      sku: "test-sku",
      location: "US",
      snapshotDate: YESTERDAY_EST,
      onHand: 100,
      sourcePullId: seededRawPullId,
    });
    const result = await runFreshnessCheck({ now: fixedNow });
    const stock = result.checks.find((c) => c.name === "stock_snapshots");
    expect(stock?.status).toBe("pass");
  });
});
