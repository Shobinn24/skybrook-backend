import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  adSpendDaily,
  alertEvents,
  dataPulls,
  rawPulls,
} from "@/lib/db/schema";
import { GET } from "@/app/api/health/route";
import { AD_SPEND_TABS } from "@/lib/sources/sheets";
import "dotenv/config";

const ORIGINAL_ENV = { ...process.env };

let rawPullId = "";

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
  rawPullId = row.id;
}

describe("GET /api/health", () => {
  beforeAll(() => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set");
  });

  beforeEach(async () => {
    await db.execute(
      sql`TRUNCATE TABLE alert_events, data_pulls, ad_spend_daily, fb_ad_spend_daily, daily_sales, stock_snapshots, shipping_stats_daily, factory_order_lines, factory_orders, factory_order_inputs, skus, raw_pulls CASCADE`,
    );
    await seedRawPull();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("ok", { status: 200 })),
    );
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns 503 + overall=fail when tables are empty", async () => {
    const res = await GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.overall).toBe("fail");
    expect(body.sources).toBeDefined();
    expect(body.tables).toBeDefined();
  });

  it("reports per-source last-pull status from data_pulls", async () => {
    await db.insert(dataPulls).values({
      pullBatchId: randomUUID(),
      source: "shopify_us",
      startedAt: new Date(),
      finishedAt: new Date(),
      status: "failed",
      errorMessage: "HTTP 502 Cloudflare",
      rowCount: 0,
    });
    const res = await GET();
    const body = await res.json();
    const shopifyUs = body.sources.find((s: { source: string }) => s.source === "shopify_us");
    expect(shopifyUs?.lastStatus).toBe("failed");
    expect(shopifyUs?.lastErrorPreview).toContain("502");
  });

  it("reports no_data for sources with no data_pulls history", async () => {
    const res = await GET();
    const body = await res.json();
    const noData = body.sources.find((s: { source: string }) => s.source === "shopify_intl");
    expect(noData?.lastStatus).toBe("no_data");
  });

  it("truncates oversized error messages", async () => {
    const longErr = "x".repeat(500);
    await db.insert(dataPulls).values({
      pullBatchId: randomUUID(),
      source: "shopify_us",
      startedAt: new Date(),
      finishedAt: new Date(),
      status: "failed",
      errorMessage: longErr,
    });
    const res = await GET();
    const body = await res.json();
    const shopifyUs = body.sources.find((s: { source: string }) => s.source === "shopify_us");
    expect(shopifyUs.lastErrorPreview.length).toBeLessThanOrEqual(120);
  });

  it("includes openAlerts count from alert_events", async () => {
    await db.insert(alertEvents).values([
      {
        dedupKey: "k1",
        severity: "p1",
        title: "still broken",
        payload: {},
        channel: "alerts",
      },
      {
        dedupKey: "k2",
        severity: "p1",
        title: "also broken",
        payload: {},
        channel: "alerts",
      },
      {
        dedupKey: "k3",
        severity: "p1",
        title: "fixed",
        payload: {},
        channel: "alerts",
        resolvedAt: new Date(),
      },
    ]);
    const res = await GET();
    const body = await res.json();
    expect(body.openAlerts).toBe(2);
  });

  it("does NOT fire any postAlert side effect", async () => {
    // Drive the endpoint twice. If it were calling postAlert, we'd see
    // duplicate alert_events rows for whichever freshness checks fail.
    await GET();
    const beforeCount = (await db.select().from(alertEvents)).length;
    await GET();
    const afterCount = (await db.select().from(alertEvents)).length;
    expect(afterCount).toBe(beforeCount);
  });

  it("returns 200 + overall=pass when everything is fresh", async () => {
    // Seed yesterday EST data into every table.
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    // Per-product freshness check (added 2026-05-22) requires every
    // canonical Supermetrics tab to have fresh data — seeding a single
    // synthetic product no longer counts as "ad_spend is healthy".
    for (const product of AD_SPEND_TABS) {
      await db.insert(adSpendDaily).values({
        product,
        spendDate: yesterday,
        costUsd: "1",
        sourcePullId: rawPullId,
      });
    }
    await db.execute(sql`
      INSERT INTO fb_ad_spend_daily (ad_number, ad_name, ad_name_raw, marketers, spend_date, cost_usd, source_pull_id)
      VALUES ('1', 'x', 'x', '{}', ${yesterday}, '1', ${rawPullId})
    `);
    await db.execute(sql`
      INSERT INTO applovin_ad_spend_daily (product, spend_date, cost_usd, source_pull_id)
      VALUES ('9055', ${yesterday}, '1', ${rawPullId})
    `);
    await db.execute(sql`
      INSERT INTO stock_snapshots (sku, location, snapshot_date, on_hand, source_pull_id)
      VALUES ('s', 'US', ${yesterday}, 1, ${rawPullId})
    `);
    await db.execute(sql`
      INSERT INTO daily_sales (channel, routed_location, sku, sales_date, units_sold, net_sales_usd, source_pull_id)
      VALUES ('shopify_us', 'US', 's', ${yesterday}, 1, '1', ${rawPullId})
    `);
    await db.execute(sql`
      INSERT INTO daily_sales (channel, routed_location, sku, sales_date, units_sold, net_sales_usd, source_pull_id)
      VALUES ('shopify_intl', 'CN', 's', ${yesterday}, 1, '1', ${rawPullId})
    `);
    // 2026-05-18 monitoring extension: shipping_stats_daily freshness
    // must also pass. The other two new checks (factory-order integrity)
    // pass by default on empty tables, so no seed needed for them.
    await db.execute(sql`
      INSERT INTO shipping_stats_daily (snapshot_date, delivered_count, transit_histogram)
      VALUES (${yesterday}, 0, '{}'::jsonb)
    `);

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.overall).toBe("pass");
  });
});
