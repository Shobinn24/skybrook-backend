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
} from "@/lib/domain/bonus-tiers";

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
  // Per-ad lifetime spend + marketers array.
  const adRows = await db
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
      const row: BonusAdRow = {
        adNumber: r.adNumber,
        adName: r.adName,
        adNameRaw: r.adNameRaw,
        adLink: r.adLink,
        marketers: adMarketers,
        lifetimeSpendUsd: Number(r.lifetimeSpendUsd),
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
 */
export async function getPendingApprovals(): Promise<PendingApproval[]> {
  const pending = await db
    .select()
    .from(bonusAwards)
    .where(eq(bonusAwards.status, "pending"))
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
      const m = metaByAd.get(p.adNumber);
      if (!m) return null;
      const full = Number(p.amountUsd);
      return {
        awardId: p.id,
        adNumber: p.adNumber,
        adName: m.adName,
        adNameRaw: m.adNameRaw,
        adLink: m.adLink,
        marketer: p.marketer as BonusMarketer,
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

export type NotificationPreview = {
  periodLabel: string;
  messageBody: string;
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

  const awardIds: string[] = [];
  for (const a of unsent) {
    const bucket = byMarketer.get(a.marketer as BonusMarketer);
    if (!bucket) continue;
    const amount = Number(a.amountUsd);
    if (a.tier === "tier1") {
      if (a.status === "approved_half") bucket.tier1HalfCount++;
      else bucket.tier1FullCount++;
    } else {
      if (a.status === "approved_half") bucket.tier2HalfCount++;
      else bucket.tier2FullCount++;
    }
    bucket.totalUsd += amount;
    awardIds.push(a.id);
  }

  const totals = Array.from(byMarketer.values());
  const grandTotalUsd = totals.reduce((s, t) => s + t.totalUsd, 0);
  const messageBody = renderNotificationMessage(periodLabel, totals);

  return { periodLabel, messageBody, totals, awardIds, grandTotalUsd };
}

/** Render the WhatsApp message body in Jasper's April-example format. */
function renderNotificationMessage(
  periodLabel: string,
  totals: NotificationPreview["totals"],
): string {
  const lines: string[] = [`${periodLabel} Bonuses`, ""];
  for (const t of totals) {
    lines.push(t.marketer);
    if (t.tier1FullCount > 0) lines.push(`${t.tier1FullCount}x 13k bonus`);
    if (t.tier1HalfCount > 0)
      lines.push(`${t.tier1HalfCount}x 13k 50% bonus`);
    if (t.tier2FullCount > 0) lines.push(`${t.tier2FullCount}x 65k bonus`);
    if (t.tier2HalfCount > 0)
      lines.push(`${t.tier2HalfCount}x 65k 50% bonus`);
    lines.push(`Total: $${t.totalUsd.toLocaleString("en-US")}`);
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
