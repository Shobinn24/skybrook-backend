import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import {
  adSpendDaily,
  alertEvents,
  dailySales,
  dataPulls,
  factoryOrderLines,
  factoryOrders,
  fbAdSpendDaily,
  rawPulls,
  shippingStatsDaily,
  skus,
  stockSnapshots,
} from "@/lib/db/schema";
import { evaluateFreshness, runFreshnessCheck } from "@/lib/jobs/freshness-check";
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
    sql`TRUNCATE TABLE ad_spend_daily, fb_ad_spend_daily, daily_sales, stock_snapshots, shipping_stats_daily, factory_order_lines, factory_orders, factory_order_inputs, skus, alert_events, raw_pulls CASCADE`,
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
    process.env.SLACK_WEBHOOK_DIGEST_URL = "https://hooks.slack.test/digest";
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

  // The 6 canonical Supermetrics tabs we check per-product. Tests use
  // these names instead of made-up products so the per-product freshness
  // check actually evaluates them (it iterates the canonical list).
  const FB_PRODUCT = "Men";
  const AL_PRODUCT = "Super HW AL";
  const FB_CHECK_NAME = "ad_spend_daily.product.men";
  const AL_CHECK_NAME = "ad_spend_daily.product.super_hw_al";

  it("fails ad_spend_daily and stock_snapshots when both are empty", async () => {
    const result = await runFreshnessCheck({ now: fixedNow });
    expect(result.asOfDate).toBe(TODAY_EST);
    const failedNames = result.checks.filter((c) => c.status === "fail").map((c) => c.name);
    // All 6 per-product ad_spend checks should fail when the table is empty.
    expect(failedNames).toContain(FB_CHECK_NAME);
    expect(failedNames).toContain(AL_CHECK_NAME);
    expect(failedNames).toContain("stock_snapshots");
    expect(result.alertsFired).toBeGreaterThan(0);
  });

  it("passes the per-product check when max(spend_date) is yesterday EST", async () => {
    await db.insert(adSpendDaily).values({
      product: FB_PRODUCT,
      spendDate: YESTERDAY_EST,
      costUsd: "10.0",
      sourcePullId: seededRawPullId,
    });
    const result = await runFreshnessCheck({ now: fixedNow });
    const fbCheck = result.checks.find((c) => c.name === FB_CHECK_NAME);
    expect(fbCheck?.status).toBe("pass");
  });

  it("fails the per-product check when max(spend_date) is older than yesterday", async () => {
    await db.insert(adSpendDaily).values({
      product: FB_PRODUCT,
      spendDate: TWO_DAYS_AGO_EST,
      costUsd: "10.0",
      sourcePullId: seededRawPullId,
    });
    const result = await runFreshnessCheck({ now: fixedNow });
    const fbCheck = result.checks.find((c) => c.name === FB_CHECK_NAME);
    expect(fbCheck?.status).toBe("fail");
    expect(fbCheck?.maxDate).toBe(TWO_DAYS_AGO_EST);
  });

  // This is the 2026-05-22 incident reproduced: AppLovin license lapsed
  // on 2026-05-05, FB tabs kept refreshing daily, AL tabs froze. The OLD
  // table-wide max(date) check passed (since FB was fresh) and the
  // outage went unnoticed for 17 days. The NEW per-product check fires
  // a P1 specifically for the stale AL product.
  it("flags a stale AL product while FB products are fresh (2026-05-22 regression)", async () => {
    // Seed every FB tab fresh + every AL tab stale, mirroring the prod state.
    const FRESH_FB = ["Men", "Shapewear", "SuperHW"];
    const STALE_AL = ["Men AL", "Shapewear AL", "Super HW AL"];
    for (const p of FRESH_FB) {
      await db.insert(adSpendDaily).values({
        product: p,
        spendDate: YESTERDAY_EST,
        costUsd: "100.0",
        sourcePullId: seededRawPullId,
      });
    }
    for (const p of STALE_AL) {
      await db.insert(adSpendDaily).values({
        product: p,
        spendDate: "2026-05-05", // license lapse date
        costUsd: "50.0",
        sourcePullId: seededRawPullId,
      });
    }
    const result = await runFreshnessCheck({ now: fixedNow });
    const byName = (n: string) => result.checks.find((c) => c.name === n)?.status;
    expect(byName("ad_spend_daily.product.men")).toBe("pass");
    expect(byName("ad_spend_daily.product.shapewear")).toBe("pass");
    expect(byName("ad_spend_daily.product.superhw")).toBe("pass");
    expect(byName("ad_spend_daily.product.men_al")).toBe("fail");
    expect(byName("ad_spend_daily.product.shapewear_al")).toBe("fail");
    expect(byName("ad_spend_daily.product.super_hw_al")).toBe("fail");
    // At least one alert fired (one per stale product, but dedup may
    // collapse — we just need the path to have triggered).
    expect(result.alertsFired).toBeGreaterThan(0);
  });

  // HRS AppLovin ("HRS AL") is wired into the ingest before any HRS AppLovin
  // spend exists, so Scott can "start importing AL now, even if zero". An
  // empty newly-wired tab has a null max(date), which would otherwise fire a
  // P1 every cron tick — so HRS AL is exempt from the stale check UNTIL its
  // first dated row arrives. Once it has data, normal staleness resumes.
  it("exempts HRS AL from the stale check while empty, then covers it once it has data", async () => {
    // Empty HRS AL → no stale check emitted at all (no false P1).
    const empty = await evaluateFreshness({ now: fixedNow });
    expect(
      empty.checks.find((c) => c.name === "ad_spend_daily.product.hrs_al"),
    ).toBeUndefined();

    // A current-dated $0 row → the check appears and passes.
    await db.insert(adSpendDaily).values({
      product: "HRS AL",
      spendDate: YESTERDAY_EST,
      costUsd: "0",
      sourcePullId: seededRawPullId,
    });
    const fresh = await evaluateFreshness({ now: fixedNow });
    expect(
      fresh.checks.find((c) => c.name === "ad_spend_daily.product.hrs_al")?.status,
    ).toBe("pass");
  });

  it("flags HRS AL stale once it has had data and then goes stale", async () => {
    // Exemption only covers the empty state — a tab that HAD data and then
    // froze is a real outage and must still page.
    await db.insert(adSpendDaily).values({
      product: "HRS AL",
      spendDate: TWO_DAYS_AGO_EST,
      costUsd: "0",
      sourcePullId: seededRawPullId,
    });
    const result = await evaluateFreshness({ now: fixedNow });
    expect(
      result.checks.find((c) => c.name === "ad_spend_daily.product.hrs_al")?.status,
    ).toBe("fail");
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

  it("auto-resolves a previously-fired per-product alert when the source recovers", async () => {
    // Fire it first by leaving the table empty.
    await runFreshnessCheck({ now: fixedNow });
    const openAfterFirst = await db
      .select()
      .from(alertEvents)
      .where(
        sql`dedup_key = 'freshness:ad_spend_daily:product:men' AND resolved_at IS NULL`,
      );
    expect(openAfterFirst.length).toBe(1);

    // Now seed fresh data for the "Men" product and re-run.
    await db.insert(adSpendDaily).values({
      product: FB_PRODUCT,
      spendDate: YESTERDAY_EST,
      costUsd: "10.0",
      sourcePullId: seededRawPullId,
    });
    const result = await runFreshnessCheck({ now: fixedNow });
    expect(result.alertsResolved).toBeGreaterThan(0);

    const openAfterSecond = await db
      .select()
      .from(alertEvents)
      .where(
        sql`dedup_key = 'freshness:ad_spend_daily:product:men' AND resolved_at IS NULL`,
      );
    expect(openAfterSecond.length).toBe(0);
  });

  it("does not fire duplicate alerts for the same stale state across runs", async () => {
    await runFreshnessCheck({ now: fixedNow });
    const firstCount = (await db.select().from(alertEvents)).length;
    await runFreshnessCheck({ now: fixedNow });
    const secondCount = (await db.select().from(alertEvents)).length;
    expect(secondCount).toBe(firstCount);
  });

  it("uses fb_ad_spend_daily separately from ad_spend_daily per-product checks", async () => {
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
    // Every per-product ad_spend_daily check should fail since we
    // didn't seed anything in that table.
    expect(result.checks.find((c) => c.name === FB_CHECK_NAME)?.status).toBe("fail");
    expect(result.checks.find((c) => c.name === AL_CHECK_NAME)?.status).toBe("fail");
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

  // --- 2026-05-18 additions: shipping snapshot + factory-order data
  // integrity + tRPC error auto-resolve.

  it("fails shipping_stats_daily when no snapshot row exists", async () => {
    const result = await runFreshnessCheck({ now: fixedNow });
    const ship = result.checks.find((c) => c.name === "shipping_stats_daily");
    expect(ship?.status).toBe("fail");
  });

  it("passes shipping_stats_daily when yesterday's snapshot is present", async () => {
    await db.insert(shippingStatsDaily).values({
      snapshotDate: YESTERDAY_EST,
      deliveredCount: 100,
      avgFulfilmentHours: "12.5",
      avgTransitDays: "3.2",
      avgTotalDays: "3.7",
      transitHistogram: { "3": 50, "4": 50 },
    });
    const result = await runFreshnessCheck({ now: fixedNow });
    const ship = result.checks.find((c) => c.name === "shipping_stats_daily");
    expect(ship?.status).toBe("pass");
  });

  it("flags approved factory orders with $0 line totals as a P2 integrity issue", async () => {
    const [order] = await db
      .insert(factoryOrders)
      .values({
        orderMonth: "2026-05-01",
        status: "approved",
        approvedAt: new Date(FAKE_NOW.getTime() - 24 * 60 * 60 * 1000),
        approvedBy: "test",
      })
      .returning({ id: factoryOrders.id });
    await db.insert(factoryOrderLines).values({
      orderId: order.id,
      sku: "test-sku-zero",
      destination: "US",
      qty: 100,
      unitCost: "0.0000", // No cost on file → 0 amount
      amount: "0.00",
      productGroup: "Test Group",
    });

    const result = await runFreshnessCheck({ now: fixedNow });
    const integrity = result.checks.find(
      (c) => c.name === "factory_orders.approved_zero_lines",
    );
    expect(integrity?.status).toBe("fail");

    const fired = await db
      .select()
      .from(alertEvents)
      .where(
        sql`dedup_key = 'factory_orders:approved_zero_lines' AND resolved_at IS NULL`,
      );
    expect(fired.length).toBe(1);
    expect(fired[0].severity).toBe("p2");
    expect(fired[0].channel).toBe("digest");
  });

  it("passes approved_zero_lines when approved orders have non-zero line totals", async () => {
    const [order] = await db
      .insert(factoryOrders)
      .values({
        orderMonth: "2026-05-01",
        status: "approved",
        approvedAt: new Date(FAKE_NOW.getTime() - 24 * 60 * 60 * 1000),
        approvedBy: "test",
      })
      .returning({ id: factoryOrders.id });
    await db.insert(factoryOrderLines).values({
      orderId: order.id,
      sku: "test-sku-ok",
      destination: "US",
      qty: 100,
      unitCost: "12.1000",
      amount: "1210.00",
      productGroup: "Test Group",
    });

    const result = await runFreshnessCheck({ now: fixedNow });
    const integrity = result.checks.find(
      (c) => c.name === "factory_orders.approved_zero_lines",
    );
    expect(integrity?.status).toBe("pass");
  });

  it("ignores DRAFT factory orders with $0 lines (only flags approved)", async () => {
    const [order] = await db
      .insert(factoryOrders)
      .values({
        orderMonth: "2026-05-01",
        status: "draft",
      })
      .returning({ id: factoryOrders.id });
    await db.insert(factoryOrderLines).values({
      orderId: order.id,
      sku: "test-sku-draft",
      destination: "US",
      qty: 100,
      unitCost: "0.0000",
      amount: "0.00",
      productGroup: "Test Group",
    });
    const result = await runFreshnessCheck({ now: fixedNow });
    const integrity = result.checks.find(
      (c) => c.name === "factory_orders.approved_zero_lines",
    );
    expect(integrity?.status).toBe("pass");
  });

  it("flags active SKUs missing unit_cost_usd as a P2 integrity issue", async () => {
    await db.insert(skus).values([
      {
        sku: "active-no-cost",
        productName: "Test Active",
        unitCostUsd: null,
        firstSeenAt: "2026-01-01",
        active: true,
      },
      {
        sku: "active-with-cost",
        productName: "Test Active 2",
        unitCostUsd: "10.0000",
        firstSeenAt: "2026-01-01",
        active: true,
      },
      {
        sku: "inactive-no-cost",
        productName: "Old SKU",
        unitCostUsd: null,
        firstSeenAt: "2025-01-01",
        active: false,
      },
    ]);

    const result = await runFreshnessCheck({ now: fixedNow });
    const integrity = result.checks.find(
      (c) => c.name === "factory_orders.active_skus_missing_cost",
    );
    expect(integrity?.status).toBe("fail");
    expect(integrity?.detail).toContain("count=1"); // only the active one
  });

  it("passes active_skus_missing_cost when every active SKU has a unit cost", async () => {
    await db.insert(skus).values({
      sku: "active-priced",
      productName: "Test Active",
      unitCostUsd: "10.0000",
      firstSeenAt: "2026-01-01",
      active: true,
    });
    const result = await runFreshnessCheck({ now: fixedNow });
    const integrity = result.checks.find(
      (c) => c.name === "factory_orders.active_skus_missing_cost",
    );
    expect(integrity?.status).toBe("pass");
  });

  it("auto-resolves trpc.error:* alerts at end of every cron tick", async () => {
    // Seed an open trpc.error alert as if the onError tap had fired
    // some hours earlier in the day.
    await db.insert(alertEvents).values({
      dedupKey: "trpc.error:factoryOrders.approve",
      severity: "p1",
      title: "tRPC mutation factoryOrders.approve threw INTERNAL_SERVER_ERROR",
      payload: {},
      channel: "alerts",
      firedAt: new Date(FAKE_NOW.getTime() - 2 * 60 * 60 * 1000),
    });

    const result = await runFreshnessCheck({ now: fixedNow });
    expect(result.alertsResolved).toBeGreaterThanOrEqual(1);

    const stillOpen = await db
      .select()
      .from(alertEvents)
      .where(
        sql`dedup_key LIKE 'trpc.error:%' AND resolved_at IS NULL`,
      );
    expect(stillOpen.length).toBe(0);
  });

  it("does not touch non-trpc.error alerts during auto-resolve", async () => {
    // A genuine freshness alert in flight — must NOT be resolved by
    // the trpc.error sweep.
    await db.insert(alertEvents).values({
      dedupKey: "freshness:stock_snapshots",
      severity: "p1",
      title: "stock_snapshots is stale",
      payload: {},
      channel: "alerts",
      firedAt: new Date(FAKE_NOW.getTime() - 2 * 60 * 60 * 1000),
    });
    // Seed yesterday's stock so the check itself doesn't re-fire.
    await db.insert(stockSnapshots).values({
      sku: "test-sku",
      location: "US",
      snapshotDate: YESTERDAY_EST,
      onHand: 100,
      sourcePullId: seededRawPullId,
    });

    // includeReferenceTabs:false → this test asserts DB-side alert
    // auto-resolve only; skip the Sheets-API reference-tab + FB-shape
    // sweep (real network, irrelevant here, and slow on a double call).
    await runFreshnessCheck({ now: fixedNow, includeReferenceTabs: false });

    // The freshness-recovery branch resolves stock_snapshots — that's
    // legitimate. What we're guarding here is that NON-freshness
    // unrelated dedup keys are left alone. Add one to confirm.
    await db.insert(alertEvents).values({
      dedupKey: "ingest.source.failed:shopify_us",
      severity: "p1",
      title: "shopify_us source failed",
      payload: {},
      channel: "alerts",
      firedAt: new Date(FAKE_NOW.getTime() - 2 * 60 * 60 * 1000),
    });
    await runFreshnessCheck({ now: fixedNow, includeReferenceTabs: false });
    const ingestStillOpen = await db
      .select()
      .from(alertEvents)
      .where(
        sql`dedup_key = 'ingest.source.failed:shopify_us' AND resolved_at IS NULL`,
      );
    expect(ingestStillOpen.length).toBe(1);
  });

  // --- Schema-drift detection -------------------------------------------
  async function insertSuccessPull(
    source: "sheets_ad_spend" | "sheets_fb_ads" | "shopify_us",
    fingerprint: string,
    startedAt: Date,
  ) {
    const [raw] = await db
      .insert(rawPulls)
      .values({
        source,
        pullBatchId: randomUUID(),
        payload: {},
        rowCount: 0,
        schemaFingerprint: fingerprint,
      })
      .returning({ id: rawPulls.id });
    await db.insert(dataPulls).values({
      pullBatchId: randomUUID(),
      source,
      startedAt,
      finishedAt: startedAt,
      status: "success",
      rowCount: 0,
      rawPullId: raw.id,
    });
  }

  it("flags schema drift when a source's fingerprint changes between successful pulls", async () => {
    const t0 = new Date(FAKE_NOW.getTime() - 48 * 60 * 60 * 1000);
    const t1 = new Date(FAKE_NOW.getTime() - 24 * 60 * 60 * 1000);
    await insertSuccessPull("sheets_ad_spend", "fp_old", t0);
    await insertSuccessPull("sheets_ad_spend", "fp_new", t1);

    const { checks } = await evaluateFreshness({ now: fixedNow });
    const drift = checks.find((c) => c.name === "schema_drift.sheets_ad_spend");
    expect(drift?.status).toBe("fail");
    expect(drift?.fields.priorFingerprint).toBe("fp_old");
    expect(drift?.fields.currentFingerprint).toBe("fp_new");
  });

  it("passes schema drift when consecutive successful pulls share a fingerprint", async () => {
    const t0 = new Date(FAKE_NOW.getTime() - 48 * 60 * 60 * 1000);
    const t1 = new Date(FAKE_NOW.getTime() - 24 * 60 * 60 * 1000);
    await insertSuccessPull("sheets_fb_ads", "fp_same", t0);
    await insertSuccessPull("sheets_fb_ads", "fp_same", t1);

    const { checks } = await evaluateFreshness({ now: fixedNow });
    const drift = checks.find((c) => c.name === "schema_drift.sheets_fb_ads");
    expect(drift?.status).toBe("pass");
  });

  it("does not flag drift on a source's first successful pull", async () => {
    await insertSuccessPull(
      "shopify_us",
      "fp_first",
      new Date(FAKE_NOW.getTime() - 24 * 60 * 60 * 1000),
    );

    const { checks } = await evaluateFreshness({ now: fixedNow });
    const drift = checks.find((c) => c.name === "schema_drift.shopify_us");
    expect(drift?.status).toBe("pass");
  });
});
