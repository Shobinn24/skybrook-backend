import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import { eq, and } from "drizzle-orm";
import { resetDb, seedBasic } from "@/tests/fixtures/seed";
import { runPhase2 } from "@/lib/jobs/reconcile";
import { db } from "@/lib/db";
import {
  daysOfStock,
  salesVelocity,
  sustainabilityFlags,
} from "@/lib/db/schema";

describe("Phase 2 derive (MVP — no reconciliation)", () => {
  beforeAll(() => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set in test env");
  });

  beforeEach(async () => {
    await resetDb();
    await seedBasic();
  });

  it("writes sales_velocity rows for 3/7/30 day windows per SKU", async () => {
    await runPhase2({ asOfDate: "2026-04-23" });
    const rows = await db.select().from(salesVelocity);
    const windows = new Set(rows.map((r) => r.windowDays));
    expect(windows).toEqual(new Set([3, 7, 30]));
    // EV-A: 5+2 = 7 units/day × 7 days = 49 units → 7d velocity = 7
    const evA7 = rows.find((r) => r.sku === "EV-A" && r.windowDays === 7 && r.channel === "all");
    expect(Number(evA7?.unitsPerDay)).toBeCloseTo(7, 3);
  });

  it("writes per-channel velocity rows so US and CN can show different numbers", async () => {
    await runPhase2({ asOfDate: "2026-04-23" });
    const rows = await db.select().from(salesVelocity);
    const channels = new Set(rows.map((r) => r.channel));
    expect(channels).toEqual(new Set(["all", "shopify_us", "shopify_intl"]));
    // EV-A: shopify_us=5/day, shopify_intl=2/day
    const evAUs = rows.find((r) => r.sku === "EV-A" && r.windowDays === 7 && r.channel === "shopify_us");
    const evAIntl = rows.find((r) => r.sku === "EV-A" && r.windowDays === 7 && r.channel === "shopify_intl");
    expect(Number(evAUs?.unitsPerDay)).toBeCloseTo(5, 3);
    expect(Number(evAIntl?.unitsPerDay)).toBeCloseTo(2, 3);
  });

  it("writes days_of_stock rows for each (SKU, location) with a snapshot", async () => {
    await runPhase2({ asOfDate: "2026-04-23" });
    const rows = await db.select().from(daysOfStock);
    // EV-A US: on_hand=100, velocity(US)=5/day (shopify_us only) → DOS = 20
    const evAUS = rows.find((r) => r.sku === "EV-A" && r.location === "US");
    expect(Number(evAUS?.daysOfStock)).toBeCloseTo(20, 3);
    // EV-A CN: on_hand=500, velocity(CN)=2/day (shopify_intl) → DOS = 250
    const evACN = rows.find((r) => r.sku === "EV-A" && r.location === "CN");
    expect(Number(evACN?.daysOfStock)).toBeCloseTo(250, 3);
  });

  it("writes sustainability flag rows per (SKU, location)", async () => {
    await runPhase2({ asOfDate: "2026-04-23" });
    const rows = await db.select().from(sustainabilityFlags);
    // EV-A US: DOS=20, healthy (>14, no incoming POs to consider)
    expect(
      rows.find((r) => r.sku === "EV-A" && r.location === "US")?.flag
    ).toBe("healthy");
    // EV-A CN: DOS=250, overstocked (>90)
    expect(
      rows.find((r) => r.sku === "EV-A" && r.location === "CN")?.flag
    ).toBe("overstocked");
    // EV-B US: on_hand=20, velocity(US)=3/day → DOS=6.67 → at_risk (<7)
    expect(
      rows.find((r) => r.sku === "EV-B" && r.location === "US")?.flag
    ).toBe("at_risk");
  });

  it("is idempotent — re-running produces the same rows, not duplicates", async () => {
    await runPhase2({ asOfDate: "2026-04-23" });
    const firstCount = (await db.select().from(sustainabilityFlags)).length;
    await runPhase2({ asOfDate: "2026-04-23" });
    const secondCount = (await db.select().from(sustainabilityFlags)).length;
    expect(secondCount).toBe(firstCount);
  });

  it("skips (SKU, location) combinations with no stock snapshot", async () => {
    const result = await runPhase2({ asOfDate: "2026-04-23" });
    // EV-B only has a US snapshot — CN should be skipped (1 skip).
    expect(result.skusSkipped).toBeGreaterThanOrEqual(1);
    const evBCn = await db
      .select()
      .from(sustainabilityFlags)
      .where(and(eq(sustainabilityFlags.sku, "EV-B"), eq(sustainabilityFlags.location, "CN")));
    expect(evBCn).toHaveLength(0);
  });
});
