// Auto-detect received shipments by diffing day-over-day stock snapshots.
//
// Heuristic: when a SKU's on-hand jumps from yesterday to today by an
// amount in the same ballpark as an overdue PO's quantity, the most
// likely explanation is "the PO landed and got counted in inventory."
// We mark that PO received automatically. Edge cases push us toward
// being CONSERVATIVE — false positives create wrong stock totals; false
// negatives just mean Scott manually clicks Mark received.
//
// Rules (in order):
//   1. delta must be positive (stock went up).
//   2. Sum of expected sales over the day is added to delta — a PO
//      delivering 200 with 30 sold the same day looks like +170 net,
//      we want it to still match a 200-unit PO.
//   3. Find overdue POs (no receipt yet, ETA <= today, matching
//      sku + destination).
//   4. If exactly one overdue PO exists AND its quantity is within
//      tolerance of the adjusted delta, mark it received.
//   5. If multiple POs match, skip (ambiguous — let the operator pick).
//   6. If no PO is in tolerance, skip (delta is unrelated to a PO,
//      probably a manual correction).

export type StockSnapshot = {
  sku: string;
  location: "US" | "CN";
  onHand: number;
};

export type WindowRow = StockSnapshot & {
  /** YYYY-MM-DD snapshot date this on-hand belongs to. */
  snapshotDate: string;
};

/**
 * Pick the "after" and "before" snapshot sets for day-over-day arrival
 * detection, computed PER LOCATION rather than from one global date.
 *
 * Why per-location: the inventory sheet's US and CN tabs can advance their
 * newest dated column on different days (observed from 2026-05-30). Each tab
 * is ingested under its OWN latest date, so on a given run US's newest
 * snapshot may be dated e.g. 06-01 while CN's is still 05-31. A single global
 * today/yesterday then diffs today's US against yesterday's CN — mismatched
 * regions — and the detector silently sees nothing (and, symmetrically, could
 * read a region reappearing as a phantom jump). Choosing each location's own
 * latest two snapshot dates keeps every diff within-region. It is also
 * resilient to per-location gaps: a location that skipped a day pairs its
 * latest snapshot with whatever date actually precedes it.
 *
 * `rows` should be every snapshot in a recent window (a couple of weeks is
 * plenty); anything dated after `asOfDate` is ignored.
 */
export function selectSnapshotWindow(input: {
  rows: ReadonlyArray<WindowRow>;
  asOfDate: string;
}): {
  afterByLocation: Map<"US" | "CN", string>;
  beforeByLocation: Map<"US" | "CN", string>;
  todaySnapshots: StockSnapshot[];
  yesterdaySnapshots: StockSnapshot[];
} {
  const inWindow = input.rows.filter((r) => r.snapshotDate <= input.asOfDate);
  const afterByLocation = new Map<"US" | "CN", string>();
  const beforeByLocation = new Map<"US" | "CN", string>();
  for (const loc of ["US", "CN"] as const) {
    const dates = Array.from(
      new Set(inWindow.filter((r) => r.location === loc).map((r) => r.snapshotDate)),
    ).sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)); // newest first
    if (dates[0]) afterByLocation.set(loc, dates[0]);
    if (dates[1]) beforeByLocation.set(loc, dates[1]);
  }
  const todaySnapshots: StockSnapshot[] = [];
  const yesterdaySnapshots: StockSnapshot[] = [];
  for (const r of inWindow) {
    const snap: StockSnapshot = { sku: r.sku, location: r.location, onHand: r.onHand };
    if (afterByLocation.get(r.location) === r.snapshotDate) todaySnapshots.push(snap);
    else if (beforeByLocation.get(r.location) === r.snapshotDate) yesterdaySnapshots.push(snap);
  }
  return { afterByLocation, beforeByLocation, todaySnapshots, yesterdaySnapshots };
}

export type OverduePO = {
  sku: string;
  destination: "US" | "CN";
  shipmentName: string;
  expectedArrival: string;
  quantity: number;
};

export type AutoReceipt = {
  shipmentName: string;
  destination: "US" | "CN";
  expectedArrival: string;
  detectedDelta: number;
  poQuantity: number;
  /** Brief audit trail Scott sees when reviewing the receipt. */
  reasoning: string;
};

