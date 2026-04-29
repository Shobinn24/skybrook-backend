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
 * @param dailyRate units sold per day. Pass 0 to model "no demand"; the
 *   walker treats every stockLeft as currentStock and every runOutDate
 *   as null.
 * @param today YYYY-MM-DD anchor for the first shipment's window.
 * @param shipments must be sorted ASCENDING by `eta`. The walker does
 *   NOT sort — sorting belongs to the caller so it can apply any
 *   secondary ordering (e.g. tie-break by shipmentName) that test
 *   fixtures may rely on.
 */
export function walkProjection(
  currentStock: number,
  dailyRate: number,
  today: string,
  shipments: ReadonlyArray<ShipmentInput>,
): ProjectionRow[] {
  const out: ProjectionRow[] = [];
  let pivotDays = ymdToDays(today);
  let stock = currentStock;

  for (const ship of shipments) {
    const etaDays = ymdToDays(ship.eta);
    const daysFromPrevious = Math.max(0, etaDays - pivotDays);
    const salesInWindow = dailyRate > 0 ? dailyRate * daysFromPrevious : 0;
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
      const daysToZero = Math.ceil(stock / dailyRate);
      runOutDate = daysToYmd(pivotDays + daysToZero);
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

    pivotDays = etaDays;
    stock = afterReceiptStock;
  }

  return out;
}
