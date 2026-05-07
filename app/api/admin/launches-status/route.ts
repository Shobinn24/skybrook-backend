// Read-only diagnostic for the /launches page auto-populate logic.
//
// Returns:
// - currentLaunches: every row in product_launches (newest first)
// - candidates: dry-run preview of (productName, shipmentName) pairs
//   from incoming, with the auto-populate decision for each:
//     "would_insert" | "skipped_existing_product" | "skipped_already_launched" | "skipped_default_name"
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

  // 2. Candidate (productName, shipmentName) pairs from incoming
  const incomingPairs = await db
    .selectDistinct({
      productName: skus.productName,
      shipmentName: incomingShipments.shipmentName,
    })
    .from(incomingShipments)
    .innerJoin(skus, eq(incomingShipments.sku, skus.sku))
    .where(isNotNull(skus.productName));

  // 3. ProductNames with stock history (= "established")
  const stockedRows = await db
    .selectDistinct({ productName: skus.productName })
    .from(skus)
    .innerJoin(stockSnapshots, eq(skus.sku, stockSnapshots.sku))
    .where(isNotNull(skus.productName));
  const productsWithStockHistory = new Set(
    stockedRows.map((r) => r.productName as string),
  );

  // 4. Existing launch keys
  const existingKeys = new Set(
    currentLaunches.map((r) => `${r.productName}|${r.shipmentName}`),
  );

  // 5. Decide outcome for each pair (matches runLaunchAutoPopulate logic)
  const candidates = incomingPairs.map((pair) => {
    const productName = pair.productName as string | null;
    const shipmentName = pair.shipmentName as string;
    if (!productName) {
      return { productName: null, shipmentName, decision: "skipped_null_name" };
    }
    if (productName.startsWith("ev-")) {
      return { productName, shipmentName, decision: "skipped_default_name" };
    }
    if (productsWithStockHistory.has(productName)) {
      return { productName, shipmentName, decision: "skipped_existing_product" };
    }
    const key = `${productName}|${shipmentName}`;
    if (existingKeys.has(key)) {
      return { productName, shipmentName, decision: "skipped_already_launched" };
    }
    return { productName, shipmentName, decision: "would_insert" };
  });

  // 6. Roll up
  const summary = candidates.reduce<Record<string, number>>((acc, c) => {
    acc[c.decision] = (acc[c.decision] ?? 0) + 1;
    return acc;
  }, {});

  return NextResponse.json({
    ok: true,
    currentLaunchesCount: currentLaunches.length,
    currentLaunches,
    candidatePairsCount: candidates.length,
    summary,
    candidates,
  });
}

export async function GET(req: Request) {
  return authedHandler(req);
}

export async function POST(req: Request) {
  return authedHandler(req);
}
