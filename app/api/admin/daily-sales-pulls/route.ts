// Read-only diagnostic that returns per-SKU source_pull_id + raw_pull
// pulled_at for a given (date, channel). Used to investigate stale-row
// hypotheses on daily_sales — if rows for the same date carry multiple
// distinct source_pull_ids, the cron's upsert pattern is leaving rows
// from prior ingests untouched.
//
// Auth: Bearer CRON_SECRET.
// Query params:
//   date=YYYY-MM-DD                       (required, single day)
//   channel=shopify_us|shopify_intl|all   (default: all)
//
// Returns rows of: { sku, channel, unitsSold, netSalesUsd,
//                    sourcePullId, pulledAt, source }
// plus a `pullSummary` rolling up rows per source_pull_id so the gap
// between ingest batches is obvious at a glance.

import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { dailySales, rawPulls } from "@/lib/db/schema";

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
  const date = url.searchParams.get("date");
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json(
      { ok: false, error: "date must be YYYY-MM-DD" },
      { status: 400 },
    );
  }
  const channelRaw = url.searchParams.get("channel");
  const channel: Channel | undefined =
    channelRaw && channelRaw !== "all" && (VALID_CHANNELS as readonly string[]).includes(channelRaw)
      ? (channelRaw as Channel)
      : undefined;
  if (channelRaw && channelRaw !== "all" && !channel) {
    return NextResponse.json(
      { ok: false, error: "channel must be shopify_us, shopify_intl, or all" },
      { status: 400 },
    );
  }

  const conditions = [eq(dailySales.salesDate, date)];
  if (channel) conditions.push(eq(dailySales.channel, channel));

  const rows = await db
    .select({
      sku: dailySales.sku,
      channel: dailySales.channel,
      unitsSold: dailySales.unitsSold,
      netSalesUsd: dailySales.netSalesUsd,
      sourcePullId: dailySales.sourcePullId,
      pulledAt: rawPulls.pulledAt,
      source: rawPulls.source,
    })
    .from(dailySales)
    .leftJoin(rawPulls, eq(dailySales.sourcePullId, rawPulls.id))
    .where(and(...conditions))
    .orderBy(dailySales.sku);

  const formatted = rows.map((r) => ({
    sku: r.sku,
    channel: r.channel,
    unitsSold: r.unitsSold,
    netSalesUsd: Number(Number(r.netSalesUsd).toFixed(2)),
    sourcePullId: r.sourcePullId,
    pulledAt: r.pulledAt ? r.pulledAt.toISOString() : null,
    source: r.source ?? null,
  }));

  // Roll up per source_pull_id so the gap between ingest batches is
  // obvious at a glance. If only one entry, every row came from the
  // same ingest. Multiple entries = stale rows from older ingests.
  const summary = new Map<
    string,
    {
      sourcePullId: string;
      pulledAt: string | null;
      source: string | null;
      rowCount: number;
      unitsSold: number;
      netSalesUsd: number;
    }
  >();
  for (const r of formatted) {
    const key = r.sourcePullId;
    const cur = summary.get(key) ?? {
      sourcePullId: r.sourcePullId,
      pulledAt: r.pulledAt,
      source: r.source,
      rowCount: 0,
      unitsSold: 0,
      netSalesUsd: 0,
    };
    cur.rowCount++;
    cur.unitsSold += r.unitsSold;
    cur.netSalesUsd += r.netSalesUsd;
    summary.set(key, cur);
  }
  const pullSummary = [...summary.values()]
    .map((s) => ({
      ...s,
      netSalesUsd: Number(s.netSalesUsd.toFixed(2)),
    }))
    .sort((a, b) =>
      (a.pulledAt ?? "").localeCompare(b.pulledAt ?? ""),
    );

  return NextResponse.json({
    ok: true,
    date,
    channel: channel ?? "all",
    rowCount: formatted.length,
    distinctPulls: pullSummary.length,
    totalUnits: formatted.reduce((s, r) => s + r.unitsSold, 0),
    totalRevenueUsd: Number(
      formatted.reduce((s, r) => s + r.netSalesUsd, 0).toFixed(2),
    ),
    pullSummary,
    rows: formatted,
  });
}

export async function GET(req: Request) {
  return authedHandler(req);
}

// Avoid the obscure "405 Method Not Allowed" shape on accidental POSTs by
// reusing the same handler — same pattern as /api/admin/sales-detail.
export async function POST(req: Request) {
  return authedHandler(req);
}
