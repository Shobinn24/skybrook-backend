// Per-delivery sustainability timeline. Mirrors the layout of Scott's
// "Sustainability Check" sheet (`Bshort` tab) which Skybrook is replacing
// the existing flag-status report with — Scott 2026-04-28: "It needs
// to show all the future deliveries with their date. And then answer
// the questions: Will we run out between now and delivery 1? Then
// next will we run out between delivery 1 and delivery 2? And so on."
//
// The math:
//   - Sales over a chosen window (default 14 days) → daily rate.
//   - Walk forward chronologically through every upcoming shipment
//     for the SKU + location.
//   - At each step, compute stock-left-at-ETA = startingStock - (rate
//     × daysSincePrevious). If that crosses zero, surface a runOutDate.
//   - After the shipment lands, afterReceiptStock = stockLeftAtEta +
//     shipmentQty (Scott's sheet does NOT floor at zero — a shortfall
//     is preserved into the next window so the operator sees it).
//   - The next shipment's window starts from this ETA with the new
//     post-receipt stock.

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type ShipmentInput = {
  shipmentName: string;
  eta: string; // YYYY-MM-DD
  quantity: number;
};

export type ProjectionRow = {
  shipmentName: string;
  eta: string; // YYYY-MM-DD
  daysFromPrevious: number; // days since today (1st row) or prior shipment ETA
  salesInWindow: number; // depletion across daysFromPrevious at dailyRate
  stockLeftAtEta: number; // startingStock - salesInWindow (may be negative)
  runOutDate: string | null; // YYYY-MM-DD if startingStock would deplete in this window
  shipmentQty: number;
  afterReceiptStock: number; // stockLeftAtEta + shipmentQty (no flooring)
};

// Pure ymd date math — no Date/timezone games. Inputs/outputs are
// `YYYY-MM-DD` strings interpreted as calendar dates, which is what
// the source sheets work with.
function ymdToDays(ymd: string): number {
  const [y, m, d] = ymd.split("-").map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / MS_PER_DAY);
}

function daysToYmd(days: number): string {
  const ms = days * MS_PER_DAY;
  return new Date(ms).toISOString().slice(0, 10);
}

/** Compute the per-shipment sustainability projection for a single SKU.
 *
 * @param currentStock on-hand at `today` (in 5-pack-equivalent units,
 *   matching the inventory pipeline's canonicalization).
 * @param dailyRate units sold per day at baseline. Pass 0 to model "no
 *   demand"; the walker treats every stockLeft as currentStock and every
 *   runOutDate as null.
 * @param today YYYY-MM-DD anchor for the first shipment's window.
 * @param shipments must be sorted ASCENDING by `eta`. The walker does
 *   NOT sort — sorting belongs to the caller so it can apply any
 *   secondary ordering (e.g. tie-break by shipmentName) that test
 *   fixtures may rely on.
 * @param options.multiplierAt optional per-day multiplier on `dailyRate`.
 *   Returns 1.0 by default if not provided. When provided, the walker
 *   sums sales day-by-day inside each window and finds runOutDate by
 *   the same per-day walk — slower but exact under non-uniform rates.
 *   This is how velocity scaling factors (Scott 2026-05-05) feed in.
 */
