import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql, eq, and } from "drizzle-orm";
import { db } from "@/lib/db";
import { getAssumptions, getCashflowGrid, listManualEntries } from "@/lib/queries/cashflow";
import { setAssumptions, enterWeeklyCash, setPayout, addManualEntry, deleteManualEntry } from "@/lib/jobs/cashflow-mutations";
import { generateRevenueForecast, generateEvActuals, upsertGeneratedEvents } from "@/lib/jobs/cashflow-forecast";
import { cashflowEvents, dailySales, rawPulls } from "@/lib/db/schema";
import { randomUUID } from "node:crypto";
import "dotenv/config";

async function truncate() {
  await db.execute(sql`TRUNCATE TABLE cashflow_events, cashflow_assumptions, cashflow_weekly CASCADE`);
}

describe("cashflow assumptions", () => {
  beforeAll(() => { if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set in test env"); });
  beforeEach(truncate);
  afterEach(truncate);

  it("seeds defaults on first read (payout 0.9, threshold 30000)", async () => {
    const a = await getAssumptions();
    expect(a.profitPayoutPct).toBe(0.9);
    expect(a.varianceThresholdUsd).toBe(30000);
    expect(a.cogsPct).toBe(0.15);
  });

  it("setAssumptions patches only provided fields", async () => {
    await getAssumptions();
    await setAssumptions({ evRevenueStart: 550000, evNetMargin: 0.18 }, "test@x.com");
    const a = await getAssumptions();
    expect(a.ev.revenueStart).toBe(550000);
    expect(a.ev.netMargin).toBe(0.18);
    expect(a.profitPayoutPct).toBe(0.9); // untouched
  });
});

describe("revenue forecast generator", () => {
  beforeEach(truncate);
  it("writes per-channel revenue + cogs forecast events for 13 weeks, idempotently", async () => {
    await getAssumptions();
    await setAssumptions({ evRevenueStart: 500000, evWeeklyGrowth: 1, evNetMargin: 0.2 }, "t");
    await generateRevenueForecast("2026-06-01");
    const evRows = await db.select().from(cashflowEvents)
      .where(and(eq(cashflowEvents.kind, "forecast"), eq(cashflowEvents.category, "revenue_ev")));
    expect(evRows).toHaveLength(13);
    expect(Number(evRows[0].amountUsd)).toBeCloseTo(500000, 0);
    // Re-run is a no-op (idempotent upsert on source_ref)
    await generateRevenueForecast("2026-06-01");
    const after = await db.select().from(cashflowEvents)
      .where(and(eq(cashflowEvents.kind, "forecast"), eq(cashflowEvents.category, "revenue_ev")));
    expect(after).toHaveLength(13);
  });
});

describe("EV actual revenue", () => {
  let createdPullId: string | null = null;
  beforeEach(truncate);
  afterEach(async () => {
    // Clean up ONLY the rows this test inserted (scoped by the pull id). A
    // blanket DELETE FROM raw_pulls breaks a full-suite run: other test files
    // create raw_pulls rows with FK children (incoming_shipments,
    // ad_spend_daily) that aren't cleaned yet when this afterEach fires.
    if (createdPullId) {
      await db.execute(sql`DELETE FROM daily_sales WHERE source_pull_id = ${createdPullId}`);
      await db.execute(sql`DELETE FROM raw_pulls WHERE id = ${createdPullId}`);
      createdPullId = null;
    }
  });
  it("buckets daily_sales net sales into weekly actual revenue_ev events", async () => {
    const [pull] = await db.insert(rawPulls).values({
      source: "shopify_us", pullBatchId: randomUUID(), payload: {}, rowCount: 0, schemaFingerprint: "t",
    }).returning({ id: rawPulls.id });
    createdPullId = pull.id;
    // Two sales rows in the same week (2026-06-01..07): 100 + 250 = 350
    // locationEnum values are "US" and "CN" (not "us"/"intl") — adjusted from task spec
    await db.insert(dailySales).values([
      { channel: "shopify_us", routedLocation: "US", sku: "ev-x", salesDate: "2026-06-02", unitsSold: 1, netSalesUsd: "100", sourcePullId: pull.id },
      { channel: "shopify_intl", routedLocation: "CN", sku: "ev-y", salesDate: "2026-06-04", unitsSold: 2, netSalesUsd: "250", sourcePullId: pull.id },
    ]);
    await generateEvActuals("2026-06-01", "2026-06-07");
    const rows = await db.select().from(cashflowEvents)
      .where(and(eq(cashflowEvents.kind, "actual"), eq(cashflowEvents.category, "revenue_ev")));
    expect(rows).toHaveLength(1);
    expect(rows[0].cashDate).toBe("2026-06-01");
    expect(Number(rows[0].amountUsd)).toBeCloseTo(350, 2);
    // Idempotency: re-running produces same single row (upsert on source_ref)
    await generateEvActuals("2026-06-01", "2026-06-07");
    const after = await db.select().from(cashflowEvents)
      .where(and(eq(cashflowEvents.kind, "actual"), eq(cashflowEvents.category, "revenue_ev")));
    expect(after).toHaveLength(1);
  });
});

describe("bulk order events", () => {
  beforeEach(truncate);
  afterEach(truncate);
  it("upserts a bulk_order out-event keyed by week", async () => {
    await upsertGeneratedEvents([{
      kind: "forecast", category: "bulk_order", direction: "out",
      amountUsd: "413028.96", accrualDate: "2024-04-08", cashDate: "2024-04-08",
      source: "sheet_pull", sourceRef: "bulk:2024-04-08", description: "x",
    }]);
    const rows = await db.select().from(cashflowEvents)
      .where(eq(cashflowEvents.category, "bulk_order"));
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].amountUsd)).toBeCloseTo(413028.96, 2);
  });
});

