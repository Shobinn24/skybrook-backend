import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { db } from "@/lib/db";
import { rawPulls, skus, stockSnapshots } from "@/lib/db/schema";
import { getStockValue, getStockValueByProductLine } from "@/lib/queries/stock";
import { resetDb } from "@/tests/fixtures/seed";

/**
 * Pins the per-warehouse cost routing introduced 2026-04-29:
 *   - US warehouse rows multiply by skus.unit_cost_usd
 *   - CN warehouse rows multiply by skus.unit_cost_intl_usd
 *   - CN falls back to US cost when unit_cost_intl_usd is null
 *
 * Scott confirmed the requirement 2026-04-28 EOD: "for international
 * stock should use the international cost".
 */

async function insertRawPull(): Promise<string> {
  const [r] = await db
    .insert(rawPulls)
    .values({
      source: "sheets_inventory",
      pullBatchId: randomUUID(),
      payload: {},
      rowCount: 0,
      schemaFingerprint: "fp",
    })
    .returning({ id: rawPulls.id });
  return r.id;
}

async function seed(opts: {
  sku: string;
  productLine?: string | null;
  unitCostUsd: string | null;
  unitCostIntlUsd: string | null;
  location: "US" | "CN";
  onHand: number;
}): Promise<void> {
  const rawId = await insertRawPull();
  // skus row is keyed on sku — only insert once per SKU even if multiple
  // (sku, location) snapshots get seeded.
  const existing = await db.select({ sku: skus.sku }).from(skus);
  if (!existing.find((s) => s.sku === opts.sku)) {
    await db.insert(skus).values({
      sku: opts.sku,
      productName: opts.sku,
      productLine: opts.productLine ?? null,
      unitCostUsd: opts.unitCostUsd ?? undefined,
      unitCostIntlUsd: opts.unitCostIntlUsd ?? undefined,
      firstSeenAt: "2026-01-01",
      active: true,
    });
  }
  await db.insert(stockSnapshots).values({
    sku: opts.sku,
    location: opts.location,
    snapshotDate: "2026-04-29",
    onHand: opts.onHand,
    sourcePullId: rawId,
  });
}

describe("per-warehouse cost routing (US vs INTL)", () => {
  beforeAll(() => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set in test env");
  });

  beforeEach(async () => {
    await resetDb();
  });

  it("uses unit_cost_intl_usd for CN warehouse rows", async () => {
    await seed({
      sku: "EV-A",
      productLine: "Core",
      unitCostUsd: "10",
      unitCostIntlUsd: "6",
      location: "CN",
      onHand: 100,
    });
    const cn = await getStockValue({ location: "CN" });
    // 100 × 6 (INTL cost) = 600. NOT 100 × 10 (would be wrong).
    expect(cn.totalUsd).toBe(600);
  });

  it("uses unit_cost_usd for US warehouse rows", async () => {
    await seed({
      sku: "EV-A",
      productLine: "Core",
      unitCostUsd: "10",
      unitCostIntlUsd: "6",
      location: "US",
      onHand: 100,
    });
    const us = await getStockValue({ location: "US" });
    expect(us.totalUsd).toBe(1000);
  });

  it("falls back to unit_cost_usd at CN when unit_cost_intl_usd is null", async () => {
    // Pre-migration / not-yet-priced INTL case: dashboard should still
    // show a meaningful number rather than zeroing out CN value.
    await seed({
      sku: "EV-B",
      productLine: "Core",
      unitCostUsd: "10",
      unitCostIntlUsd: null,
      location: "CN",
      onHand: 50,
    });
    const cn = await getStockValue({ location: "CN" });
    expect(cn.totalUsd).toBe(500);
  });

  it("combined view (no location filter) routes per-row", async () => {
    // Same SKU in both warehouses. US row uses US cost, CN row uses
    // INTL cost — totalled together they reflect correct per-warehouse
    // valuation rather than a single cost applied to both.
    await seed({
      sku: "EV-A",
      productLine: "Core",
      unitCostUsd: "10",
      unitCostIntlUsd: "6",
      location: "US",
      onHand: 100,
    });
    await seed({
      sku: "EV-A",
      productLine: "Core",
      unitCostUsd: "10",
      unitCostIntlUsd: "6",
      location: "CN",
      onHand: 200,
    });
    const all = await getStockValue({});
    // 100 × 10 (US) + 200 × 6 (INTL) = 1000 + 1200 = 2200
    expect(all.totalUsd).toBe(2200);
  });

  it("propagates routing through getStockValueByProductLine", async () => {
    await seed({
      sku: "EV-A",
      productLine: "Core",
      unitCostUsd: "10",
      unitCostIntlUsd: "6",
      location: "CN",
      onHand: 100,
    });
    const rows = await getStockValueByProductLine({ location: "CN" });
    expect(rows).toHaveLength(1);
    expect(rows[0].totalUsd).toBe(600);
  });
});
