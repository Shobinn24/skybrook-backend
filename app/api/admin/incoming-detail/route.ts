// Read-only diagnostic that returns full incoming_shipments rows for
// reconciliation against the Incoming_new Google sheet. Used to find
// shipments that appear in one source but not the other (Scott
// 2026-05-08 PM: missing men's shipments, May 3rd auto-mark gaps).
//
// Auth: Bearer CRON_SECRET.
// Query params:
//   destination=US|CN              (optional)
//   shipmentName=<exact match>     (optional)
//   skuPattern=<ILIKE pattern>     (optional, e.g. "ev-m%" for men's)
//   etaStart=YYYY-MM-DD            (optional, inclusive)
//   etaEnd=YYYY-MM-DD              (optional, inclusive)
//   includeReceipts=1              (optional — adds matching incoming_receipts row to each shipment)
//
// Returns rows of:
//   { sku, destination, shipmentName, quantity, expectedArrival,
//     status, sourceRowRef, received? }
// sorted by (shipmentName, expectedArrival, sku).
import { NextResponse } from "next/server";
import { and, asc, eq, gte, ilike, lte, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { incomingReceipts, incomingShipments } from "@/lib/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_DESTS = ["US", "CN"] as const;
type Dest = (typeof VALID_DESTS)[number];

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

  const url = new URL(req.url);
  const destinationRaw = url.searchParams.get("destination");
  const destination: Dest | undefined =
    destinationRaw && (VALID_DESTS as readonly string[]).includes(destinationRaw)
      ? (destinationRaw as Dest)
      : undefined;
  if (destinationRaw && !destination) {
    return NextResponse.json(
      { ok: false, error: "destination must be US or CN" },
      { status: 400 },
    );
  }
  const shipmentName = url.searchParams.get("shipmentName") || undefined;
  const skuPattern = url.searchParams.get("skuPattern") || undefined;
  const etaStart = url.searchParams.get("etaStart") || undefined;
  const etaEnd = url.searchParams.get("etaEnd") || undefined;
  const includeReceipts = url.searchParams.get("includeReceipts") === "1";

  for (const [key, val] of [["etaStart", etaStart], ["etaEnd", etaEnd]] as const) {
    if (val !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(val)) {
      return NextResponse.json(
        { ok: false, error: `${key} must be YYYY-MM-DD` },
        { status: 400 },
      );
    }
  }

  const conditions = [];
  if (destination) conditions.push(eq(incomingShipments.destination, destination));
  if (shipmentName) conditions.push(eq(incomingShipments.shipmentName, shipmentName));
  if (skuPattern) conditions.push(ilike(incomingShipments.sku, skuPattern));
  if (etaStart) conditions.push(gte(incomingShipments.expectedArrival, etaStart));
  if (etaEnd) conditions.push(lte(incomingShipments.expectedArrival, etaEnd));

  const baseQuery = db
    .select({
      sku: incomingShipments.sku,
      destination: incomingShipments.destination,
      shipmentName: incomingShipments.shipmentName,
      quantity: incomingShipments.quantity,
      expectedArrival: incomingShipments.expectedArrival,
      status: incomingShipments.status,
      sourceRowRef: incomingShipments.sourceRowRef,
    })
    .from(incomingShipments);
  const rows = await (
    conditions.length > 0 ? baseQuery.where(and(...conditions)) : baseQuery
  ).orderBy(
    asc(incomingShipments.shipmentName),
    asc(incomingShipments.expectedArrival),
    asc(incomingShipments.sku),
  );

  let withReceipts: typeof rows | (typeof rows[number] & { received: boolean; receivedAt: string | null })[] = rows;
  if (includeReceipts) {
    const receiptRows = await db
      .select({
        shipmentName: incomingReceipts.shipmentName,
        destination: incomingReceipts.destination,
        expectedArrival: incomingReceipts.expectedArrival,
        receivedAt: incomingReceipts.receivedAt,
      })
      .from(incomingReceipts);
    const receivedKey = new Map<string, string>();
    for (const r of receiptRows) {
      const key = `${r.shipmentName}|${r.destination}|${r.expectedArrival}`;
      receivedKey.set(key, r.receivedAt.toISOString());
    }
    withReceipts = rows.map((r) => {
      const key = `${r.shipmentName}|${r.destination}|${r.expectedArrival}`;
      const receivedAt = receivedKey.get(key) ?? null;
      return { ...r, received: receivedAt !== null, receivedAt };
    });
  }

  const distinctShipments = await db
    .select({
      shipmentName: incomingShipments.shipmentName,
      destination: incomingShipments.destination,
      expectedArrival: incomingShipments.expectedArrival,
      poCount: sql<number>`count(*)::int`,
      totalQuantity: sql<number>`sum(${incomingShipments.quantity})::int`,
    })
    .from(incomingShipments)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .groupBy(
      incomingShipments.shipmentName,
      incomingShipments.destination,
      incomingShipments.expectedArrival,
    )
    .orderBy(
      asc(incomingShipments.expectedArrival),
      asc(incomingShipments.shipmentName),
      asc(incomingShipments.destination),
    );

  return NextResponse.json({
    ok: true,
    rowCount: rows.length,
    shipmentSummary: distinctShipments,
    rows: withReceipts,
  });
}

export async function GET(req: Request) {
  return authedHandler(req);
}
export async function POST(req: Request) {
  return authedHandler(req);
}
