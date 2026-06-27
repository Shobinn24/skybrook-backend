import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { fbAdUrlMap, fbGeoSpend, rawPulls } from "@/lib/db/schema";
import { parseFbGeoSheet, replaceFbGeoSpend } from "@/lib/sources/sheets/fb-geo-spend";
import { parseFbUrlMapSheet, replaceFbAdUrlMap } from "@/lib/sources/sheets/fb-ad-url-map";
import "dotenv/config";

async function seedPull(): Promise<string> {
  const [row] = await db
    .insert(rawPulls)
    .values({ source: "sheets_fb_geo", pullBatchId: randomUUID(), payload: {}, rowCount: 0, schemaFingerprint: "fp" })
    .returning({ id: rawPulls.id });
  return row.id;
}

describe("parseFbGeoSheet", () => {
  it("aggregates per (adId, country), skips zero/blank, sums dupes", () => {
    const { rows, skipped } = parseFbGeoSheet([
      ["Ad ID", "Country code", "Cost"],
      ["a1", "US", "100"],
      ["a1", "US", "25"], // same (a1, US) -> 125
      ["a1", "gb", "40"], // lowercased -> GB
      ["a2", "US", "0"], // zero -> skipped
      ["", "US", "10"], // blank ad id -> skipped
    ]);
    expect(skipped).toEqual([]);
    const us = rows.find((r) => r.adId === "a1" && r.countryCode === "US");
    expect(us?.costUsd).toBe(125);
    expect(rows.find((r) => r.adId === "a1" && r.countryCode === "GB")?.costUsd).toBe(40);
    expect(rows.find((r) => r.adId === "a2")).toBeUndefined();
  });

  it("rejects an unexpected header", () => {
    const { rows, skipped } = parseFbGeoSheet([["Foo", "Bar", "Baz"]]);
    expect(rows).toEqual([]);
    expect(skipped[0].reason).toContain("unexpected header");
  });
});

describe("parseFbUrlMapSheet", () => {
  const header = [
    "Ad name",
    "Ad ID",
    "Destination URL",
    "External destination URL",
    "Promoted post destination URL",
    "Cost",
  ];
  it("coalesces promoted-post -> external -> catch-all, keeping only everdries URLs", () => {
    const { rows } = parseFbUrlMapSheet([
      header,
      // promoted post is everdries -> wins over the facebook catch-all
      ["(9055) Ad 1 - x", "a1", "https://facebook.com/video/1", "", "https://everdries.com/comfortplus", "100"],
      // promoted post blank, external everdries -> used
      ["(BShort) Ad 2 - y", "a2", "https://facebook.com/reel/2", "https://www.everdries.com/boyshort", "", "50"],
      // only a facebook URL anywhere -> null (ad-name fallback downstream)
      ["(Mens) Ad 3 - z", "a3", "https://facebook.com/reel/3", "", "", "30"],
    ]);
    const byId = Object.fromEntries(rows.map((r) => [r.adId, r]));
    expect(byId.a1.destUrl).toBe("https://everdries.com/comfortplus");
    expect(byId.a2.destUrl).toBe("https://www.everdries.com/boyshort");
    expect(byId.a3.destUrl).toBeNull();
  });

  it("dedupes a repeated ad_id, keeping the highest-cost row", () => {
    const { rows } = parseFbUrlMapSheet([
      header,
      ["(9055) Ad 1 - low", "a1", "", "", "https://everdries.com/comfort", "10"],
      ["(9055) Ad 1 - high", "a1", "", "", "https://everdries.com/comfortplus", "900"],
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].destUrl).toBe("https://everdries.com/comfortplus");
    expect(rows[0].costUsd).toBe(900);
  });
});

describe("replaceFbGeoSpend / replaceFbAdUrlMap (full snapshot replace)", () => {
  beforeAll(() => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set");
  });
  beforeEach(async () => {
    await db.execute(sql`TRUNCATE TABLE fb_geo_spend, fb_ad_url_map, raw_pulls CASCADE`);
  });

  it("fully replaces geo rows each pull and is a no-op on empty", async () => {
    const p1 = await seedPull();
    await replaceFbGeoSpend([{ adId: "old", countryCode: "US", costUsd: 5 }], p1);
    const p2 = await seedPull();
    await replaceFbGeoSpend([{ adId: "new", countryCode: "US", costUsd: 9 }], p2);
    let rows = await db.select({ adId: fbGeoSpend.adId, cost: fbGeoSpend.costUsd }).from(fbGeoSpend);
    expect(rows).toEqual([{ adId: "new", cost: "9.0000" }]); // old fully gone
    // empty pull does not wipe
    await replaceFbGeoSpend([], await seedPull());
    rows = await db.select({ adId: fbGeoSpend.adId, cost: fbGeoSpend.costUsd }).from(fbGeoSpend);
    expect(rows).toEqual([{ adId: "new", cost: "9.0000" }]);
  });

  it("fully replaces url-map rows each pull and is a no-op on empty", async () => {
    const p1 = await seedPull();
    await replaceFbAdUrlMap([{ adId: "old", adName: "(9055) Ad 1", destUrl: "https://everdries.com/comfort", costUsd: 5 }], p1);
    const p2 = await seedPull();
    await replaceFbAdUrlMap([{ adId: "new", adName: "(BShort) Ad 2", destUrl: null, costUsd: 9 }], p2);
    let rows = await db.select({ adId: fbAdUrlMap.adId, url: fbAdUrlMap.destUrl }).from(fbAdUrlMap);
    expect(rows).toEqual([{ adId: "new", url: null }]);
    await replaceFbAdUrlMap([], await seedPull());
    rows = await db.select({ adId: fbAdUrlMap.adId, url: fbAdUrlMap.destUrl }).from(fbAdUrlMap);
    expect(rows).toEqual([{ adId: "new", url: null }]);
  });
});
