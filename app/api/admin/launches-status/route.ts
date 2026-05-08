// Read-only diagnostic for the /launches page auto-populate logic.
//
// Mirrors runLaunchAutoPopulate's per-tuple decision rules so the
// returned `candidates` array shows what would happen on the next run:
//
//   "would_insert"             — passes all filters, would insert
//   "skipped_alt_color"        — alt-color of OG / HW / 9055
//   "skipped_has_stock"        — non-zero stock at the destination
//   "skipped_has_sales"        — recent sales on the destination's channel
//   "skipped_already_launched" — (productName, shipmentName) already in launches
//
// Auth: Bearer CRON_SECRET. Read-only — does not insert or delete.

import { NextResponse } from "next/server";
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  dailySales,
  incomingShipments,
  productLaunches,
  skus,
  stockSnapshots,
} from "@/lib/db/schema";
import { deriveLaunchName, isMainColor } from "@/lib/domain/sku-naming";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SALES_LOOKBACK_DAYS = 60;

function destinationToChannel(dest: string): "shopify_us" | "shopify_intl" {
  return dest === "US" ? "shopify_us" : "shopify_intl";
}

function ymdDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

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

  const rows = await db
    .select({
      sku: incomingShipments.sku,
      productName: skus.productName,
      shipmentName: incomingShipments.shipmentName,
      destination: incomingShipments.destination,
    })
    .from(incomingShipments)
    .innerJoin(skus, eq(incomingShipments.sku, skus.sku));

  const seen = new Set<string>();
  type Tuple = {
    sku: string;
    productName: string | null;
    shipmentName: string;
    destination: string;
  };
  const tuples: Tuple[] = [];
  for (const r of rows) {
    const key = `${r.sku}|${r.shipmentName}|${r.destination}`;
    if (seen.has(key)) continue;
    seen.add(key);
    tuples.push(r);
  }

  const skusInIncoming = Array.from(new Set(tuples.map((t) => t.sku)));
  const stockRows = skusInIncoming.length
    ? await db
        .select({
          sku: stockSnapshots.sku,
          location: stockSnapshots.location,
          onHand: stockSnapshots.onHand,
          snapshotDate: stockSnapshots.snapshotDate,
        })
        .from(stockSnapshots)
        .where(inArray(stockSnapshots.sku, skusInIncoming))
        .orderBy(desc(stockSnapshots.snapshotDate))
    : [];
  const latestStock = new Map<string, number>();
  for (const r of stockRows) {
    const k = `${r.sku}|${r.location}`;
    if (!latestStock.has(k)) latestStock.set(k, r.onHand);
  }

  const since = ymdDaysAgo(SALES_LOOKBACK_DAYS);
  const salesRows = skusInIncoming.length
    ? await db
        .select({
          sku: dailySales.sku,
          channel: dailySales.channel,
          unitsSold: dailySales.unitsSold,
        })
        .from(dailySales)
        .where(and(inArray(dailySales.sku, skusInIncoming), gte(dailySales.salesDate, since)))
    : [];
  const recentSales = new Map<string, number>();
  for (const r of salesRows) {
    const k = `${r.sku}|${r.channel}`;
    recentSales.set(k, (recentSales.get(k) ?? 0) + r.unitsSold);
  }

  const existingKeys = new Set(
    currentLaunches.map((r) => `${r.productName}|${r.shipmentName}`),
  );

  const candidates = tuples.map((t) => {
    const baseName = t.productName ?? t.sku;
    const launchName = deriveLaunchName(t.sku, baseName);
    if (!isMainColor(t.sku)) {
      return { ...t, launchName, decision: "skipped_alt_color" };
    }
    const stock = latestStock.get(`${t.sku}|${t.destination}`) ?? 0;
    if (stock > 0) {
      return { ...t, launchName, decision: "skipped_has_stock", stock };
    }
    const channel = destinationToChannel(t.destination);
    const sales = recentSales.get(`${t.sku}|${channel}`) ?? 0;
    if (sales > 0) {
      return { ...t, launchName, decision: "skipped_has_sales", recentSalesUnits: sales };
    }
    if (existingKeys.has(`${launchName}|${t.shipmentName}`)) {
      return { ...t, launchName, decision: "skipped_already_launched" };
    }
    return { ...t, launchName, decision: "would_insert" };
  });

  const summary = candidates.reduce<Record<string, number>>((acc, c) => {
    acc[c.decision] = (acc[c.decision] ?? 0) + 1;
    return acc;
  }, {});

  const wouldInsertLaunchRows = new Set(
    candidates
      .filter((c) => c.decision === "would_insert")
      .map((c) => `${c.launchName}|${c.shipmentName}`),
  );

  return NextResponse.json({
    ok: true,
    salesLookbackDays: SALES_LOOKBACK_DAYS,
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
