import { describe, expect, it } from "vitest";
import { parseCampaignSheet } from "@/lib/sources/sheets/fb-campaigns";
import {
  CAMPAIGN_BUCKETS,
  bucketForCampaign,
} from "@/lib/domain/campaign-buckets";

// Source: "Campaign Daily" tab, long format straight from Supermetrics:
//   Row 1: ["Date", "Campaign name", "Cost", "Website purchases conversion value"]
// Ops request 2026-07-06: campaign-level tracker with daily spend + derived
// ROAS. Mapping campaign -> tracker bucket verified against the operator's
// hand-built sheet to the cent on 2026-07-06 (see campaign-buckets.ts).
describe("parseCampaignSheet", () => {
  const HEADER = ["Date", "Campaign name", "Cost", "Website purchases conversion value"];

  it("parses long-format rows into (campaign, date) spend + purchase value", () => {
    const { rows, skipped } = parseCampaignSheet([
      HEADER,
      ["2026-07-01", "Cost Cap Campaign", 5657.51, 12694.55],
      ["2026-07-01", "Zombie Campaign US", "350.61", "849.94"],
      ["2026-07-02", "Cost Cap Campaign", 7269.67, 14588.65],
    ]);
    expect(skipped).toEqual([]);
    expect(rows).toEqual([
      { campaignName: "Cost Cap Campaign", spendDate: "2026-07-01", costUsd: 5657.51, purchaseValueUsd: 12694.55 },
      { campaignName: "Zombie Campaign US", spendDate: "2026-07-01", costUsd: 350.61, purchaseValueUsd: 849.94 },
      { campaignName: "Cost Cap Campaign", spendDate: "2026-07-02", costUsd: 7269.67, purchaseValueUsd: 14588.65 },
    ]);
  });

  it("accepts datetime-ish date cells and trims campaign names", () => {
    const { rows } = parseCampaignSheet([
      HEADER,
      ["2026-07-01 00:00:00", "  Partnership Campaign ", 100, 200],
    ]);
    expect(rows).toEqual([
      { campaignName: "Partnership Campaign", spendDate: "2026-07-01", costUsd: 100, purchaseValueUsd: 200 },
    ]);
  });

  it("treats a blank purchase-value cell as zero (spend can exist without conversions)", () => {
    const { rows, skipped } = parseCampaignSheet([
      HEADER,
      ["2026-07-01", "Mens Listicle 1 Test", 12.34, ""],
    ]);
    expect(skipped).toEqual([]);
    expect(rows[0].purchaseValueUsd).toBe(0);
  });

  it("skips malformed rows with a reason instead of throwing", () => {
    const { rows, skipped } = parseCampaignSheet([
      HEADER,
      ["not-a-date", "Cost Cap Campaign", 1, 2],
      ["2026-07-01", "", 1, 2],
      ["2026-07-01", "Cost Cap Campaign", "abc", 2],
      ["2026-07-01", "Cost Cap Campaign", 5, 6],
    ]);
    expect(rows).toHaveLength(1);
    expect(skipped).toHaveLength(3);
    expect(skipped.map((s) => s.rowIdx)).toEqual([1, 2, 3]);
  });

  it("sums duplicate (campaign, date) rows defensively", () => {
    const { rows } = parseCampaignSheet([
      HEADER,
      ["2026-07-01", "Cost Cap Campaign", 10, 20],
      ["2026-07-01", "Cost Cap Campaign", 1.5, 2.5],
    ]);
    expect(rows).toEqual([
      { campaignName: "Cost Cap Campaign", spendDate: "2026-07-01", costUsd: 11.5, purchaseValueUsd: 22.5 },
    ]);
  });

  it("rejects a grid whose header is not the expected 4-column layout", () => {
    const { rows, skipped } = parseCampaignSheet([
      ["Campaign name", "Cost"],
      ["Cost Cap Campaign", 5],
    ]);
    expect(rows).toEqual([]);
    expect(skipped[0].reason).toMatch(/header/i);
  });
});

describe("campaign bucket map", () => {
  it("maps the 7 tracked campaigns to their verified buckets", () => {
    expect(bucketForCampaign("Cost Cap Campaign")?.key).toBe("us_cc");
    expect(bucketForCampaign("US BAU CBO IA Campaign")?.key).toBe("us_bau");
    expect(bucketForCampaign("INTL Cost Cap Campaign")?.key).toBe("intl_cc");
    expect(bucketForCampaign("INTL BAU CBO IA Campaign")?.key).toBe("intl_bau");
    expect(bucketForCampaign("CC CBO Testing Campaign")?.key).toBe("cc_cbo");
    expect(bucketForCampaign("Partnership Campaign")?.key).toBe("partnership");
    expect(bucketForCampaign("Zombie Campaign US")?.key).toBe("zombie");
  });

  it("returns null for untracked campaigns (they still ingest, just no column)", () => {
    // Verified 2026-07-06: the operator's Zombie column excludes the INTL
    // zombie campaign — exact to the cent across 14 tested days.
    expect(bucketForCampaign("Zombie Campaign INTL")).toBeNull();
    expect(bucketForCampaign("Men's Campaign")).toBeNull();
  });

  it("declares exactly which buckets roll into the US and INTL totals", () => {
    const us = CAMPAIGN_BUCKETS.filter((b) => b.totalGroup === "US").map((b) => b.key);
    const intl = CAMPAIGN_BUCKETS.filter((b) => b.totalGroup === "INTL").map((b) => b.key);
    expect(us).toEqual(["us_cc", "us_bau"]);
    expect(intl).toEqual(["intl_cc", "intl_bau"]);
  });
});
