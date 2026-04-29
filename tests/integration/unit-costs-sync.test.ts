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

  it("extends size: extreme sizes inherit cost from a same-base sibling", async () => {
    // Scenario: regular size is in EVSKUmap, 5xl is not. 5xl should
    // pick up cost from L. Mirrors Shobinn's 2026-04-29 call: in
    // EVSKUmap, 98 of 141 product groups have flat cost across sizes.
    await db.insert(skus).values([
      {
        sku: "ev-bshort-hf-5x-l",
        productName: "Boyshort HF L",
        firstSeenAt: "2026-01-01",
        active: true,
      },
      {
        sku: "ev-bshort-hf-5x-5xl",
        productName: "Boyshort HF 5XL",
        firstSeenAt: "2026-01-01",
        active: true,
      },
    ]);

    const result = await syncUnitCosts({
      costsProvider: provider([
        { sku: "ev-bshort-hf-5x-l", costUsd: 9.52, costIntlUsd: 8.74 },
        // 5xl deliberately absent — that's the case this test pins.
      ]),
    });

    expect(result.sizeExtended).toBe(1);
    expect(result.sizeExtendedIntl).toBe(1);
    const fiveXl = await readSku("ev-bshort-hf-5x-5xl");
    expect(Number(fiveXl.unitCostUsd)).toBeCloseTo(9.52);
    expect(Number(fiveXl.unitCostIntlUsd)).toBeCloseTo(8.74);
  });

  it("cascades fc-mirror after size-extension primes the base", async () => {
    // Most demanding case: ev-bshort-fc-hf-5x-5xl is fc-line, base
    // ev-bshort-hf-5x-5xl is also missing from EVSKUmap. Sequence:
    //   1. fc-mirror tries fc → base → fails (base unpriced)
    //   2. size-extension primes the base from ev-bshort-hf-5x-l
    //   3. fc-mirror runs again, now fc-line picks up
    await db.insert(skus).values([
      {
        sku: "ev-bshort-hf-5x-l",
        productName: "Boyshort HF L",
        firstSeenAt: "2026-01-01",
        active: true,
      },
      {
        sku: "ev-bshort-hf-5x-5xl",
        productName: "Boyshort HF 5XL",
        firstSeenAt: "2026-01-01",
        active: true,
      },
      {
        sku: "ev-bshort-fc-hf-5x-5xl",
        productName: "Boyshort FC HF 5XL",
        firstSeenAt: "2026-01-01",
        active: true,
      },
    ]);

    const result = await syncUnitCosts({
      costsProvider: provider([
        { sku: "ev-bshort-hf-5x-l", costUsd: 9.52, costIntlUsd: 8.74 },
      ]),
    });

    // Base 5xl gets size-extended; fc-line 5xl gets fc-mirrored after.
    expect(result.sizeExtended).toBeGreaterThanOrEqual(1);
    expect(result.mirrored).toBeGreaterThanOrEqual(1);

    const base5xl = await readSku("ev-bshort-hf-5x-5xl");
    const fc5xl = await readSku("ev-bshort-fc-hf-5x-5xl");
    expect(Number(base5xl.unitCostUsd)).toBeCloseTo(9.52);
    expect(Number(base5xl.unitCostIntlUsd)).toBeCloseTo(8.74);
    expect(Number(fc5xl.unitCostUsd)).toBeCloseTo(9.52);
    expect(Number(fc5xl.unitCostIntlUsd)).toBeCloseTo(8.74);
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
