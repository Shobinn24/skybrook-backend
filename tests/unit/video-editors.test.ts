import { describe, expect, it } from "vitest";
import {
  EXCLUDED_VIDEO_EDITOR_INITIALS,
  VIDEO_EDITORS,
  extractVideoEditor,
  isVideoEditor,
  videoEditorBonusAmountAtFullUsd,
  videoEditorBonusAmountUsd,
} from "@/lib/domain/video-editors";

describe("extractVideoEditor", () => {
  it("maps SR to Sebastian on a real AI-ad name shape", () => {
    expect(
      extractVideoEditor("(Mens CC) Ad 2077 - AIad - SR - UGC hook remix"),
    ).toEqual({ kind: "editor", editor: "Sebastian", initials: "SR" });
  });

  it("maps each known initials tag to its editor", () => {
    const cases: Array<[string, string]> = [
      ["GA", "Greg"],
      ["RC", "Ryan"],
      ["SR", "Sebastian"],
      ["JM", "Job"],
      ["CE", "Cristian"],
    ];
    for (const [initials, editor] of cases) {
      expect(
        extractVideoEditor(`(Product) Ad 1234 - AIad - ${initials} - desc`),
      ).toEqual({ kind: "editor", editor, initials });
    }
  });

  it("maps both PL and PHL to Phat Lee (PL is an alternate tag)", () => {
    expect(
      extractVideoEditor("(Product) Ad 2100 - AIad - PL - remix"),
    ).toEqual({ kind: "editor", editor: "Phat Lee", initials: "PL" });
    expect(
      extractVideoEditor("(Product) Ad 2101 - AIad - PHL - remix"),
    ).toEqual({ kind: "editor", editor: "Phat Lee", initials: "PHL" });
  });

  it("returns excluded (not unknown) for CJ / SJ / SCOTTY", () => {
    expect(
      extractVideoEditor("(Product) Ad 2102 - AIad - SJ - remix"),
    ).toEqual({ kind: "excluded", initials: "SJ" });
    expect(
      extractVideoEditor("(Product) Ad 2103 - AIad - CJ - remix"),
    ).toEqual({ kind: "excluded", initials: "CJ" });
    // Excluded matching is case-insensitive on the segment.
    expect(
      extractVideoEditor("(Product) Ad 2104 - AIad - Scotty - remix"),
    ).toEqual({ kind: "excluded", initials: "SCOTTY" });
  });

  it("returns unknown with normalized initials for unrecognized tags", () => {
    expect(
      extractVideoEditor("(Product) Ad 2105 - AIad - XY - remix"),
    ).toEqual({ kind: "unknown", initials: "XY" });
  });

  it("returns null for names without the AIad marker", () => {
    expect(extractVideoEditor("Ad 2326 - RC - Craig Mens VID 2")).toBeNull();
    expect(extractVideoEditor("Dan Navarra Postpartum")).toBeNull();
    expect(extractVideoEditor("")).toBeNull();
  });

  it("matches the AIad marker case-insensitively", () => {
    expect(
      extractVideoEditor("(Product) Ad 2106 - AIAD - SR - remix"),
    ).toEqual({ kind: "editor", editor: "Sebastian", initials: "SR" });
    expect(
      extractVideoEditor("(Product) Ad 2107 - aiad - rc - remix"),
    ).toEqual({ kind: "editor", editor: "Ryan", initials: "RC" });
  });

  it("does not fire on AIad appearing inside a longer segment", () => {
    expect(
      extractVideoEditor("(Product) Ad 2108 - AIadvert - SR - remix"),
    ).toBeNull();
  });

  it("returns null when the AIad segment has no following segment", () => {
    expect(extractVideoEditor("(Product) Ad 2109 - AIad")).toBeNull();
    expect(extractVideoEditor("(Product) Ad 2110 - AIad - ")).toBeNull();
  });
});

describe("isVideoEditor", () => {
  it("accepts every editor display name", () => {
    for (const e of VIDEO_EDITORS) expect(isVideoEditor(e)).toBe(true);
  });
  it("rejects marketer names and arbitrary strings", () => {
    expect(isVideoEditor("Craig")).toBe(false);
    expect(isVideoEditor("JW")).toBe(false);
    expect(isVideoEditor("SR")).toBe(false); // initials are not display names
    expect(isVideoEditor("")).toBe(false);
  });
});

describe("video editor bonus amounts (flat — no main/secondary split)", () => {
  it("tier1 = $200, tier2 = $800 at full approval", () => {
    expect(
      videoEditorBonusAmountUsd({ tier: "tier1", approval: "approved_full" }),
    ).toBe(200);
    expect(
      videoEditorBonusAmountUsd({ tier: "tier2", approval: "approved_full" }),
    ).toBe(800);
  });

  it("approved_half halves the rate, same as the marketer convention", () => {
    expect(
      videoEditorBonusAmountUsd({ tier: "tier1", approval: "approved_half" }),
    ).toBe(100);
    expect(
      videoEditorBonusAmountUsd({ tier: "tier2", approval: "approved_half" }),
    ).toBe(400);
  });

  it("exposes the pre-approval full amount for seeding pending rows", () => {
    expect(videoEditorBonusAmountAtFullUsd({ tier: "tier1" })).toBe(200);
    expect(videoEditorBonusAmountAtFullUsd({ tier: "tier2" })).toBe(800);
  });
});

describe("roster invariants", () => {
  it("editor display names never collide with the marketer roster (shared bonus_awards.marketer column + unique index)", () => {
    // BONUS_MARKETERS + FB_MARKETERS live in their own modules; the
    // uniqueness contract on bonus_awards (ad, marketer, tier) relies on
    // editor names being disjoint from marketer names.
    const marketers = ["Craig", "Nate", "Raul", "Tyler", "Scotty", "Jacob", "Dan", "JW"];
    for (const e of VIDEO_EDITORS) expect(marketers).not.toContain(e);
  });

  it("excluded initials cover the client's ruled-out tags", () => {
    for (const x of ["CJ", "SJ", "SCOTTY"]) {
      expect(EXCLUDED_VIDEO_EDITOR_INITIALS.has(x)).toBe(true);
    }
  });
});
