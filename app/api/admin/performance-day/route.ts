// Read-only diagnostic that returns the same per-brand rollup the
// /performance dashboard shows, callable from the CLI for reconciliation
// against external daily reports.
//
// Auth: Bearer CRON_SECRET.
// Query params:
//   today=YYYY-MM-DD          anchor (defaults to current EST date)
//   rangeDays=1|7|14|30       defaults to 1 (yesterday only)
//   channel=shopify_us|shopify_intl  optional revenue filter; when set,
//                             revenue rolls up only that store. Spend
//                             is unaffected (ad-spend tabs aren't
//                             channel-tagged uniformly).
//
// Example:
//   curl -H "Authorization: Bearer $CRON_SECRET" \
//     "$URL/api/admin/performance-day?today=2026-05-07&rangeDays=1&channel=shopify_intl"
import { NextResponse } from "next/server";
import {
  getPerformanceRollup,
  type SalesChannel,
} from "@/lib/queries/performance";
import { toEstDate } from "@/lib/tz";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_RANGE = [1, 7, 14, 30] as const;
const VALID_CHANNELS = ["shopify_us", "shopify_intl"] as const;

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
  const channelRaw = url.searchParams.get("channel");
  const channel: SalesChannel | undefined =
    channelRaw && (VALID_CHANNELS as readonly string[]).includes(channelRaw)
      ? (channelRaw as SalesChannel)
      : undefined;
  if (channelRaw && !channel) {
    return NextResponse.json(
      { ok: false, error: "channel must be shopify_us or shopify_intl" },
      { status: 400 },
    );
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) {
    return NextResponse.json(
      { ok: false, error: "today must be YYYY-MM-DD" },
      { status: 400 },
    );
  }

  const result = await getPerformanceRollup({ today, rangeDays, channel });
  return NextResponse.json({ ok: true, channel: channel ?? "all", ...result });
}

export async function GET(req: Request) {
  return authedHandler(req);
}

export async function POST(req: Request) {
  return authedHandler(req);
}
