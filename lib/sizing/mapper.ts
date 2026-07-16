// Sizing exchange analysis — style/size mapping and direction logic.
// Faithful port of the manual-analysis spec (Scott, 2026-07-15) with the
// spec's own "Known data issues" fixes applied:
//   4.1 XXS/XXXS included in the rank scale (the manual run dropped them)
//   4.3 boundary sizes flagged so censored cells never drive a verdict
//   plus one fix the spec missed: Size Replaced can itself contain
//   multiple products ("HW HF 3XL, OG HF 3XL") — treated like the
//   multi-product Style rows and excluded.

export const SIZE_RANK: Record<string, number> = {
  XXXS: -2,
  XXS: -1,
  XS: 0,
  S: 1,
  M: 2,
  L: 3,
  XL: 4,
  "2XL": 5,
  "3XL": 6,
  "4XL": 7,
  "5XL": 8,
  "6XL": 9,
};

export const SIZE_ORDER = ["XXS", "XS", "S", "M", "L", "XL", "2XL", "3XL", "4XL", "5XL"];

// End-anchored: "HW HF 3XL" must resolve to 3XL. Longer alternatives
// first or XXL would match as XL.
const SIZE_RE = /(XXXS|XXS|XS|XXXL|XXL|3XL|4XL|5XL|6XL|2XL|XL|S|M|L)$/;

const CANON: Record<string, string> = { XXXL: "3XL", XXL: "2XL" };

export function normSize(v: string | null | undefined): string | null {
  if (v == null) return null;
  const cleaned = String(v).trim().toUpperCase().replace(/\s+/g, "");
  if (!cleaned) return null;
  const m = SIZE_RE.exec(cleaned);
  if (!m) return null;
  return CANON[m[1]] ?? m[1];
}

export type StyleMapping = { product: string; heavy: boolean } | null;

const NO_ABSORBENCY_SPLIT = new Set(["Men's", "Super HW", "Shapewear", "Highrise Short", "Cotton"]);

// Token match, never substring — 'S' inside 'BSHORT' must not hit.
export function mapStyle(style: string | null | undefined): StyleMapping {
  if (style == null || !String(style).trim()) return null;
  const t = String(style).trim().toUpperCase().replace(/\./g, "").split(/\s+/);
  if (t.includes("SL")) return null; // Seamless: excluded by decision
  const heavy = t.includes("HF") || t.includes("HE");
  if (t.includes("CP")) return { product: "Comfort Plus", heavy };
  if (t.includes("HW")) return { product: "High Waisted", heavy };
  if (t.includes("OG")) return { product: "Comfy & Discreet", heavy };
  if (["BSHORT", "BS", "BOYSHORT", "BSHORTS"].some((x) => t.includes(x)))
    return { product: "Boyshort", heavy };
  if (t.includes("HIP")) return { product: "Hipster", heavy };
  if (t.includes("BIK")) return { product: "Bikini", heavy };
  if (t.includes("MENS") || t.includes("MEN'S") || t.includes("MEN"))
    return { product: "Men's", heavy: false };
  if (t.includes("SUPHW") || t.includes("SUPHFW")) return { product: "Super HW", heavy: false };
  // FC/HC: CS also writes French Cut / High Cut as initials.
  if (["FRENCH", "FR", "FC", "HC"].some((x) => t.includes(x))) return { product: "French", heavy };
  if (t.includes("SW") || t.includes("SHAPEWEAR")) return { product: "Shapewear", heavy: false };
  // Post-spec products (launched 2026): Highrise/Comfort Shorts and Cotton.
  if (["HRSHORT", "HSHORT", "HRSHORTS", "HSHORTS"].some((x) => t.includes(x)))
    return { product: "Highrise Short", heavy: false };
  if (t.includes("COTTON")) return { product: "Cotton", heavy: false };
  if (t.includes("HIPSTER")) return { product: "Hipster", heavy };
  return null;
}

export function labelOf(m: StyleMapping): string | null {
  if (!m) return null;
  if (NO_ABSORBENCY_SPLIT.has(m.product)) return m.product;
  return `${m.product} ${m.heavy ? "Heavy" : "Std"}`;
}

export function direction(
  sizeOrdered: string | null,
  sizeReplaced: string | null,
): "up" | "down" | "same" | "unknown" {
  const o = sizeOrdered != null ? SIZE_RANK[sizeOrdered] : undefined;
  const x = sizeReplaced != null ? SIZE_RANK[sizeReplaced] : undefined;
  if (o === undefined || x === undefined) return "unknown";
  if (x > o) return "up";
  if (x < o) return "down";
  return "same";
}

/** Multi-product cell: covers several products at once, unattributable. */
export function isMultiProduct(v: string | null | undefined): boolean {
  return /[,/]/.test(String(v ?? ""));
}

/**
 * Map a Shopify product title to the same labels the CS data uses
 * (spec step 8 mapping — order matters; exclusions first, then longest
 * names before their substrings).
 */
export function labelFromProductTitle(title: string): string | null {
  const s = title.toLowerCase();
  if (s.includes("seamless")) return null;
  if (
    ["lace brief", "cheeky", "floral", "mystery", "manual", "booklet"].some((x) => s.includes(x))
  ) {
    return null;
  }
  const heavy = s.includes("heavy");
  let product: string | null = null;
  if (s.includes("shapewear") || s.includes("shaping brief")) product = "Shapewear";
  else if (s.includes("men's") || s.includes("mens")) product = "Men's";
  else if (s.includes("super high waisted")) product = "Super HW";
  // Comfort Shorts is the same garment as Highrise Shorts (reviews page
  // already merges them under one display name).
  else if (
    s.includes("highrise short") ||
    s.includes("high rise short") ||
    s.includes("comfort shorts")
  ) {
    product = "Highrise Short";
  } else if (s.includes("high cut")) product = "French";
  else if (s.includes("boyshort")) product = "Boyshort";
  else if (s.includes("hipster")) product = "Hipster";
  else if (s.includes("bikini")) product = "Bikini";
  else if (s.includes("comfort plus")) product = "Comfort Plus";
  else if (s.includes("high waisted")) product = "High Waisted";
  else if (s.includes("comfy") && s.includes("discreet")) product = "Comfy & Discreet";
  else if (s.includes("cotton")) product = "Cotton";
  if (!product) return null;
  if (NO_ABSORBENCY_SPLIT.has(product)) return product;
  return `${product} ${heavy ? "Heavy" : "Std"}`;
}

/** Size from a Shopify variant title: the part before the first '/'. */
export function sizeFromVariantTitle(variantTitle: string): string | null {
  const first = variantTitle.split("/")[0];
  return normSize(first);
}

/**
 * Map a reviews-page KPI row (displayName, line) to its sizing label.
 * The KPI row's line is authoritative for Std/Heavy — the same display
 * name covers both lines.
 */
export function sizingLabelFor(displayName: string, line: string | null): string | null {
  const base = labelFromProductTitle(displayName);
  if (!base) return null;
  if (base.endsWith(" Std") || base.endsWith(" Heavy")) {
    const product = base.replace(/ (Std|Heavy)$/, "");
    return `${product} ${line === "heavy" ? "Heavy" : "Std"}`;
  }
  return base;
}
