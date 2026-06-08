export type ChannelKey = "ev" | "jm" | "ewc";

export interface ChannelAssumption {
  revenueStart: number;
  weeklyGrowth: number;
  netMargin: number;
}

export interface CashflowAssumptions {
  ev: ChannelAssumption;
  jm: ChannelAssumption;
  ewc: ChannelAssumption;
  cogsPct: number;
  profitPayoutPct: number;
  varianceThresholdUsd: number;
}

const CHANNELS: ChannelKey[] = ["ev", "jm", "ewc"];

/** revenue_start × weekly_growth^weekIndex (weekIndex 0 = first week). */
export function projectRevenue(a: ChannelAssumption, weekIndex: number): number {
  return a.revenueStart * Math.pow(a.weeklyGrowth, weekIndex);
}

/** Σ over channels of projected revenue × net margin. */
export function netProfit(a: CashflowAssumptions, weekIndex: number): number {
  return CHANNELS.reduce(
    (sum, k) => sum + projectRevenue(a[k], weekIndex) * a[k].netMargin,
    0,
  );
}

export function totalRevenue(a: CashflowAssumptions, weekIndex: number): number {
  return CHANNELS.reduce((sum, k) => sum + projectRevenue(a[k], weekIndex), 0);
}

/** COGS add-back = cogsPct × total revenue (paid via bulk orders, not weekly). */
export function cogs(a: CashflowAssumptions, weekIndex: number): number {
  return a.cogsPct * totalRevenue(a, weekIndex);
}

/** "Total Cashflow from Stores" = Net Profit + COGS (reference-sheet convention). */
export function cashflowFromStores(a: CashflowAssumptions, weekIndex: number): number {
  return netProfit(a, weekIndex) + cogs(a, weekIndex);
}

/** Profit payout: skip wins, then override, else pct × net profit. */
export function profitPayout(
  netProfitUsd: number,
  opts: { payoutPct: number; overrideUsd?: number | null; skipped?: boolean },
): number {
  if (opts.skipped) return 0;
  if (opts.overrideUsd != null) return opts.overrideUsd;
  return opts.payoutPct * netProfitUsd;
}

export function endingCash(beginning: number, cashIn: number, cashOut: number): number {
  return beginning + cashIn - cashOut;
}

/** actual − forecast (positive = ended with more cash than forecast). */
export function variance(actualEnding: number, forecastEnding: number): number {
  return actualEnding - forecastEnding;
}

export function isVarianceSignificant(varianceUsd: number, thresholdUsd: number): boolean {
  return Math.abs(varianceUsd) > thresholdUsd;
}