describe("cashflow grid", () => {
  beforeEach(truncate);
  afterEach(truncate);
  it("rolls 13 weeks: beginning snowballs, payout applied, variance flagged", async () => {
    await getAssumptions();
    await setAssumptions({ evRevenueStart: 500000, evWeeklyGrowth: 1, evNetMargin: 0.2, jmRevenueStart: 0, ewcRevenueStart: 0, cogsPct: 0.15, profitPayoutPct: 0.9 }, "t");
    await generateRevenueForecast("2026-06-01");
    // Net profit/wk = 500000*0.2 = 100000 ; payout = 90000 ; cogs = 75000
    // Grid computes: cash_in = Σ in-events (revenue + cogs_addback), cash_out = Σ out-events + payout
    await enterWeeklyCash("2026-06-01", 200000, "t"); // beginning anchor
    const grid = await getCashflowGrid("2026-06-01");
    expect(grid.weeks).toHaveLength(13);
    expect(grid.weeks[0].weekStart).toBe("2026-06-01");
    expect(grid.weeks[0].beginning).toBeCloseTo(200000, 0);
    // in = revenue(500k) + cogs_addback(75k) = 575000 ; out = payout 90000
    expect(grid.weeks[0].cashIn).toBeCloseTo(575000, 0);
    expect(grid.weeks[0].cashOut).toBeCloseTo(90000, 0);
    expect(grid.weeks[0].ending).toBeCloseTo(200000 + 575000 - 90000, 0);
    // wk1 beginning = wk0 ending (snowball)
    expect(grid.weeks[1].beginning).toBeCloseTo(grid.weeks[0].ending, 0);
  });

  it("payout override and skip change the week's out-flow", async () => {
    await getAssumptions();
    await setAssumptions({ evRevenueStart: 500000, evWeeklyGrowth: 1, evNetMargin: 0.2, profitPayoutPct: 0.9 }, "t");
    await generateRevenueForecast("2026-06-01");
    await setPayout("2026-06-01", { overrideUsd: 10000 }, "t");
    let grid = await getCashflowGrid("2026-06-01");
    expect(grid.weeks[0].payout).toBeCloseTo(10000, 0);
    await setPayout("2026-06-01", { skipped: true }, "t");
    grid = await getCashflowGrid("2026-06-01");
    expect(grid.weeks[0].payout).toBeCloseTo(0, 0);
  });

  it("variance is entered-actual minus the calculated/expected (prior-week) balance, not the re-derived ending", async () => {
    await getAssumptions();
    await setAssumptions({ evRevenueStart: 500000, evWeeklyGrowth: 1, evNetMargin: 0.2, jmRevenueStart: 0, ewcRevenueStart: 0, cogsPct: 0.15, profitPayoutPct: 0.9 }, "t");
    await generateRevenueForecast("2026-06-01");
    // wk0 anchor; in = 575000, payout = 0.9*100000 = 90000, out = 90000
    await enterWeeklyCash("2026-06-01", 200000, "t");
    // ending0 = 200000 + 575000 - 90000 = 685000 => expected beginning of wk1
    const grid0 = await getCashflowGrid("2026-06-01");
    const expectedWk1Begin = grid0.weeks[0].ending; // 685000
    // Enter wk1 actual that diverges from the expected by > $30k threshold
    await enterWeeklyCash("2026-06-08", expectedWk1Begin + 35000, "t");
    const grid = await getCashflowGrid("2026-06-01");
    // wk0 is the anchor — no prior-week expectation, so no variance
    expect(grid.weeks[0].variance).toBeNull();
    // wk1 variance = entered actual - expected (prior ending), NOT a constant
    expect(grid.weeks[1].variance).toBeCloseTo(35000, 0);
    expect(grid.weeks[1].varianceSignificant).toBe(true);
    // wk1 beginning re-anchors to the entered actual
    expect(grid.weeks[1].beginning).toBeCloseTo(expectedWk1Begin + 35000, 0);
  });
});

