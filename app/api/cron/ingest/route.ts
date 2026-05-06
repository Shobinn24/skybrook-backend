import { NextResponse } from "next/server";
import { runAutoReceiptDetection } from "@/lib/jobs/auto-receipt";
import { runIngest, type SourceKey, type SourceRunner } from "@/lib/jobs/ingest";
import { runLaunchAutoPopulate } from "@/lib/jobs/launches";
import { syncProductNames } from "@/lib/jobs/product-names";
import { runPhase2 } from "@/lib/jobs/reconcile";
import { syncUnitCosts } from "@/lib/jobs/unit-costs";
import {
  sheetsAdSpendRunner,
  sheetsIncomingRunner,
  sheetsInventoryRunner,
} from "@/lib/sources/sheets";
import { shopifyIntlRunner, shopifyUsRunner } from "@/lib/sources/shopify";
import { toEstDate } from "@/lib/tz";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const SOURCES: Partial<Record<SourceKey, SourceRunner>> = {
  sheets_inventory: sheetsInventoryRunner,
  sheets_incoming: sheetsIncomingRunner,
  sheets_ad_spend: sheetsAdSpendRunner,
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
  const productNames = await syncProductNames();
  const unitCosts = await syncUnitCosts();
  // Auto-receipt detection runs after ingest (today's stock snapshot
  // is fresh) and before phase2 (so derived metrics see the updated
  // receipt state, e.g. incoming projections drop the auto-marked POs).
  const autoReceipts = await runAutoReceiptDetection({ asOfDate });
  // Auto-populate launches runs after syncProductNames (so productNames
  // are current) but is independent of phase2 — failures shouldn't
  // block downstream metrics.
  const autoLaunches = await runLaunchAutoPopulate();
  const phase2 = await runPhase2({ asOfDate, pullBatchId: batchId });

  logger.info("cron.ingest.done", {
    batchId,
    asOfDate,
    productNames,
    unitCosts,
    autoReceipts,
    autoLaunches,
    ...phase2,
  });
  return NextResponse.json({
    ok: true,
    batchId,
    asOfDate,
    productNames,
    unitCosts,
    autoReceipts,
    autoLaunches,
    phase2,
  });
}

// Support GET for Railway Cron's default HTTP GET invocation.
export async function GET(req: Request) {
  return POST(req);
}
