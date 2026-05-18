/**
 * Static config for the Factory Order Automation product groups.
 *
 * Spec: docs/factory-order-spec/factory-order-automation.md §5
 *
 * Two flavors:
 *   - "calculated" — the MOS chain (§3.1) runs against per-SKU sales,
 *     stock, and incoming data to produce a Qty to Order.
 *   - "custom" — the user enters a total quantity and it gets
 *     distributed across sizes using a standard size-percentage curve
 *     (§4.2).
 *
 * Some products appear in BOTH lists (Super HW, Shapewear, Cotton
 * Hipster, etc.) — the user picks mode per-product per-month. We
 * model that as two separate entries with different `name`s so the
 * dashboard can show both options.
 */

/** Size-distribution curve used to allocate a custom total across SKUs. */
export type SizeCurve =
  | "standard10" // women's 10-size
  | "boyshort"   // 10-size, biased differently from standard
  | "mens6";     // 6-size men's

/**
 * Spec §4.2 — standard 10-size curve for most women's products.
 * Percentages sum to 100.01% (spec rounding); we re-normalize at
 * compute time via the largest-bucket-balancing rule (§4.3).
 */
export const STANDARD_10_CURVE: Record<string, number> = {
  xxs: 2.25,
  xs: 1.44,
  s: 4.75,
  m: 14.56,
  l: 25.13,
  xl: 24.25,
  xxl: 13.88,
  "3xl": 6.06,
  "4xl": 3.69,
  "5xl": 4.0,
};

export const BOYSHORT_10_CURVE: Record<string, number> = {
  xxs: 2.83,
  xs: 2.17,
  s: 5.17,
  m: 14.17,
  l: 24.0,
  xl: 23.17,
  xxl: 13.5,
  "3xl": 6.33,
  "4xl": 4.17,
  "5xl": 4.5,
};

export const MENS_6_CURVE: Record<string, number> = {
  s: 6.77,
  m: 23.23,
  l: 27.5,
  xl: 21.83,
  xxl: 10.63,
  "3xl": 10.03,
};

export const SIZE_CURVES: Record<SizeCurve, Record<string, number>> = {
  standard10: STANDARD_10_CURVE,
  boyshort: BOYSHORT_10_CURVE,
  mens6: MENS_6_CURVE,
};

// ---------------------------------------------------------------------
// Calculated product groups (Spec §5.1)
// ---------------------------------------------------------------------

export type CalculatedGroup = {
  kind: "calculated";
  /** Display name shown in the dashboard + Excel sheet. */
  name: string;
  /**
   * Prefix used to enumerate the SKUs that belong to this group from
   * the `skus` table. Match is case-insensitive, anchored to the
   * start of the SKU code, and bounded by an extra check on size
   * suffix so e.g. `ev-bshort-5x-` doesn't pick up `ev-bshort-fc-5x-*`.
   */
  skuPrefix: string;
  /** Allowed size suffixes after the prefix (lowercase). */
  sizes: ReadonlyArray<string>;
  /**
   * Main-line membership. The three Main Line groups (9055 Main, OG
   * Main, HW Main) share a common demand pool — Current Split is
   * computed across just these three, and Change Split overrides
   * apply to them only.
   */
  isMainLine?: boolean;
};

const TEN_SIZES = ["xxs", "xs", "s", "m", "l", "xl", "xxl", "3xl", "4xl", "5xl"] as const;
// OG Main uses `xxxl` instead of `3xl` per the actual catalog (the
// spec's "3xl" notation in §5.1 is the conceptual size, not the
// literal suffix Shopify uses for the ev-mixed-* line).
const TEN_SIZES_OG_MAIN = ["xxs", "xs", "s", "m", "l", "xl", "xxl", "xxxl", "4xl", "5xl"] as const;
const NINE_SIZES_NO_5XL = ["xxs", "xs", "s", "m", "l", "xl", "xxl", "3xl", "4xl"] as const;
const EIGHT_SIZES_HIPSTER = ["xxs", "xs", "s", "m", "l", "xl", "xxl", "3xl"] as const;
const EIGHT_SIZES_HW1X = ["xxs", "xs", "s", "m", "l", "xl", "xxl", "3xl"] as const;
const MENS_SIZES = ["s", "m", "l", "xl", "xxl", "3xl"] as const;

