// Maps /launches row names (deriveLaunchName output, e.g. "Cotton High
// Waisted 5-Pack") onto the Launch Info sheet's "Product" column (e.g.
// "Cotton HW"). The two vocabularies grew independently, so exact
// normalized match is tried first and a hand-checked alias table covers
// the rest (verified against prod launches + the live tab, 2026-07-08).
// Sheet facts are the source of truth per the owner: the team updates
// the sheet, the tool only displays.

/** lowercase, trim, collapse runs of whitespace. */
export function normalizeLaunchInfoName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, " ").trim();
}

/** launch productName (normalized) -> sheet Product (normalized). */
const LAUNCH_TO_SHEET_ALIASES: Record<string, string> = {
  "cotton high waisted 5-pack": "cotton hw",
  "super high-waist 5-pack multi color": "super hw fc",
  "mens brief with fly 3-pack": "men's brief with fly",
  "mens brief with fly 3-pack black": "men's brief with fly (black)",
  "boxer w/ fly 3-pack": "men's boxer brief with fly",
  "boxer w/ fly 3-pack black": "men's boxer brief with fly (black)",
};

/** Resolve a launch row's productName to the sheet-product key
 * (normalized). Callers index their launch_info rows by
 * normalizeLaunchInfoName(product). */
export function launchInfoKeyFor(launchProductName: string): string {
  const n = normalizeLaunchInfoName(launchProductName);
  return LAUNCH_TO_SHEET_ALIASES[n] ?? n;
}
