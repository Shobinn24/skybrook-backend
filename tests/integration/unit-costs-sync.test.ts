import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { db } from "@/lib/db";
import { skus } from "@/lib/db/schema";
import { syncUnitCosts, type ParsedCostResult } from "@/lib/jobs/unit-costs";
import { eq } from "drizzle-orm";
import { resetDb } from "@/tests/fixtures/seed";

/**
 * Pins the dual-column sync behavior introduced 2026-04-29:
 *
 *   - syncUnitCosts writes BOTH unit_cost_usd and unit_cost_intl_usd
 *     when the cost-sheet row has values for both
 *   - INTL is null-tolerant: a missing INTL cell does NOT clear an
 *     existing DB value (sticky semantics — Scott's sheet has gaps)
 *   - the fc-mirror pass inherits both costs independently from the
 *     non-fc sibling
 */

function provider(rows: Array<{ sku: string; costUsd: number; costIntlUsd: number | null }>):
  () => Promise<ParsedCostResult> {
  return async () => ({
    rows,
    latestColumn: { dateLabel: "May'25", usCol: 9, intlCol: 10 },
    errorRows: 0,
  });
}

async function readSku(sku: string) {
  const [row] = await db
    .select({
      sku: skus.sku,
      unitCostUsd: skus.unitCostUsd,
      unitCostIntlUsd: skus.unitCostIntlUsd,
    })
    .from(skus)
    .where(eq(skus.sku, sku));
  return row;
}

describe("syncUnitCosts — dual-column", () => {
  beforeAll(() => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set in test env");
  });

  beforeEach(async () => {
    await resetDb();
  });

  it("writes both unit_cost_usd and unit_cost_intl_usd from a paired cell", async () => {
    await db.insert(skus).values({
      sku: "ev-og-5x-l",
      productName: "OG L",
      firstSeenAt: "2026-01-01",
      active: true,
    });
    const result = await syncUnitCosts({
      costsProvider: provider([{ sku: "ev-og-5x-l", costUsd: 6.73, costIntlUsd: 6.04 }]),
    });
    expect(result.updated).toBe(1);
    expect(result.updatedIntl).toBe(1);
    const row = await readSku("ev-og-5x-l");
    expect(Number(row.unitCostUsd)).toBeCloseTo(6.73);
    expect(Number(row.unitCostIntlUsd)).toBeCloseTo(6.04);
  });

  it("does not clear unit_cost_intl_usd when the sheet's INTL cell is null", async () => {
    // Pre-existing DB value for INTL — should survive a sync where the
    // sheet's INTL cell is empty.
    await db.insert(skus).values({
      sku: "ev-a",
      productName: "A",
      unitCostUsd: "10.0000",
      unitCostIntlUsd: "5.0000",
      firstSeenAt: "2026-01-01",
      active: true,
    });
    const result = await syncUnitCosts({
      costsProvider: provider([{ sku: "ev-a", costUsd: 10, costIntlUsd: null }]),
    });
    // US unchanged + INTL skipped → unchanged++
    expect(result.unchanged).toBe(1);
    expect(result.updatedIntl).toBe(0);
    const row = await readSku("ev-a");
    expect(Number(row.unitCostIntlUsd)).toBeCloseTo(5.0);
  });

  it("fc-line SKU inherits both US and INTL from its non-fc sibling", async () => {
    // Set up the non-fc base SKU + an unpriced fc-line sibling.
    await db.insert(skus).values([
      {
        sku: "ev-bshort-5x-l",
        productName: "Boyshort L",
        firstSeenAt: "2026-01-01",
        active: true,
      },
      {
        sku: "ev-bshort-fc-5x-l",
        productName: "Boyshort FC L",
        firstSeenAt: "2026-01-01",
        active: true,
      },
    ]);

    const result = await syncUnitCosts({
      costsProvider: provider([
        { sku: "ev-bshort-5x-l", costUsd: 4.5, costIntlUsd: 3.9 },
      ]),
    });

    // Base updates count once each.
    expect(result.updated).toBe(1);
    expect(result.updatedIntl).toBe(1);
    // fc sibling mirrors both columns.
    expect(result.mirrored).toBe(1);
    expect(result.mirroredIntl).toBe(1);

    const fc = await readSku("ev-bshort-fc-5x-l");
    expect(Number(fc.unitCostUsd)).toBeCloseTo(4.5);
    expect(Number(fc.unitCostIntlUsd)).toBeCloseTo(3.9);
  });

  it("fc-line SKU mirrors only the column its base has priced", async () => {
    // Base has US only; INTL absent. fc should inherit US, leave INTL null.
    await db.insert(skus).values([
      {
        sku: "ev-bshort-5x-l",
        productName: "Boyshort L",
        unitCostUsd: "4.5000",
        firstSeenAt: "2026-01-01",
        active: true,
      },
      {
        sku: "ev-bshort-fc-5x-l",
        productName: "Boyshort FC L",
        firstSeenAt: "2026-01-01",
        active: true,
      },
    ]);

    const result = await syncUnitCosts({
      costsProvider: provider([
        { sku: "ev-bshort-5x-l", costUsd: 4.5, costIntlUsd: null },
      ]),
    });

    expect(result.mirrored).toBe(1);
    expect(result.mirroredIntl).toBe(0);
    const fc = await readSku("ev-bshort-fc-5x-l");
    expect(Number(fc.unitCostUsd)).toBeCloseTo(4.5);
    expect(fc.unitCostIntlUsd).toBeNull();
  });
});
