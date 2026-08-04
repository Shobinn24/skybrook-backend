import { describe, expect, it } from "vitest";
import {
  deriveCampaignTokens,
  formatLaunchSignals,
  stripCampaignTokens,
  tokenizePrefix,
  type LaunchSignals,
} from "@/lib/jobs/launch-detector";

// A representative slice of the real prefix vocabulary (2026-08 production).
// Includes the 07/31 "BC" wave, the campaign/region suffixes, and the
// multi-word product names that must survive stripping.
//
// The slice is deliberately wide enough to reproduce production's TOKEN
// STATISTICS, not just its shapes: deriveCampaignTokens counts how many
// distinct heads a token trails, so a fixture carrying only one or two "US
// BAU" prefixes would classify "bau" differently than the real 43-head data
// does. Keep at least three distinct heads behind every token asserted to be
// campaign structure below.
const REAL_PREFIXES = [
  "9055",
  "9055 CC",
  "9055 ICC",
  "9055 INTL",
  "9055 US BAU",
  "9055 US ZOMB",
  "9055 ASC",
  "9055 HF",
  "9055 HF CC",
  "9055 Pas CC",
  "HRS",
  "HRS CC",
  "HRS ICC",
  "HRS INT BAU",
  "HRS US ZOMB",
  "HRS BC",
  "Boyshort",
  "Boyshort CC",
  "Boyshort ICC",
  "Boyshort ASC",
  "Boyshort US BAU",
  "Boyshort INT BAU",
  "Boyshort US ZOMB",
  "Boyshort BC",
  "SupHW",
  "SupHW CC",
  "SupHW US BAU",
  "SupHW BC",
  "Shape",
  "Shape CC",
  "Shape BC",
  "OG Gifts",
  "OG Gifts CC",
  "HW Gifts",
  "Mens",
  "Mens BB",
  "Mens INTL",
  "Men Brief INTL",
  "Clearance",
  "Clearance ASC",
  "Clearance US BAU",
  "Clearance INT BAU",
  "Clearance BC",
  "HOME US BAU",
  "Home CC",
  "Cotton",
  "Cotton INTL",
  "Cotton ICC",
  "CHW",
  "CHW INTL",
  "Cotton Collection INTL",
];

describe("tokenizePrefix", () => {
  it("splits on runs of whitespace and drops empties", () => {
    expect(tokenizePrefix("  Cotton   Collection INTL ")).toEqual([
      "Cotton",
      "Collection",
      "INTL",
    ]);
  });

  it("returns an empty list for a blank prefix", () => {
    expect(tokenizePrefix("")).toEqual([]);
    expect(tokenizePrefix("   ")).toEqual([]);
  });
});

describe("deriveCampaignTokens", () => {
  const campaign = deriveCampaignTokens(REAL_PREFIXES);

  it("classifies suffixes that trail many distinct heads as campaign structure", () => {
    for (const token of ["cc", "icc", "intl", "bau", "bc"]) {
      expect(campaign.has(token), `${token} should be a campaign token`).toBe(true);
    }
  });

  it("does NOT classify a word that trails exactly one head", () => {
    // "Collection" only ever follows "Cotton" — it is part of the product
    // name, not campaign structure. This is the whole basis of the detector.
    expect(campaign.has("collection")).toBe(false);
  });

  it("holds a token below the threshold as part of the product name", () => {
    // "Gifts" follows only OG and HW here: 2 heads, one short of the cutoff,
    // so "OG Gifts" keeps its full head. This documents threshold behaviour
    // rather than a fact about production — in the live data a third head
    // pushes "gifts" over the line and it strips. Either side is acceptable:
    // Gifts is a merchandising variant of an existing product, so a new
    // "<known> Gifts" is not a launch we need to hear about.
    expect(campaign.has("gifts")).toBe(false);
    expect(stripCampaignTokens("OG Gifts CC", campaign)).toBe("OG Gifts");
  });

  it("never treats a first token as a campaign token", () => {
    // "Cotton" leads several prefixes but never trails one.
    expect(campaign.has("cotton")).toBe(false);
    expect(campaign.has("9055")).toBe(false);
  });

  it("classifies a brand-new suffix rolled out across many products at once", () => {
    // The 2026-07-31 "BC" wave: 20 existing products gained a "BC" variant on
    // a single day. Deriving over all history (not just pre-window) is what
    // lets this be recognised immediately instead of firing 20 false launches.
    const heads = ["A", "B", "C", "D", "E"];
    const tokens = deriveCampaignTokens([
      ...heads,
      ...heads.map((h) => `${h} ZZ`),
    ]);
    expect(tokens.has("zz")).toBe(true);
  });
});

