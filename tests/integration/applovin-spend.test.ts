import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { applovinAdSpendDaily, rawPulls } from "@/lib/db/schema";
import {
  parseApplovinSheet,
  replaceApplovinSpendLiveWindow,
  type ApplovinAggregated,
} from "@/lib/sources/sheets/applovin";
import "dotenv/config";

async function seedPull(): Promise<string> {
  const [row] = await db
    .insert(rawPulls)
    .values({
      source: "sheets_applovin",
      pullBatchId: randomUUID(),
      payload: {},
      rowCount: 0,
      schemaFingerprint: "fp",
    })
    .returning({ id: rawPulls.id });
  return row.id;
}

const findAgg = (rows: ApplovinAggregated[], product: string, date: string) =>
  rows.find((r) => r.product === product && r.spendDate === date);

describe("parseApplovinSheet", () => {
  it("aggregates long rows to (product, date) via the pipe segment", () => {
    const grid = [
      ["Ad name", "Date", "Spend"],
      ["hash_1 | 9055 | a", "2026-06-10", "100"],
      ["hash_2 | HW Gifts | b", "2026-06-10", "50"],
      ["hash_3 | 9055 | c", "2026-06-10", "25"], // same (9055, 06-10) -> sums to 125
      ["hash_4 | Clearance | d", "2026-06-11", "30"],
      ["3P_no_pipe_creative", "2026-06-10", "10"], // no pipe -> Unmapped
      ["hash_5 | 9055 | e", "2026-06-10", "0"], // zero spend -> skipped
      ["hash_6 | 9055 | f", "not-a-date", "5"], // bad date -> skipped
    ];
    const { aggregated, skipped } = parseApplovinSheet(grid);
    expect(findAgg(aggregated, "9055", "2026-06-10")!.costUsd).toBe(125);
    expect(findAgg(aggregated, "HW", "2026-06-10")!.costUsd).toBe(50);
    expect(findAgg(aggregated, "Clearance / Mixed", "2026-06-11")!.costUsd).toBe(30);
    expect(findAgg(aggregated, "Unmapped", "2026-06-10")!.costUsd).toBe(10);
    expect(skipped.some((s) => s.reason.includes("bad date"))).toBe(true);
  });

  it("captures the Country column (4-col layout) and uppercases the code", () => {
    const grid = [
      ["Ad name", "Date", "Country", "Spend"],
      ["hash_1 | 9055 | a", "2026-06-10", "us", "100"],
      ["hash_2 | 9055 | b", "2026-06-10", "gb", "40"], // same product/date, diff country
      ["hash_3 | 9055 | c", "2026-06-10", "us", "25"], // (9055, US, 06-10) -> 125
    ];
    const { aggregated } = parseApplovinSheet(grid);
    const us = aggregated.find((a) => a.product === "9055" && a.countryCode === "US" && a.spendDate === "2026-06-10");
    const gb = aggregated.find((a) => a.product === "9055" && a.countryCode === "GB" && a.spendDate === "2026-06-10");
    expect(us!.costUsd).toBe(125);
    expect(gb!.costUsd).toBe(40);
  });

  it("returns nothing + a skip on an unexpected header", () => {
    const { aggregated, skipped } = parseApplovinSheet([["Foo", "Bar", "Baz"]]);
    expect(aggregated).toEqual([]);
    expect(skipped[0].reason).toContain("unexpected header");
  });
});

describe("replaceApplovinSpendLiveWindow", () => {
  beforeAll(() => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set");
  });
  beforeEach(async () => {
    await db.execute(sql`TRUNCATE TABLE applovin_ad_spend_daily, raw_pulls CASCADE`);
  });

  it("replaces the live window and preserves history below it", async () => {
    const seed = await seedPull();
    await db.insert(applovinAdSpendDaily).values([
      { product: "9055", spendDate: "2026-04-01", costUsd: "500", sourcePullId: seed }, // history, survives
      { product: "HW", spendDate: "2026-06-10", costUsd: "10", sourcePullId: seed }, // stale, overwritten
    ]);
    const live = await seedPull();
    await replaceApplovinSpendLiveWindow(
      [
        { product: "HW", countryCode: "US", spendDate: "2026-06-10", costUsd: 99 },
        { product: "9055", countryCode: "GB", spendDate: "2026-06-11", costUsd: 40 },
      ],
      live,
    );
    const rows = await db
      .select({ product: applovinAdSpendDaily.product, countryCode: applovinAdSpendDaily.countryCode, spendDate: applovinAdSpendDaily.spendDate, costUsd: applovinAdSpendDaily.costUsd })
      .from(applovinAdSpendDaily)
      .orderBy(applovinAdSpendDaily.spendDate, applovinAdSpendDaily.product);
    expect(rows).toEqual([
      { product: "9055", countryCode: "", spendDate: "2026-04-01", costUsd: "500.0000" }, // history (no country), survives
      { product: "HW", countryCode: "US", spendDate: "2026-06-10", costUsd: "99.0000" },
      { product: "9055", countryCode: "GB", spendDate: "2026-06-11", costUsd: "40.0000" },
    ]);
  });

  it("is a no-op on an empty pull", async () => {
    const seed = await seedPull();
    await db.insert(applovinAdSpendDaily).values({
      product: "HW", spendDate: "2026-06-10", costUsd: "10", sourcePullId: seed,
    });
    await replaceApplovinSpendLiveWindow([], await seedPull());
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(applovinAdSpendDaily);
    expect(n).toBe(1);
  });
});
