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
//
// Size token canonicalization: the velocity sheet uses `2xl` for the
// 9055 line while Shopify (and most inventory rows) uses `xxl` for
// the same physical size. Without normalization, the two forms sit
// as separate SKUs and Skybrook double-orphans them — `ev-9055-5x-2xl`
// went unmatched against `ev-9055-5x-xxl` (1.7k units / 4 weeks). We
// canonicalize trailing `-2xl` → `-xxl` since `xxl` is the dominant
// form across both the inventory sheet and Shopify.
//
// Family-aware pack base: most families track inventory at the 5-pack
// level, but `mens` and `cb` track at the 3-pack level instead (Scott
// 2026-04-29). For those families, `6x` → 2× 3x, `9x` → 3× 3x (mens),
// `12x` → 4× 3x (cb). Family rules are exclusive — when a family has
// its own ruleset, default rules don't fall through, so `ev-mens-10x-l`
// (which shouldn't exist in practice) won't accidentally decompose to
// 5-pack base.
//
// HW no-pack collapse: HW's no-color inventory is tracked under a bare
// `ev-hw-{size}` form (no pack token at all) — Scott's velocity sheet
// labels these "HW 5-Pack". Shopify partly mirrors this (`ev-hw-l`,
// 1.4k units / 30d) but also writes a parallel `ev-hw-5x-{size}`
// (~350 units / 30d) that doesn't match any inventory row. Same
// physical product, two SKU strings. We collapse the 5x form into the
// no-pack form so both sales paths land on the same SKU. Colored
// 5-packs (`ev-hw-5x-{color}-{size}`) keep their separate identity —
// only the bare-size form gets collapsed.

const PACK_TOKEN_RE = /^ev-([a-zA-Z0-9-]+)-(1|3|5|6|9|10|12|15)x?-(.+)$/i;

type PackTarget = { canonicalToken: string; multiplier: number };

// Default 5-pack base: applies to every family without its own ruleset.
//   1, 5  → cosmetic rename only ("ev-x-5-l" → "ev-x-5x-l", multiplier 1)
//   10    → decompose to 5x with multiplier 2
//   15    → decompose to 5x with multiplier 3
const DEFAULT_PACK_RULES: Record<string, PackTarget> = {
  "1": { canonicalToken: "1x", multiplier: 1 },
  "5": { canonicalToken: "5x", multiplier: 1 },
  "10": { canonicalToken: "5x", multiplier: 2 },
  "15": { canonicalToken: "5x", multiplier: 3 },
};

// Family-specific rules. Keyed by exact family token (the chunk between
// `ev-` and the pack token). When a family is listed here, ITS rules
// are used exclusively — defaults do not fall through.
const FAMILY_PACK_RULES: Record<string, Record<string, PackTarget>> = {
  // Mens 3-pack base. 6-pack = 2× 3x, 9-pack = 3× 3x.
  mens: {
    "3": { canonicalToken: "3x", multiplier: 1 },
    "6": { canonicalToken: "3x", multiplier: 2 },
    "9": { canonicalToken: "3x", multiplier: 3 },
  },
  // CB 3-pack base. 6-pack = 2× 3x, 12-pack = 4× 3x.
  cb: {
    "3": { canonicalToken: "3x", multiplier: 1 },
    "6": { canonicalToken: "3x", multiplier: 2 },
    "12": { canonicalToken: "3x", multiplier: 4 },
  },
  // HW HF and OG HF: have legitimate 1/3/5-pack inventory plus 6/9-pack
  // sales that decompose to 3-pack base (mirror of mens 3/6/9 pattern).
  // Both families therefore need the full default ruleset (1/5/10/15)
  // PLUS the 3-pack family rules — exclusive family-rule lookup means
  // we have to spread defaults explicitly. Inventory is dash-form for
  // 1/3/5 (`ev-hw-hf-3-l`, `ev-og-hf-5-xs`) so the rename rules cover
  // the canonicalization path. 6/9-pack volume is tiny (3 units / 30d)
  // but the structure is identical to mens — close the orphans.
  "hw-hf": {
    "1": { canonicalToken: "1x", multiplier: 1 },
    "3": { canonicalToken: "3x", multiplier: 1 },
    "5": { canonicalToken: "5x", multiplier: 1 },
    "6": { canonicalToken: "3x", multiplier: 2 },
    "9": { canonicalToken: "3x", multiplier: 3 },
    "10": { canonicalToken: "5x", multiplier: 2 },
    "15": { canonicalToken: "5x", multiplier: 3 },
  },
  "og-hf": {
    "1": { canonicalToken: "1x", multiplier: 1 },
    "3": { canonicalToken: "3x", multiplier: 1 },
    "5": { canonicalToken: "5x", multiplier: 1 },
    "6": { canonicalToken: "3x", multiplier: 2 },
    "9": { canonicalToken: "3x", multiplier: 3 },
    "10": { canonicalToken: "5x", multiplier: 2 },
    "15": { canonicalToken: "5x", multiplier: 3 },
  },
};

