// Size-per-review resolution (Scott 2026-07-23, fashion designer request):
// given the order lines matched for one review, decide which sizes to show
// next to it. Pure — the router runs the set-based SQL and feeds rows in,
// so the priority logic is unit-testable without a database.
//
// Priority:
//   1. EXACT — the review carries loox_order_id: sizes come from that
//      order's lines. Lines whose product id belongs to the review's
//      product family win; if none match (e.g. a bundle listing the family
//      map has never seen), every line of the order counts instead.
//   2. HISTORY — no linked order: the reviewer email's past purchases of
//      the same family, most recent first, capped at HISTORY_SIZE_CAP.
//   3. Nothing resolvable — empty, no source.

export type SizeSource = "order" | "history" | null;

export const HISTORY_SIZE_CAP = 4;

function dedupe(titles: string[]): string[] {
  return [...new Set(titles)];
}

export function resolveBoughtSizes(
  looxOrderId: string | null,
  // Lines of the review's own order (exact path); empty when the order is
  // unknown or the sizes table has no rows for it yet.
  orderLines: Array<{ variantTitle: string; inFamily: boolean }>,
  // Distinct family variant titles from order history, most recent first.
  historySizes: string[],
): { boughtSizes: string[]; sizeSource: SizeSource } {
  if (looxOrderId) {
    const familySizes = dedupe(
      orderLines.filter((l) => l.inFamily).map((l) => l.variantTitle),
    );
    const boughtSizes =
      familySizes.length > 0 ? familySizes : dedupe(orderLines.map((l) => l.variantTitle));
    return { boughtSizes, sizeSource: boughtSizes.length > 0 ? "order" : null };
  }
  const boughtSizes = dedupe(historySizes).slice(0, HISTORY_SIZE_CAP);
  return { boughtSizes, sizeSource: boughtSizes.length > 0 ? "history" : null };
}
