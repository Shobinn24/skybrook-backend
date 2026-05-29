// Daily safety-net check: find overdue shipments whose stock actually
// arrived (a real on-hand jump on/after the ETA). Two paths:
//   1. High-confidence arrivals (cumulative-since-ETA >= 50% AND no
//      other unreceived PO is expected for any of the same SKUs at
//      the same destination) — AUTO-MARK as received. Closes the
//      no-one-clicked-the-alert loop that left KAI sub-shipments
//      overdue for 14-19 days through 2026-05-28.
//   2. Lower-confidence arrivals (25%-50% OR competing PO present)
//      — FLAG for human confirm via daily P2 Slack alert (the
//      original safety-net behavior).
// Returns both lists so the cron can write receipts for autoMarked
// and post the alert for flagged.

import { and, eq, gte, inArray, isNull, lt, ne } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  incomingReceipts,
  incomingShipments,
  stockSnapshots,
} from "@/lib/db/schema";
import {
  AUTO_MARK_FROM_EVIDENCE_MIN_PCT,
  detectLikelyArrivedOverdue,
  type ArrivalEvidence,
  type OverdueShipmentLine,
  type SnapshotPoint,
} from "@/lib/domain/arrival-evidence";
import { getReceivedShipmentKeys, shipmentReceiptKey } from "@/lib/queries/incoming";
import { logger } from "@/lib/logger";

function minusDays(ymd: string, days: number): string {
  const ms = 24 * 60 * 60 * 1000;
  return new Date(
    Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(5, 7)) - 1, Number(ymd.slice(8, 10))) -
      days * ms,
  )
    .toISOString()
    .slice(0, 10);
}

export type ArrivalEvidenceResult = {
  /** Lower-confidence arrivals — surface as a P2 confirm-prompt alert. */
  flagged: ArrivalEvidence[];
  /** High-confidence arrivals that were auto-marked received (one
   * incoming_receipts row inserted per evidence row). The cron logs
   * these but does NOT alert — they're closed-loop. */
  autoMarked: ArrivalEvidence[];
};

