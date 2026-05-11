import type { FamilyOverrideMap } from "@/lib/domain/sku-naming-overrides";

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
  // Scott 2026-05-07
  "hrshort": "High Rise Short",
};

// Multi-segment family prefixes — checked before single-segment lookup.
// Example: ev-sl-bik-pink-5x-l → family = "sl-bik".
const MULTI_FAMILY_LABELS: Record<string, string> = {
  // Scott 2026-05-06: SL = Seamless. Bikini and High Waisted are 2
  // separate Seamless products.
  "sl-bik": "Seamless Bikini",
  "sl-hw": "Seamless High Waisted",
};

// Aliases that route a multi-segment prefix to a single-segment family
// rather than creating a new parent product. Scott 2026-05-06:
//  - "new-og" / "new-9055" → color variants of OG / Style 9055
//  - "bp-9055" → Beige Pink colorway of Style 9055
// Scott 2026-05-07:
//  - "pp-hw" / "pp-og" → variants of HW / OG (the pp- prefix is
//    a colorway/spec marker; the actual product is HW/OG)
// Treat them as if they were ev-og-5x-* / ev-9055-5x-* respectively.
const FAMILY_ALIAS: Record<string, string> = {
  "new-og": "og",
  "new-9055": "9055",
  "bp-9055": "9055",
  "pp-hw": "hw",
  "pp-og": "og",
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
  "hrshort",
]);

