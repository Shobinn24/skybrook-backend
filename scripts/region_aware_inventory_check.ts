// Region-aware daily inventory check. Companion to daily_inventory_xref.ts,
// which diffs the global latest-vs-previous snapshot and is MISLEADING on
// region-split days: when the US and CN inventory tabs advance their
// rightmost date column on different days, each region's snapshot lands
// under its own snapshot_date, so the global diff reports the entire
// behind-region as fake [DROPPED_KEY] decreases.
//
// This script instead compares EACH location against its OWN prior
// snapshot date, so split days read cleanly. It reports:
//   (a) real landings   — per-region on_hand increases >= MIN_LANDING
//                          (the only true "stock jumped / inventory landed")
//   (b) negative on_hand — data quirk at latest-per-region (flag to the
//                          sheet maintainer)
//   (c) true overdue     — incoming_shipments LEFT JOIN incoming_receipts
//                          (shipment_name + destination + expected_arrival),
//                          r.id IS NULL and expected_arrival < today.
//                          NOT incoming_shipments.status (always 'po').
//
// 0 landings + 0 overdue + ETAs-not-past = a clean "not arrived, not
// overdue, keep watching" -- do not mistake not-landed for overdue.
//
// Run against PROD:
//   DATABASE_URL=<public url> node_modules/.bin/tsx scripts/region_aware_inventory_check.ts
import "dotenv/config";
import { db } from "@/lib/db";
import { sql } from "drizzle-orm";

const MIN_LANDING = 50;

function rowsOf<T = any>(res: any): T[] {
  return (res?.rows ?? res) as T[];
}

async function main() {
  // Latest 2 distinct snapshot dates per location.
  const dates = rowsOf(
    await db.execute(sql`
      select location, snapshot_date::text as d
      from (
        select location, snapshot_date,
               row_number() over (partition by location order by snapshot_date desc) rn
        from (select distinct location, snapshot_date from stock_snapshots) x
      ) y
      where rn <= 2
      order by location, d desc`)
  );

  const byLoc = new Map<string, string[]>();
  for (const r of dates) {
    const list = byLoc.get(r.location) ?? [];
    list.push(r.d);
    byLoc.set(r.location, list);
  }

  for (const [loc, ds] of byLoc.entries()) {
    const [latest, prev] = ds;
    console.log(`\n=== ${loc} :: latest=${latest} prev=${prev ?? "(none)"} ===`);
    if (!prev) {
      console.log("  only one snapshot date for this location; skipping diff.");
      continue;
    }

    const diff = rowsOf(
      await db.execute(sql`
        with l as (select sku, on_hand from stock_snapshots where location = ${loc} and snapshot_date = ${latest}),
             p as (select sku, on_hand from stock_snapshots where location = ${loc} and snapshot_date = ${prev})
        select coalesce(l.sku, p.sku) as sku,
               coalesce(p.on_hand, 0) as prev,
               coalesce(l.on_hand, 0) as latest
        from l full outer join p on l.sku = p.sku`)
    );

    const landings = diff
      .filter((r: any) => Number(r.latest) - Number(r.prev) >= MIN_LANDING)
      .sort((a: any, b: any) => Number(b.latest) - Number(b.prev) - (Number(a.latest) - Number(a.prev)));
    const negatives = diff.filter((r: any) => Number(r.latest) < 0);

    console.log(`  rows=${diff.length} | landings(>=${MIN_LANDING})=${landings.length} | negatives=${negatives.length}`);
    for (const r of landings) {
      console.log(`    LANDING +${Number(r.latest) - Number(r.prev)}  ${r.sku} (${r.prev} -> ${r.latest})`);
    }
    for (const r of negatives) {
      console.log(`    NEG on_hand  ${r.sku} = ${r.latest}`);
    }
  }

  // True overdue: no receipt row and ETA in the past.
  const overdue = rowsOf(
    await db.execute(sql`
      select s.expected_arrival::text as ea, s.shipment_name, s.destination
      from incoming_shipments s
      left join incoming_receipts r
        on r.shipment_name = s.shipment_name
       and r.destination = s.destination
       and r.expected_arrival = s.expected_arrival
      where r.id is null and s.expected_arrival < CURRENT_DATE
      order by s.expected_arrival`)
  );
  console.log(`\n=== TRUE OVERDUE (no receipt, ETA past): ${overdue.length} ===`);
  for (const r of overdue) console.log(`  ${r.ea}  ${r.shipment_name} @ ${r.destination}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
