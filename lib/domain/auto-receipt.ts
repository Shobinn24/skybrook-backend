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

  return out;
}
