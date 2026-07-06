// Campaign -> tracker-bucket mapping for the /campaign-tracker page.
//
// The ops team tracks a deliberate SUBSET of FB campaigns as named buckets;
// every bucket is one literal campaign (verified 2026-07-06 against their
// hand-built sheet: daily spend exact to the cent and ROAS to 4 decimals on
// settled days, plus Ads Manager lifetime checksums within 0.012%). The
// Zombie bucket is the US zombie campaign ONLY — "Zombie Campaign INTL" is
// excluded (verified across 14 days).
//
// fb_campaign_daily ingests EVERY campaign verbatim, so adding a bucket (or
// splitting one) is a config change here — no re-pull, history included.
// US/INTL Total columns are derived: spend sums, ROAS spend-weighted
// (sum(value)/sum(spend)), matching how the operator's sheet computes them.

export type CampaignBucket = {
  /** Stable key used in query output + UI. */
  key: string;
  /** Column label, matching the operator's sheet. */
  label: string;
  /** Exact FB campaign name this bucket tracks. */
  campaignName: string;
  /** Which derived total column this bucket rolls into, if any. */
  totalGroup: "US" | "INTL" | null;
};

export const CAMPAIGN_BUCKETS: readonly CampaignBucket[] = [
  { key: "us_cc", label: "US CC", campaignName: "Cost Cap Campaign", totalGroup: "US" },
  { key: "us_bau", label: "US BAU", campaignName: "US BAU CBO IA Campaign", totalGroup: "US" },
  { key: "intl_cc", label: "INTL CC", campaignName: "INTL Cost Cap Campaign", totalGroup: "INTL" },
  { key: "intl_bau", label: "INTL BAU", campaignName: "INTL BAU CBO IA Campaign", totalGroup: "INTL" },
  { key: "cc_cbo", label: "CC CBO", campaignName: "CC CBO Testing Campaign", totalGroup: null },
  { key: "partnership", label: "Partnership", campaignName: "Partnership Campaign", totalGroup: null },
  { key: "zombie", label: "Zombie", campaignName: "Zombie Campaign US", totalGroup: null },
];

const BY_CAMPAIGN = new Map(CAMPAIGN_BUCKETS.map((b) => [b.campaignName, b]));

/** The bucket a campaign belongs to, or null when untracked. */
export function bucketForCampaign(campaignName: string): CampaignBucket | null {
  return BY_CAMPAIGN.get(campaignName.trim()) ?? null;
}
