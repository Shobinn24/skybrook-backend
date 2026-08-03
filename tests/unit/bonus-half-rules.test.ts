import { describe, expect, it } from "vitest";
import {
  HALF_RULE_MARKETERS,
  IMAGE_EDITORS,
  halfBonusReason,
} from "@/lib/domain/bonus-half-rules";

describe("halfBonusReason (client spec 2026-08-03)", () => {
  it("fires on Remake / Rehook in the ad name, case-insensitively", () => {
    expect(
      halfBonusReason({
        marketer: "Craig",
        adNameRaw: "(HW) Ad 3300 - CJ - Craig DCA230 Boyshort MC Rehooks",
        adMarketers: ["Craig"],
      }),
    ).toMatch(/Rehook/);
    expect(
      halfBonusReason({
        marketer: "Tyler",
        adNameRaw: "Ad 3301 - Tyler VID 200 REMAKE",
        adMarketers: ["Tyler"],
      }),
    ).toMatch(/Remake/);
  });

  it("fires on an image-editor collab via the parsed marketers array", () => {
    const reason = halfBonusReason({
      marketer: "Craig",
      adNameRaw: "Ad 1954 - JR - Jacob x Craig - C4 - Feb26",
      adMarketers: ["Jacob", "Craig"],
    });
    expect(reason).toMatch(/Jacob/);
  });

  it("fires on an image-editor name in the raw name even if the roster parse missed it", () => {
    expect(
      halfBonusReason({
        marketer: "Raul",
        adNameRaw: "Ad 3400 - JW x Raul images batch 2",
        adMarketers: ["Raul"],
      }),
    ).toMatch(/JW/);
  });

  it("never fires for marketers outside the rule set (Jacob keeps full on his own collab)", () => {
    expect(
      halfBonusReason({
        marketer: "Jacob",
        adNameRaw: "Ad 1954 - JR - Jacob x Craig - C4 - Feb26",
        adMarketers: ["Jacob", "Craig"],
      }),
    ).toBeNull();
    expect(
      halfBonusReason({
        marketer: "Dan",
        adNameRaw: "Ad 5 - Dan Rehook",
        adMarketers: ["Dan"],
      }),
    ).toBeNull();
  });

  it("returns null for a plain solo ad", () => {
    expect(
      halfBonusReason({
        marketer: "Craig",
        adNameRaw: "Ad 2200 - CJ - Craig Dirty Jack: Studio Ad",
        adMarketers: ["Craig"],
      }),
    ).toBeNull();
  });

  it("does not false-fire JW inside longer words", () => {
    expect(
      halfBonusReason({
        marketer: "Craig",
        adNameRaw: "Ad 6 - Craig NJWEB promo",
        adMarketers: ["Craig"],
      }),
    ).toBeNull();
  });

  it("rule rosters match the client spec", () => {
    expect([...HALF_RULE_MARKETERS].sort()).toEqual(["Craig", "Raul", "Tyler"]);
    expect([...IMAGE_EDITORS].sort()).toEqual(["JW", "Jacob"]);
  });
});
