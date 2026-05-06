// One-shot endpoint to run the auto-receipt backfill against historical
// stock snapshots. Auth: same Bearer CRON_SECRET as /api/cron/ingest.
//
// Usage:
//   curl -X POST -H "Authorization: Bearer $CRON_SECRET" \
//     "$APP_URL/api/admin/auto-receipt-backfill?days=30"
//
// `days` is clamped to [1, 90].

import { NextResponse } from "next/server";
import { runAutoReceiptBackfill } from "@/lib/jobs/auto-receipt-backfill";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const maxDuration = 300;
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

  const url = new URL(req.url);
  const daysParam = url.searchParams.get("days");
  const daysBack = daysParam ? Number(daysParam) : 30;
  if (!Number.isFinite(daysBack) || daysBack <= 0) {
    return NextResponse.json(
      { ok: false, error: "days must be a positive number" },
      { status: 400 },
    );
  }

  try {
    const result = await runAutoReceiptBackfill({ daysBack });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    logger.error("auto-receipt-backfill.failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

export async function GET(req: Request) {
  return authedHandler(req);
}
export async function POST(req: Request) {
  return authedHandler(req);
}
