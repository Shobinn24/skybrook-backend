// One-shot cleanup: delete `pending` bonus_awards rows where the ad
// number is below the marketer's BONUS_AD_FLOOR. Approved / rejected
// rows stay — those are history. Run once after deploying the floor.
//
//   npx tsx scripts/cleanup_below_floor_pending_bonuses.ts            # dry-run
//   npx tsx scripts/cleanup_below_floor_pending_bonuses.ts --apply    # delete
import "dotenv/config";
import { and, eq, lt, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { bonusAwards } from "@/lib/db/schema";
import {
  BONUS_AD_FLOOR,
  BONUS_MARKETERS,
  type BonusMarketer,
} from "@/lib/domain/bonus-tiers";

async function main() {
  const apply = process.argv.includes("--apply");
  console.log(`Mode: ${apply ? "APPLY (will delete)" : "dry-run (no changes)"}`);

  let totalCandidates = 0;
  const perMarketer: Array<{
    marketer: BonusMarketer;
    floor: number;
    rows: { id: string; adNumber: string; tier: string; status: string }[];
  }> = [];

  for (const marketer of BONUS_MARKETERS) {
    const floor = BONUS_AD_FLOOR[marketer];
    if (floor === 0) continue;

    // Find all pending awards for this marketer where ad_number (text)
    // parses to an integer below the floor. Postgres CAST handles the
    // text→int cast inline; rows with non-numeric ad_number fall out
    // via the regex guard so we don't error on bad data.
    const rows = await db
      .select({
        id: bonusAwards.id,
        adNumber: bonusAwards.adNumber,
        tier: bonusAwards.tier,
        status: bonusAwards.status,
      })
      .from(bonusAwards)
      .where(
        and(
          eq(bonusAwards.marketer, marketer),
          eq(bonusAwards.status, "pending"),
          sql`${bonusAwards.adNumber} ~ '^[0-9]+$'`,
          lt(sql`${bonusAwards.adNumber}::int`, floor),
        ),
      );

    if (rows.length > 0) {
      perMarketer.push({ marketer, floor, rows });
      totalCandidates += rows.length;
    }
  }

  if (totalCandidates === 0) {
    console.log("No below-floor pending rows to clean. Done.");
    return;
  }

  console.log(`\nFound ${totalCandidates} below-floor pending rows:`);
  for (const m of perMarketer) {
    console.log(`\n  ${m.marketer} (floor ${m.floor}): ${m.rows.length} rows`);
    for (const r of m.rows.slice(0, 10)) {
      console.log(`    ad=${r.adNumber} tier=${r.tier} id=${r.id}`);
    }
    if (m.rows.length > 10) console.log(`    … and ${m.rows.length - 10} more`);
  }

  if (!apply) {
    console.log("\nDry-run complete. Re-run with --apply to delete.");
    return;
  }

  const ids = perMarketer.flatMap((m) => m.rows.map((r) => r.id));
  await db
    .delete(bonusAwards)
    .where(
      sql`${bonusAwards.id} = ANY(${sql.raw(`ARRAY[${ids.map((id) => `'${id}'`).join(",")}]::uuid[]`)})`,
    );
  console.log(`\nDeleted ${ids.length} rows.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
