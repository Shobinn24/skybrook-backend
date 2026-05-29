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
  observedJump: number; // cumulative on-hand increase from the pre-ETA baseline to the post-ETA peak
  jumpDate: string | null; // the post-ETA snapshot date where the peak landed
  pctOfPo: number; // observedJump / poQuantity (0..1+)
};

/** A shipment is flagged "likely arrived" when the CUMULATIVE on-hand
 * increase across its tracked SKUs since the ETA crosses this fraction
 * of the PO quantity. Lower than the auto-receipt band (0.7-1.3×) on
 * purpose — this is a confirm-prompt, not an auto-action, so we want to
 * surface partials too.
 *
 * 2026-05-28: lowered from 0.5 to 0.25 AND switched from "biggest single
 * consecutive-snapshot jump" to cumulative-since-ETA. The single-jump
 * heuristic missed every shipment that trickled in over multiple snapshots
 * (the dominant KAI pattern); 153 of 155 known-arrived CN shipments
 * stayed silently overdue. Cumulative + 25% surfaces them at the cost
 * of a few extra confirm prompts. */
export const LIKELY_ARRIVED_MIN_PCT = 0.25;

/** Cumulative-since-ETA threshold for AUTO-MARKING a PO received
 * (no human click needed). Higher bar than the alert threshold above
 * because a wrong auto-mark is much harder to undo than a missed
 * alert. 50% chosen so partial-but-clearly-arrived KAI shipments
 * (which trickle in over multiple weeks) close themselves once the
 * majority has landed — the 2026-05-29 case where 4 sub-shipments
 * sat overdue for 14-19 days despite cumulative arrivals of 44-97%
 * of PO. Still gated by the no-competing-PO check in
 * lib/jobs/arrival-evidence-check.ts so two overlapping orders for
 * the same SKU never get cross-attributed. */
export const AUTO_MARK_FROM_EVIDENCE_MIN_PCT = 0.5;

const key = (s: { shipmentName: string; destination: "US" | "CN"; expectedArrival: string }) =>
  `${s.shipmentName}|${s.destination}|${s.expectedArrival}`;

/**
 * Find overdue shipments whose stock jumped on/after their ETA — i.e.
 * they almost certainly arrived but were never marked received.
 *
 * Increase = (peak summed on-hand on/after ETA) − (last summed on-hand
 * strictly before ETA), across the shipment's tracked SKUs at its
 * destination. Cumulative since the ETA, NOT a single consecutive-
 * snapshot jump — most KAI deliveries trickle in across multiple
 * snapshot dates so the single-jump heuristic was missing them
 * silently (2026-05-28 incident: 153 of 155 known-arrived CN shipments
 * stayed overdue). Using the pre-ETA baseline as the floor attributes
 * everything that arrived after the ETA to this PO and not to an
 * earlier restock.
 *
 * Falsifiability: this WILL surface a confirm-prompt for any post-ETA
 * stock increase >= 25% of PO even when the cause is actually an
 * earlier-than-expected next PO. That's acceptable — the prompt is
 * confirm-only, never auto-receipt.
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

    // Cumulative-since-ETA: baseline = last summed on-hand strictly
    // BEFORE the ETA (or 0 if no pre-ETA snapshot exists), peak = max
    // summed on-hand on/after the ETA. observedJump = peak − baseline
    // (clamped at 0). Captures multi-snapshot trickled arrivals that
    // the prior single-jump algorithm missed.
    let baseline = 0;
    let peak = 0;
    let jumpDate: string | null = null;
    for (const d of sortedDates) {
      const v = totalByDate.get(d) ?? 0;
      if (d < g.expectedArrival) {
        baseline = v; // keep updating; loop yields the last pre-ETA value
      } else {
        if (jumpDate === null || v > peak) {
          peak = v;
          jumpDate = d;
        }
      }
    }
    // If there's no post-ETA snapshot, peak stays 0 and jumpDate stays
    // null; observedJump ends up 0 (or negative if baseline was positive)
    // — clamp so a sales drawdown can't masquerade as a negative arrival.
    const observedJump = Math.max(0, peak - baseline);

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