export const CALCULATED_GROUPS: ReadonlyArray<CalculatedGroup> = [
  // Main Line — shared split logic
  {
    kind: "calculated",
    name: "9055 Main",
    skuPrefix: "ev-9055-5x-",
    sizes: TEN_SIZES,
    isMainLine: true,
  },
  {
    // Production catalog uses `ev-mixed-*` for the OG 5-Pack family
    // (not `ev-pp-og-*` as in the spec text — the spec was conceptual).
    kind: "calculated",
    name: "OG Main",
    skuPrefix: "ev-mixed-",
    sizes: TEN_SIZES_OG_MAIN,
    isMainLine: true,
  },
  {
    // Production uses `ev-hw-*` (no `5x`/`pp` infix).
    kind: "calculated",
    name: "HW Main",
    skuPrefix: "ev-hw-",
    sizes: NINE_SIZES_NO_5XL,
    isMainLine: true,
  },

  // HF variants
  { kind: "calculated", name: "9055 HF", skuPrefix: "ev-9055-hf-5x-", sizes: TEN_SIZES },
  { kind: "calculated", name: "OG HF", skuPrefix: "ev-og-hf-5x-", sizes: TEN_SIZES },
  { kind: "calculated", name: "HW HF", skuPrefix: "ev-hw-hf-5x-", sizes: NINE_SIZES_NO_5XL },

  // Boyshort family (calculated mode — same SKUs as the custom entries below)
  { kind: "calculated", name: "Boyshort", skuPrefix: "ev-bshort-5x-", sizes: TEN_SIZES },
  { kind: "calculated", name: "Boyshort Beige", skuPrefix: "ev-bshort-beige-5x-", sizes: TEN_SIZES },
  { kind: "calculated", name: "Boyshort FC (3-layer)", skuPrefix: "ev-bshort-fc-5x-", sizes: TEN_SIZES },
  { kind: "calculated", name: "Boyshort HF (4-layer)", skuPrefix: "ev-bshort-hf-5x-", sizes: TEN_SIZES },
  { kind: "calculated", name: "Boyshort Beige HF", skuPrefix: "ev-bshort-beige-hf-5x-", sizes: TEN_SIZES },
  { kind: "calculated", name: "Boyshort FC HF (4-layer)", skuPrefix: "ev-bshort-fc-hf-5x-", sizes: TEN_SIZES },

  // 1-Pack variants
  { kind: "calculated", name: "OG Beige 1-Pack", skuPrefix: "ev-og-1x-beige-", sizes: NINE_SIZES_NO_5XL },
  { kind: "calculated", name: "OG Black 1-Pack", skuPrefix: "ev-og-1x-black-", sizes: NINE_SIZES_NO_5XL },
  { kind: "calculated", name: "HW Beige 1-Pack", skuPrefix: "ev-hw-1x-beige-", sizes: EIGHT_SIZES_HW1X },
  { kind: "calculated", name: "HW Black 1-Pack", skuPrefix: "ev-hw-1x-black-", sizes: EIGHT_SIZES_HW1X },
  { kind: "calculated", name: "9055 Pink 1-Pack", skuPrefix: "ev-9055-1x-pink-", sizes: TEN_SIZES },
  { kind: "calculated", name: "9055 Brown 1-Pack", skuPrefix: "ev-9055-1x-brown-", sizes: TEN_SIZES },

  // 5-pack color variants
  { kind: "calculated", name: "9055 Pastel", skuPrefix: "ev-9055-pastel-5x-", sizes: TEN_SIZES },
  { kind: "calculated", name: "9055 Blush", skuPrefix: "ev-9055-blush-5x-", sizes: TEN_SIZES },
  { kind: "calculated", name: "9055 Beige", skuPrefix: "ev-9055-beige-5x-", sizes: TEN_SIZES },
  { kind: "calculated", name: "9055 Black", skuPrefix: "ev-9055-black-5x-", sizes: TEN_SIZES },

  // Hipster / Bikini / French
  { kind: "calculated", name: "Hipster", skuPrefix: "ev-hip-5x-", sizes: EIGHT_SIZES_HIPSTER },
  { kind: "calculated", name: "Hipster HF", skuPrefix: "ev-hip-hf-5x-", sizes: EIGHT_SIZES_HIPSTER },
  { kind: "calculated", name: "Bikini", skuPrefix: "ev-bik-5x-", sizes: EIGHT_SIZES_HIPSTER },
  { kind: "calculated", name: "Bikini HF", skuPrefix: "ev-bik-hf-5x-", sizes: EIGHT_SIZES_HIPSTER },
  { kind: "calculated", name: "French Cut", skuPrefix: "ev-french-5x-", sizes: EIGHT_SIZES_HIPSTER },
  { kind: "calculated", name: "French Cut HF", skuPrefix: "ev-french-hf-5x-", sizes: EIGHT_SIZES_HIPSTER },

  { kind: "calculated", name: "Mens", skuPrefix: "ev-mens-3x-", sizes: MENS_SIZES },
  { kind: "calculated", name: "Super HW", skuPrefix: "ev-suphw-5x-", sizes: TEN_SIZES },
  { kind: "calculated", name: "Shapewear", skuPrefix: "ev-sw-5x-", sizes: TEN_SIZES },
];

