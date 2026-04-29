// Read-only state dump for cross-checking Skybrook against Scott's source-
// of-truth Google sheets. Returns the latest available data per SKU across
// every layer of interest:
//
//   - skus: catalog with product_name, product_line, unit_cost_usd, unit_cost_intl_usd
//   - velocity: latest sales_velocity per (sku, channel) at windowDays=7
//   - stock: latest stock_snapshots per (sku, location)
//   - incoming: pending PO totals per (sku, destination)
//   - dailyTotals30d: per-(sku, channel) units_sold + net summed over the
//     last 30 days, for week-by-week velocity sheet comparison
//
// Auth: same Bearer CRON_SECRET as the rest of /api/admin/*. Read-only.
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function authedHandler(req: Request) {
  const auth = req.headers.get("authorization") ?? "";
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return NextResponse.json({ ok: false, error: "CRON_SECRET not configured" }, { status: 500 });
  }
  if (auth !== `Bearer ${expected}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const skus = (await db.execute(sql`
    SELECT sku, product_name, product_line, unit_cost_usd, unit_cost_intl_usd, active
    FROM skus
    WHERE sku LIKE 'ev-%'
    ORDER BY sku
  `)) as unknown as Record<string, unknown>[];

  const velocity = (await db.execute(sql`
    WITH latest AS (
      SELECT sku, channel, window_days, MAX(as_of_date) AS as_of_date
      FROM sales_velocity
      WHERE window_days = 7
      GROUP BY sku, channel, window_days
    )
    SELECT sv.sku, sv.channel, sv.units_per_day::float AS units_per_day, sv.as_of_date
    FROM sales_velocity sv
    JOIN latest l ON l.sku = sv.sku AND l.channel = sv.channel
                 AND l.window_days = sv.window_days AND l.as_of_date = sv.as_of_date
    ORDER BY sv.sku, sv.channel
  `)) as unknown as Record<string, unknown>[];

  const stock = (await db.execute(sql`
    WITH latest AS (
      SELECT sku, location, MAX(snapshot_date) AS snapshot_date
      FROM stock_snapshots
      GROUP BY sku, location
    )
    SELECT ss.sku, ss.location, ss.on_hand, ss.snapshot_date
    FROM stock_snapshots ss
    JOIN latest l ON l.sku = ss.sku AND l.location = ss.location AND l.snapshot_date = ss.snapshot_date
    ORDER BY ss.sku, ss.location
  `)) as unknown as Record<string, unknown>[];

  const incoming = (await db.execute(sql`
    SELECT sku, destination, SUM(quantity)::int AS pending_units, COUNT(*)::int AS po_count,
           ARRAY_AGG(expected_arrival ORDER BY expected_arrival) AS arrivals
    FROM incoming_shipments
    WHERE status <> 'arrived'
    GROUP BY sku, destination
    ORDER BY sku, destination
  `)) as unknown as Record<string, unknown>[];

  // 30-day per-(sku, channel) totals — useful for comparing against the
  // velocity sheet's weekly Qty Sold figures (which are 7-day buckets).
  const dailyTotals30d = (await db.execute(sql`
    SELECT sku, channel, SUM(units_sold)::int AS units_sold,
           SUM(net_sales_usd)::float AS net_sales_usd,
           MIN(sales_date) AS earliest_date, MAX(sales_date) AS latest_date
    FROM daily_sales
    WHERE sales_date >= CURRENT_DATE - INTERVAL '30 days'
    GROUP BY sku, channel
    ORDER BY sku, channel
  `)) as unknown as Record<string, unknown>[];

  return NextResponse.json({
    ok: true,
    asOf: new Date().toISOString(),
    counts: {
      skus: skus.length,
      velocity: velocity.length,
      stock: stock.length,
      incoming: incoming.length,
      dailyTotals30d: dailyTotals30d.length,
    },
    skus,
    velocity,
    stock,
    incoming,
    dailyTotals30d,
  });
}

export async function GET(req: Request) {
  return authedHandler(req);
}

export async function POST(req: Request) {
  return authedHandler(req);
}
