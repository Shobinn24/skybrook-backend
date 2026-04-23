import { NextResponse } from "next/server";
import { runIngest, type SourceKey, type SourceRunner } from "@/lib/jobs/ingest";
import { runPhase2 } from "@/lib/jobs/reconcile";
import { sheetsInventoryRunner } from "@/lib/sources/sheets";
import { shopifyIntlRunner, shopifyUsRunner } from "@/lib/sources/shopify";
import { toEstDate } from "@/lib/tz";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const SOURCES: Partial<Record<SourceKey, SourceRunner>> = {
  sheets_inventory: sheetsInventoryRunner,
  shopify_us: shopifyUsRunner,
  shopify_intl: shopifyIntlRunner,
};

export async function POST(req: Request) {
  const auth = req.headers.get("authorization") ?? "";
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return NextResponse.json({ ok: false, error: "CRON_SECRET not configured" }, { status: 500 });
  }
  if (auth !== `Bearer ${expected}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const asOfDate = toEstDate(new Date());
  const batchId = await runIngest({ sources: SOURCES });
  const phase2 = await runPhase2({ asOfDate, pullBatchId: batchId });

  logger.info("cron.ingest.done", { batchId, asOfDate, ...phase2 });
  return NextResponse.json({
    ok: true,
    batchId,
    asOfDate,
    phase2,
  });
}

// Support GET for Railway Cron's default HTTP GET invocation.
export async function GET(req: Request) {
  return POST(req);
}
