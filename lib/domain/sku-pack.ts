// 10-pack and 15-pack SKUs are sold on the website but inventory is
// tracked at the 5-pack level — Scott 2026-04-28: "they would come
// out of the inventory as 3x 5-packs. So you just need to pull the
// 5-pack data". This module translates pack-variant SKUs to their
// 5-pack canonical equivalent + a multiplier, applied at Shopify
// ingest time so daily_sales accurately reflects the rate at which
// physical 5-pack inventory is being depleted.
//
// 1-pack SKUs (`-1x-`) are NOT decomposed — they map to physically
// separate inventory items (OG/HW single underwear), not multi-pack
// repackaging.
//
// Two SKU shapes seen in production for the same pack: with and
// without the trailing `x` (e.g. `EV-hw-10x-l` and `EV-hw-10-l`).
// Both get matched. Family also accepts an inner HF qualifier
// (`EV-9055-HF-10-xl` → `ev-9055-hf-5x-xl`).

const PACK_TOKEN_RE = /^ev-([a-zA-Z0-9-]+)-(10x?|15x?)-(.+)$/i;

const MULTIPLIER: Record<string, number> = {
  "10": 2,
  "10x": 2,
  "15": 3,
  "15x": 3,
};

export type DecomposedSku = {
  canonicalSku: string; // the 5-pack equivalent SKU
  multiplier: number; // how many 5-packs one of the original equals
};

export function decomposePackSku(sku: string): DecomposedSku | null {
  const m = sku.match(PACK_TOKEN_RE);
  if (!m) return null;
  const [, family, packToken, rest] = m;
  const mult = MULTIPLIER[packToken.toLowerCase()];
  if (!mult) return null;
  return {
    canonicalSku: `ev-${family}-5x-${rest}`.toLowerCase(),
    multiplier: mult,
  };
}

// SQL LIKE patterns matching legacy pack SKUs that may be sitting in
// daily_sales from before ingest-side decomposition landed. The cron
// purges these after each Shopify run to keep the orphan list clean.
// Patterns are case-insensitive (used with ILIKE).
export const PACK_SKU_DB_PATTERNS: ReadonlyArray<string> = [
  "ev-%-10x-%",
  "ev-%-15x-%",
  "ev-%-10-%",
  "ev-%-15-%",
];
