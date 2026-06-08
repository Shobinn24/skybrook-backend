// Within-product SKU ordering for the dashboard tabs (overstock, inventory,
// incoming, at-risk). Scott (2026-06-06): keep the product-level sort dynamic,
// but within a product order SKUs largest size -> smallest, grouped by color.
//
// Approach: a SKU is `...-{variant}-{size}` where the trailing token is the
// size and everything before it (product + pack + optional color) is the
// "variant group". Sorting groups alphabetically (so colors land A->Z, e.g.
// gray before pink) and, within a group, by size descending. No explicit
// color parse needed — the prefix already separates variants.

const SIZE_RANK: Record<string, number> = {
  "5xl": 10,
  "4xl": 9,
  "3xl": 8,
  xxxl: 8,
  xxl: 7,
  "2xl": 7,
  xl: 6,
  l: 5,
  m: 4,
  s: 3,
  xs: 2,
  xxs: 1,
};

function sizeToken(sku: string): string {
  const parts = sku.toLowerCase().split("-");
  return parts[parts.length - 1] ?? "";
}

function variantGroup(sku: string): string {
  const parts = sku.toLowerCase().split("-");
  return parts.slice(0, -1).join("-");
}

function sizeRank(sku: string): number {
  return SIZE_RANK[sizeToken(sku)] ?? 0;
}

/**
 * Comparator for SKUs *within a single product*. Groups by variant (color)
 * alphabetically, then orders by size largest -> smallest. Stable tie-break on
 * the size token so unknown/equal sizes keep a deterministic order.
 */
export function compareWithinProduct(a: string, b: string): number {
  const ga = variantGroup(a);
  const gb = variantGroup(b);
  if (ga !== gb) return ga < gb ? -1 : 1;
  const diff = sizeRank(b) - sizeRank(a);
  if (diff !== 0) return diff;
  return sizeToken(a).localeCompare(sizeToken(b));
}
