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

// Per-marketer hard floor on ad numbers — ads below this are excluded
// from BOTH display AND crossing detection (Scott 2026-05-20). Earlier
// ads under these marketers' names were either mis-attributed or
// pre-date the bonus program. Existing approved/rejected rows stay for
// history; only pending rows below the floor get cleaned up.
export const BONUS_AD_FLOOR = {
  Craig: 0,
  Raul: 0,
  Tyler: 0,
  Jacob: 1896,
  Dan: 1944,
  JW: 1907,
} as const satisfies Record<BonusMarketer, number>;

// `adNumber` is stored as text in fb_ad_spend_daily; parseInt with a
// NaN guard treats malformed values as below-floor (excluded).
export function isAboveBonusFloor(
  marketer: BonusMarketer,
  adNumber: string,
): boolean {
  const n = parseInt(adNumber, 10);
  if (Number.isNaN(n)) return false;
  return n >= BONUS_AD_FLOOR[marketer];
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

/**
 * The spend_date on which an ad's CUMULATIVE spend first reaches `threshold`,
 * or null if it never does. This is the true bonus-crossing date — the day the
 * ad actually earned the tier — which must drive the payout month so a
 * crossing that lands late-month but only settles in FB the next month is
 * still attributed to the month it happened (e.g. ad 1901 crossed $13k on
 * 2026-05-30 but FB didn't settle that spend until 2026-06-02). Stamping the
 * detection date instead would mis-pay it as the following month's bonus.
 *
 * Sorts by date internally so callers needn't pre-order. Crossing is `>=`
 * (an exact-threshold cumulative counts).
 */
export function firstCrossingDate(
  dailySpend: ReadonlyArray<{ spendDate: string; costUsd: number }>,
  threshold: number,
): string | null {
  const sorted = [...dailySpend].sort((a, b) =>
    a.spendDate.localeCompare(b.spendDate),
  );
  let cumulative = 0;
  for (const day of sorted) {
    cumulative += day.costUsd;
    if (cumulative >= threshold) return day.spendDate;
  }
  return null;
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
