import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  rawPulls,
  skus,
  stockSnapshots,
} from "@/lib/db/schema";
import { runPhase2 } from "@/lib/jobs/reconcile";
import { getOverstockRows } from "@/lib/queries/overstock";
import { thresholds } from "@/config/thresholds";
import { resetDb, seedBasic } from "@/tests/fixtures/seed";

/**
 * Overstock view (SPEC §5.5, Phase 2).
 *
 * Scott 2026-05-18: "Anything above 300 days." Applied at the PRODUCT
 * rollup level (sum stock + sum velocity across every SKU of a product,
 * both locations) — NOT per-SKU. These tests pin the new contract:
 *   (1) only SKUs of products whose rolled-up DOS > threshold appear
 *   (2) order: products sorted by total stock value desc; within a
 *       product, SKUs sorted by stock value desc
 *   (3) summary.count is product count (not SKU count)
 *   (4) zero-velocity products with stock are flagged (Infinity DOS)
 *   (5) empty result is clean.
 */
describe("getOverstockRows (Phase 2 — product-level rollup)", () => {
  beforeAll(() => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set in test env");
  });

  beforeEach(async () => {
    await resetDb();
    await seedBasic();
    await runPhase2({ asOfDate: "2026-04-24" });
  });

  it("flags products whose rolled-up DOS exceeds the threshold", async () => {
    // seedBasic gives us Alpha (EV-A: US 100 + CN 500 = 600 onHand, plus
    // 200 incoming = 800 futureStock, combined velocity = 5+2 = 7/day →
    // 114d combined — NOT overstocked under the 300d threshold).
    //
    // To produce a deterministic overstock case at the product level we
    // bump Alpha's CN stock so combined DOS clearly exceeds 300d.
    // 100 (US) + 2000 (CN) + 200 incoming = 2300 / 7 = 328.6d → flagged.
    const [extraRaw] = await db
      .insert(rawPulls)
      .values({
        source: "sheets_inventory",
        pullBatchId: crypto.randomUUID(),
        payload: {},
        rowCount: 0,
        schemaFingerprint: "fp",
      })
      .returning({ id: rawPulls.id });

    // Overwrite the CN snapshot for EV-A with a much higher number.
    await db
      .update(stockSnapshots)
      .set({ onHand: 2000, sourcePullId: extraRaw.id })
      .where(
        and(
          eq(stockSnapshots.sku, "EV-A"),
          eq(stockSnapshots.location, "CN"),
        ),
      );
    await runPhase2({ asOfDate: "2026-04-24" });

    const result = await getOverstockRows();
    // Alpha is overstocked; Beta has DOS = 20/3 ≈ 6.6d — fine.
    const productNames = new Set(result.rows.map((r) => r.productName));
    expect(productNames).toEqual(new Set(["Alpha"]));
    expect(result.summary.count).toBe(1);

    // Both EV-A rows (US + CN) are returned because they belong to the
    // overstocked product, even though per-SKU US has only 100 units.
    const skuLocations = result.rows.map((r) => `${r.sku}:${r.location}`);
    expect(skuLocations.sort()).toEqual(["EV-A:CN", "EV-A:US"].sort());
  });

  it("returns an empty result when no product crosses the threshold", async () => {
    // seedBasic alone: Alpha combined DOS ≈ 114d (under 300), Beta ≈ 7d.
    const result = await getOverstockRows();
    expect(result.rows).toEqual([]);
    expect(result.summary.count).toBe(0);
    expect(result.summary.totalStockValueUsd).toBe(0);
    expect(result.summary.medianDaysOfStock).toBeNull();
  });

  it("flags products with stock and zero combined velocity (Infinity DOS)", async () => {
    // Insert a product whose SKUs have no sales at all → combined
    // velocity is 0, productDOS = Infinity, productDOS > 300 → flagged.
    const [raw] = await db
      .insert(rawPulls)
      .values({
        source: "sheets_inventory",
        pullBatchId: crypto.randomUUID(),
        payload: {},
        rowCount: 0,
        schemaFingerprint: "fp",
      })
      .returning({ id: rawPulls.id });
    await db.insert(skus).values({
      sku: "EV-NOSALES",
      productName: "Gamma",
      productLine: "Core",
      unitCostUsd: "10",
      firstSeenAt: "2026-04-01",
      active: true,
    });
    await db.insert(stockSnapshots).values({
      sku: "EV-NOSALES",
      location: "US",
      snapshotDate: "2026-04-23",
      onHand: 50,
      sourcePullId: raw.id,
    });
    await runPhase2({ asOfDate: "2026-04-24" });

    const result = await getOverstockRows();
    const productNames = new Set(result.rows.map((r) => r.productName));
    expect(productNames.has("Gamma")).toBe(true);
    // Infinity is dropped from the median (only finite product-DOS
    // contributes); with only Gamma flagged → median is null.
    expect(result.summary.count).toBeGreaterThanOrEqual(1);
  });

  it("sorts products by total stock value desc and SKUs by stock value desc within product", async () => {
    // Seed a second overstocked product with lower total stock value so
    // we can verify product-level ordering, plus a second SKU on the
    // first product to verify within-product SKU ordering.
    const [raw] = await db
      .insert(rawPulls)
      .values({
        source: "sheets_inventory",
        pullBatchId: crypto.randomUUID(),
        payload: {},
        rowCount: 0,
        schemaFingerprint: "fp",
      })
      .returning({ id: rawPulls.id });

    // Push EV-A's CN stock high enough to flag Alpha (combined DOS > 300).
    await db
      .update(stockSnapshots)
      .set({ onHand: 5000, sourcePullId: raw.id })
      .where(
        and(
          eq(stockSnapshots.sku, "EV-A"),
          eq(stockSnapshots.location, "CN"),
        ),
      );

    // A separate overstocked product "Delta" with a smaller stock value.
    await db.insert(skus).values([
      {
        sku: "EV-D1",
        productName: "Delta",
        productLine: "Core",
        unitCostUsd: "1",
        firstSeenAt: "2026-04-01",
        active: true,
      },
      {
        sku: "EV-D2",
        productName: "Delta",
        productLine: "Core",
        unitCostUsd: "1",
        firstSeenAt: "2026-04-01",
        active: true,
      },
    ]);
    await db.insert(stockSnapshots).values([
      { sku: "EV-D1", location: "US", snapshotDate: "2026-04-23", onHand: 50, sourcePullId: raw.id },
      { sku: "EV-D2", location: "US", snapshotDate: "2026-04-23", onHand: 200, sourcePullId: raw.id },
    ]);
    await runPhase2({ asOfDate: "2026-04-24" });

    const result = await getOverstockRows();

    // Alpha (EV-A US 100 + CN 5000 × $5 = $25,500) outranks Delta (250 × $1 = $250).
    expect(result.rows[0].productName).toBe("Alpha");
    // Last Alpha row is followed by the first Delta row.
    const productOrder = result.rows.map((r) => r.productName);
    const alphaEnd = productOrder.lastIndexOf("Alpha");
    const deltaStart = productOrder.indexOf("Delta");
    expect(deltaStart).toBeGreaterThan(alphaEnd);

    // Within Alpha, CN ($25,000) precedes US ($500).
    const alphaRows = result.rows.filter((r) => r.productName === "Alpha");
    expect(alphaRows[0].location).toBe("CN");
    // Within Delta, EV-D2 (200 units) precedes EV-D1 (50 units).
    const deltaRows = result.rows.filter((r) => r.productName === "Delta");
    expect(deltaRows[0].sku).toBe("EV-D2");
  });

  it("threshold constant matches Scott's 300d spec", () => {
    expect(thresholds.productOverstockDays).toBe(300);
  });
});