function rulesForFamily(family: string): Record<string, PackTarget> {
  return FAMILY_PACK_RULES[family] ?? DEFAULT_PACK_RULES;
}

export type DecomposedSku = {
  canonicalSku: string; // the canonical x-form (decomposed if needed)
  multiplier: number; // how many canonical-base packs one of the original equals
};

export function decomposePackSku(sku: string): DecomposedSku | null {
  const lower = sku.toLowerCase();
  const m = lower.match(PACK_TOKEN_RE);
  if (!m) return null;
  const [, family, packMatch, rest] = m;
  const numericPack = packMatch.replace(/x$/, "");
  const target = rulesForFamily(family)[numericPack];
  if (!target) return null;
  const canonicalRest = canonicalizeSizeToken(rest);
  let canonicalSku = `ev-${family}-${target.canonicalToken}-${canonicalRest}`;
  // HW no-pack collapse: bare-size HW 5-packs fold to the no-pack form
  // that inventory uses. Skipped when rest carries a color or qualifier
  // (multi-segment, e.g. `black-l`) so colored 5-packs stay distinct.
  if (
    family === "hw" &&
    target.canonicalToken === "5x" &&
    !canonicalRest.includes("-")
  ) {
    canonicalSku = `ev-hw-${canonicalRest}`;
  }
  // Already canonical and no multiplier needed → caller treats as no-op.
  if (canonicalSku === lower && target.multiplier === 1) return null;
  return { canonicalSku, multiplier: target.multiplier };
}

// Trailing size token: `-2xl` → `-xxl`. Same physical size, two source
// conventions in the data.
function canonicalizeSizeToken(rest: string): string {
  return rest.replace(/(^|-)2xl$/i, "$1xxl");
}

// SQL LIKE patterns for legacy SKU forms that may sit in daily_sales
// from before ingest-side normalization landed. The cron purges these
// after each Shopify run to keep the orphan list clean. Patterns
// target tokens that `decomposePackSku` has since replaced with the
// canonical form: dash-form pack tokens, 10/15-pack rows for default
// families, mens 6/9-pack rows (now 3x base), cb 6/12-pack rows (now
// 3x base), and the `-2xl` size alias (now folded into `-xxl`).
export const PACK_SKU_DB_PATTERNS: ReadonlyArray<string> = [
  "ev-%-1-%",
  "ev-%-5-%",
  "ev-%-10x-%",
  "ev-%-10-%",
  "ev-%-15x-%",
  "ev-%-15-%",
  "ev-mens-3-%",
  "ev-mens-6x-%",
  "ev-mens-6-%",
  "ev-mens-9x-%",
  "ev-mens-9-%",
  "ev-cb-3-%",
  "ev-cb-6x-%",
  "ev-cb-6-%",
  "ev-cb-12x-%",
  "ev-cb-12-%",
  "ev-hw-hf-3-%",
  "ev-hw-hf-6x-%",
  "ev-hw-hf-6-%",
  "ev-hw-hf-9x-%",
  "ev-hw-hf-9-%",
  "ev-og-hf-3-%",
  "ev-og-hf-6x-%",
  "ev-og-hf-6-%",
  "ev-og-hf-9x-%",
  "ev-og-hf-9-%",
  "ev-%-2xl",
];