// ---------------------------------------------------------------------
// Custom-input product groups (Spec §5.2)
// ---------------------------------------------------------------------

export type CustomGroup = {
  kind: "custom";
  name: string;
  skuPrefix: string;
  sizes: ReadonlyArray<string>;
  curve: SizeCurve;
};

export const CUSTOM_GROUPS: ReadonlyArray<CustomGroup> = [
  { kind: "custom", name: "Boyshort (custom batch)", skuPrefix: "ev-bshort-5x-", sizes: TEN_SIZES, curve: "boyshort" },
  { kind: "custom", name: "Boyshort HF (custom batch)", skuPrefix: "ev-bshort-hf-5x-", sizes: TEN_SIZES, curve: "boyshort" },
  { kind: "custom", name: "Super HW (custom batch)", skuPrefix: "ev-suphw-5x-", sizes: TEN_SIZES, curve: "standard10" },
  { kind: "custom", name: "FC Super HW", skuPrefix: "ev-suphw-fc-5x-", sizes: TEN_SIZES, curve: "standard10" },
  { kind: "custom", name: "Cotton Hipster", skuPrefix: "ev-cottonhip-5x-", sizes: TEN_SIZES, curve: "standard10" },
  { kind: "custom", name: "Cotton HW", skuPrefix: "ev-cottonhw-5x-", sizes: TEN_SIZES, curve: "standard10" },
  { kind: "custom", name: "Shapewear Beige", skuPrefix: "ev-sw-5x-", sizes: TEN_SIZES, curve: "standard10" },
  { kind: "custom", name: "Shapewear Black", skuPrefix: "ev-sw-black-5x-", sizes: TEN_SIZES, curve: "standard10" },
  { kind: "custom", name: "Men's Improved", skuPrefix: "ev-mens-3x-", sizes: MENS_SIZES, curve: "mens6" },
  { kind: "custom", name: "Men's Brief w Fly", skuPrefix: "ev-flybrief-3x-", sizes: MENS_SIZES, curve: "mens6" },
  { kind: "custom", name: "Men's Boxer Brief w Fly", skuPrefix: "ev-boxerbrief-3x-", sizes: MENS_SIZES, curve: "mens6" },
  { kind: "custom", name: "High Rise Short", skuPrefix: "ev-hrshort-5x-", sizes: TEN_SIZES, curve: "standard10" },
];

export type ProductGroup = CalculatedGroup | CustomGroup;

export const ALL_GROUPS: ReadonlyArray<ProductGroup> = [
  ...CALCULATED_GROUPS,
  ...CUSTOM_GROUPS,
];

/** Group name → group entry, for quick lookup. */
export const GROUPS_BY_NAME: ReadonlyMap<string, ProductGroup> = new Map(
  ALL_GROUPS.map((g) => [g.name, g]),
);

/**
 * Predicate used to decide whether a given SKU belongs to a group.
 * Used by the calc engine when bucketing SKUs from `daily_sales` /
 * `stock_snapshots` etc.
 *
 * Matches when: (a) SKU starts with the prefix and (b) what's left
 * after the prefix is one of the configured sizes. The size check
 * prevents `ev-bshort-5x-fc-m` (if that ever existed) from
 * accidentally matching `Boyshort` when we mean `Boyshort FC`.
 */
export function skuMatchesGroup(sku: string, group: ProductGroup): boolean {
  const lower = sku.toLowerCase();
  if (!lower.startsWith(group.skuPrefix)) return false;
  const tail = lower.slice(group.skuPrefix.length);
  return group.sizes.includes(tail);
}

/**
 * Build the SKU list for a calculated group at calc time. Caller
 * passes the full catalog (`skus.sku` rows) so we don't import the
 * DB into a pure config module.
 */
export function skusInGroup(
  group: ProductGroup,
  catalog: Iterable<string>,
): string[] {
  const matches: string[] = [];
  for (const sku of catalog) {
    if (skuMatchesGroup(sku, group)) matches.push(sku);
  }
  return matches;
}
