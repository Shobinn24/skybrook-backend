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

const PACK_TOKEN_RE = /^ev-([a-zA-Z0-9-]+)-(1|5|10|15)x?-(.+)$/i;

// (numeric pack token) → (canonical x-form, multiplier in 5-pack units)
//   1, 5  → cosmetic rename only ("ev-x-5-l" → "ev-x-5x-l", multiplier 1)
//   10    → decompose to 5x with multiplier 2
//   15    → decompose to 5x with multiplier 3
const TARGET: Record<string, { canonicalToken: string; multiplier: number }> = {
  "1": { canonicalToken: "1x", multiplier: 1 },
  "5": { canonicalToken: "5x", multiplier: 1 },
  "10": { canonicalToken: "5x", multiplier: 2 },
  "15": { canonicalToken: "5x", multiplier: 3 },
};

export type DecomposedSku = {
  canonicalSku: string; // the canonical x-form (decomposed if needed)
  multiplier: number; // how many 5-packs one of the original equals
};

export function decomposePackSku(sku: string): DecomposedSku | null {
  const lower = sku.toLowerCase();
  const m = lower.match(PACK_TOKEN_RE);
  if (!m) return null;
  const [, family, packMatch, rest] = m;
  const numericPack = packMatch.replace(/x$/, "");
  const target = TARGET[numericPack];
  if (!target) return null;
  const canonicalSku = `ev-${family}-${target.canonicalToken}-${rest}`;
  // Already canonical and no multiplier needed → caller treats as no-op.
  if (canonicalSku === lower && target.multiplier === 1) return null;
  return { canonicalSku, multiplier: target.multiplier };
}

// SQL LIKE patterns for legacy pack/dash-form SKUs that may sit in
// daily_sales from before ingest-side normalization landed. The cron
// purges these after each Shopify run to keep the orphan list clean.
// Patterns are case-insensitive when used with ILIKE — but the cleanup
// also looks for any uppercase-bearing rows separately so case is moot
// here. Each pattern targets a token that's been replaced by its
// x-form by `decomposePackSku`.
export const PACK_SKU_DB_PATTERNS: ReadonlyArray<string> = [
  "ev-%-1-%",
  "ev-%-5-%",
  "ev-%-10x-%",
  "ev-%-10-%",
  "ev-%-15x-%",
  "ev-%-15-%",
];
