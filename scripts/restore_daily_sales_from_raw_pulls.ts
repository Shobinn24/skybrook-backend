// One-time restore of daily_sales history erased by the fixed-window
// Shopify ingest bug (since=2026-03-01 fell outside the 60-day
// read_orders scope around 2026-05-01; each cron then deleted the days
// Shopify could no longer return — Mar/early-Apr rows were gone by the
// time this was caught on 2026-06-10).
//
// Source of truth for the restore: raw_pulls payloads. Each Shopify
// pull stores its aggregated rows in payload->'rows'; the 2026-05-01
// pulls still covered back to 2026-03-02, so their rows for dates
// before the current daily_sales minimum can be re-inserted.
//
// Caveats (accepted — restored history beats no history):
// - rows predate the EST-bucketing fix (2026-05-06), so day boundaries
//   are UTC-based: orders within ~5h of midnight may sit one day off
//   vs current rows
// - rows predate warehouse routing (2026-05-12) and carry no
//   routedLocation; we default US store -> US, INTL store -> CN,
//   matching routeOrder's missing-ship-to fallback
//
// Additive only: INSERT ... ON CONFLICT DO NOTHING, restricted to
// sales_date strictly before the channel's current minimum. Reversible:
// DELETE FROM daily_sales WHERE source_pull_id = <pull id> AND
// sales_date < <that minimum>.
//
// Usage:
//   npx tsx scripts/restore_daily_sales_from_raw_pulls.ts          # dry run
//   npx tsx scripts/restore_daily_sales_from_raw_pulls.ts --apply  # write
// Point DATABASE_URL at the target database.

import "dotenv/config";
import { and, eq, lt, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { dailySales, rawPulls } from "@/lib/db/schema";

// The newest pulls whose payload still reached back before the wipe
// (verified 2026-06-10: 8,619 + 5,143 rows before 2026-04-11).
const RESTORE_PULLS = [
  { pullId: "c882e6dc-808d-47b1-b074-de6c9a2db03b", channel: "shopify_us", defaultLocation: "US" },
  { pullId: "59dfbb25-eb69-462e-9d23-58425b20015e", channel: "shopify_intl", defaultLocation: "CN" },
] as const;

type PayloadRow = {
  sku: string;
  salesDate: string;
  unitsSold: number;
  netSalesUsd: number;
  routedLocation?: string;
};

async function main() {
  const apply = process.argv.includes("--apply");
  console.log(apply ? "APPLY mode — writing rows" : "DRY RUN — pass --apply to write");

  for (const { pullId, channel, defaultLocation } of RESTORE_PULLS) {
    const [pull] = await db
      .select({ payload: rawPulls.payload })
      .from(rawPulls)
      .where(eq(rawPulls.id, pullId))
      .limit(1);
    if (!pull) {
      console.error(`${channel}: raw pull ${pullId} not found — skipping`);
      continue;
    }

    const [{ minDate }] = await db
      .select({ minDate: sql<string | null>`min(${dailySales.salesDate})` })
      .from(dailySales)
      .where(eq(dailySales.channel, channel));
    if (!minDate) {
      console.error(`${channel}: daily_sales is empty — refusing to restore into an empty table`);
      continue;
    }

    const payload = pull.payload as { rows?: PayloadRow[] };
    const candidates = (payload.rows ?? []).filter(
      (r) => r.salesDate < minDate && r.sku && Number.isFinite(r.unitsSold),
    );

    const byMonth = new Map<string, { rows: number; units: number; net: number }>();
    for (const r of candidates) {
      const m = r.salesDate.slice(0, 7);
      const agg = byMonth.get(m) ?? { rows: 0, units: 0, net: 0 };
      agg.rows++;
      agg.units += r.unitsSold;
      agg.net += r.netSalesUsd;
      byMonth.set(m, agg);
    }
    console.log(`\n${channel}: current min sales_date=${minDate}; ${candidates.length} restorable rows`);
    for (const [m, agg] of [...byMonth.entries()].sort()) {
      console.log(`  ${m}: ${agg.rows} rows, ${agg.units} units, $${agg.net.toFixed(2)}`);
    }
    if (!apply || candidates.length === 0) continue;

    const values = candidates.map((r) => ({
      channel,
      routedLocation: (r.routedLocation ?? defaultLocation) as "US" | "CN",
      sku: r.sku,
      salesDate: r.salesDate,
      unitsSold: r.unitsSold,
      netSalesUsd: String(r.netSalesUsd),
      sourcePullId: pullId,
    }));
    const CHUNK = 1000;
    for (let i = 0; i < values.length; i += CHUNK) {
      await db
        .insert(dailySales)
        .values(values.slice(i, i + CHUNK))
        .onConflictDoNothing();
    }
    // postgres-js doesn't surface rowCount on inserts — count what
    // actually landed under this pull id instead.
    const [{ landed }] = await db
      .select({ landed: sql<number>`count(*)` })
      .from(dailySales)
      .where(and(eq(dailySales.sourcePullId, pullId), lt(dailySales.salesDate, minDate)));
    console.log(`  ${landed} rows now present from this pull (attempted ${values.length}; conflicts skipped)`);

    // Post-check: confirm nothing landed at/after the pre-restore minimum.
    const [{ overlap }] = await db
      .select({ overlap: sql<number>`count(*)` })
      .from(dailySales)
      .where(and(eq(dailySales.sourcePullId, pullId), sql`${dailySales.salesDate} >= ${minDate}`));
    if (Number(overlap) > 0) {
      console.error(`  WARNING: ${overlap} restored rows at/after ${minDate} — investigate`);
    }
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
