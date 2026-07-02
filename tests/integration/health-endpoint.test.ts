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
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth";
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

// Cookie-aware fetch stub. The health route's auth round-trip check probes
// /api/auth/selfcheck through the (real, deployed) middleware; here we fake
// that boundary: a cookie that verifies against SESSION_SECRET gets 200,
// anything else 307-bounces — the middleware's contract. All other URLs
// (e.g. the whatsapp bridge probe) keep the old generic 200 "ok" response.
function stubAppFetch(overrides?: { validStatus?: number; selfcheckError?: boolean }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/api/auth/selfcheck")) {
        if (overrides?.selfcheckError) throw new Error("connect ECONNREFUSED");
        const cookie = String(
          (init?.headers as Record<string, string> | undefined)?.cookie ?? "",
        );
        const m = new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(cookie);
        const session = m
          ? await verifySessionToken(process.env.SESSION_SECRET!, m[1])
          : null;
        const status = session ? (overrides?.validStatus ?? 200) : 307;
        return new Response(status === 200 ? JSON.stringify({ ok: true }) : null, {
          status,
          headers: status === 307 ? { location: "https://app.example/login" } : {},
        });
      }
      return new Response("ok", { status: 200 });
    }),
  );
}

// Seeds yesterday-EST rows into every freshness-checked table so the data
// side of /api/health evaluates to pass. Extracted so the auth-check tests
// can isolate "auth broke" from "data is stale".
async function seedFreshData() {
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
    stubAppFetch();
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
    await seedFreshData();

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.overall).toBe("pass");
  });

  it("includes a passing auth_round_trip table entry when the login gate round-trips", async () => {
    await seedFreshData();
    const res = await GET();
    const body = await res.json();
    const auth = body.tables.find(
      (t: { name: string }) => t.name === "auth_round_trip",
    );
    expect(auth).toBeDefined();
    expect(auth.status).toBe("pass");
  });

  it("flips overall to fail + 503 when the middleware bounces a signed session, even with fresh data", async () => {
    await seedFreshData();
    stubAppFetch({ validStatus: 307 });
    const res = await GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.overall).toBe("fail");
    const auth = body.tables.find(
      (t: { name: string }) => t.name === "auth_round_trip",
    );
    expect(auth.status).toBe("fail");
    expect(auth.detail).toContain("bounced");
  });

  it("treats an unreachable auth probe as warn, not fail", async () => {
    await seedFreshData();
    stubAppFetch({ selfcheckError: true });
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.overall).toBe("pass");
    const auth = body.tables.find(
      (t: { name: string }) => t.name === "auth_round_trip",
    );
    expect(auth.status).toBe("warn");
    expect(auth.detail).toContain("unreachable");
  });
});
