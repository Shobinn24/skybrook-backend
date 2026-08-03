// Auto-half rules (client spec 2026-08-03): certain ad patterns mean the
// marketer earns 50% of the bonus, applied ONLY to Craig / Raul / Tyler.
// Jacob and JW are the image-editor roster — when one of them appears on
// an ad alongside a rule marketer, the ad is an image-editor collab and
// the marketer's cut is half (the image editor's own award stays full).
//
// Detection is advisory at crossing time: the detector stamps
// half_suggested + half_reason on the pending award, the UI shows the
// suggestion, and the monthly auto-approval honors it. An operator can
// still override either way (client keeps final say via the mid-month
// review screen).

export const HALF_RULE_MARKETERS: ReadonlySet<string> = new Set([
  "Craig",
  "Raul",
  "Tyler",
]);

export const IMAGE_EDITORS = ["Jacob", "JW"] as const;

/**
 * Why this award should default to a 50% bonus, or null for full.
 *
 * `adMarketers` is the ad's parsed roster array (word-boundary match
 * against the marketer roster, done at ingest) — an image editor in it
 * IS "the editor's name appears in the ad name", which covers both of
 * the client's suggested detection methods: the same-ad image-editor
 * award only exists because the editor is in this array. The direct
 * name regex stays as a belt-and-suspenders fallback.
 */
export function halfBonusReason(opts: {
  marketer: string;
  adNameRaw: string;
  adMarketers: readonly string[];
}): string | null {
  if (!HALF_RULE_MARKETERS.has(opts.marketer)) return null;
  const name = opts.adNameRaw ?? "";
  if (/remake/i.test(name)) return 'auto 50%: "Remake" in ad name';
  if (/rehook/i.test(name)) return 'auto 50%: "Rehook" in ad name';
  const collab = IMAGE_EDITORS.find(
    (editor) =>
      opts.adMarketers.includes(editor) ||
      new RegExp(`\\b${editor}\\b`, "i").test(name),
  );
  if (collab) return `auto 50%: image ad with ${collab} (image editor)`;
  return null;
}
