// Monthly bonus auto-send trigger (client spec 2026-08-03). Fired by
// the scheduled workflow on the 1st (with retries later that day); the
// job self-guards on day, env gate, spend freshness, and once-per-month
// idempotence, so extra calls are harmless no-ops. See
// lib/jobs/bonus-auto-send.ts for the full safety model.
import { NextResponse } from "next/server";
import { runMonthlyBonusAutoSend } from "@/lib/jobs/bonus-auto-send";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

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

  try {
    const result = await runMonthlyBonusAutoSend();
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    logger.error("cron.bonus-autosend.failed", { error: String(e) });
    return NextResponse.json(
      { ok: false, error: String(e) },
      { status: 500 },
    );
  }
}
