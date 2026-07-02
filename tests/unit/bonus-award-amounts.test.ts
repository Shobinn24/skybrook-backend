// The single amount chooser behind approveBonus / bulkApprovePending.
// `bonus_awards.marketer` is free-text, so pricing hinges entirely on
// which roster a name belongs to — these tests pin the two happy paths
// and, more importantly, the two fail-LOUD branches: a name in NEITHER
// roster must never silently price at secondary marketer rates, and a
// name in BOTH rosters (impossible today, guarded by the disjointness
// test in video-editors.test.ts) must scream the day it happens.

import { describe, expect, it, vi } from "vitest";
import { awardAmountUsd } from "@/lib/jobs/bonus-mutations";

// Pass-through mock of the video-editors domain module with a test-
// controlled escape hatch: names added to `collisionNames` count as
// video editors IN ADDITION to their real roster membership, letting us
// exercise the both-rosters guard without touching the real rosters.
const { collisionNames } = vi.hoisted(() => ({
  collisionNames: new Set<string>(),
}));
vi.mock("@/lib/domain/video-editors", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/domain/video-editors")>();
  return {
    ...actual,
    isVideoEditor: (name: string) =>
      actual.isVideoEditor(name) || collisionNames.has(name),
  };
});

describe("awardAmountUsd", () => {
  it("prices marketer names at the existing main/secondary rates", () => {
    expect(
      awardAmountUsd({
        marketer: "Craig",
        tier: "tier1",
        approval: "approved_full",
      }),
    ).toBe(500);
    expect(
      awardAmountUsd({
        marketer: "Jacob",
        tier: "tier2",
        approval: "approved_half",
      }),
    ).toBe(750); // secondary T2 $1500 halved
  });

  it("prices video-editor names at the flat editor rates", () => {
    expect(
      awardAmountUsd({
        marketer: "Sebastian",
        tier: "tier1",
        approval: "approved_full",
      }),
    ).toBe(200);
    expect(
      awardAmountUsd({
        marketer: "Phat Lee",
        tier: "tier2",
        approval: "approved_half",
      }),
    ).toBe(400);
  });

  it("throws (never silently prices) for a name in NEITHER roster", () => {
    // Before this guard, an unrecognized name fell through to the
    // marketer path and priced at secondary rates ($250/$1500). Rows
    // only ever come from the two crossing detectors, so an unknown
    // name means a hand-inserted or corrupted row — investigate, don't pay.
    expect(() =>
      awardAmountUsd({
        marketer: "Zorp",
        tier: "tier1",
        approval: "approved_full",
      }),
    ).toThrow(/Zorp.*(roster|marketer|editor)/i);
  });

  it("throws if a name is somehow in BOTH rosters (belt-and-braces on the disjointness invariant)", () => {
    collisionNames.add("Craig");
    try {
      expect(() =>
        awardAmountUsd({
          marketer: "Craig",
          tier: "tier1",
          approval: "approved_full",
        }),
      ).toThrow(/Craig.*both/i);
    } finally {
      collisionNames.delete("Craig");
    }
  });
});
