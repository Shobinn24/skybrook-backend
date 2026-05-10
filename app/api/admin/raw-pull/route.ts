// Read-only diagnostic that returns the raw_pulls payload for a given
// pull ID (UUID). Used to investigate cron-vs-live divergences — the
// payload contains the aggregated rows that were ingested AT CRON TIME,
// which is the only authoritative record of what Shopify returned then.
//
// Auth: Bearer CRON_SECRET.
// Query params:
//   id=<uuid>                              (required when latest is false)
//   latest=1                               (alternative: get most recent pull)
//   source=shopify_us|shopify_intl|...     (required when latest=1)
//
// Returns: { id, source, pulledAt, pullBatchId, schemaFingerprint,
//            rowCount, payload }
// Payload shape varies by source — for shopify_* it has
// { channel, store, since, until, apiVersion, pagesFetched, orderCount,
//   aggregatedRows, rows: [...] } where rows are the per-SKU aggregates
// the cron upserted into daily_sales.

import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { rawPulls } from "@/lib/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_SOURCES = [
  "sheets_inventory",
  "sheets_incoming",
  "sheets_ad_spend",
  "shopify_us",
  "shopify_intl",
] as const;
type Source = (typeof VALID_SOURCES)[number];

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
  const id = url.searchParams.get("id");
  const latest = url.searchParams.get("latest") === "1";
  const sourceRaw = url.searchParams.get("source");
  const source =
    sourceRaw && (VALID_SOURCES as readonly string[]).includes(sourceRaw)
      ? (sourceRaw as Source)
      : null;

  if (!id && !latest) {
    return NextResponse.json(
      { ok: false, error: "provide id=<uuid> or latest=1&source=<...>" },
      { status: 400 },
    );
  }
  if (latest && !source) {
    return NextResponse.json(
      { ok: false, error: "latest=1 requires source param" },
      { status: 400 },
    );
  }
  if (id && !/^[0-9a-fA-F-]{36}$/.test(id)) {
    return NextResponse.json(
      { ok: false, error: "id must be a UUID" },
      { status: 400 },
    );
  }

  const row = id
    ? await db
        .select()
        .from(rawPulls)
        .where(eq(rawPulls.id, id))
        .limit(1)
    : await db
        .select()
        .from(rawPulls)
        .where(eq(rawPulls.source, source!))
        .orderBy(desc(rawPulls.pulledAt))
        .limit(1);

  if (row.length === 0) {
    return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
  }

  const r = row[0];
  return NextResponse.json({
    ok: true,
    id: r.id,
    source: r.source,
    pulledAt: r.pulledAt.toISOString(),
    pullBatchId: r.pullBatchId,
    schemaFingerprint: r.schemaFingerprint,
    rowCount: r.rowCount,
    payload: r.payload,
  });
}

export async function GET(req: Request) {
  return authedHandler(req);
}

export async function POST(req: Request) {
  return authedHandler(req);
}
