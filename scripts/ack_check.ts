// Manage acknowledged health checks (see acknowledged_checks in schema.ts).
//
//   pnpm tsx scripts/ack_check.ts                                  # list
//   pnpm tsx scripts/ack_check.ts "<pattern>" "<reason>" [days]    # ack (upsert)
//   pnpm tsx scripts/ack_check.ts --remove "<pattern>"             # unack
//
// Pattern = exact check name, or prefix with trailing '*'
// (e.g. 'fb_url_unmapped.*'); sources ack as 'source:<name>'.
// Run against PROD: prefix with DATABASE_URL='<railway url>' (see
// docs/DEV_PROD.md — plain .env points at the local database).
import "dotenv/config";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { acknowledgedChecks } from "@/lib/db/schema";

const args = process.argv.slice(2);

async function main() {
  if (args[0] === "--remove" && args[1]) {
    const gone = await db
      .delete(acknowledgedChecks)
      .where(eq(acknowledgedChecks.pattern, args[1]))
      .returning({ pattern: acknowledgedChecks.pattern });
    console.log(gone.length ? `removed ack: ${args[1]}` : `no ack found for: ${args[1]}`);
    return;
  }

  if (args.length >= 2) {
    const [pattern, reason, daysRaw] = args;
    const days = daysRaw ? Number(daysRaw) : null;
    if (daysRaw && (!Number.isFinite(days) || days! <= 0)) {
      throw new Error(`bad days value: ${daysRaw}`);
    }
    const expiresAt = days ? new Date(Date.now() + days * 24 * 3600 * 1000) : null;
    await db
      .insert(acknowledgedChecks)
      .values({ pattern, reason, expiresAt, ackedBy: process.env.USER ?? null })
      .onConflictDoUpdate({
        target: acknowledgedChecks.pattern,
        set: { reason, expiresAt },
      });
    console.log(
      `acked ${pattern} (${expiresAt ? `expires ${expiresAt.toISOString().slice(0, 10)}` : "no expiry"}): ${reason}`,
    );
    return;
  }

  const rows = await db.select().from(acknowledgedChecks);
  if (rows.length === 0) {
    console.log("no acknowledged checks");
    return;
  }
  for (const r of rows) {
    const exp = r.expiresAt ? ` (expires ${r.expiresAt.toISOString().slice(0, 10)})` : "";
    const stale = r.expiresAt && r.expiresAt.getTime() <= Date.now() ? " [EXPIRED]" : "";
    console.log(`${r.pattern}${exp}${stale}: ${r.reason}`);
  }
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
