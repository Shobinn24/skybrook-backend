// The 8-marketer roster Scott uses for FB Ads attribution.
// Order = display order in the multi-select filter. "JW" is intentionally
// kept as 2 letters since that's the in-sheet convention.
export const FB_MARKETERS = [
  "Craig",
  "Nate",
  "Raul",
  "Tyler",
  "Scotty",
  "Jacob",
  "Dan",
  "JW",
] as const;

export type FbMarketer = (typeof FB_MARKETERS)[number];

// Sentinel value for ads whose ad_name_raw matched none of the 8 names.
// Used in the UI multi-select alongside the real names.
export const FB_MARKETER_UNASSIGNED = "Unassigned" as const;

// Pre-compiled case-insensitive word-boundary regex per name.
// `\b` correctly fires between word chars and non-word chars, which
// covers the real ad-name patterns ("Ad 2326 - RC - Craig Mens VID 2",
// "Dan Navarra Postpartum", "JW - C1 - 3/9/26") without false-matching
// inside longer words like "Daniel" or "Bandana".
const MARKETER_PATTERNS: ReadonlyArray<readonly [FbMarketer, RegExp]> =
  FB_MARKETERS.map((name) => [name, new RegExp(`\\b${name}\\b`, "i")] as const);

/**
 * Returns the deduped, roster-ordered list of marketer names that appear
 * as standalone words inside `adNameRaw`. Empty array when no roster
 * name matches — the UI treats those as "Unassigned".
 */
export function extractMarketers(adNameRaw: string): FbMarketer[] {
  if (!adNameRaw) return [];
  const hits: FbMarketer[] = [];
  for (const [name, pattern] of MARKETER_PATTERNS) {
    if (pattern.test(adNameRaw)) hits.push(name);
  }
  return hits;
}
