import { NextResponse } from "next/server";
import { runLooxApiSync } from "@/lib/jobs/loox-api-sync";
import { runLooxIngest } from "@/lib/jobs/loox-ingest";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

// Loox reviews pipeline. Primary path is the Merchant API sync over both
// stores (main + intl, cross-store dedup); the forwarding-inbox ingest runs
// after it as a fallback for any window where API access lapses. Both jobs
// are dormant until their env vars exist, so this route is safe to schedule
// ahead of configuration. Also invoked at the end of the two scheduled cron
// sweeps. Pass ?full=1 to re-walk all Loox history (catches moderation
// changes on old reviews that the incremental window can't see).
//
// No scheduled Claude analysis by design (Scott 2026-07-13): reviews are
// stored and aggregated in SQL for free; Claude only runs when someone asks
// a question in the reviews chat.
export async function POST(req: Request) {
  const auth = req.headers.get("authorization") ?? "";
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return NextResponse.json({ ok: false, error: "CRON_SECRET not configured" }, { status: 500 });
  }
  if (auth !== `Bearer ${expected}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const full = new URL(req.url).searchParams.get("full") === "1";
  const apiSync = await runLooxApiSync({ full });
  const ingest = await runLooxIngest();
  // Purchase verification: pull fresh order emails from both Shopify
  // stores, then restamp every review's verified/unverified/unknown flag.
  // Best-effort — a Shopify hiccup must not fail the review sync.
  let purchase = null;
  try {
    const { runPurchaseVerification } = await import("@/lib/jobs/shopify-order-emails");
    purchase = await runPurchaseVerification();
  } catch (e) {
    console.error("purchase verification failed", e);
  }
  return NextResponse.json({ ok: true, apiSync, ingest, purchase });
}

// Railway native cron invokes via GET.
export async function GET(req: Request) {
  return POST(req);
}
