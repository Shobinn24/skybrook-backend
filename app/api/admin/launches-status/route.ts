// Read-only diagnostic for the /launches page auto-populate logic.
//
// Mirrors runLaunchAutoPopulate's variant-level decision rules
// (Scott 2026-05-07): a SKU with no prior stock_snapshots history
// triggers a launch row even when its productName has prior history.
//
// Returns:
// - currentLaunches: every row in product_launches (newest first)
// - candidates: dry-run preview of (sku, productName, shipmentName)
//   tuples from incoming, with the auto-populate decision for each:
//     "would_insert" | "skipped_existing_variant" |
//     "skipped_already_launched" | "skipped_default_name" | "skipped_null_name"
//
// Auth: Bearer CRON_SECRET. Read-only — does not insert anything.
import { NextResponse } from "next/server";
import { desc, eq, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  incomingShipments,
  productLaunches,
  skus,
  stockSnapshots,
} from "@/lib/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

  // 1. Current launches table
  const currentLaunches = await db
    .select({
      id: productLaunches.id,
      productName: productLaunches.productName,
      shipmentName: productLaunches.shipmentName,
      intlSiteLive: productLaunches.intlSiteLive,
      intlLaunchDate: productLaunches.intlLaunchDate,
      usSiteLive: productLaunches.usSiteLive,
      usLaunchDate: productLaunches.usLaunchDate,
      note: productLaunches.note,
      createdAt: productLaunches.createdAt,
    })
    .from(productLaunches)
    .orderBy(desc(productLaunches.createdAt));

  // 2. Candidate (sku, productName, shipmentName) tuples from incoming.
  //    Dedupe at SKU level so a SKU appearing across multiple POs in
  //    the same shipment counts once.
  const rows = await db
    .select({
      sku: incomingShipments.sku,
      productName: skus.productName,
      shipmentName: incomingShipments.shipmentName,
    })
    .from(incomingShipments)
    .innerJoin(skus, eq(incomingShipments.sku, skus.sku))
    .where(isNotNull(skus.productName));
  const seen = new Set<string>();
  const tuples: Array<{ sku: string; productName: string | null; shipmentName: string }> = [];
  for (const r of rows) {
    const key = `${r.sku}|${r.shipmentName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    tuples.push({
      sku: r.sku,
      productName: r.productName,
      shipmentName: r.shipmentName,
    });
  }

  // 3. SKUs with stock history (= "established variants")
  const stockedRows = await db
    .selectDistinct({ sku: stockSnapshots.sku })
    .from(stockSnapshots);
  const skusWithStockHistory = new Set(stockedRows.map((r) => r.sku));

  // 4. Existing launch keys
  const existingKeys = new Set(
    currentLaunches.map((r) => `${r.productName}|${r.shipmentName}`),
  );

  // 5. Decide outcome for each tuple (matches runLaunchAutoPopulate)
  const candidates = tuples.map((t) => {
    if (!t.productName) {
      return {
        sku: t.sku,
        productName: null,
        shipmentName: t.shipmentName,
        decision: "skipped_null_name",
      };
    }
    if (t.productName.startsWith("ev-")) {
      return {
        sku: t.sku,
        productName: t.productName,
        shipmentName: t.shipmentName,
        decision: "skipped_default_name",
      };
    }
    if (skusWithStockHistory.has(t.sku)) {
      return {
        sku: t.sku,
        productName: t.productName,
        shipmentName: t.shipmentName,
        decision: "skipped_existing_variant",
      };
    }
    const key = `${t.productName}|${t.shipmentName}`;
    if (existingKeys.has(key)) {
      return {
        sku: t.sku,
        productName: t.productName,
        shipmentName: t.shipmentName,
        decision: "skipped_already_launched",
      };
    }
    return {
      sku: t.sku,
      productName: t.productName,
      shipmentName: t.shipmentName,
      decision: "would_insert",
    };
  });

  // 6. Roll up
  const summary = candidates.reduce<Record<string, number>>((acc, c) => {
    acc[c.decision] = (acc[c.decision] ?? 0) + 1;
    return acc;
  }, {});

  // Distinct (productName, shipmentName) pairs that would actually
  // produce a launch row (since multiple new SKUs in same shipment
  // dedupe to one launch).
  const wouldInsertLaunchRows = new Set(
    candidates
      .filter((c) => c.decision === "would_insert")
      .map((c) => `${c.productName}|${c.shipmentName}`),
  );

  return NextResponse.json({
    ok: true,
    currentLaunchesCount: currentLaunches.length,
    currentLaunches,
    candidatePairsCount: candidates.length,
    summary,
    wouldInsertLaunchRowCount: wouldInsertLaunchRows.size,
    candidates,
  });
}

export async function GET(req: Request) {
  return authedHandler(req);
}

export async function POST(req: Request) {
  return authedHandler(req);
}
