// Read-only daily inventory cross-reference + anomaly hunt.
import "dotenv/config";
import { db } from "@/lib/db";
import { sql } from "drizzle-orm";

async function main() {
  // 1. Totals per date, last 8 snapshots — spot anomalous under/over counts.
  const totals = await db.execute<any>(sql`
    select snapshot_date::text as d, count(*)::int as n, sum(on_hand)::bigint as units
    from stock_snapshots
    group by snapshot_date order by snapshot_date desc limit 8`);
  const trows = (totals as any).rows ?? totals;
  console.log("=== snapshot totals (newest first) ===");
  for (const r of trows) console.log(`  ${r.d}: ${r.n} sku-locations, ${Number(r.units).toLocaleString()} units`);

  const dateList = trows.map((r: any) => r.d);
  const [today, prev] = dateList;
  const todayStr = new Date().toISOString().slice(0, 10);
  console.log(`\nSkybrook latest = ${today} | UTC today = ${todayStr} | ${today === todayStr ? "CURRENT ✓" : "STALE"}`);

  // 2. FULL OUTER JOIN — every key that appeared, disappeared, or changed.
  const diff = await db.execute<any>(sql`
    with t as (select sku, location, on_hand from stock_snapshots where snapshot_date = ${today}),
         p as (select sku, location, on_hand from stock_snapshots where snapshot_date = ${prev})
    select coalesce(t.sku,p.sku) as sku, coalesce(t.location,p.location) as location,
           p.on_hand as prev_oh, t.on_hand as today_oh,
           (coalesce(t.on_hand,0) - coalesce(p.on_hand,0)) as delta,
           case when p.sku is null then 'NEW_KEY' when t.sku is null then 'DROPPED_KEY' else 'CHANGED' end as kind
    from t full outer join p on t.sku=p.sku and t.location=p.location
    where coalesce(t.on_hand,-1) <> coalesce(p.on_hand,-1)
    order by delta desc`);
  const d = (diff as any).rows ?? diff;
  const ups = d.filter((r: any) => Number(r.delta) > 0);
  const downs = d.filter((r: any) => Number(r.delta) < 0);
  console.log(`\n=== INCREASES (landed / appeared): ${ups.length} ===`);
  for (const r of ups.slice(0, 80)) console.log(`  +${r.delta}  ${r.sku} @ ${r.location}  (${r.prev_oh ?? "—"} -> ${r.today_oh})  [${r.kind}]`);
  if (ups.length > 80) console.log(`  ... +${ups.length - 80} more`);
  console.log(`\n=== DECREASES (sold / dropped): ${downs.length} (showing <= -100) ===`);
  for (const r of downs.filter((r: any) => Number(r.delta) <= -100).slice(0, 40)) console.log(`  ${r.delta}  ${r.sku} @ ${r.location}  (${r.prev_oh} -> ${r.today_oh ?? "—"})  [${r.kind}]`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