describe("stripCampaignTokens", () => {
  const campaign = deriveCampaignTokens(REAL_PREFIXES);

  it("keeps a genuine multi-word product name intact", () => {
    expect(stripCampaignTokens("Cotton Collection INTL", campaign)).toBe("Cotton Collection");
  });

  it("strips campaign suffixes back to the product head", () => {
    expect(stripCampaignTokens("HRS BC", campaign)).toBe("HRS");
    expect(stripCampaignTokens("9055 US BAU", campaign)).toBe("9055");
    expect(stripCampaignTokens("Boyshort ICC", campaign)).toBe("Boyshort");
  });

  it("leaves a bare head untouched", () => {
    expect(stripCampaignTokens("Boyshort", campaign)).toBe("Boyshort");
  });

  it("never strips to empty even when the head itself looks like a suffix", () => {
    const allCampaign = new Set(["cc", "intl"]);
    expect(stripCampaignTokens("CC", allCampaign)).toBe("CC");
    expect(stripCampaignTokens("CC INTL", allCampaign)).toBe("CC");
  });

  it("stops at the first non-campaign token rather than stripping through it", () => {
    // "Collection" blocks the strip, so "INTL" comes off but nothing beyond.
    expect(stripCampaignTokens("Cotton Collection INTL", campaign)).not.toBe("Cotton");
  });
});

function signals(over: Partial<LaunchSignals> = {}): LaunchSignals {
  return {
    asOfDate: "2026-08-03",
    windowStart: "2026-07-14",
    windowDays: 21,
    newAdHeads: [],
    newSkus: [],
    ...over,
  };
}

describe("formatLaunchSignals", () => {
  it("stays green and quiet when nothing is new", () => {
    const r = formatLaunchSignals(signals());
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("no new ad prefixes or SKUs");
  });

  it("reports the silent-absorption case with what it is being counted as", () => {
    // The Cotton Collection shape: mapped (so no coverage alert fires) but new.
    const r = formatLaunchSignals(
      signals({
        newAdHeads: [
          {
            head: "Cotton Collection",
            prefixes: ["Cotton Collection INTL"],
            firstSeen: "2026-07-27",
            spendUsd: 782.14,
            attributedTo: "Cotton 9055",
            absorbed: true,
            landingUrls: [
              {
                url: "shop.everdries.com/cotton-collection",
                mapped: false,
                productLabel: null,
                spendUsd: 782.14,
              },
            ],
          },
        ],
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("(Cotton Collection INTL)");
    expect(r.detail).toContain("2026-07-27");
    expect(r.detail).toContain("counted as Cotton 9055");
    expect(r.detail).toContain("URL not in product sheet");
    expect(r.detail).toContain("shop.everdries.com/cotton-collection");
  });

  it("distinguishes an unmapped head from an absorbed one", () => {
    const r = formatLaunchSignals(
      signals({
        newAdHeads: [
          {
            head: "Wibble",
            prefixes: ["Wibble INTL"],
            firstSeen: "2026-07-20",
            spendUsd: 100,
            attributedTo: "Unmapped",
            absorbed: false,
            landingUrls: [],
          },
        ],
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("UNMAPPED prefix");
    expect(r.detail).toContain("no landing URL in snapshot");
  });

  it("says so when the new head's URL is already mapped", () => {
    const r = formatLaunchSignals(
      signals({
        newAdHeads: [
          {
            head: "Wibble",
            prefixes: ["Wibble INTL"],
            firstSeen: "2026-07-20",
            spendUsd: 100,
            attributedTo: "Wibble",
            absorbed: true,
            landingUrls: [
              {
                url: "shop.everdries.com/wibble",
                mapped: true,
                productLabel: "Wibble",
                spendUsd: 100,
              },
            ],
          },
        ],
      }),
    );
    // Fully-resolved launch: still described, but green. A permanently amber
    // line during an active launch period trains people to ignore the digest.
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("URL mapped to Wibble");
    expect(r.detail).toContain("Wibble");
    expect(r.detail).not.toContain("not in product sheet");
  });

  it("groups new SKUs by family instead of listing every size variant", () => {
    // A supplier bundle lands as ~26 size variants of a few products. Listing
    // each one buried the ad-side lines in the first production dry run.
    const sizes = ["xs", "s", "m", "l", "xl"];
    const r = formatLaunchSignals(
      signals({
        newSkus: [
          ...sizes.map((z) => ({
            sku: `ac-9055-3x-${z}`,
            productName: "Acclaims Style 9055 3-Pack",
            productLine: null,
            firstSeen: "2026-07-18",
            hasCost: true,
          })),
          ...sizes.map((z) => ({
            sku: `ac-9055-6x-${z}`,
            productName: "Acclaims Style 9055 6-Pack",
            productLine: null,
            firstSeen: "2026-07-18",
            hasCost: true,
          })),
        ],
      }),
    );
    expect(r.ok).toBe(true); // all priced, nothing to chase
    expect(r.detail).toContain("10 new SKUs in 2 families");
    expect(r.detail).toContain("Acclaims Style 9055 3-Pack (5)");
    expect(r.detail).not.toContain("ac-9055-3x-xs");
  });

  it("summarises new SKUs and flags the ones missing a unit cost", () => {
    const r = formatLaunchSignals(
      signals({
        newSkus: [
          {
            sku: "ev-mens-3x-4xl",
            productName: "Mens 3XL/4XL",
            productLine: "Mens",
            firstSeen: "2026-08-01",
            hasCost: false,
          },
          {
            sku: "ev-cotton-s",
            productName: "Cotton S",
            productLine: "Cotton",
            firstSeen: "2026-08-01",
            hasCost: true,
          },
        ],
      }),
    );
    // A SKU with no unit cost is a concrete thing to chase, so this goes amber.
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("2 new SKUs in 2 families");
    expect(r.detail).toContain("Mens 3XL/4XL (1, 1 no cost)");
    expect(r.detail).toContain("Cotton S (1)");
  });
});
