import { NextResponse } from "next/server";
import { runLooxAnalysis } from "@/lib/jobs/loox-analysis";
import { runLooxIngest } from "@/lib/jobs/loox-ingest";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

// Loox reviews pipeline: poll the forwarding inbox, then re-analyze any
// product with new reviews. Dormant until LOOX_IMAP_* / ANTHROPIC_API_KEY
// are set, so this route is safe to schedule ahead of the inbox existing.
// Also invoked at the end of the two scheduled cron sweeps.
export async function POST(req: Request) {
  const auth = req.headers.get("authorization") ?? "";
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return NextResponse.json({ ok: false, error: "CRON_SECRET not configured" }, { status: 500 });
  }
  if (auth !== `Bearer ${expected}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const ingest = await runLooxIngest();
  const analysis = ingest.configured ? await runLooxAnalysis() : null;
  return NextResponse.json({ ok: true, ingest, analysis });
}

// Railway native cron invokes via GET.
export async function GET(req: Request) {
  return POST(req);
}
