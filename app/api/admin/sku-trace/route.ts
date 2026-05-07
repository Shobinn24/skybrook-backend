// One-shot diagnostic: trace a single SKU across the system.
// Returns its presence + state in skus, stock_snapshots, daily_sales,
// and incoming_shipments — used to debug why a SKU is or isn't
// auto-detected as a launch.
import { NextResponse } from "next/server";
import { eq, asc, desc } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  dailySales,
  incomingShipments,
  skus,
  stockSnapshots,
} from "@/lib/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function authedHandler(req: Request) {
  const auth = req.headers.get("authorization") ?? "";
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return NextResponse.json({ ok: false, error: "CRON_SECRET not configured" }, { status: 500 });
  }
  if (auth !== `Bearer ${expected}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const sku = url.searchParams.get("sku");
  if (!sku) {
    return NextResponse.json({ ok: false, error: "sku query param required" }, { status: 400 });
  }

  const skuRow = await db.select().from(skus).where(eq(skus.sku, sku));
  const stockRows = await db
    .select({
      location: stockSnapshots.location,
      snapshotDate: stockSnapshots.snapshotDate,
      onHand: stockSnapshots.onHand,
    })
    .from(stockSnapshots)
    .where(eq(stockSnapshots.sku, sku))
    .orderBy(asc(stockSnapshots.snapshotDate));

  const salesRows = await db
    .select({
      channel: dailySales.channel,
      salesDate: dailySales.salesDate,
      unitsSold: dailySales.unitsSold,
      netSalesUsd: dailySales.netSalesUsd,
    })
    .from(dailySales)
    .where(eq(dailySales.sku, sku))
    .orderBy(desc(dailySales.salesDate));

  const incomingRows = await db
    .select({
      shipmentName: incomingShipments.shipmentName,
      destination: incomingShipments.destination,
      expectedArrival: incomingShipments.expectedArrival,
      quantity: incomingShipments.quantity,
      status: incomingShipments.status,
    })
    .from(incomingShipments)
    .where(eq(incomingShipments.sku, sku));

  const totalUnitsSold = salesRows.reduce((s, r) => s + Number(r.unitsSold), 0);
  const totalRevenueUsd = salesRows.reduce(
    (s, r) => s + Number(r.netSalesUsd ?? 0),
    0,
  );
  const stockNonZero = stockRows.filter((r) => Number(r.onHand) > 0);

  return NextResponse.json({
    ok: true,
    sku,
    inSkusTable: skuRow.length > 0,
    skuRow: skuRow[0] ?? null,
    stockSnapshotCount: stockRows.length,
    stockSnapshotsWithNonZero: stockNonZero.length,
    earliestStockSnapshot: stockRows[0]?.snapshotDate ?? null,
    latestStockSnapshot: stockRows[stockRows.length - 1]?.snapshotDate ?? null,
    salesRowCount: salesRows.length,
    totalUnitsSold,
    totalRevenueUsd: Number(totalRevenueUsd.toFixed(2)),
    incomingRowCount: incomingRows.length,
    incoming: incomingRows,
    sampleStockRows: stockRows.slice(0, 5).concat(stockRows.slice(-5)),
    sampleSalesRows: salesRows.slice(0, 5),
  });
}

export async function GET(req: Request) {
  return authedHandler(req);
}