/** Tolerance band: an adjusted delta within these multipliers of a PO's
 * quantity counts as a match. Loose enough to handle a partial
 * counting day or a few sales nibbling at the inbound, tight enough
 * that a 200-unit PO doesn't get matched to a 50-unit jump. */
const MIN_MULTIPLIER = 0.7;
const MAX_MULTIPLIER = 1.3;

/** Don't trust very small deltas as receipts. Below this threshold a
 * jump is more likely to be a counting tweak than a delivery. */
const MIN_ABSOLUTE_DELTA = 20;

export function detectAutoReceipts(input: {
  todaySnapshots: ReadonlyArray<StockSnapshot>;
  yesterdaySnapshots: ReadonlyArray<StockSnapshot>;
  /** Sales that happened on this same day (per sku × location), so a
   * delivery netted out by sales still matches its PO quantity. Pass an
   * empty array to skip sales adjustment. */
  todaySales: ReadonlyArray<{ sku: string; location: "US" | "CN"; units: number }>;
  /** All POs visible today that have NOT been received yet. ETA in
   * the past or the present day means "overdue / due today" — the
   * stock jump is a plausible candidate for receipt. */
  overduePOs: ReadonlyArray<OverduePO>;
}): AutoReceipt[] {
  // Build today/yesterday lookup maps keyed on (sku, location).
  const yesterdayByKey = new Map<string, number>();
  for (const s of input.yesterdaySnapshots) {
    yesterdayByKey.set(`${s.sku}|${s.location}`, s.onHand);
  }
  const salesByKey = new Map<string, number>();
  for (const s of input.todaySales) {
    salesByKey.set(`${s.sku}|${s.location}`, (salesByKey.get(`${s.sku}|${s.location}`) ?? 0) + s.units);
  }
  // Bucket POs by (sku, location) for quick lookup.
  const posByKey = new Map<string, OverduePO[]>();
  for (const po of input.overduePOs) {
    const k = `${po.sku}|${po.destination}`;
    const bucket = posByKey.get(k) ?? [];
    bucket.push(po);
    posByKey.set(k, bucket);
  }

  const out: AutoReceipt[] = [];
  const matchedShipmentKeys = new Set<string>();
  const shipmentKey = (po: Pick<OverduePO, "shipmentName" | "destination" | "expectedArrival">) =>
    `${po.shipmentName}|${po.destination}|${po.expectedArrival}`;

  // PASS 1 — per-SKU exact matching (the original detector).
  for (const today of input.todaySnapshots) {
    const k = `${today.sku}|${today.location}`;
    const yesterdayHand = yesterdayByKey.get(k);
    if (yesterdayHand === undefined) continue; // no prior snapshot to compare
    const rawDelta = today.onHand - yesterdayHand;
    if (rawDelta <= 0) continue;
    const sales = salesByKey.get(k) ?? 0;
    const adjustedDelta = rawDelta + sales;
    if (adjustedDelta < MIN_ABSOLUTE_DELTA) continue;

    const candidates = posByKey.get(k) ?? [];
    if (candidates.length === 0) continue;

    // Find POs whose quantity is in tolerance of the adjusted delta.
    const inBand = candidates.filter((po) => {
      const ratio = adjustedDelta / po.quantity;
      return ratio >= MIN_MULTIPLIER && ratio <= MAX_MULTIPLIER;
    });
    if (inBand.length !== 1) continue; // 0 or 2+ matches → skip ambiguous

    const po = inBand[0];
    matchedShipmentKeys.add(shipmentKey(po));
    out.push({
      shipmentName: po.shipmentName,
      destination: po.destination,
      expectedArrival: po.expectedArrival,
      detectedDelta: rawDelta,
      poQuantity: po.quantity,
      reasoning:
        `Stock for ${po.sku} jumped from ${yesterdayHand} to ${today.onHand}` +
        (sales > 0 ? ` (+${sales} sold same day)` : ``) +
        ` ≈ ${po.quantity}-unit PO ${po.shipmentName} ETA ${po.expectedArrival}.`,
    });
  }

  // PASS 2 — shipment-level aggregate matching. Scott 2026-05-06 round 2:
  // partial deliveries where individual SKUs come in below/above the
  // 0.7-1.3× band would never match per-SKU, but their SUM across all
  // SKUs in a shipment usually lands close to the shipment total. Sum
  // gives us a stronger signal at the cost of some precision.
  //
  // To avoid mis-attributing one shipment's delivery to another that
  // shares SKUs (e.g., a fresh and a stale Boyshort PO both overdue),
  // we restrict the aggregate to SKUs that are EXCLUSIVE to this
  // shipment among the still-unmatched overdue POs at the same
  // destination. If the exclusive coverage is too thin, we skip
  // rather than guess.
  //
  // Build per-shipment buckets of (sku, quantity) and a (destination,
  // sku) → number-of-shipments index for overlap detection.
  type ShipmentBucket = {
    shipmentName: string;
    destination: "US" | "CN";
    expectedArrival: string;
    skus: Array<{ sku: string; quantity: number }>;
  };
  const shipmentBuckets = new Map<string, ShipmentBucket>();
  const skuOccurrencesAtDest = new Map<string, number>(); // key: sku|dest
  for (const po of input.overduePOs) {
    const sk = shipmentKey(po);
    if (matchedShipmentKeys.has(sk)) continue; // pass-1 already got it
    const bucket = shipmentBuckets.get(sk) ?? {
      shipmentName: po.shipmentName,
      destination: po.destination,
      expectedArrival: po.expectedArrival,
      skus: [],
    };
    bucket.skus.push({ sku: po.sku, quantity: po.quantity });
    shipmentBuckets.set(sk, bucket);
    const dk = `${po.sku}|${po.destination}`;
    skuOccurrencesAtDest.set(dk, (skuOccurrencesAtDest.get(dk) ?? 0) + 1);
  }

  // Threshold: at least half of the shipment's expected qty must come
  // from SKUs exclusive to this shipment for us to trust the aggregate.
  const EXCLUSIVE_COVERAGE_MIN = 0.5;
  // Floor on the exclusive shipment total so we don't fire on tiny
  // shipments where noise dominates signal.
  const SHIPMENT_MIN_EXPECTED = 50;

  for (const bucket of shipmentBuckets.values()) {
    const exclusive = bucket.skus.filter(
      (s) => (skuOccurrencesAtDest.get(`${s.sku}|${bucket.destination}`) ?? 0) === 1,
    );
    const totalExpected = bucket.skus.reduce((n, s) => n + s.quantity, 0);
    const exclusiveExpected = exclusive.reduce((n, s) => n + s.quantity, 0);
    if (exclusiveExpected < SHIPMENT_MIN_EXPECTED) continue;
    if (exclusiveExpected / totalExpected < EXCLUSIVE_COVERAGE_MIN) continue;

    // Sum observed (delta + sales) across exclusive SKUs only.
    let observedSum = 0;
    let positiveJumpCount = 0;
    for (const s of exclusive) {
      const k = `${s.sku}|${bucket.destination}`;
      const today = input.todaySnapshots.find((t) => t.sku === s.sku && t.location === bucket.destination);
      const yest = yesterdayByKey.get(k);
      if (today === undefined || yest === undefined) continue;
      const raw = today.onHand - yest;
      const sales = salesByKey.get(k) ?? 0;
      const contribution = raw + sales;
      // Only count up-jumps + sales — down-jumps are noise (manual
      // adjustments) and would unfairly drag the aggregate down.
      if (contribution > 0) {
        observedSum += contribution;
        if (raw > 0) positiveJumpCount++;
      }
    }

    // Need at least 2 SKUs to actually have jumped — a single jump is
    // pass-1's job and shouldn't trigger an aggregate match.
    if (positiveJumpCount < 2) continue;

    const ratio = observedSum / exclusiveExpected;
    if (ratio < MIN_MULTIPLIER || ratio > MAX_MULTIPLIER) continue;

    out.push({
      shipmentName: bucket.shipmentName,
      destination: bucket.destination,
      expectedArrival: bucket.expectedArrival,
      detectedDelta: observedSum,
      poQuantity: exclusiveExpected,
      reasoning:
        `Aggregate stock jump across ${positiveJumpCount} of ${exclusive.length} ` +
        `exclusive SKUs ≈ ${observedSum.toLocaleString()} units vs ` +
        `${exclusiveExpected.toLocaleString()}-unit shipment ${bucket.shipmentName} ` +
        `ETA ${bucket.expectedArrival}.`,
    });
    matchedShipmentKeys.add(shipmentKey(bucket));
  }

  return out;
}
