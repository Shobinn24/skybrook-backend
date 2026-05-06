// Derives a human-readable product name from a SKU code, used as a
// fallback when the velocity sheet hasn't supplied an explicit name.
//
// Format observed in Scott's velocity sheet (2026-04-28):
//   ev-{family}-{...modifiers...}-{size}
//
// Where modifiers can include any of: pack-size token (1x/5x/10x/15x),
// color (beige/black/pink/lilac/fc), and HF (high-flow).
//
// Scott 2026-05-06 round-2: combine color variants into one product at
// the rollup level. Color, FC, and other colorway markers are parsed
// (so they don't break size/pack/hf detection) but intentionally
// dropped from the productName output. Pack and HF stay distinguishing
// — those represent separate products. The SKU code itself still
// surfaces variant detail in the per-SKU expanded view.
//
// Returns null when the SKU doesn't match a known family — caller
// should keep whatever name was already set (often the SKU itself as
// fallback).

const FAMILY_LABELS: Record<string, string> = {
  "9055": "Style 9055",
  "bshort": "Boyshort",
  "og": "OG",
  "hw": "HW",
  "sw": "Shapewear",
  "suphw": "Super High-Waist",
  "mens": "Mens",
  "cb": "CB",
  "hip": "Hipster",
  "bik": "Bikini",
  "french": "French",
  // Best-guess labels for new families seen in production stock data
  // 2026-05-06. Pending Scott confirmation on exact wording.
  "jac": "Jacquard",
  "mlb": "MLB",
};

// Multi-segment family prefixes — checked before single-segment lookup.
// Example: ev-sl-bik-pink-5x-l → family = "sl-bik".
const MULTI_FAMILY_LABELS: Record<string, string> = {
  "new-og": "New OG",
  "new-9055": "New Style 9055",
  "sl-bik": "Super Light Bikini",
  "sl-hw": "Super Light HW",
  "bp-9055": "BP Style 9055",
};

// Colorways are parsed (so they don't get mistaken for size/pack/hf
// tokens) but intentionally dropped from productName. The SKU code
// itself still distinguishes variants in the expanded view.
const COLOR_TOKENS = new Set([
  "beige",
  "black",
  "pink",
  "lilac",
  "fc", // FC = 5-color colorway per Scott 2026-05-06
]);

const PACK_LABELS: Record<string, string> = {
  "1x": "1-Pack",
  "3x": "3-Pack",
  "5x": "5-Pack",
  "6x": "6-Pack",
  "9x": "9-Pack",
  "10x": "10-Pack",
  "12x": "12-Pack",
  "15x": "15-Pack",
};

// For families with only one pack tier in the catalog, the pack label
// is implicit and dropped from productName to avoid noise.
// Multi-pack families (og, hw, mens) keep the pack label so 1-pack
// and 5-pack remain distinct products per Scott 2026-05-06.
const IMPLICIT_5PACK_FAMILIES = new Set([
  "9055",
  "bshort",
  "sw",
  "hip",
  "bik",
  "french",
  "jac",
  "sl-bik",
  "sl-hw",
  "new-og",
  "new-9055",
  "bp-9055",
]);

export function deriveProductName(sku: string): string | null {
  const lower = sku.toLowerCase();
  const parts = lower.split("-");
  if (parts[0] !== "ev" || parts.length < 3) return null;

  // Try multi-segment family first (sl-bik, new-og, etc.) before
  // falling back to single-segment family.
  let family: string;
  let middleStart: number;
  const twoSeg = parts.length >= 3 ? `${parts[1]}-${parts[2]}` : "";
  if (MULTI_FAMILY_LABELS[twoSeg]) {
    family = twoSeg;
    middleStart = 3;
  } else {
    family = parts[1];
    middleStart = 2;
  }

  // Need at least one segment after the family for the size.
  if (parts.length < middleStart + 1) return null;

  const middle = parts.slice(middleStart, -1);

  let pack: string | null = null;
  let hf = false;
  for (const t of middle) {
    if (PACK_LABELS[t] && !pack) pack = PACK_LABELS[t];
    else if (t === "hf") hf = true;
    // Color/FC tokens parsed but ignored — they're SKU-level variants,
    // not separate products. Other unknown tokens (e.g. trailing
    // colorway not yet in COLOR_TOKENS) are silently skipped so a new
    // colorway doesn't break out into its own product row.
  }

  // ev-mixed is a special case — Scott's no-color default OG 5-pack.
  // Bucket under "OG 5-Pack" so /inventory groups it with the other
  // ev-og-5x-{color}-{size} variants.
  if (family === "mixed") return "OG 5-Pack";

  const baseLabel = MULTI_FAMILY_LABELS[family] ?? FAMILY_LABELS[family];
  if (!baseLabel) return null;

  const out = [baseLabel];
  // Drop pack label when it's the family's implicit default (5-pack
  // for bshort/9055/sw/hip/bik/etc). Keep pack label when the family
  // ships in multiple pack tiers (og/hw/mens/cb/suphw).
  const dropPack = pack === "5-Pack" && IMPLICIT_5PACK_FAMILIES.has(family);
  if (pack && !dropPack) out.push(pack);
  if (hf) out.push("HF");
  return out.join(" ");
}
