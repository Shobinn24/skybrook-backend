// Read-only diagnostic that returns the same per-brand rollup the
// /performance dashboard shows, callable from the CLI for reconciliation
// against external daily reports.
//
// Auth: Bearer CRON_SECRET.
// Query params:
//   today=YYYY-MM-DD   anchor (defaults to current EST date)
//   rangeDays=1|7|14|30   defaults to 1 (yesterday only)
//
// Example:
//   curl -H "Authorization: Bearer $CRON_SECRET" \
//     "$URL/api/admin/performance-day?today=2026-05-07&rangeDays=1"
import { NextResponse } from "next/server";
import { getPerformanceRollup } from "@/lib/queries/performance";
import { toEstDate } from "@/lib/tz";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_RANGE = [1, 7, 14, 30] as const;

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
  const today = url.searchParams.get("today") ?? toEstDate(new Date());
  const rangeDaysRaw = Number(url.searchParams.get("rangeDays") ?? "1");
  const rangeDays = (VALID_RANGE as readonly number[]).includes(rangeDaysRaw)
    ? rangeDaysRaw
    : 1;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) {
    return NextResponse.json(
      { ok: false, error: "today must be YYYY-MM-DD" },
      { status: 400 },
    );
  }

  const result = await getPerformanceRollup({ today, rangeDays });
  return NextResponse.json({ ok: true, ...result });
}

export async function GET(req: Request) {
  return authedHandler(req);
}

export async function POST(req: Request) {
  return authedHandler(req);
}