describe("manual entries", () => {
  beforeEach(truncate);
  afterEach(truncate);

  it("a one-off manual expense flows into that week's cashOut and lists once", async () => {
    await getAssumptions();
    await addManualEntry(
      { category: "payroll", direction: "out", amountUsd: 45000, cashDate: "2026-06-01", description: "Payroll 1st" },
      "t",
    );
    const grid = await getCashflowGrid("2026-06-01");
    // payroll out-event reduces the category line and adds to cashOut
    expect(grid.weeks[0].byCategory["payroll"]).toBeCloseTo(-45000, 0);
    expect(grid.weeks[0].cashOut).toBeCloseTo(45000, 0); // no payout (no revenue assumptions generated)
    const list = await listManualEntries("2026-06-01");
    expect(list).toHaveLength(1);
    expect(list[0].recurring).toBe(false);
    expect(Number(list[0].amountUsd)).toBeCloseTo(45000, 0);
  });

  it("a monthly manual expense creates one event per month in the horizon and lists as one recurring row", async () => {
    await getAssumptions();
    await addManualEntry(
      { category: "software", direction: "out", amountUsd: 10000, cashDate: "2026-06-01", description: "Software", repeatMonthly: true },
      "t",
    );
    // 2026-06-01 horizon spans Jun/Jul/Aug -> 3 monthly occurrences
    const jun = await getCashflowGrid("2026-06-01");
    expect(jun.weeks[0].byCategory["software"]).toBeCloseTo(-10000, 0);
    const events = await db.select().from(cashflowEvents).where(eq(cashflowEvents.category, "software"));
    expect(events.length).toBeGreaterThanOrEqual(3);
    const list = await listManualEntries("2026-06-01");
    expect(list).toHaveLength(1);
    expect(list[0].recurring).toBe(true);
  });

  it("deleteManualEntry removes the whole group", async () => {
    await getAssumptions();
    await addManualEntry(
      { category: "agency", direction: "out", amountUsd: 6000, cashDate: "2026-06-01", description: "Whitelisting", repeatMonthly: true },
      "t",
    );
    const list = await listManualEntries("2026-06-01");
    expect(list).toHaveLength(1);
    await deleteManualEntry(list[0].ref, "t");
    expect(await listManualEntries("2026-06-01")).toHaveLength(0);
    const events = await db.select().from(cashflowEvents).where(eq(cashflowEvents.category, "agency"));
    expect(events).toHaveLength(0);
  });
});
