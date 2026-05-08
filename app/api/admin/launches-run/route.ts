// One-shot trigger for runLaunchAutoPopulate. Lets us run the
// detection + cleanup logic immediately after a code change without
// waiting for the next cron tick (14:00 UTC daily). Idempotent —
// re-running won't duplicate launches because (productName,
// shipmentName) is unique-indexed.
//
// Auth: Bearer CRON_SECRET. POST only.

import { NextResponse } from "next/server";
import { runLaunchAutoPopulate } from "@/lib/jobs/launches";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
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

  const result = await runLaunchAutoPopulate();
  return NextResponse.json({ ok: true, result });
}
