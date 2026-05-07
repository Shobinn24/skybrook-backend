// Read-only diagnostic that returns per-SKU sales detail for a given
// date range, channel, and productName pattern. Used to drill into the
// SupHW / Shapewear reconciliation mismatches against the daily-report
// agency's numbers.
//
// Auth: Bearer CRON_SECRET.
// Query params:
//   start=YYYY-MM-DD     (required)
//   end=YYYY-MM-DD       (required, inclusive)
//   channel=shopify_us|shopify_intl  (optional — omit for both)
//   pattern=ILIKE pattern on skus.productName (optional, e.g. "Super High-Waist%")
//   skuPattern=ILIKE pattern on daily_sales.sku (optional, e.g. "ev-suphw-%")
//
// Returns rows of: { sku, productName, channel, unitsSold, netSalesUsd }
// sorted by netSalesUsd desc.
import { NextResponse } from "next/server";
import { and, desc, eq, gte, ilike, lte, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { dailySales, skus } from "@/lib/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_CHANNELS = ["shopify_us", "shopify_intl"] as const;
type Channel = (typeof VALID_CHANNELS)[number];

async function authedHandler(req: Request) {
  const auth = req.headers.get("authorization") ?? "";
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return NextResponse.json(
      { ok: false, error: "CRON_SECRET not configured" },
      { status: 500 },
    );
  }
  if (auth !== `Bearer ${expected}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const start = url.searchParams.get("start");
  const end = url.searchParams.get("end");
  if (!start || !/^\d{4}-\d{2}-\d{2}$/.test(start)) {
    return NextResponse.json(
      { ok: false, error: "start must be YYYY-MM-DD" },
      { status: 400 },
    );
  }
  if (!end || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    return NextResponse.json(
      { ok: false, error: "end must be YYYY-MM-DD" },
      { status: 400 },
    );
  }
  const channelRaw = url.searchParams.get("channel");
  const channel: Channel | undefined =
    channelRaw && (VALID_CHANNELS as readonly string[]).includes(channelRaw)
      ? (channelRaw as Channel)
      : undefined;
  if (channelRaw && !channel) {
    return NextResponse.json(
      { ok: false, error: "channel must be shopify_us or shopify_intl" },
      { status: 400 },
    );
  }
  const pattern = url.searchParams.get("pattern");
  const skuPattern = url.searchParams.get("skuPattern");

  // Aggregate daily_sales joined to skus, summed per (sku, channel) over
  // the window. Filter on productName pattern (post-join) so we capture
  // the brand-card semantics. Optional skuPattern is an additional
  // narrowing on the daily_sales.sku column directly.
  const conditions = [
    gte(dailySales.salesDate, start),
    lte(dailySales.salesDate, end),
  ];
  if (channel) conditions.push(eq(dailySales.channel, channel));
  if (skuPattern) conditions.push(ilike(dailySales.sku, skuPattern));
  if (pattern) conditions.push(ilike(skus.productName, pattern));

  const rows = await db
    .select({
      sku: dailySales.sku,
      productName: skus.productName,
      channel: dailySales.channel,
      unitsSold: sql<string>`sum(${dailySales.unitsSold})`,
      netSalesUsd: sql<string>`sum(${dailySales.netSalesUsd})`,
    })
    .from(dailySales)
    .leftJoin(skus, eq(dailySales.sku, skus.sku))
    .where(and(...conditions))
    .groupBy(dailySales.sku, skus.productName, dailySales.channel)
    .orderBy(desc(sql`sum(${dailySales.netSalesUsd})`));

  const formatted = rows.map((r) => ({
    sku: r.sku,
    productName: r.productName ?? null,
    channel: r.channel,
    unitsSold: Number(r.unitsSold),
    netSalesUsd: Number(Number(r.netSalesUsd).toFixed(2)),
  }));
  const totalRevenue = formatted.reduce((s, r) => s + r.netSalesUsd, 0);
  const totalUnits = formatted.reduce((s, r) => s + r.unitsSold, 0);

  return NextResponse.json({
    ok: true,
    start,
    end,
    channel: channel ?? "all",
    pattern: pattern ?? null,
    skuPattern: skuPattern ?? null,
    rowCount: formatted.length,
    totalUnits,
    totalRevenueUsd: Number(totalRevenue.toFixed(2)),
    rows: formatted,
  });
}

export async function GET(req: Request) {
  return authedHandler(req);
}

export async function POST(req: Request) {
  return authedHandler(req);
}
