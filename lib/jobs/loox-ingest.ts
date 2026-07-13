import { ImapFlow } from "imapflow";
import { simpleParser, type ParsedMail } from "mailparser";
import { db } from "@/lib/db";
import { looxReviews } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { parseLooxReviewEmail } from "@/lib/sources/loox/parse-review-email";

// Poll the dedicated Loox-reviews inbox over IMAP and land one row per
// review email. Loox has no API (Scott 2026-07-13); notification emails
// forward to this inbox instead.
//
// Dormant until configured: without LOOX_IMAP_USER / LOOX_IMAP_PASSWORD the
// job returns {configured: false} and touches nothing — same pattern as the
// studio's optional providers, so this ships ahead of the inbox existing.
//
// Idempotency: rows key on the email Message-ID (unique index); a re-poll
// or a re-forwarded duplicate lands as a no-op conflict. Messages are left
// UNREAD-agnostic — we read everything in INBOX since the last row's date
// minus a day, so a crashed run can't strand mail in a "seen but not
// stored" state.

export type LooxIngestResult = {
  configured: boolean;
  fetched: number;
  inserted: number;
  unparsed: number;
  error?: string;
};

export async function runLooxIngest(): Promise<LooxIngestResult> {
  const user = process.env.LOOX_IMAP_USER?.trim();
  const pass = process.env.LOOX_IMAP_PASSWORD?.trim();
  if (!user || !pass) {
    return { configured: false, fetched: 0, inserted: 0, unparsed: 0 };
  }
  const host = process.env.LOOX_IMAP_HOST?.trim() || "imap.gmail.com";

  const client = new ImapFlow({
    host,
    port: 993,
    secure: true,
    auth: { user, pass },
    logger: false,
  });

  let fetched = 0;
  let inserted = 0;
  let unparsed = 0;
  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    try {
      // Overlap window: everything since the newest stored review minus 2
      // days. Cheap on a single-purpose inbox and immune to crashed runs.
      const newest = await db
        .select({ receivedAt: looxReviews.receivedAt })
        .from(looxReviews)
        .orderBy(looxReviews.receivedAt)
        .then((rows) => rows.at(-1)?.receivedAt);
      const since = newest
        ? new Date(newest.getTime() - 2 * 24 * 3600 * 1000)
        : new Date(0);

      for await (const msg of client.fetch({ since }, { source: true })) {
        fetched += 1;
        if (!msg.source) continue;
        const mail: ParsedMail = await simpleParser(msg.source);
        const messageId = mail.messageId ?? `no-id:${msg.uid}@${user}`;
        const text = mail.text ?? "";
        const subject = mail.subject ?? "";
        const parsedReview = parseLooxReviewEmail(subject, text);
        if (!parsedReview.parsed) unparsed += 1;
        const res = await db
          .insert(looxReviews)
          .values({
            emailMessageId: messageId,
            receivedAt: mail.date ?? new Date(),
            productTitle: parsedReview.productTitle,
            rating: parsedReview.rating,
            reviewerName: parsedReview.reviewerName,
            reviewText: parsedReview.reviewText,
            rawText: `${subject}\n\n${text}`.slice(0, 20000),
            parsed: parsedReview.parsed,
          })
          .onConflictDoNothing({ target: looxReviews.emailMessageId })
          .returning({ id: looxReviews.id });
        if (res.length > 0) inserted += 1;
      }
    } finally {
      lock.release();
    }
    await client.logout();
    logger.info("loox.ingest.done", { fetched, inserted, unparsed });
    return { configured: true, fetched, inserted, unparsed };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    logger.error("loox.ingest.failed", { error });
    try {
      await client.logout();
    } catch {
      /* already gone */
    }
    return { configured: true, fetched, inserted, unparsed, error };
  }
}
