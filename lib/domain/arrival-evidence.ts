// Safety net for the auto-receipt detector.
//
// The auto-receipt detector (lib/domain/auto-receipt.ts) is deliberately
// conservative — it only marks a PO received when a stock jump cleanly
// matches its quantity. That means partial deliveries, deliveries spread
// thin across many small SKUs, and arrivals that land right after a
// snapshot gap are NEVER auto-cleared, and the shipment sits "overdue"
// silently until a human notices (2026-05-27: Scott caught the May-10
// KAI deliveries this way).
//
// This module closes that gap WITHOUT touching stock totals: it scans
// overdue shipments for *evidence* that their stock actually arrived
// (a real jump in on-hand on/after the ETA) and surfaces them so an
// operator can confirm receipt with one click. It never inserts a
// receipt itself — false positives here only cost a confirmation prompt,
// never a wrong stock number.

export type OverdueShipmentLine = {
  shipmentName: string;
  destination: "US" | "CN";
  expectedArrival: string; // YYYY-MM-DD
  sku: string;
  quantity: number;
};

export type SnapshotPoint = {
  sku: string;
  location: "US" | "CN";
  snapshotDate: string; // YYYY-MM-DD
  onHand: number;
};

export type ArrivalEvidence = {
  shipmentName: string;
  destination: "US" | "CN";
  expectedArrival: string;
  poQuantity: number; // total expected across all lines (tracked + untracked)
  totalLines: number;
  trackedLines: number; // lines whose SKU we can see in snapshots
  observedJump: number; // biggest consecutive-snapshot on-hand increase on/after ETA
  jumpDate: string | null; // the snapshot date the jump landed on
  pctOfPo: number; // observedJump / poQuantity (0..1+)
};

/** A shipment is flagged "likely arrived" when the on-hand of its tracked
 * SKUs jumped by at least this fraction of the PO quantity on/after the
 * ETA. Lower than the auto-receipt band (0.7-1.3×) on purpose — this is a
 * confirm-prompt, not an auto-action, so we want to surface partials too. */
export const LIKELY_ARRIVED_MIN_PCT = 0.5;

const key = (s: { shipmentName: string; destination: "US" | "CN"; expectedArrival: string }) =>
  `${s.shipmentName}|${s.destination}|${s.expectedArrival}`;

/**
 * Find overdue shipments whose stock jumped on/after their ETA — i.e.
 * they almost certainly arrived but were never marked received.
 *
 * Jump = the largest increase in summed on-hand (across the shipment's
 * tracked SKUs at its destination) between two consecutive snapshot
 * dates where the LATER date is on/after the ETA. Constraining to
 * on/after the ETA attributes the jump to THIS PO rather than an earlier
 * restock of the same SKUs.
 */
export function detectLikelyArrivedOverdue(input: {
  overdue: ReadonlyArray<OverdueShipmentLine>;
  snapshots: ReadonlyArray<SnapshotPoint>;
  minPct?: number;
}): ArrivalEvidence[] {
  const minPct = input.minPct ?? LIKELY_ARRIVED_MIN_PCT;

  // (sku|location) → date → onHand
  const onHandBySkuLoc = new Map<string, Map<string, number>>();
  const datesPresent = new Set<string>();
  for (const s of input.snapshots) {
    const k = `${s.sku}|${s.location}`;
    const byDate = onHandBySkuLoc.get(k) ?? new Map<string, number>();
    byDate.set(s.snapshotDate, s.onHand);
    onHandBySkuLoc.set(k, byDate);
    datesPresent.add(s.snapshotDate);
  }
  const sortedDates = [...datesPresent].sort();

  // Group overdue lines into shipments.
  type Group = {
    shipmentName: string;
    destination: "US" | "CN";
    expectedArrival: string;
    skus: string[];
    poQuantity: number;
  };
  const groups = new Map<string, Group>();
  for (const line of input.overdue) {
    const k = key(line);
    const g = groups.get(k) ?? {
      shipmentName: line.shipmentName,
      destination: line.destination,
      expectedArrival: line.expectedArrival,
      skus: [],
      poQuantity: 0,
    };
    g.skus.push(line.sku);
    g.poQuantity += line.quantity;
    groups.set(k, g);
  }

  const out: ArrivalEvidence[] = [];
  for (const g of groups.values()) {
    const trackedSkus = g.skus.filter((sku) => onHandBySkuLoc.has(`${sku}|${g.destination}`));

    // Summed on-hand across tracked SKUs per snapshot date.
    const totalByDate = new Map<string, number>();
    for (const sku of trackedSkus) {
      const byDate = onHandBySkuLoc.get(`${sku}|${g.destination}`)!;
      for (const [d, v] of byDate) {
        totalByDate.set(d, (totalByDate.get(d) ?? 0) + v);
      }
    }

    // Biggest consecutive-snapshot increase landing on/after the ETA.
    let observedJump = 0;
    let jumpDate: string | null = null;
    for (let i = 1; i < sortedDates.length; i++) {
      const d = sortedDates[i];
      if (d < g.expectedArrival) continue; // later date must be on/after ETA
      const prev = sortedDates[i - 1];
      const delta = (totalByDate.get(d) ?? 0) - (totalByDate.get(prev) ?? 0);
      if (delta > observedJump) {
        observedJump = delta;
        jumpDate = d;
      }
    }

    const pctOfPo = g.poQuantity > 0 ? observedJump / g.poQuantity : 0;
    if (trackedSkus.length > 0 && pctOfPo >= minPct) {
      out.push({
        shipmentName: g.shipmentName,
        destination: g.destination,
        expectedArrival: g.expectedArrival,
        poQuantity: g.poQuantity,
        totalLines: g.skus.length,
        trackedLines: trackedSkus.length,
        observedJump,
        jumpDate,
        pctOfPo,
      });
    }
  }

  // Most-confident first.
  out.sort((a, b) => b.pctOfPo - a.pctOfPo);
  return out;
}
