import { desc, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { fbAdSpendDaily } from "@/lib/db/schema";
import {
  BONUS_MARKETERS,
  type BonusMarketer,
} from "@/lib/domain/bonus-tiers";

export type BonusAdRow = {
  adNumber: string;
  adName: string;
  adNameRaw: string;
  adLink: string | null;
  marketers: string[];
  lifetimeSpendUsd: number;
};

export type BonusTrackerSection = {
  marketer: BonusMarketer;
  rows: BonusAdRow[];
};

export type BonusTrackerResult = {
  sections: BonusTrackerSection[];
};

/**
 * Lifetime FB ad spend grouped by ad, bucketed under each bonus-eligible
 * marketer the ad's `marketers` array contains. Spend is summed across
 * the entire `fb_ad_spend_daily` table — no date filter. Ads that match
 * multiple bonus marketers appear in each of their sections (per Jasper:
 * each marketer gets credit for the full ad spend in their bonus view).
 *
 * Sort within a section: lifetime spend descending.
 */
export async function getBonusTracker(): Promise<BonusTrackerResult> {
  const result = await db
    .select({
      adNumber: fbAdSpendDaily.adNumber,
      adName: sql<string>`max(${fbAdSpendDaily.adName})`,
      adNameRaw: sql<string>`max(${fbAdSpendDaily.adNameRaw})`,
      adLink: sql<string | null>`max(${fbAdSpendDaily.adLink})`,
      marketers: sql<string[]>`min(${fbAdSpendDaily.marketers})`,
      lifetimeSpendUsd: sql<string>`coalesce(sum(${fbAdSpendDaily.costUsd}), 0)`,
    })
    .from(fbAdSpendDaily)
    .groupBy(fbAdSpendDaily.adNumber)
    .orderBy(desc(sql`sum(${fbAdSpendDaily.costUsd})`));

  const sections: BonusTrackerSection[] = BONUS_MARKETERS.map((m) => ({
    marketer: m,
    rows: [] as BonusAdRow[],
  }));
  const sectionByMarketer = new Map(sections.map((s) => [s.marketer, s]));

  for (const r of result) {
    const adMarketers = r.marketers ?? [];
    if (adMarketers.length === 0) continue;
    const row: BonusAdRow = {
      adNumber: r.adNumber,
      adName: r.adName,
      adNameRaw: r.adNameRaw,
      adLink: r.adLink,
      marketers: adMarketers,
      lifetimeSpendUsd: Number(r.lifetimeSpendUsd),
    };
    for (const name of adMarketers) {
      const section = sectionByMarketer.get(name as BonusMarketer);
      if (section) section.rows.push(row);
    }
  }

  return { sections };
}
