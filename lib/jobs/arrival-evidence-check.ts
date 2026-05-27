// Daily safety-net check: find overdue shipments whose stock actually
// arrived (a real on-hand jump on/after the ETA) but were never marked
// received — the silent gap the conservative auto-receipt detector
// leaves behind. Read-only: it returns evidence for the cron to alert
// on; it never writes receipts or stock.

import { and, gte, lt } from "drizzle-orm";
import { db } from "@/lib/db";
import { incomingShipments, stockSnapshots } from "@/lib/db/schema";
import {
  detectLikelyArrivedOverdue,
  type ArrivalEvidence,
  type OverdueShipmentLine,
  type SnapshotPoint,
} from "@/lib/domain/arrival-evidence";
import { getReceivedShipmentKeys, shipmentReceiptKey } from "@/lib/queries/incoming";

function minusDays(ymd: string, days: number): string {
  const ms = 24 * 60 * 60 * 1000;
  return new Date(
    Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(5, 7)) - 1, Number(ymd.slice(8, 10))) -
      days * ms,
  )
    .toISOString()
    .slice(0, 10);
}

export async function runArrivalEvidenceCheck(input: {
  asOfDate: string; // YYYY-MM-DD (EST today)
}): Promise<ArrivalEvidence[]> {
  // Overdue = ETA strictly before today AND no receipt on file (matches
  // the /incoming "overdue" display status).
  const pastDue = await db
    .select()
    .from(incomingShipments)
    .where(lt(incomingShipments.expectedArrival, input.asOfDate));
  if (pastDue.length === 0) return [];

  const receivedKeys = await getReceivedShipmentKeys();
  const overdue: OverdueShipmentLine[] = [];
  let earliestEta = input.asOfDate;
  for (const r of pastDue) {
    const k = shipmentReceiptKey({
      shipmentName: r.shipmentName,
      destination: r.destination,
      expectedArrival: r.expectedArrival,
    });
    if (receivedKeys.has(k)) continue;
    overdue.push({
      shipmentName: r.shipmentName,
      destination: r.destination,
      expectedArrival: r.expectedArrival,
      sku: r.sku,
      quantity: r.quantity,
    });
    if (r.expectedArrival < earliestEta) earliestEta = r.expectedArrival;
  }
  if (overdue.length === 0) return [];

  // Pull snapshots from a week before the earliest overdue ETA through
  // today — enough to see the pre-jump baseline and any post-ETA jump.
  const windowStart = minusDays(earliestEta, 7);
  const snapRows = await db
    .select({
      sku: stockSnapshots.sku,
      location: stockSnapshots.location,
      snapshotDate: stockSnapshots.snapshotDate,
      onHand: stockSnapshots.onHand,
    })
    .from(stockSnapshots)
    .where(
      and(
        gte(stockSnapshots.snapshotDate, windowStart),
        lt(stockSnapshots.snapshotDate, minusDays(input.asOfDate, -1)), // <= today
      ),
    );

  return detectLikelyArrivedOverdue({
    overdue,
    snapshots: snapRows as SnapshotPoint[],
  });
}
