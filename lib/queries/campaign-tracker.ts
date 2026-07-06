import { gte, max, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { campaignTrackerNotes, fbCampaignDaily } from "@/lib/db/schema";
import { CAMPAIGN_BUCKETS } from "@/lib/domain/campaign-buckets";

// /campaign-tracker rollup — mirrors the operator's hand-built sheet:
// day rows grouped into Mon–Sun weeks, one cell per tracked bucket
// (1D spend + derived ROAS), weekly (7D) Mon–Sun aggregates with
// spend-weighted ROAS, and derived US/INTL Total columns (CC + BAU per
// region). All conventions verified against the operator's sheet
// 2026-07-06: totals are plain sums; every ROAS = sum(value)/sum(spend),
// never an average of ratios. Weeks/days ascend chronologically (their
// sheet's layout). Tracking starts 2026-05-11 per the ops request.
export const CAMPAIGN_TRACKER_START = "2026-05-11";

export type CampaignTrackerCell = {
  spendUsd: number;
  purchaseValueUsd: number;
  /** null when spend is 0 — no meaningful ROAS. */
  roas: number | null;
};

export type CampaignTrackerDay = {
  date: string;
  buckets: Record<string, CampaignTrackerCell>;
  usTotal: CampaignTrackerCell;
  intlTotal: CampaignTrackerCell;
};

export type CampaignTrackerWeek = {
  /** Monday, YYYY-MM-DD. */
  weekStart: string;
  days: CampaignTrackerDay[];
  weekly: {
    buckets: Record<string, CampaignTrackerCell>;
    usTotal: CampaignTrackerCell;
    intlTotal: CampaignTrackerCell;
  };
  note: string | null;
};

export type CampaignTrackerResult = {
  weeks: CampaignTrackerWeek[];
  /** Max ingested spend_date, or null when nothing is ingested yet. */
  asOfDate: string | null;
};

function emptyCell(): { spendUsd: number; purchaseValueUsd: number } {
  return { spendUsd: 0, purchaseValueUsd: 0 };
}

function toCell(acc: { spendUsd: number; purchaseValueUsd: number }): CampaignTrackerCell {
  const spendUsd = round2(acc.spendUsd);
  const purchaseValueUsd = round2(acc.purchaseValueUsd);
  return {
    spendUsd,
    purchaseValueUsd,
    roas: spendUsd > 0 ? acc.purchaseValueUsd / acc.spendUsd : null,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Monday of the ISO week containing `date` (YYYY-MM-DD, UTC math). */
function mondayOf(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const dow = d.getUTCDay(); // 0=Sun
  d.setUTCDate(d.getUTCDate() - ((dow + 6) % 7));
  return d.toISOString().slice(0, 10);
}

function nextDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export async function getCampaignTracker(opts?: {
  startDate?: string;
}): Promise<CampaignTrackerResult> {
  const startDate = opts?.startDate ?? CAMPAIGN_TRACKER_START;

  const [maxRow] = await db
    .select({ max: max(fbCampaignDaily.spendDate) })
    .from(fbCampaignDaily);
  const asOfDate = maxRow?.max ?? null;
  if (asOfDate === null || asOfDate < startDate) return { weeks: [], asOfDate: null };

  const rows = await db
    .select({
      campaignName: fbCampaignDaily.campaignName,
      spendDate: fbCampaignDaily.spendDate,
      costUsd: fbCampaignDaily.costUsd,
      purchaseValueUsd: fbCampaignDaily.purchaseValueUsd,
    })
    .from(fbCampaignDaily)
    .where(gte(fbCampaignDaily.spendDate, startDate));

  const notes = await db
    .select({ weekStart: campaignTrackerNotes.weekStart, note: campaignTrackerNotes.note })
    .from(campaignTrackerNotes);
  const noteByWeek = new Map(notes.map((n) => [n.weekStart, n.note]));

  const bucketByCampaign = new Map(CAMPAIGN_BUCKETS.map((b) => [b.campaignName, b]));

  // (date, bucketKey) -> accumulated spend/value for tracked campaigns only.
  const perDay = new Map<string, Map<string, { spendUsd: number; purchaseValueUsd: number }>>();
  for (const r of rows) {
    const bucket = bucketByCampaign.get(r.campaignName);
    if (!bucket) continue;
    let day = perDay.get(r.spendDate);
    if (!day) {
      day = new Map();
      perDay.set(r.spendDate, day);
    }
    const acc = day.get(bucket.key) ?? emptyCell();
    acc.spendUsd += Number(r.costUsd);
    acc.purchaseValueUsd += Number(r.purchaseValueUsd);
    day.set(bucket.key, acc);
  }

  // Walk every calendar day startDate..asOfDate so gaps render as zero rows.
  const weeks: CampaignTrackerWeek[] = [];
  let current: CampaignTrackerWeek | null = null;
  // weekly accumulators (raw sums; converted to cells when the week closes)
  let weeklyAcc: Map<string, { spendUsd: number; purchaseValueUsd: number }> = new Map();

  const closeWeek = () => {
    if (!current) return;
    const buckets: Record<string, CampaignTrackerCell> = {};
    const us = emptyCell();
    const intl = emptyCell();
    for (const b of CAMPAIGN_BUCKETS) {
      const acc = weeklyAcc.get(b.key) ?? emptyCell();
      buckets[b.key] = toCell(acc);
      if (b.totalGroup === "US") {
        us.spendUsd += acc.spendUsd;
        us.purchaseValueUsd += acc.purchaseValueUsd;
      } else if (b.totalGroup === "INTL") {
        intl.spendUsd += acc.spendUsd;
        intl.purchaseValueUsd += acc.purchaseValueUsd;
      }
    }
    current.weekly = { buckets, usTotal: toCell(us), intlTotal: toCell(intl) };
    weeks.push(current);
    current = null;
  };

  for (let date = startDate; date <= asOfDate; date = nextDay(date)) {
    const weekStart = mondayOf(date);
    if (!current || current.weekStart !== weekStart) {
      closeWeek();
      current = {
        weekStart,
        days: [],
        weekly: { buckets: {}, usTotal: toCell(emptyCell()), intlTotal: toCell(emptyCell()) },
        note: noteByWeek.get(weekStart) ?? null,
      };
      weeklyAcc = new Map();
    }
    const dayAcc = perDay.get(date);
    const buckets: Record<string, CampaignTrackerCell> = {};
    const us = emptyCell();
    const intl = emptyCell();
    for (const b of CAMPAIGN_BUCKETS) {
      const acc = dayAcc?.get(b.key) ?? emptyCell();
      buckets[b.key] = toCell(acc);
      const wk = weeklyAcc.get(b.key) ?? emptyCell();
      wk.spendUsd += acc.spendUsd;
      wk.purchaseValueUsd += acc.purchaseValueUsd;
      weeklyAcc.set(b.key, wk);
      if (b.totalGroup === "US") {
        us.spendUsd += acc.spendUsd;
        us.purchaseValueUsd += acc.purchaseValueUsd;
      } else if (b.totalGroup === "INTL") {
        intl.spendUsd += acc.spendUsd;
        intl.purchaseValueUsd += acc.purchaseValueUsd;
      }
    }
    current.days.push({ date, buckets, usTotal: toCell(us), intlTotal: toCell(intl) });
  }
  closeWeek();

  return { weeks, asOfDate };
}

/**
 * Insert-or-update the free-text weekly note. weekStart must be a Monday —
 * the UI derives it from the week row, so anything else is a caller bug.
 */
export async function upsertCampaignTrackerNote(input: {
  weekStart: string;
  note: string;
  updatedBy: string;
}): Promise<void> {
  if (mondayOf(input.weekStart) !== input.weekStart) {
    throw new Error(`weekStart must be a Monday, got ${input.weekStart}`);
  }
  await db
    .insert(campaignTrackerNotes)
    .values({ weekStart: input.weekStart, note: input.note, updatedBy: input.updatedBy })
    .onConflictDoUpdate({
      target: campaignTrackerNotes.weekStart,
      set: {
        note: input.note,
        updatedBy: input.updatedBy,
        updatedAt: sql`now()`,
      },
    });
}
