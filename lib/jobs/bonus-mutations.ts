import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { bonusAwards, bonusNotificationBatches } from "@/lib/db/schema";
import {
  bonusAmountUsd,
  isBonusMarketer,
} from "@/lib/domain/bonus-tiers";
import {
  isVideoEditor,
  videoEditorBonusAmountUsd,
} from "@/lib/domain/video-editors";
import { previewNotification } from "@/lib/queries/bonus-tracker";
import { logger } from "@/lib/logger";

/** Thrown inside the claim transaction when another send already
 * stamped one of the previewed awards — rolls the whole claim back. */
class ConcurrentSendError extends Error {}

/** Canonical frozen amount for an award row. `bonus_awards.marketer` is
 * free-text and holds either a marketer name or a video-editor display
 * name (the two rosters are disjoint — unit-tested in
 * video-editors.test.ts). Editors use the flat \$200/\$800 rates; the
 * marketer path is unchanged.
 *
 * Fail-LOUD on anything else: award rows only ever come from the two
 * crossing detectors, so a name in neither roster means a hand-inserted
 * or corrupted row — investigate it, don't pay it. (Previously such a
 * name silently fell through to secondary marketer rates.) A name in
 * BOTH rosters is impossible while the disjointness invariant holds;
 * this guard is the belt-and-braces that screams the day it doesn't.
 * Exported for unit tests. */
export function awardAmountUsd(opts: {
  marketer: string;
  tier: "tier1" | "tier2";
  approval: "approved_full" | "approved_half";
}): number {
  if (isVideoEditor(opts.marketer) && isBonusMarketer(opts.marketer)) {
    throw new Error(
      `bonus award name "${opts.marketer}" is in BOTH the video-editor and marketer rosters — ` +
        `the rosters must stay disjoint (see video-editors.test.ts); refusing to price it`,
    );
  }
  if (isVideoEditor(opts.marketer)) {
    return videoEditorBonusAmountUsd({
      tier: opts.tier,
      approval: opts.approval,
    });
  }
  if (isBonusMarketer(opts.marketer)) {
    return bonusAmountUsd({
      marketer: opts.marketer,
      tier: opts.tier,
      approval: opts.approval,
    });
  }
  throw new Error(
    `bonus award name "${opts.marketer}" is in neither the marketer nor the video-editor roster — ` +
      `refusing to price it (award rows should only come from the crossing detectors)`,
  );
}

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

  const amount = awardAmountUsd({
    marketer: current.marketer,
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
    const amount = awardAmountUsd({
      marketer: p.marketer,
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

  // CLAIM-FIRST. The old order (send WhatsApp, then stamp in a tx) had
  // two failure modes: a double-click sent the payout announcement to
  // the team twice (both clicks computed the same preview and both
  // fired before either stamped), and the losing click still inserted
  // a batch row carrying full totalsJson — double-counting the month in
  // the notification-history grand totals. Now the batch + stamps are
  // committed FIRST (whatsapp_status='sending'); the claim aborts unless
  // it stamps every previewed award, so exactly one concurrent caller
  // can win. The message goes out only after the claim commits, and the
  // outcome is recorded on the batch afterwards. A crash between commit
  // and send leaves a visible 'sending' batch to resend from — strictly
  // better than money announced with no record.
  let batchId: string;
  try {
    batchId = await db.transaction(async (tx) => {
      const [batch] = await tx
        .insert(bonusNotificationBatches)
        .values({
          periodLabel: preview.periodLabel,
          messageBody: preview.messageBody,
          totalsJson: preview.totals,
          sentBy: opts.sentBy,
          whatsappStatus: "sending",
        })
        .returning({ id: bonusNotificationBatches.id });

      const stamped = await tx
        .update(bonusAwards)
        .set({ notificationBatchId: batch.id, updatedAt: new Date() })
        .where(
          and(
            inArray(bonusAwards.id, preview.awardIds),
            // Unsent recheck inside the tx — a concurrent send that
            // already claimed any of these awards makes the count
            // mismatch below roll the whole claim back.
            sql`${bonusAwards.notificationBatchId} IS NULL`,
          ),
        )
        .returning({ id: bonusAwards.id });

      if (stamped.length !== preview.awardIds.length) {
        throw new ConcurrentSendError(
          `claimed ${stamped.length}/${preview.awardIds.length} awards — another send is in flight`,
        );
      }
      return batch.id;
    });
  } catch (e) {
    if (e instanceof ConcurrentSendError) {
      logger.warn("bonus.notification.concurrent_send_blocked", { reason: e.message });
      return { skipped: true, reason: e.message };
    }
    throw e;
  }

  const send = opts.sendWhatsApp ?? (async () => ({ ok: false, reason: "no whatsapp sender configured" }));
  let whatsappStatus: string;
  try {
    const whatsappResult = await send(preview.messageBody);
    whatsappStatus = whatsappResult.ok
      ? "sent"
      : `failed:${whatsappResult.reason ?? "unknown"}`;
  } catch (e) {
    whatsappStatus = `failed:${e instanceof Error ? e.message : String(e)}`.slice(0, 200);
  }

  await db
    .update(bonusNotificationBatches)
    .set({ whatsappStatus })
    .where(eq(bonusNotificationBatches.id, batchId));

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
