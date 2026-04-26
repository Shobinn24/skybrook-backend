import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { db } from "@/lib/db";
import {
  rawPulls,
  skus,
  stockSnapshots,
  sustainabilityFlags,
} from "@/lib/db/schema";
import { runPhase2 } from "@/lib/jobs/reconcile";
import { getOverstockRows } from "@/lib/queries/overstock";
import { resetDb, seedBasic } from "@/tests/fixtures/seed";

/**
 * Overstock view (SPEC §5.5) is a marketing-facing slice of the existing
 * sustainability flag data. These tests pin: (1) only ⚫-flagged rows
 * surface, (2) sort order is biggest-stock-value-first, (3) summary
 * totals match the rows shown, (4) empty-state is clean.
 */
describe("getOverstockRows", () => {
  beforeAll(() => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set in test env");
  });

  beforeEach(async () => {
    await resetDb();
    await seedBasic();
    await runPhase2({ asOfDate: "2026-04-23" });
  });

  it("returns only overstocked rows from the inventory data", async () => {
    const result = await getOverstockRows();
    // seedBasic + runPhase2 produces exactly one overstocked row:
    // EV-A @ CN (DOS=250 days, well over the 90-day threshold).
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].sku).toBe("EV-A");
    expect(result.rows[0].location).toBe("CN");
    expect(result.rows[0].flag).toBe("overstocked");
  });

  it("summary counts match the rows returned", async () => {
    const result = await getOverstockRows();
    expect(result.summary.count).toBe(result.rows.length);
    const expectedTotal = result.rows.reduce((acc, r) => acc + r.stockValueUsd, 0);
    expect(result.summary.totalStockValueUsd).toBeCloseTo(expectedTotal, 2);
  });

  it("sorts rows by stock value descending when there are multiple overstocked rows", async () => {
    // Inject a second overstocked row with a smaller stock value so we
    // can verify the sort. Using a fresh raw_pulls row + new SKU keeps
    // the rest of the seed untouched.
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
      sku: "EV-OS2",
      productName: "Smaller Overstock",
      productLine: "Core",
      unitCostUsd: "1",
      firstSeenAt: "2026-04-01",
      active: true,
    });
    await db.insert(stockSnapshots).values({
      sku: "EV-OS2",
      location: "CN",
      snapshotDate: "2026-04-23",
      onHand: 100,
      sourcePullId: raw.id,
    });
    await db.insert(sustainabilityFlags).values({
      sku: "EV-OS2",
      location: "CN",
      asOfDate: "2026-04-23",
      flag: "overstocked",
      runOutDate: null,
      reasoning: "Test fixture",
      sourceRefs: { test: true },
    });

    const result = await getOverstockRows();
    expect(result.rows.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < result.rows.length; i++) {
      expect(result.rows[i - 1].stockValueUsd).toBeGreaterThanOrEqual(
        result.rows[i].stockValueUsd,
      );
    }
    // EV-A @ CN ($5 × 500 = $2,500) outranks EV-OS2 @ CN ($1 × 100 = $100).
    expect(result.rows[0].sku).toBe("EV-A");
  });

  it("returns an empty result with zero summary when nothing is overstocked", async () => {
    // Strip overstock flags by overwriting them as healthy. Reset isn't
    // enough on its own because phase2 runs in beforeEach.
    await db
      .update(sustainabilityFlags)
      .set({ flag: "healthy" });

    const result = await getOverstockRows();
    expect(result.rows).toEqual([]);
    expect(result.summary.count).toBe(0);
    expect(result.summary.totalStockValueUsd).toBe(0);
    expect(result.summary.medianDaysOfStock).toBeNull();
  });
});
