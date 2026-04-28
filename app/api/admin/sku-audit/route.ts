// Read-only diagnostic that surfaces the SKU-mapping gaps Scott flagged
// 2026-04-28 ("Why do some products not have stock?", "ev-hw-xxs missing
// sales data"). Returns three buckets:
//
//   1. activeNoStock   — active skus rows with NO stock_snapshots ever.
//      → inventory sheet doesn't have these SKUs (or they're filtered).
//   2. activeZeroSales — active skus rows with NO daily_sales ever.
//      → either truly zero sales or the Shopify SKU code is different.
//   3. orphanSalesSkus — daily_sales SKUs that have NO matching skus row.
//      → Shopify is selling something the inventory sheet doesn't track.
//
// All three filter to ev-* SKUs to ignore noise. Auth: same Bearer
// CRON_SECRET as /api/cron/ingest.
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function authedHandler(req: Request) {
  const auth = req.headers.get("authorization") ?? "";
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return NextResponse.json(
      { ok: false, error: "CRON_SECRET not configured" },
      { status: 500 }
    );
  }
  if (auth !== `Bearer ${expected}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const activeNoStock = await db.execute(sql`
    SELECT s.sku, s.product_name, s.product_line
    FROM skus s
    WHERE s.active = true
      AND s.sku LIKE 'ev-%'
      AND NOT EXISTS (
        SELECT 1 FROM stock_snapshots ss WHERE ss.sku = s.sku
      )
    ORDER BY s.sku
  `);

  const activeZeroSales = await db.execute(sql`
    SELECT s.sku, s.product_name
    FROM skus s
    WHERE s.active = true
      AND s.sku LIKE 'ev-%'
      AND NOT EXISTS (
        SELECT 1 FROM daily_sales ds WHERE ds.sku = s.sku
      )
    ORDER BY s.sku
  `);

  const orphanSalesSkus = await db.execute(sql`
    SELECT ds.sku, SUM(ds.units_sold)::int AS units_sold_30d, COUNT(*) AS rows
    FROM daily_sales ds
    WHERE ds.sales_date >= CURRENT_DATE - INTERVAL '30 days'
      AND NOT EXISTS (SELECT 1 FROM skus s WHERE s.sku = ds.sku)
    GROUP BY ds.sku
    ORDER BY units_sold_30d DESC NULLS LAST, ds.sku
  `);

  // SKU prefix histogram across the active catalog so we can see what
  // families dominate and which are sparse.
  const familyHistogram = await db.execute(sql`
    SELECT
      split_part(s.sku, '-', 2) AS family,
      COUNT(*) AS sku_count,
      COUNT(DISTINCT ds.sku) AS skus_with_sales
    FROM skus s
    LEFT JOIN daily_sales ds ON ds.sku = s.sku
    WHERE s.active = true AND s.sku LIKE 'ev-%'
    GROUP BY family
    ORDER BY sku_count DESC
  `);

  // postgres-js driver returns the row list directly (no .rows wrapper).
  const noStockRows = activeNoStock as unknown as Record<string, unknown>[];
  const zeroSalesRows = activeZeroSales as unknown as Record<string, unknown>[];
  const orphanRows = orphanSalesSkus as unknown as Record<string, unknown>[];
  const familyRows = familyHistogram as unknown as Record<string, unknown>[];

  return NextResponse.json({
    ok: true,
    counts: {
      activeNoStock: noStockRows.length,
      activeZeroSales: zeroSalesRows.length,
      orphanSalesSkus: orphanRows.length,
    },
    activeNoStock: noStockRows,
    activeZeroSales: zeroSalesRows,
    orphanSalesSkus: orphanRows,
    familyHistogram: familyRows,
  });
}

export async function GET(req: Request) {
  return authedHandler(req);
}

export async function POST(req: Request) {
  return authedHandler(req);
}