export async function runArrivalEvidenceCheck(input: {
  asOfDate: string; // YYYY-MM-DD (EST today)
}): Promise<ArrivalEvidenceResult> {
  // Overdue = ETA strictly before today AND no receipt on file (matches
  // the /incoming "overdue" display status).
  const pastDue = await db
    .select()
    .from(incomingShipments)
    .where(lt(incomingShipments.expectedArrival, input.asOfDate));
  if (pastDue.length === 0) return { flagged: [], autoMarked: [] };

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
  if (overdue.length === 0) return { flagged: [], autoMarked: [] };

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

  const evidence = detectLikelyArrivedOverdue({
    overdue,
    snapshots: snapRows as SnapshotPoint[],
  });
  if (evidence.length === 0) return { flagged: [], autoMarked: [] };

  // Partition by auto-mark eligibility. Only evidence with pct >=
  // AUTO_MARK_FROM_EVIDENCE_MIN_PCT (= 0.5) is even considered for
  // auto-marking; the rest stays in `flagged` for the daily P2 alert.
  const autoMarkCandidates = evidence.filter(
    (e) => e.pctOfPo >= AUTO_MARK_FROM_EVIDENCE_MIN_PCT,
  );
  const flaggedOnly = evidence.filter(
    (e) => e.pctOfPo < AUTO_MARK_FROM_EVIDENCE_MIN_PCT,
  );
  if (autoMarkCandidates.length === 0) {
    return { flagged: flaggedOnly, autoMarked: [] };
  }

  // Build the set of SKUs we need to check for competing POs. Anchor
  // by the overdue group's SKUs (different name + same destination +
  // unreceived). One DB round-trip across all candidates.
  const candidateGroups = new Map<
    string,
    { evidence: ArrivalEvidence; skus: Set<string> }
  >();
  for (const e of autoMarkCandidates) {
    const k = `${e.shipmentName}|${e.destination}|${e.expectedArrival}`;
    if (candidateGroups.has(k)) continue;
    const skus = new Set<string>();
    for (const o of overdue) {
      if (
        o.shipmentName === e.shipmentName &&
        o.destination === e.destination &&
        o.expectedArrival === e.expectedArrival
      ) {
        skus.add(o.sku);
      }
    }
    candidateGroups.set(k, { evidence: e, skus });
  }

  const allCandidateSkus = Array.from(
    new Set(
      Array.from(candidateGroups.values()).flatMap((c) => Array.from(c.skus)),
    ),
  );
  // Pull every OTHER unreceived shipment for any candidate SKU at any
  // destination. Conservatism: if ANY other shipmentName has at least
  // one same-SKU unreceived row at the same destination, we don't
  // auto-mark this group — we don't want to attribute incoming stock
  // to the wrong PO. Per memory note in domain layer, same-name
  // sub-shipments (different ETAs under the same shipment_name) do
  // NOT count as competing — those are the same logical PO split.
  const competing = await db
    .select({
      shipmentName: incomingShipments.shipmentName,
      destination: incomingShipments.destination,
      sku: incomingShipments.sku,
      expectedArrival: incomingShipments.expectedArrival,
    })
    .from(incomingShipments)
    .leftJoin(
      incomingReceipts,
      and(
        eq(incomingReceipts.shipmentName, incomingShipments.shipmentName),
        eq(incomingReceipts.destination, incomingShipments.destination),
        eq(incomingReceipts.expectedArrival, incomingShipments.expectedArrival),
      ),
    )
    .where(
      and(
        inArray(incomingShipments.sku, allCandidateSkus),
        isNull(incomingReceipts.id),
      ),
    );

  // (sku|destination) → Set of competing shipment names (excluding
  // the candidate's own shipment_name when we check below)
  const competingByKey = new Map<string, Set<string>>();
  for (const c of competing) {
    const k = `${c.sku}|${c.destination}`;
    const set = competingByKey.get(k) ?? new Set<string>();
    set.add(c.shipmentName);
    competingByKey.set(k, set);
  }

  const autoMarked: ArrivalEvidence[] = [];
  const blockedByCompeting: ArrivalEvidence[] = [];
  for (const { evidence: e, skus } of candidateGroups.values()) {
    let hasCompetitor = false;
    for (const sku of skus) {
      const names = competingByKey.get(`${sku}|${e.destination}`);
      if (!names) continue;
      for (const n of names) {
        if (n !== e.shipmentName) {
          hasCompetitor = true;
          break;
        }
      }
      if (hasCompetitor) break;
    }
    if (hasCompetitor) {
      blockedByCompeting.push(e);
      continue;
    }

    // Write the receipt. Idempotent via the (shipmentName, destination,
    // expectedArrival) unique target — re-runs are safe.
    await db
      .insert(incomingReceipts)
      .values({
        shipmentName: e.shipmentName,
        destination: e.destination,
        expectedArrival: e.expectedArrival,
        note: `Auto-marked ${input.asOfDate}: cumulative-since-ETA arrival evidence (${Math.round(e.pctOfPo * 100)}% of ${e.poQuantity.toLocaleString()}-unit PO observed; peak on ${e.jumpDate}). No competing PO for any of the ${e.trackedLines} tracked SKU lines at ${e.destination}.`,
      })
      .onConflictDoNothing({
        target: [
          incomingReceipts.shipmentName,
          incomingReceipts.destination,
          incomingReceipts.expectedArrival,
        ],
      });
    autoMarked.push(e);
  }

  if (autoMarked.length > 0) {
    logger.info("arrival-evidence.auto-marked", {
      count: autoMarked.length,
      shipments: autoMarked.map((e) => ({
        name: e.shipmentName,
        dest: e.destination,
        eta: e.expectedArrival,
        pct: Math.round(e.pctOfPo * 100),
      })),
    });
  }

  return {
    flagged: [...flaggedOnly, ...blockedByCompeting],
    autoMarked,
  };
}