export function walkProjection(
  currentStock: number,
  dailyRate: number,
  today: string,
  shipments: ReadonlyArray<ShipmentInput>,
  options?: { multiplierAt?: (ymd: string) => number },
): ProjectionRow[] {
  const out: ProjectionRow[] = [];
  let pivotDays = ymdToDays(today);
  let stock = currentStock;
  // Anchor that carries the most recent computed run-out date forward
  // into subsequent shipment windows where the SKU starts already OOS
  // (stock <= 0 at the pivot). Scott 2026-05-15: if a SKU runs out
  // before shipment 1 and stays OOS, future shipment cells should keep
  // showing the same run-out date rather than recomputing a fresh
  // (often nonsensical) date or rendering "—". Anchor is replaced
  // whenever a fresh date is computed (i.e. the SKU recovered and
  // entered a window with stock > 0), preserving the "compute fresh on
  // recovery" property.
  let lastRunOutDate: string | null = null;
  const useMultiplier = !!options?.multiplierAt;
  const multiplierAt = options?.multiplierAt;

  for (const ship of shipments) {
    const etaDays = ymdToDays(ship.eta);
    const daysFromPrevious = Math.max(0, etaDays - pivotDays);

    // Sum sales across the window. Constant-rate path stays the simple
    // multiplication; multiplier-aware path iterates per-day.
    let salesInWindow = 0;
    if (dailyRate > 0) {
      if (useMultiplier && multiplierAt) {
        for (let d = 0; d < daysFromPrevious; d++) {
          const m = Math.max(0, multiplierAt(daysToYmd(pivotDays + d)));
          salesInWindow += dailyRate * m;
        }
      } else {
        salesInWindow = dailyRate * daysFromPrevious;
      }
    }
    const stockLeftAtEta = stock - salesInWindow;

    // Run-out date is always projected forward from the pivot at the
    // current rate, even if the upcoming shipment would intervene —
    // Scott's sheet uses this as a "without further intervention"
    // indicator, not a strict shortfall flag. The colored flag (built
    // separately on top of stockLeftAtEta < 0) is what operators
    // actually trigger off; the date is informational.
    //
    // Skipped only when there's no demand (rate=0) or no stock to
    // burn through (stock <= 0 at the start of the window — already
    // out, no future date is meaningful).
    let runOutDate: string | null = null;
    if (dailyRate > 0 && stock > 0) {
      if (useMultiplier && multiplierAt) {
        // Walk day-by-day until stock crosses 0. Bound the search to
        // avoid an infinite loop if every future day carries a
        // 0-multiplier (no demand). The floor of ~3 years (1095d)
        // matters for overdue columns where daysFromPrevious is 0 —
        // with the old `+365` cap, high-stock SKUs whose runOut sat
        // 366+ days out would silently render as "—".
        const maxDaysAhead = Math.max(daysFromPrevious + 365, 1095);
        let runningStock = stock;
        for (let d = 0; d < maxDaysAhead; d++) {
          const m = Math.max(0, multiplierAt(daysToYmd(pivotDays + d)));
          runningStock -= dailyRate * m;
          if (runningStock <= 0) {
            runOutDate = daysToYmd(pivotDays + d);
            break;
          }
        }
      } else {
        const daysToZero = Math.ceil(stock / dailyRate);
        runOutDate = daysToYmd(pivotDays + daysToZero);
      }
      // Fresh compute — replace the anchor (including with null when
      // stock holds through the horizon). Acts as the "recovery clears"
      // path for the carry-forward rule.
      lastRunOutDate = runOutDate;
    } else if (dailyRate > 0 && stock <= 0) {
      // Already OOS at start of this window — carry forward the most
      // recent anchor instead of rendering "—" (null when no prior
      // window ever set one, e.g. SKU was OOS at `today`).
      runOutDate = lastRunOutDate;
    }
    const afterReceiptStock = stockLeftAtEta + ship.quantity;

    out.push({
      shipmentName: ship.shipmentName,
      eta: ship.eta,
      daysFromPrevious,
      salesInWindow: Number(salesInWindow.toFixed(2)),
      stockLeftAtEta: Number(stockLeftAtEta.toFixed(2)),
      runOutDate,
      shipmentQty: ship.quantity,
      afterReceiptStock: Number(afterReceiptStock.toFixed(2)),
    });

    // Don't let past ETAs rewind the pivot — that would invent phantom
    // sales between two overdue shipments (the time between their ETAs
    // has already passed in real life). For overdue rows daysFromPrevious
    // already clamps to 0; this preserves the same property for the
    // NEXT iteration's window.
    pivotDays = Math.max(pivotDays, etaDays);
    stock = afterReceiptStock;
  }

  return out;
}

/** Resolve the multiplier that applies to a given calendar day for a
 * given product. Override scope:
 *   - `productName: null` → applies to every product at the location
 *     (brand-level)
 *   - `productName: "Mens 3-Pack"` → applies only to that product
 *
 * Resolution rule for a (ymd, productName) pair:
 *   1. Product-scoped overrides whose product matches and date range
 *      covers `ymd` win first (operator-most-specific).
 *   2. Brand-level (null product) overrides come next.
 *   3. Default (no match) is 1.0.
 *
 * First-match wins inside each tier; callers control tier-internal
 * ordering. Layering "+10% all products" with "+30% Mens" gives Mens
 * +30% on overlapping days, every other product +10%.
 */
export type VelocityOverride = {
  startDate: string; // YYYY-MM-DD inclusive
  endDate: string; // YYYY-MM-DD inclusive
  multiplier: number;
  /** null = brand-level (applies to all products). Otherwise must
   * match `skus.product_name` for the override to apply. */
  productName: string | null;
};

export function resolveMultiplier(
  ymd: string,
  productName: string,
  overrides: ReadonlyArray<VelocityOverride>,
): number {
  // Tier 1: product-specific overrides.
  for (const o of overrides) {
    if (
      o.productName !== null &&
      o.productName === productName &&
      ymd >= o.startDate &&
      ymd <= o.endDate
    ) {
      return o.multiplier;
    }
  }
  // Tier 2: brand-level (null product) overrides.
  for (const o of overrides) {
    if (o.productName === null && ymd >= o.startDate && ymd <= o.endDate) {
      return o.multiplier;
    }
  }
  return 1.0;
}
