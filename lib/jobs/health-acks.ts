import { db } from "@/lib/db";
import { acknowledgedChecks } from "@/lib/db/schema";

// Matching for the acknowledged-checks tier (see the schema comment).
// Pure so the precedence rules are unit-testable without a DB.

export type AckRow = {
  pattern: string;
  reason: string;
  expiresAt: Date | null;
};

/** First active ack whose pattern matches the check name, else null. */
export function ackFor(name: string, acks: AckRow[], now: Date): AckRow | null {
  for (const a of acks) {
    if (a.expiresAt && a.expiresAt.getTime() <= now.getTime()) continue;
    const matched = a.pattern.endsWith("*")
      ? name.startsWith(a.pattern.slice(0, -1))
      : name === a.pattern;
    if (matched) return a;
  }
  return null;
}

export async function loadAcks(): Promise<AckRow[]> {
  const rows = await db
    .select({
      pattern: acknowledgedChecks.pattern,
      reason: acknowledgedChecks.reason,
      expiresAt: acknowledgedChecks.expiresAt,
    })
    .from(acknowledgedChecks);
  return rows;
}
