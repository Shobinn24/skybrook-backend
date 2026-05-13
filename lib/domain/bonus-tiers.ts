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

// Main marketers earn the full bonus rate; secondary marketers earn
// half (Jasper 2026-05-13). 50%-rehook bonuses use the half-of-main
// rate, applied via the `approved_half` status — the status itself
// encodes the modifier so the audit trail reads cleanly.
const MAIN_MARKETERS: ReadonlySet<BonusMarketer> = new Set([
  "Craig",
  "Raul",
  "Tyler",
]);

export type BonusCategory = "main" | "secondary";

export function bonusCategory(marketer: BonusMarketer): BonusCategory {
  return MAIN_MARKETERS.has(marketer) ? "main" : "secondary";
}

// Concrete dollar amounts for each (category, tier, approval-state).
// Frozen into bonus_awards.amount_usd at approval time so the ledger
// stays correct even if rates change later.
const BONUS_RATES: Record<BonusCategory, Record<"tier1" | "tier2", number>> = {
  main: { tier1: 500, tier2: 3000 },
  secondary: { tier1: 250, tier2: 1500 },
};

export type BonusApproval = "approved_full" | "approved_half";

export function bonusAmountUsd(opts: {
  marketer: BonusMarketer;
  tier: "tier1" | "tier2";
  approval: BonusApproval;
}): number {
  const base = BONUS_RATES[bonusCategory(opts.marketer)][opts.tier];
  return opts.approval === "approved_half" ? base / 2 : base;
}

// When seeding a fresh `bonus_awards` row before approval, pre-stage
// the full amount so the pending queue can show "default $X" to
// Jasper. The frozen amount is rewritten at the actual approval moment
// based on the chosen status.
export function bonusAmountAtFullUsd(opts: {
  marketer: BonusMarketer;
  tier: "tier1" | "tier2";
}): number {
  return BONUS_RATES[bonusCategory(opts.marketer)][opts.tier];
}
