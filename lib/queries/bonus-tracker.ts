import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  bonusAwards,
  bonusNotificationBatches,
  fbAdSpendDaily,
} from "@/lib/db/schema";
import {
  BONUS_MARKETERS,
  type BonusMarketer,
  isAboveBonusFloor,
  isBonusMarketer,
} from "@/lib/domain/bonus-tiers";
import { toEstDate } from "@/lib/tz";

// Date-only arithmetic in UTC to avoid host-TZ drift (mirrors the
// helper pattern used in queries/performance.ts and sustainability-
// timeline.ts).
function addDays(ymd: string, days: number): string {
  const dt = new Date(`${ymd}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

export type BonusAwardStatus =
  | "pending"
  | "approved_full"
  | "approved_half"
  | "rejected";

export type BonusAwardTier = "tier1" | "tier2";

export type BonusAwardForRow = {
  id: string;
  tier: BonusAwardTier;
  status: BonusAwardStatus;
  amountUsd: number;
  crossedAt: string;
  approvedAt: string | null;
};

export type BonusAdRow = {
  adNumber: string;
  adName: string;
  adNameRaw: string;
  adLink: string | null;
  marketers: string[];
  lifetimeSpendUsd: number;
  // Rolling 7-day window: spend in [today-6, today] EST inclusive.
  past7dSpendUsd: number;
  // Per (ad × THIS section's marketer × tier) award. Null when no
  // crossing has been detected for that tier yet.
  awards: { tier1: BonusAwardForRow | null; tier2: BonusAwardForRow | null };
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
 * marketer the ad's `marketers` array contains. Each row carries its
 * (T1, T2) bonus_award status so the UI can color-by-approval rather
 * than auto-color by threshold (Jasper 2026-05-13).
 *
 * Sort within a section: lifetime spend descending.
 */
export async function getBonusTracker(): Promise<BonusTrackerResult> {
  // 7-day rolling window in EST: [today-6, today] inclusive. Same SQL
  // FILTER trick keeps it to a single scan, so cost is unchanged.
  const todayEst = toEstDate(new Date());
  const sevenDaysAgoEst = addDays(todayEst, -6);

  // Per-ad lifetime spend + 7d spend + marketers array.
  const adRows = await db
    .select({
      adNumber: fbAdSpendDaily.adNumber,
      adName: sql<string>`max(${fbAdSpendDaily.adName})`,
      adNameRaw: sql<string>`max(${fbAdSpendDaily.adNameRaw})`,
      adLink: sql<string | null>`max(${fbAdSpendDaily.adLink})`,
      marketers: sql<string[]>`min(${fbAdSpendDaily.marketers})`,
      lifetimeSpendUsd: sql<string>`coalesce(sum(${fbAdSpendDaily.costUsd}), 0)`,
      past7dSpendUsd: sql<string>`coalesce(sum(${fbAdSpendDaily.costUsd}) filter (where ${fbAdSpendDaily.spendDate} >= ${sevenDaysAgoEst}), 0)`,
    })
    .from(fbAdSpendDaily)
    .groupBy(fbAdSpendDaily.adNumber)
    .orderBy(desc(sql`sum(${fbAdSpendDaily.costUsd})`));

  // Per (ad × marketer × tier) award rows. Single query, indexed by
  // composite key in the Map.
  const awardRows = await db.select().from(bonusAwards);
  const awardByKey = new Map<string, BonusAwardForRow>();
  for (const a of awardRows) {
    awardByKey.set(`${a.adNumber}|${a.marketer}|${a.tier}`, {
      id: a.id,
      tier: a.tier,
      status: a.status,
      amountUsd: Number(a.amountUsd),
      crossedAt: a.crossedAt,
      approvedAt:
        a.approvedAt instanceof Date ? a.approvedAt.toISOString() : a.approvedAt,
    });
  }

  const sections: BonusTrackerSection[] = BONUS_MARKETERS.map((m) => ({
    marketer: m,
    rows: [] as BonusAdRow[],
  }));
  const sectionByMarketer = new Map(sections.map((s) => [s.marketer, s]));

  for (const r of adRows) {
    const adMarketers = r.marketers ?? [];
    if (adMarketers.length === 0) continue;
    for (const name of adMarketers) {
      const section = sectionByMarketer.get(name as BonusMarketer);
      if (!section) continue;
      if (!isAboveBonusFloor(name as BonusMarketer, r.adNumber)) continue;
      const row: BonusAdRow = {
        adNumber: r.adNumber,
        adName: r.adName,
        adNameRaw: r.adNameRaw,
        adLink: r.adLink,
        marketers: adMarketers,
        lifetimeSpendUsd: Number(r.lifetimeSpendUsd),
        past7dSpendUsd: Number(r.past7dSpendUsd),
        awards: {
          tier1: awardByKey.get(`${r.adNumber}|${name}|tier1`) ?? null,
          tier2: awardByKey.get(`${r.adNumber}|${name}|tier2`) ?? null,
        },
      };
      section.rows.push(row);
    }
  }

  return { sections };
}

export type PendingApproval = {
  awardId: string;
  adNumber: string;
  adName: string;
  adNameRaw: string;
  adLink: string | null;
  marketer: BonusMarketer;
  tier: BonusAwardTier;
  defaultAmountUsd: number;
  // Default amount if approved half (50% of full).
  halfAmountUsd: number;
  // Lifetime spend on this ad — context for the approver.
  lifetimeSpendUsd: number;
  crossedAt: string;
};

/**
 * Awards in `pending` status, enriched with ad metadata + current
 * lifetime spend so Jasper can review without leaving the page.
 *
 * Sort: crossed_at desc (newest first), then lifetime spend desc.
 *
 * Optional `marketer` filter scopes the queue to a single marketer
 * (Jasper 2026-05-20: each marketer's tab shows only their pending).
 */
export async function getPendingApprovals(opts?: {
  marketer?: BonusMarketer;
}): Promise<PendingApproval[]> {
  const whereClause = opts?.marketer
    ? and(
        eq(bonusAwards.status, "pending"),
        eq(bonusAwards.marketer, opts.marketer),
      )
    : eq(bonusAwards.status, "pending");

  const pending = await db
    .select()
    .from(bonusAwards)
    .where(whereClause)
    .orderBy(desc(bonusAwards.crossedAt));

  if (pending.length === 0) return [];

  const adNumbers = Array.from(new Set(pending.map((p) => p.adNumber)));

  // Per-ad metadata + lifetime spend in one shot.
  const meta = await db
    .select({
      adNumber: fbAdSpendDaily.adNumber,
      adName: sql<string>`max(${fbAdSpendDaily.adName})`,
      adNameRaw: sql<string>`max(${fbAdSpendDaily.adNameRaw})`,
      adLink: sql<string | null>`max(${fbAdSpendDaily.adLink})`,
      lifetimeSpendUsd: sql<string>`coalesce(sum(${fbAdSpendDaily.costUsd}), 0)`,
    })
    .from(fbAdSpendDaily)
    .where(inArray(fbAdSpendDaily.adNumber, adNumbers))
    .groupBy(fbAdSpendDaily.adNumber);

  const metaByAd = new Map(meta.map((m) => [m.adNumber, m]));

  return pending
    .map<PendingApproval | null>((p) => {
      if (!isBonusMarketer(p.marketer)) return null;
      if (!isAboveBonusFloor(p.marketer, p.adNumber)) return null;
      const m = metaByAd.get(p.adNumber);
      if (!m) return null;
      const full = Number(p.amountUsd);
      return {
        awardId: p.id,
        adNumber: p.adNumber,
        adName: m.adName,
        adNameRaw: m.adNameRaw,
        adLink: m.adLink,
        marketer: p.marketer,
        tier: p.tier,
        defaultAmountUsd: full,
        halfAmountUsd: full / 2,
        lifetimeSpendUsd: Number(m.lifetimeSpendUsd),
        crossedAt: p.crossedAt,
      };
    })
    .filter((r): r is PendingApproval => r !== null)
    // Sort: largest lifetime spend first within each crossing date.
    .sort(
      (a, b) =>
        b.crossedAt.localeCompare(a.crossedAt) ||
        b.lifetimeSpendUsd - a.lifetimeSpendUsd,
    );
}

export type NotificationAward = {
  marketer: BonusMarketer;
  tier: BonusAwardTier;
  status: "approved_full" | "approved_half";
  amountUsd: number;
  adNumber: string;
  adName: string;
  adLink: string | null;
};

export type NotificationPreview = {
  periodLabel: string;
  messageBody: string;
  // Per-award detail powers the rich WhatsApp message body
  // (Jasper 2026-05-20: ad name + link per award + per-marketer total).
  awards: NotificationAward[];
  // Per-marketer roll-up — kept for backward compat with
  // bonus_notification_batches.totals_json history records.
  totals: Array<{
    marketer: BonusMarketer;
    tier1FullCount: number;
    tier1HalfCount: number;
    tier2FullCount: number;
    tier2HalfCount: number;
    totalUsd: number;
  }>;
  awardIds: string[]; // awards that would be marked sent
  grandTotalUsd: number;
};

/**
 * Aggregate every `approved_full` / `approved_half` award that hasn't
 * been notified yet (`notification_batch_id IS NULL`) into the WhatsApp
 * message Jasper outlined in his April example. The same shape is used
 * both for preview (render-only) and for the actual send (which then
 * writes a `bonus_notification_batches` row and stamps the awards).
 */
export async function previewNotification(opts?: {
  periodLabel?: string;
}): Promise<NotificationPreview> {
  const periodLabel = opts?.periodLabel ?? defaultPeriodLabel();
  const unsent = await db
    .select()
    .from(bonusAwards)
    .where(
      and(
        sql`${bonusAwards.status} IN ('approved_full','approved_half')`,
        isNull(bonusAwards.notificationBatchId),
      ),
    );

  // Pull ad metadata (name + link) for every ad in the batch in one
  // query. Keyed by ad_number so we can hydrate each award.
  const adNumbersInBatch = Array.from(new Set(unsent.map((a) => a.adNumber)));
  const adMeta =
    adNumbersInBatch.length > 0
      ? await db
          .select({
            adNumber: fbAdSpendDaily.adNumber,
            adName: sql<string>`max(${fbAdSpendDaily.adName})`,
            adLink: sql<string | null>`max(${fbAdSpendDaily.adLink})`,
          })
          .from(fbAdSpendDaily)
          .where(inArray(fbAdSpendDaily.adNumber, adNumbersInBatch))
          .groupBy(fbAdSpendDaily.adNumber)
      : [];
  const metaByAd = new Map(adMeta.map((m) => [m.adNumber, m]));

  type Bucket = NotificationPreview["totals"][number];
  const byMarketer = new Map<BonusMarketer, Bucket>();
  for (const m of BONUS_MARKETERS) {
    byMarketer.set(m, {
      marketer: m,
      tier1FullCount: 0,
      tier1HalfCount: 0,
      tier2FullCount: 0,
      tier2HalfCount: 0,
      totalUsd: 0,
    });
  }

  const awards: NotificationAward[] = [];
  const awardIds: string[] = [];
  for (const a of unsent) {
    if (!isBonusMarketer(a.marketer)) continue;
    const bucket = byMarketer.get(a.marketer);
    if (!bucket) continue;
    if (a.status !== "approved_full" && a.status !== "approved_half") continue;
    const amount = Number(a.amountUsd);
    if (a.tier === "tier1") {
      if (a.status === "approved_half") bucket.tier1HalfCount++;
      else bucket.tier1FullCount++;
    } else {
      if (a.status === "approved_half") bucket.tier2HalfCount++;
      else bucket.tier2FullCount++;
    }
    bucket.totalUsd += amount;
    const meta = metaByAd.get(a.adNumber);
    awards.push({
      marketer: a.marketer,
      tier: a.tier,
      status: a.status,
      amountUsd: amount,
      adNumber: a.adNumber,
      adName: meta?.adName ?? `Ad ${a.adNumber}`,
      adLink: meta?.adLink ?? null,
    });
    awardIds.push(a.id);
  }

  const totals = Array.from(byMarketer.values());
  const grandTotalUsd = totals.reduce((s, t) => s + t.totalUsd, 0);
  const messageBody = renderNotificationMessage(periodLabel, awards);

  return {
    periodLabel,
    messageBody,
    awards,
    totals,
    awardIds,
    grandTotalUsd,
  };
}

/**
 * Render the WhatsApp message body: per-marketer total followed by an
 * itemized list of awards (tier + ad number + ad name + link).
 * Jasper 2026-05-20: "ad name + ad link for those hit".
 */
function renderNotificationMessage(
  periodLabel: string,
  awards: NotificationAward[],
): string {
  const lines: string[] = [`${periodLabel} Bonuses`, ""];
  if (awards.length === 0) {
    lines.push("(no approved bonuses this period)");
    return lines.join("\n").trimEnd();
  }
  // Preserve BONUS_MARKETERS roster order (Craig, Raul, Tyler, Jacob, Dan, JW).
  const byMarketer = new Map<BonusMarketer, NotificationAward[]>();
  for (const m of BONUS_MARKETERS) byMarketer.set(m, []);
  for (const a of awards) byMarketer.get(a.marketer)?.push(a);

  for (const marketer of BONUS_MARKETERS) {
    const list = byMarketer.get(marketer) ?? [];
    if (list.length === 0) continue;
    const total = list.reduce((s, a) => s + a.amountUsd, 0);
    lines.push(`${marketer} — Total: $${total.toLocaleString("en-US")}`);
    for (const a of list) {
      const tierLabel = a.tier === "tier1" ? "$13k" : "$65k";
      const halfMarker = a.status === "approved_half" ? " (half)" : "";
      lines.push(
        `• ${tierLabel}${halfMarker} · Ad ${a.adNumber} — ${a.adName}`,
      );
      if (a.adLink) lines.push(`  ${a.adLink}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

/** Default period label = the month that just ended (so Jasper's
 *  Apr-bonus message goes out in early May). */
function defaultPeriodLabel(): string {
  const now = new Date();
  // Last day of previous month
  const lastDayPrevMonth = new Date(now.getFullYear(), now.getMonth(), 0);
  return lastDayPrevMonth.toLocaleString("en-US", {
    month: "long",
    year: "numeric",
  });
}

export type NotificationHistoryRow = {
  id: string;
  periodLabel: string;
  messageBody: string;
  sentAt: string;
  sentBy: string;
  whatsappStatus: string | null;
  grandTotalUsd: number;
};

export async function getNotificationHistory(): Promise<NotificationHistoryRow[]> {
  const rows = await db
    .select()
    .from(bonusNotificationBatches)
    .orderBy(desc(bonusNotificationBatches.sentAt));

  return rows.map((r) => {
    const totals = (r.totalsJson as { totalUsd: number }[]) ?? [];
    const grand = totals.reduce((s, t) => s + (t.totalUsd ?? 0), 0);
    return {
      id: r.id,
      periodLabel: r.periodLabel,
      messageBody: r.messageBody,
      sentAt: r.sentAt instanceof Date ? r.sentAt.toISOString() : String(r.sentAt),
      sentBy: r.sentBy,
      whatsappStatus: r.whatsappStatus,
      grandTotalUsd: grand,
    };
  });
}

export type BonusSummaryRow = {
  marketer: BonusMarketer;
  // Map of "YYYY-MM" → total approved bonus amount sent that month.
  cells: Record<string, number>;
  total: number;
};

export type BonusSummary = {
  // Months that have any sent batch — sorted DESC (newest first).
  months: string[];
  rows: BonusSummaryRow[];
  // Column totals (per month).
  monthTotals: Record<string, number>;
  grandTotal: number;
};

/**
 * Scoreboard view (Jasper 2026-05-20): bonus paid per month per marketer.
 * Reads from `bonus_awards` joined to `bonus_notification_batches` —
 * unsent approved awards are intentionally excluded; only what has
 * actually been notified counts on the scoreboard.
 *
 * Returns one row per marketer in roster order, with cells keyed by
 * "YYYY-MM" derived from the batch's `sent_at` in EST.
 */
export async function getBonusSummary(): Promise<BonusSummary> {
  // Aggregate amounts at (marketer × YYYY-MM) granularity. EST month
  // bucket matches the FB ad-spend day boundary used elsewhere.
  const rows = await db
    .select({
      marketer: bonusAwards.marketer,
      month: sql<string>`to_char(${bonusNotificationBatches.sentAt} at time zone 'America/New_York', 'YYYY-MM')`,
      totalUsd: sql<string>`sum(${bonusAwards.amountUsd})`,
    })
    .from(bonusAwards)
    .innerJoin(
      bonusNotificationBatches,
      eq(bonusAwards.notificationBatchId, bonusNotificationBatches.id),
    )
    .where(sql`${bonusAwards.status} IN ('approved_full','approved_half')`)
    .groupBy(
      bonusAwards.marketer,
      sql`to_char(${bonusNotificationBatches.sentAt} at time zone 'America/New_York', 'YYYY-MM')`,
    );

  const monthSet = new Set<string>();
  const cellByMarketer = new Map<BonusMarketer, Record<string, number>>();
  for (const m of BONUS_MARKETERS) cellByMarketer.set(m, {});

  for (const r of rows) {
    if (!isBonusMarketer(r.marketer)) continue;
    monthSet.add(r.month);
    const cells = cellByMarketer.get(r.marketer)!;
    cells[r.month] = (cells[r.month] ?? 0) + Number(r.totalUsd);
  }

  const months = Array.from(monthSet).sort().reverse();

  const monthTotals: Record<string, number> = {};
  for (const month of months) monthTotals[month] = 0;

  const resultRows: BonusSummaryRow[] = BONUS_MARKETERS.map((marketer) => {
    const cells = cellByMarketer.get(marketer)!;
    let total = 0;
    for (const month of months) {
      const v = cells[month] ?? 0;
      total += v;
      monthTotals[month] += v;
    }
    return { marketer, cells, total };
  });

  const grandTotal = Object.values(monthTotals).reduce((s, v) => s + v, 0);

  return { months, rows: resultRows, monthTotals, grandTotal };
}
