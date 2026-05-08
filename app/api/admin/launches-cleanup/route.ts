// One-shot cleanup endpoint for stale default-named launch placeholders.
//
// When a new SKU prefix appears in incoming before its family label has
// been added to lib/domain/sku-naming.ts, runLaunchAutoPopulate inserts
// a placeholder row with productName = sku ("ev-hrshort-5x-l" etc).
// Once the friendly label is deployed, the next auto-populate run
// inserts a SECOND row under the proper name without dropping the
// placeholder. This endpoint runs the same cleanup that's now baked
// into runLaunchAutoPopulate, in isolation, so the stale rows can be
// dropped immediately without waiting for the next cron tick.
//
// Idempotent. Safe to call repeatedly.
//
// Auth: Bearer CRON_SECRET. POST only.

import { NextResponse } from "next/server";
import { cleanupStaleDefaultLaunches } from "@/lib/jobs/launches";

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

  const deleted = await cleanupStaleDefaultLaunches();
  return NextResponse.json({ ok: true, deleted });
}
