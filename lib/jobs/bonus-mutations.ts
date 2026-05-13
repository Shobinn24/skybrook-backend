import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { bonusAwards, bonusNotificationBatches } from "@/lib/db/schema";
import {
  type BonusMarketer,
  bonusAmountUsd,
} from "@/lib/domain/bonus-tiers";
import { previewNotification } from "@/lib/queries/bonus-tracker";
import { logger } from "@/lib/logger";

export type ApproveBonusOpts = {
  awardId: string;
  approval: "approved_full" | "approved_half";
  approvedBy: string;
  notes?: string;
};

/**
 * Approve a pending bonus award. Re-computes the frozen amount from the
 * canonical bonus rate × half modifier so a stale UI value can't ship a
 * wrong payout. Only pending awards can be approved — already-approved
 * or rejected rows are no-ops (idempotent).
 */
export async function approveBonus(opts: ApproveBonusOpts): Promise<{
  updated: boolean;
  awardId: string;
}> {
  const [current] = await db
    .select()
    .from(bonusAwards)
    .where(eq(bonusAwards.id, opts.awardId))
    .limit(1);

  if (!current) {
    throw new Error(`bonus_award not found: ${opts.awardId}`);
  }
  if (current.status !== "pending") {
    return { updated: false, awardId: opts.awardId };
  }

  const amount = bonusAmountUsd({
    marketer: current.marketer as BonusMarketer,
    tier: current.tier,
    approval: opts.approval,
  });

  await db
    .update(bonusAwards)
    .set({
      status: opts.approval,
      amountUsd: amount.toFixed(2),
      approvedAt: new Date(),
      approvedBy: opts.approvedBy,
      notes: opts.notes ?? null,
      updatedAt: new Date(),
    })
    .where(eq(bonusAwards.id, opts.awardId));

  logger.info("bonus.approve", {
    awardId: opts.awardId,
    approval: opts.approval,
    marketer: current.marketer,
    tier: current.tier,
    amount,
    approvedBy: opts.approvedBy,
  });
  return { updated: true, awardId: opts.awardId };
}

/** Mark a pending or approved bonus as rejected — won't appear in the
 * notification preview, won't be paid. */
export async function rejectBonus(opts: {
  awardId: string;
  approvedBy: string;
  notes?: string;
}): Promise<{ updated: boolean; awardId: string }> {
  const [current] = await db
    .select()
    .from(bonusAwards)
    .where(eq(bonusAwards.id, opts.awardId))
    .limit(1);

  if (!current) {
    throw new Error(`bonus_award not found: ${opts.awardId}`);
  }
  if (current.notificationBatchId) {
    throw new Error(
      `bonus_award already shipped in notification ${current.notificationBatchId} — cannot reject`,
    );
  }

  await db
    .update(bonusAwards)
    .set({
      status: "rejected",
      approvedAt: new Date(),
      approvedBy: opts.approvedBy,
      notes: opts.notes ?? null,
      updatedAt: new Date(),
    })
    .where(eq(bonusAwards.id, opts.awardId));

  logger.info("bonus.reject", {
    awardId: opts.awardId,
    approvedBy: opts.approvedBy,
  });
  return { updated: true, awardId: opts.awardId };
}

/**
 * One-click triage for historical backlog: flip every still-pending
 * award to `approved_full`. Use case: bulk-process the crossings that
 * pre-date the approval workflow (~50+ rows on first ingest after
 * Phase B deploy). Subsequent days' crossings are small (~0-3/day) so
 * Jasper reviews per-ad after this initial run.
 */
export async function bulkApprovePending(opts: {
  approvedBy: string;
}): Promise<{ updatedCount: number }> {
  const pending = await db
    .select({ id: bonusAwards.id, marketer: bonusAwards.marketer, tier: bonusAwards.tier })
    .from(bonusAwards)
    .where(eq(bonusAwards.status, "pending"));

  if (pending.length === 0) return { updatedCount: 0 };

  // Per-row updates — each row gets the right approval-full amount
  // for its (marketer, tier). Single SQL with CASE would be faster
  // but at the scale we expect (≤100 rows during the one-time
  // backfill), per-row is simpler and easier to audit.
  for (const p of pending) {
    const amount = bonusAmountUsd({
      marketer: p.marketer as BonusMarketer,
      tier: p.tier,
      approval: "approved_full",
    });
    await db
      .update(bonusAwards)
      .set({
        status: "approved_full",
        amountUsd: amount.toFixed(2),
        approvedAt: new Date(),
        approvedBy: opts.approvedBy,
        updatedAt: new Date(),
      })
      .where(eq(bonusAwards.id, p.id));
  }

  logger.info("bonus.bulk_approve", {
    updatedCount: pending.length,
    approvedBy: opts.approvedBy,
  });
  return { updatedCount: pending.length };
}

/**
 * Materialize an unsent approved-bonus batch into a
 * `bonus_notification_batches` row + stamp the awards with the new
 * batch_id. Optionally fires the message to WhatsApp via the whatsapp-mcp
 * channel — when MCP isn't reachable, we still persist the batch and
 * record `whatsapp_status='failed:<reason>'` so the operator can resend.
 *
 * Idempotency: if there are no unsent approved awards, returns
 * `{ skipped: true }` without creating an empty batch.
 */
export async function sendNotification(opts: {
  sentBy: string;
  periodLabel?: string;
  /** Optional override for the actual sender. Defaults to the no-op
   * stub so backend cron / preview paths don't hit the network. */
  sendWhatsApp?: (body: string) => Promise<{ ok: boolean; reason?: string }>;
}): Promise<
  | { skipped: true; reason: string }
  | { skipped: false; batchId: string; messageBody: string; awardCount: number; whatsappStatus: string }
> {
  const preview = await previewNotification({ periodLabel: opts.periodLabel });
  if (preview.awardIds.length === 0) {
    return { skipped: true, reason: "no unsent approved bonuses" };
  }

  const send = opts.sendWhatsApp ?? (async () => ({ ok: false, reason: "no whatsapp sender configured" }));
  const whatsappResult = await send(preview.messageBody);
  const whatsappStatus = whatsappResult.ok
    ? "sent"
    : `failed:${whatsappResult.reason ?? "unknown"}`;

  // Insert the batch and stamp the awards in a single transaction so
  // an empty batch can't get created if the award update fails.
  const batchId = await db.transaction(async (tx) => {
    const [batch] = await tx
      .insert(bonusNotificationBatches)
      .values({
        periodLabel: preview.periodLabel,
        messageBody: preview.messageBody,
        totalsJson: preview.totals,
        sentBy: opts.sentBy,
        whatsappStatus,
      })
      .returning({ id: bonusNotificationBatches.id });

    await tx
      .update(bonusAwards)
      .set({ notificationBatchId: batch.id, updatedAt: new Date() })
      .where(
        and(
          inArray(bonusAwards.id, preview.awardIds),
          // Re-check the unsent condition inside the tx so racing
          // concurrent sends don't double-stamp.
          sql`${bonusAwards.notificationBatchId} IS NULL`,
        ),
      );

    return batch.id;
  });

  logger.info("bonus.notification.sent", {
    batchId,
    awardCount: preview.awardIds.length,
    periodLabel: preview.periodLabel,
    sentBy: opts.sentBy,
    whatsappStatus,
    grandTotalUsd: preview.grandTotalUsd,
  });

  return {
    skipped: false,
    batchId,
    messageBody: preview.messageBody,
    awardCount: preview.awardIds.length,
    whatsappStatus,
  };
}
