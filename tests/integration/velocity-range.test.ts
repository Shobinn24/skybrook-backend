import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { db } from "@/lib/db";
import { dailySales, rawPulls, skus } from "@/lib/db/schema";
import { getVelocityForRange } from "@/lib/queries/velocity-range";
import { resetDb } from "@/tests/fixtures/seed";

async function seedSku(sku: string) {
  await db.insert(skus).values({
    sku,
    productName: sku,
    productLine: "Core",
    unitCostUsd: "1",
    firstSeenAt: "2026-04-01",
    active: true,
  });
}

async function seedSale(opts: {
  sku: string;
  salesDate: string;
  unitsSold: number;
  channel: "shopify_us" | "shopify_intl";
  routedLocation: "US" | "CN";
  rawId: string;
}) {
  await db.insert(dailySales).values({
    channel: opts.channel,
    routedLocation: opts.routedLocation,
    sku: opts.sku,
    salesDate: opts.salesDate,
    unitsSold: opts.unitsSold,
    netSalesUsd: String(opts.unitsSold * 20),
    sourcePullId: opts.rawId,
  });
}

describe("getVelocityForRange", () => {
  beforeAll(() => {
    if (!process.env.DATABASE_URL)
      throw new Error("DATABASE_URL not set in test env");
  });

  beforeEach(async () => {
    await resetDb();
  });

  it("sums units and divides by inclusive day count", async () => {
    const [raw] = await db
      .insert(rawPulls)
      .values({
        source: "shopify_us",
        pullBatchId: randomUUID(),
        payload: {},
        rowCount: 0,
        schemaFingerprint: "fp",
      })
      .returning({ id: rawPulls.id });

    await seedSku("EV-A");
    await seedSale({ sku: "EV-A", salesDate: "2026-04-01", unitsSold: 10, channel: "shopify_us", routedLocation: "US", rawId: raw.id });
    await seedSale({ sku: "EV-A", salesDate: "2026-04-05", unitsSold: 10, channel: "shopify_us", routedLocation: "US", rawId: raw.id });
    await seedSale({ sku: "EV-A", salesDate: "2026-04-07", unitsSold: 10, channel: "shopify_us", routedLocation: "US", rawId: raw.id });

    // Apr 1 – Apr 7 inclusive = 7 days, 30 units total → 30/7 = 4.2857
    const result = await getVelocityForRange({
      location: "US",
      rangeStart: "2026-04-01",
      rangeEnd: "2026-04-07",
    });
    expect(result.rangeDays).toBe(7);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].sku).toBe("EV-A");
    expect(result.rows[0].unitsSold).toBe(30);
    expect(result.rows[0].unitsPerDay).toBeCloseTo(30 / 7, 4);
  });

  it("filters by routed_location — CN sales don't bleed into US window", async () => {
    const [raw] = await db
      .insert(rawPulls)
      .values({
        source: "shopify_us",
        pullBatchId: randomUUID(),
        payload: {},
        rowCount: 0,
        schemaFingerprint: "fp",
      })
      .returning({ id: rawPulls.id });

    await seedSku("EV-A");
    await seedSale({ sku: "EV-A", salesDate: "2026-04-01", unitsSold: 7, channel: "shopify_us", routedLocation: "US", rawId: raw.id });
    await seedSale({ sku: "EV-A", salesDate: "2026-04-01", unitsSold: 14, channel: "shopify_intl", routedLocation: "CN", rawId: raw.id });

    const us = await getVelocityForRange({
      location: "US",
      rangeStart: "2026-04-01",
      rangeEnd: "2026-04-07",
    });
    const cn = await getVelocityForRange({
      location: "CN",
      rangeStart: "2026-04-01",
      rangeEnd: "2026-04-07",
    });
    expect(us.rows[0].unitsSold).toBe(7);
    expect(cn.rows[0].unitsSold).toBe(14);
  });

  it("excludes sales outside the range", async () => {
    const [raw] = await db
      .insert(rawPulls)
      .values({
        source: "shopify_us",
        pullBatchId: randomUUID(),
        payload: {},
        rowCount: 0,
        schemaFingerprint: "fp",
      })
      .returning({ id: rawPulls.id });

    await seedSku("EV-A");
    await seedSale({ sku: "EV-A", salesDate: "2026-03-31", unitsSold: 99, channel: "shopify_us", routedLocation: "US", rawId: raw.id });
    await seedSale({ sku: "EV-A", salesDate: "2026-04-01", unitsSold: 10, channel: "shopify_us", routedLocation: "US", rawId: raw.id });
    await seedSale({ sku: "EV-A", salesDate: "2026-04-08", unitsSold: 99, channel: "shopify_us", routedLocation: "US", rawId: raw.id });

    const result = await getVelocityForRange({
      location: "US",
      rangeStart: "2026-04-01",
      rangeEnd: "2026-04-07",
    });
    expect(result.rows[0].unitsSold).toBe(10);
  });

  it("swaps rangeStart / rangeEnd when caller passes them inverted", async () => {
    const [raw] = await db
      .insert(rawPulls)
      .values({
        source: "shopify_us",
        pullBatchId: randomUUID(),
        payload: {},
        rowCount: 0,
        schemaFingerprint: "fp",
      })
      .returning({ id: rawPulls.id });

    await seedSku("EV-A");
    await seedSale({ sku: "EV-A", salesDate: "2026-04-03", unitsSold: 21, channel: "shopify_us", routedLocation: "US", rawId: raw.id });
    // Seed a marker sale on the end date to ensure the freshness clamp
    // doesn't trim the window — this test exercises swap behavior only.
    await seedSale({ sku: "EV-A", salesDate: "2026-04-07", unitsSold: 0, channel: "shopify_us", routedLocation: "US", rawId: raw.id });

    const result = await getVelocityForRange({
      location: "US",
      rangeStart: "2026-04-07",
      rangeEnd: "2026-04-01",
    });
    expect(result.rangeStart).toBe("2026-04-01");
    expect(result.rangeEnd).toBe("2026-04-07");
    expect(result.rangeDays).toBe(7);
    expect(result.rows[0].unitsSold).toBe(21);
    expect(result.rows[0].unitsPerDay).toBeCloseTo(21 / 7, 4);
  });

  it("returns one row per SKU and omits SKUs with no sales in the window", async () => {
    const [raw] = await db
      .insert(rawPulls)
      .values({
        source: "shopify_us",
        pullBatchId: randomUUID(),
        payload: {},
        rowCount: 0,
        schemaFingerprint: "fp",
      })
      .returning({ id: rawPulls.id });

    await seedSku("EV-A");
    await seedSku("EV-B");
    await seedSku("EV-C"); // no sales — should be omitted

    await seedSale({ sku: "EV-A", salesDate: "2026-04-01", unitsSold: 5, channel: "shopify_us", routedLocation: "US", rawId: raw.id });
    await seedSale({ sku: "EV-A", salesDate: "2026-04-02", unitsSold: 5, channel: "shopify_us", routedLocation: "US", rawId: raw.id });
    await seedSale({ sku: "EV-B", salesDate: "2026-04-03", unitsSold: 21, channel: "shopify_us", routedLocation: "US", rawId: raw.id });

    const result = await getVelocityForRange({
      location: "US",
      rangeStart: "2026-04-01",
      rangeEnd: "2026-04-07",
    });
    const bySku = new Map(result.rows.map((r) => [r.sku, r]));
    expect(bySku.size).toBe(2);
    expect(bySku.get("EV-A")?.unitsSold).toBe(10);
    expect(bySku.get("EV-B")?.unitsSold).toBe(21);
    expect(bySku.has("EV-C")).toBe(false);
  });

  // --- 2026-05-23: freshness-day clamping ---
  // Bug: when the caller's window extends past the last complete sales
  // day, the denominator (rangeDays) included empty future days and
  // velocity got silently diluted. The UI's preset windows disagreed
  // with the same-window Custom picker by 10–22% during cron-stale
  // stretches. Fix: clamp rangeEnd to per-location max(salesDate).

  it("clamps rangeEnd to max(salesDate) at the location when the request extends past it", async () => {
    const [raw] = await db
      .insert(rawPulls)
      .values({
        source: "shopify_us",
        pullBatchId: randomUUID(),
        payload: {},
        rowCount: 0,
        schemaFingerprint: "fp",
      })
      .returning({ id: rawPulls.id });

    await seedSku("EV-A");
    // 3 days of sales, latest is 2026-04-05. Caller asks for window
    // ending 2026-04-08 — 3 days past actual data.
    await seedSale({ sku: "EV-A", salesDate: "2026-04-03", unitsSold: 10, channel: "shopify_us", routedLocation: "US", rawId: raw.id });
    await seedSale({ sku: "EV-A", salesDate: "2026-04-04", unitsSold: 10, channel: "shopify_us", routedLocation: "US", rawId: raw.id });
    await seedSale({ sku: "EV-A", salesDate: "2026-04-05", unitsSold: 10, channel: "shopify_us", routedLocation: "US", rawId: raw.id });

    const result = await getVelocityForRange({
      location: "US",
      rangeStart: "2026-04-03",
      rangeEnd: "2026-04-08", // 3 days past last complete day
    });
    // Effective window is 4/3–4/5 (3 days), NOT 4/3–4/8 (6 days).
    // 30 units / 3 days = 10/day (correct), NOT 30 / 6 = 5/day (wrong).
    expect(result.rangeEnd).toBe("2026-04-05");
    expect(result.requestedRangeEnd).toBe("2026-04-08");
    expect(result.rangeDays).toBe(3);
    expect(result.rows[0].unitsSold).toBe(30);
    expect(result.rows[0].unitsPerDay).toBeCloseTo(10, 4);
  });

  it("does NOT clamp when the requested rangeEnd is already within complete-data days", async () => {
    const [raw] = await db
      .insert(rawPulls)
      .values({
        source: "shopify_us",
        pullBatchId: randomUUID(),
        payload: {},
        rowCount: 0,
        schemaFingerprint: "fp",
      })
      .returning({ id: rawPulls.id });

    await seedSku("EV-A");
    await seedSale({ sku: "EV-A", salesDate: "2026-04-01", unitsSold: 7, channel: "shopify_us", routedLocation: "US", rawId: raw.id });
    await seedSale({ sku: "EV-A", salesDate: "2026-04-10", unitsSold: 7, channel: "shopify_us", routedLocation: "US", rawId: raw.id });

    // Caller's window 4/1–4/7 ends 3 days BEFORE latest data (4/10).
    // No clamping should occur.
    const result = await getVelocityForRange({
      location: "US",
      rangeStart: "2026-04-01",
      rangeEnd: "2026-04-07",
    });
    expect(result.rangeEnd).toBe("2026-04-07");
    expect(result.requestedRangeEnd).toBe("2026-04-07");
    expect(result.rangeDays).toBe(7);
  });

  it("clamps per-location independently — CN's max doesn't affect US's window", async () => {
    const [raw] = await db
      .insert(rawPulls)
      .values({
        source: "shopify_us",
        pullBatchId: randomUUID(),
        payload: {},
        rowCount: 0,
        schemaFingerprint: "fp",
      })
      .returning({ id: rawPulls.id });

    await seedSku("EV-A");
    // US has data through 4/05, CN has data through 4/10.
    await seedSale({ sku: "EV-A", salesDate: "2026-04-05", unitsSold: 10, channel: "shopify_us", routedLocation: "US", rawId: raw.id });
    await seedSale({ sku: "EV-A", salesDate: "2026-04-10", unitsSold: 10, channel: "shopify_intl", routedLocation: "CN", rawId: raw.id });

    const us = await getVelocityForRange({
      location: "US",
      rangeStart: "2026-04-01",
      rangeEnd: "2026-04-15",
    });
    const cn = await getVelocityForRange({
      location: "CN",
      rangeStart: "2026-04-01",
      rangeEnd: "2026-04-15",
    });
    expect(us.rangeEnd).toBe("2026-04-05"); // clamped to US max
    expect(cn.rangeEnd).toBe("2026-04-10"); // clamped to CN max
  });

  it("returns zero rows + rangeDays=0 when the entire window is past the last complete day", async () => {
    const [raw] = await db
      .insert(rawPulls)
      .values({
        source: "shopify_us",
        pullBatchId: randomUUID(),
        payload: {},
        rowCount: 0,
        schemaFingerprint: "fp",
      })
      .returning({ id: rawPulls.id });

    await seedSku("EV-A");
    await seedSale({ sku: "EV-A", salesDate: "2026-04-01", unitsSold: 10, channel: "shopify_us", routedLocation: "US", rawId: raw.id });

    // Window 4/05–4/10 is entirely past the 4/01 last complete day.
    const result = await getVelocityForRange({
      location: "US",
      rangeStart: "2026-04-05",
      rangeEnd: "2026-04-10",
    });
    expect(result.rows).toEqual([]);
    expect(result.rangeDays).toBe(0);
    expect(result.rangeEnd).toBe("2026-04-01"); // clamped, now < rangeStart
    expect(result.requestedRangeEnd).toBe("2026-04-10");
  });
});
