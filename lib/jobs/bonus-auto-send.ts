// Monthly bonus auto-send (client spec 2026-08-03): on the 1st of each
// month, after the last day's spend has synced, auto-approve every
// pending award (honoring the auto-half rules) and send both program
// notifications to the WhatsApp group — no manual approve/send pass.
//
// Safety model, in order:
//   1. BONUS_AUTO_SEND_ENABLED env gate — ships dark; nothing fires
//      until the client confirms go-live and the flag is flipped.
//   2. Day guard — runs only when it is the 1st in EST. The cron can
//      fire the endpoint every day (or several times that day);
//      non-1st calls are no-ops.
//   3. Spend-freshness guard — refuses to run until fb_ad_spend_daily
//      contains the last day of the month being paid, so a late
//      Supermetrics sync can never produce a message that undercounts
//      the final day (the 2026-05-28 10x-undercount lesson). A failed
//      guard is a retryable skip: the cron fires again later.
//   4. Once-per-month idempotence — each program sends only if no batch
//      for (program, periodLabel) exists yet, so retry fires and manual
//      sends can never double-announce a month.
//
// The send itself reuses sendNotification's claim-first semantics, so
// even a concurrent manual send can't double-claim awards.

import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { bonusAwards, bonusNotificationBatches, fbAdSpendDaily } from "@/lib/db/schema";
import {
  detectAndInsertBonusCrossings,
  detectAndInsertVideoEditorCrossings,
} from "@/lib/jobs/bonus-crossings";
import { bulkApprovePending, sendNotification } from "@/lib/jobs/bonus-mutations";
import { sendViaWhatsAppBridge } from "@/lib/notifications/whatsapp-bridge";
import type { BonusProgram } from "@/lib/queries/bonus-tracker";
import { logger } from "@/lib/logger";
import { toEstDate } from "@/lib/tz";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "July 2026" + "2026-07-31" for the month before the given EST date. */
export function previousMonthOf(estYmd: string): {
  periodLabel: string;
  lastDay: string;
} {
  const [y, m] = estYmd.split("-").map((x) => parseInt(x, 10));
  const prevYear = m === 1 ? y - 1 : y;
  const prevMonth = m === 1 ? 12 : m - 1;
  // day 0 of the current month = last day of the previous month
  const last = new Date(Date.UTC(prevYear, prevMonth, 0)).getUTCDate();
  return {
    periodLabel: `${MONTH_NAMES[prevMonth - 1]} ${prevYear}`,
    lastDay: `${prevYear}-${String(prevMonth).padStart(2, "0")}-${String(last).padStart(2, "0")}`,
  };
}

export type AutoSendResult = {
  ran: boolean;
  reason?: string;
  periodLabel?: string;
  approved?: number;
  programs?: Record<string, { sent: boolean; reason?: string; awardCount?: number }>;
};

export async function runMonthlyBonusAutoSend(opts?: {
  now?: Date;
  /** Test seam; defaults to the real WhatsApp bridge. */
  sendWhatsApp?: (body: string) => Promise<{ ok: boolean; reason?: string }>;
  /** Test seam for the env gate. */
  enabled?: boolean;
}): Promise<AutoSendResult> {
  const enabled =
    opts?.enabled ?? process.env.BONUS_AUTO_SEND_ENABLED === "true";
  if (!enabled) {
    return { ran: false, reason: "BONUS_AUTO_SEND_ENABLED is not 'true'" };
  }

  const now = opts?.now ?? new Date();
  const estToday = toEstDate(now);
  if (!estToday.endsWith("-01")) {
    return { ran: false, reason: `not the 1st (EST today is ${estToday})` };
  }

  const { periodLabel, lastDay } = previousMonthOf(estToday);

  // Spend-freshness guard: the month being paid must be fully synced.
  const [{ maxDate }] = (
    await db
      .select({ maxDate: sql<string | null>`max(${fbAdSpendDaily.spendDate})` })
      .from(fbAdSpendDaily)
  ) as Array<{ maxDate: string | null }>;
  if (!maxDate || maxDate < lastDay) {
    logger.info("bonus.autosend.waiting_for_spend", { maxDate, lastDay });
    return {
      ran: false,
      reason: `spend not synced through ${lastDay} yet (max ${maxDate ?? "none"}); will retry`,
    };
  }

  // Catch any crossings the just-landed spend produced, both programs.
  await detectAndInsertBonusCrossings({ asOfDate: estToday, lookbackDays: 14 });
  await detectAndInsertVideoEditorCrossings();

  // Auto-approve everything pending — flagged rows at half, rest full.
  const { updatedCount } = await bulkApprovePending({
    approvedBy: "auto-monthly",
  });

  const sender = opts?.sendWhatsApp ?? sendViaWhatsAppBridge;
  const programs: AutoSendResult["programs"] = {};
  for (const program of ["marketers", "videoEditors"] as BonusProgram[]) {
    // Once-per-month: skip if any batch for this program+period exists.
    const existing = await db
      .select({ id: bonusNotificationBatches.id })
      .from(bonusNotificationBatches)
      .where(
        and(
          eq(bonusNotificationBatches.periodLabel, periodLabel),
          eq(bonusNotificationBatches.program, program),
        ),
      )
      .limit(1);
    if (existing.length > 0) {
      programs[program] = { sent: false, reason: "batch already exists for this period" };
      continue;
    }

    const result = await sendNotification({
      periodLabel,
      program,
      sentBy: "auto-monthly",
      sendWhatsApp: sender,
    });
    programs[program] = result.skipped
      ? { sent: false, reason: result.reason }
      : { sent: true, awardCount: result.awardCount };
  }

  const summary: AutoSendResult = {
    ran: true,
    periodLabel,
    approved: updatedCount,
    programs,
  };
  logger.info("bonus.autosend.completed", summary);
  return summary;
}
