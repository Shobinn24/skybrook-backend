import { type FbMarketer } from "./fb-marketers";

// Bonus-eligible marketers — Nate and Scotty are excluded from bonus
// payouts per Jasper 2026-05-11. Order = display order in the Bonus
// Tracker tab.
export const BONUS_MARKETERS = [
  "Craig",
  "Raul",
  "Tyler",
  "Jacob",
  "Dan",
  "JW",
] as const satisfies ReadonlyArray<FbMarketer>;

export type BonusMarketer = (typeof BONUS_MARKETERS)[number];

const BONUS_SET: ReadonlySet<string> = new Set(BONUS_MARKETERS);

export function isBonusMarketer(name: string): name is BonusMarketer {
  return BONUS_SET.has(name);
}

// Lifetime-spend thresholds drive row coloring: ≥ TIER_2 → green,
// ≥ TIER_1 → orange, otherwise neutral. No bonus $ amounts surface
// in the UI per spec — only tier progress.
export const BONUS_TIER_1_USD = 13_000;
export const BONUS_TIER_2_USD = 65_000;

export type BonusTier = "none" | "tier1" | "tier2";

export function bonusTier(lifetimeSpendUsd: number): BonusTier {
  if (lifetimeSpendUsd >= BONUS_TIER_2_USD) return "tier2";
  if (lifetimeSpendUsd >= BONUS_TIER_1_USD) return "tier1";
  return "none";
}