// Optional `overrides` Map (loaded from sku_family_overrides at the
// start of syncProductNames) is consulted before the hardcoded
// FAMILY_ALIAS / MULTI_FAMILY_LABELS / FAMILY_LABELS /
// IMPLICIT_5PACK_FAMILIES tables. Each override entry can independently
// supply: aliasOf (rewrite to another family), displayLabel (label for
// this family token), and isImplicit5pack (whether to drop the 5-Pack
// suffix for this family). Without overrides, behavior is unchanged.
export function deriveProductName(
  sku: string,
  overrides?: FamilyOverrideMap
): string | null {
  const lower = sku.toLowerCase();
  const parts = lower.split("-");
  if (parts[0] !== "ev" || parts.length < 3) return null;

  // Resolve family. Multi-segment prefixes (sl-bik, new-og, bp-9055,
  // etc.) are checked first. Aliases — DB override or constant —
  // rewrite colorway-only multi-segments to their parent
  // single-segment family so they collapse under the parent product.
  let family: string;
  let middleStart: number;
  const twoSeg = parts.length >= 3 ? `${parts[1]}-${parts[2]}` : "";
  const twoSegOverride = overrides?.get(twoSeg);
  // Override aliasOf wins over constant FAMILY_ALIAS.
  const aliasTarget = twoSegOverride?.aliasOf ?? FAMILY_ALIAS[twoSeg];
  if (aliasTarget) {
    family = aliasTarget;
    middleStart = 3;
  } else if (
    (twoSegOverride && !twoSegOverride.aliasOf) ||
    MULTI_FAMILY_LABELS[twoSeg]
  ) {
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

  // Override displayLabel wins over MULTI_FAMILY_LABELS / FAMILY_LABELS.
  // Alias-mode override rows (aliasOf set) don't contribute a label —
  // we've already followed the alias to the canonical family above.
  const familyOverride = overrides?.get(family);
  const overrideLabel =
    familyOverride && !familyOverride.aliasOf
      ? familyOverride.displayLabel
      : null;
  const baseLabel =
    overrideLabel ?? MULTI_FAMILY_LABELS[family] ?? FAMILY_LABELS[family];
  if (!baseLabel) return null;

  const out = [baseLabel];
  // Drop pack label when it's the family's implicit default (5-pack
  // for bshort/9055/sw/hip/bik/etc). Override is_implicit_5pack is
  // authoritative when present (covers both directions: opt new family
  // in, or opt existing family out).
  const implicit5pack = familyOverride
    ? familyOverride.isImplicit5pack
    : IMPLICIT_5PACK_FAMILIES.has(family);
  const dropPack = pack === "5-Pack" && implicit5pack;
  if (pack && !dropPack) out.push(pack);
  if (hf) out.push("HF");
  return out.join(" ");
}

// Families that have a "base" colorway and a long tail of alternate
// colorways. Scott 2026-05-07: in the inventory tab he only wants to
// see main-color SKUs by default — the alt-color variants (e.g.
// `new-og-*`, `pp-hw-*`, `ev-9055-beige-*`) are clearance / aging
// stock and clutter the at-risk view. Boyshort + Super HW are
// excluded from this rule because all their colorways are
// independently advertised, so all colors count as main.
//
// Scott 2026-05-08: same rule applies to launches — alt-colors of
// these families don't get treated as new launches even when they're
// new SKUs in incoming, because the parent product is "old" and the
// colorways aren't independently advertised.
const ALT_COLOR_FAMILIES = new Set(["og", "hw", "9055"]);

// Scott 2026-05-08 (extended 2026-05-11 from name-scoped to family-scoped):
// "HW and OG are not launched, those are old products." Originally the
// blocklist matched bare productName values ("HW", "OG", "Style 9055"),
// so pack/HF variants ("HW 1-Pack", "OG 5-Pack HF") slipped through and
// surfaced as launches. The family-scoped check below covers every
// derived launchName a blocklisted family can produce.
//
// "mixed" is included because deriveProductName routes ev-mixed-* to
// "OG 5-Pack" (a name in the OG family).
const LAUNCH_BLOCKLISTED_FAMILIES = new Set(["og", "hw", "9055", "mixed"]);

// Friendly labels (FAMILY_LABELS entries) corresponding to the
// blocklisted families. Used by cleanupStaleDefaultLaunches to find
// existing rows in product_launches whose name was produced by a
// blocklisted family. Single source of truth: derived at module load
// from LAUNCH_BLOCKLISTED_FAMILIES so the SQL cleanup stays in sync.
export const LAUNCH_BLOCKED_NAME_PREFIXES: readonly string[] = (() => {
  const labels = new Set<string>();
  for (const f of LAUNCH_BLOCKLISTED_FAMILIES) {
    const label = FAMILY_LABELS[f];
    if (label) labels.add(label);
  }
  // ev-mixed-* is special-cased to "OG 5-Pack" by deriveProductName —
  // already covered by the "OG" prefix.
  return Array.from(labels);
})();

// Display labels for color tokens, used by deriveLaunchName so that a
// new colorway of an advertised product surfaces as e.g. "Shapewear
// Black" rather than collapsing under the parent productName.
const COLORWAY_DISPLAY: Record<string, string> = {
  beige: "Beige",
  black: "Black",
  pink: "Pink",
  lilac: "Lilac",
  fc: "Multi Color",
};

/**
 * True when `sku` is a "main color" SKU per Scott's inventory filter:
 *  - Anything outside the og / hw / 9055 families → main color.
 *    This covers Boyshort, Super HW, and every other family.
 *  - Inside og / hw / 9055: only the base colorway is main. SKUs that
 *    came in via FAMILY_ALIAS rewrite (new-og, pp-hw, bp-9055) or
 *    that carry an explicit COLOR_TOKEN in their middle segments are
 *    alt-color (returns false).
 *
 * Returns true for SKUs that don't parse (defensive — we'd rather
 * surface unknown SKUs than hide them).
 */
export function isMainColor(sku: string): boolean {
  const lower = sku.toLowerCase();
  const parts = lower.split("-");
  if (parts[0] !== "ev" || parts.length < 3) return true;

  let family: string;
  let middleStart: number;
  let routedThroughAlias = false;
  const twoSeg = parts.length >= 3 ? `${parts[1]}-${parts[2]}` : "";
  if (FAMILY_ALIAS[twoSeg]) {
    family = FAMILY_ALIAS[twoSeg];
    middleStart = 3;
    routedThroughAlias = true;
  } else if (MULTI_FAMILY_LABELS[twoSeg]) {
    family = twoSeg;
    middleStart = 3;
  } else {
    family = parts[1];
    middleStart = 2;
  }

  if (!ALT_COLOR_FAMILIES.has(family)) return true;
  // og / hw / 9055 with an alias rewrite is always alt color.
  if (routedThroughAlias) return false;
  // Look for a known color token anywhere in the middle segments.
  const middle = parts.slice(middleStart, -1);
  for (const t of middle) {
    if (COLOR_TOKENS.has(t)) return false;
  }
  return true;
}

/**
 * Resolves a SKU to its canonical family token. Follows FAMILY_ALIAS
 * rewrites so e.g. `ev-pp-hw-1x-l` returns `"hw"`. Returns null when
 * the SKU doesn't parse (anything not starting with `ev-` or shorter
 * than 3 segments).
 *
 * Does NOT consult DB overrides — matches the design of isMainColor,
 * which reads the constant maps only.
 */
export function getSkuFamily(sku: string): string | null {
  const lower = sku.toLowerCase();
  const parts = lower.split("-");
  if (parts[0] !== "ev" || parts.length < 3) return null;
  const twoSeg = `${parts[1]}-${parts[2]}`;
  if (FAMILY_ALIAS[twoSeg]) return FAMILY_ALIAS[twoSeg];
  if (MULTI_FAMILY_LABELS[twoSeg]) return twoSeg;
  return parts[1];
}

/**
 * True when the SKU's canonical family is in the launch blocklist
 * (hw, og, 9055, mixed). Used to filter the add-launch dropdown and
 * to prevent the auto-populate job from creating launch rows for
 * these families. Scott 2026-05-08: "HW and OG are not launched,
 * those are old products."
 *
 * Returns false for SKUs that don't parse — defensive default,
 * matching isMainColor's "surface unknown SKUs" stance.
 */
export function isLaunchBlockedFamily(sku: string): boolean {
  const family = getSkuFamily(sku);
  return family !== null && LAUNCH_BLOCKLISTED_FAMILIES.has(family);
}

/**
 * Compose a launch-tab display name for a SKU. When the SKU carries a
 * known color token, the result includes a colorway suffix so a new
 * colorway of an advertised product surfaces under its own row instead
 * of collapsing into the parent product. Examples:
 *
 *   ev-sw-black-5x-l       + "Shapewear"        → "Shapewear Black"
 *   ev-suphw-fc-5x-l       + "Super High-Waist" → "Super High-Waist Multi Color"
 *   ev-bshort-5x-l         + "Boyshort"         → "Boyshort"   (no color token)
 *   ev-hrshort-5x-l        + "High Rise Short"  → "High Rise Short"
 *   ev-mystery-5x-l        + "ev-mystery-5x-l"  → "ev-mystery-5x-l"  (placeholder)
 *
 * Placeholder names (anything starting with "ev-") are returned as-is
 * so we don't double-decorate raw SKU codes. The cleanup pass in
 * runLaunchAutoPopulate replaces these once a friendly label is added
 * to FAMILY_LABELS / FAMILY_ALIAS in this file.
 */
export function deriveLaunchName(sku: string, baseName: string): string {
  if (baseName.startsWith("ev-")) return baseName;
  const lower = sku.toLowerCase();
  const parts = lower.split("-");
  for (const t of parts) {
    if (COLORWAY_DISPLAY[t]) {
      return `${baseName} ${COLORWAY_DISPLAY[t]}`;
    }
  }
  return baseName;
}

// Snapshot of the constant-driven family entries — used by the
// /admin/product-names UI to render existing labels alongside DB
// overrides. Keeps the constants module-local while exposing a stable
// read-only view.
export type KnownFamilyEntry = {
  family: string;
  kind: "label" | "alias";
  displayLabel: string | null;
  aliasOf: string | null;
  isImplicit5pack: boolean;
  source: "FAMILY_LABELS" | "MULTI_FAMILY_LABELS" | "FAMILY_ALIAS";
};

export function snapshotKnownFamilies(): KnownFamilyEntry[] {
  return [
    ...Object.entries(FAMILY_LABELS).map(([family, label]) => ({
      family,
      kind: "label" as const,
      displayLabel: label,
      aliasOf: null,
      isImplicit5pack: IMPLICIT_5PACK_FAMILIES.has(family),
      source: "FAMILY_LABELS" as const,
    })),
    ...Object.entries(MULTI_FAMILY_LABELS).map(([family, label]) => ({
      family,
      kind: "label" as const,
      displayLabel: label,
      aliasOf: null,
      isImplicit5pack: IMPLICIT_5PACK_FAMILIES.has(family),
      source: "MULTI_FAMILY_LABELS" as const,
    })),
    ...Object.entries(FAMILY_ALIAS).map(([family, target]) => ({
      family,
      kind: "alias" as const,
      displayLabel: null,
      aliasOf: target,
      isImplicit5pack: false,
      source: "FAMILY_ALIAS" as const,
    })),
  ];
}
