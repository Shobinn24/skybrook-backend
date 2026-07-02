// Video-editor bonus program (client spec 2026-07-02): AI video ads —
// raw names carrying the "AIad" dash-segment — earn a SECOND bonus for
// the video editor tagged right after that segment, on the same
// $13k/$65k lifetime-spend thresholds as the marketer program
// (BONUS_TIER_1_USD / BONUS_TIER_2_USD in bonus-tiers.ts). Dual credit
// is intended: one ad can pay both its marketer and its editor.
//
// Editor awards reuse the bonus_awards table: the free-text `marketer`
// column stores the editor's DISPLAY NAME, so these names must never
// collide with the FB marketer roster (unit-tested).

// Display order for the Bonus Tracker "Video Editors" section.
export const VIDEO_EDITORS = [
  "Greg",
  "Ryan",
  "Sebastian",
  "Job",
  "Cristian",
  "Phat Lee",
] as const;

export type VideoEditor = (typeof VIDEO_EDITORS)[number];

const VIDEO_EDITOR_SET: ReadonlySet<string> = new Set(VIDEO_EDITORS);

export function isVideoEditor(name: string): name is VideoEditor {
  return VIDEO_EDITOR_SET.has(name);
}

// Initials → editor. PHL and PL are alternate tags for the same person
// (client 2026-07-02). Keys are uppercase; lookups normalize first.
export const VIDEO_EDITOR_INITIALS: Readonly<Record<string, VideoEditor>> = {
  GA: "Greg",
  RC: "Ryan",
  SR: "Sebastian",
  JM: "Job",
  CE: "Cristian",
  PHL: "Phat Lee",
  PL: "Phat Lee",
};

// Initials seen in real AIAD ad names that the client ruled are NOT
// video editors (2026-07-02). No bonus, and intentionally kept OFF the
// unknown-initials "needs a ruling" surface — they already have one.
export const EXCLUDED_VIDEO_EDITOR_INITIALS: ReadonlySet<string> = new Set([
  "CJ",
  "SJ",
  "SCOTTY",
]);

export type VideoEditorExtraction =
  | { kind: "editor"; editor: VideoEditor; initials: string }
  | { kind: "excluded"; initials: string }
  | { kind: "unknown"; initials: string };

/**
 * Parse an ad's raw name for the video-editor tag. Real shape:
 *
 *   (Product) Ad NNNN - AIad - <INITIALS> - <description>
 *
 * The initials are the dash-segment immediately after the "AIad"
 * segment (case-insensitive, exact segment match — "AIadvert" doesn't
 * fire). Returns:
 *   - { kind: "editor" }   known initials (see VIDEO_EDITOR_INITIALS)
 *   - { kind: "excluded" } client-ruled non-editors (CJ/SJ/SCOTTY)
 *   - { kind: "unknown" }  anything else — surfaced for an operator ruling
 *   - null                 not an AI ad (no AIad segment / no initials)
 *
 * Initials are normalized to uppercase in every branch so callers can
 * aggregate unknowns without case-dupes.
 */
export function extractVideoEditor(
  adNameRaw: string,
): VideoEditorExtraction | null {
  if (!adNameRaw) return null;
  const segments = adNameRaw.split("-").map((s) => s.trim());
  const aiadIdx = segments.findIndex((s) => s.toLowerCase() === "aiad");
  if (aiadIdx < 0) return null;
  const initials = segments[aiadIdx + 1]?.toUpperCase();
  if (!initials) return null;
  if (EXCLUDED_VIDEO_EDITOR_INITIALS.has(initials)) {
    return { kind: "excluded", initials };
  }
  const editor = VIDEO_EDITOR_INITIALS[initials];
  if (editor) return { kind: "editor", editor, initials };
  return { kind: "unknown", initials };
}

// Flat editor rates — no main/secondary split (client 2026-07-02).
// Same freeze-at-approval convention as marketer amounts.
const VIDEO_EDITOR_RATES: Record<"tier1" | "tier2", number> = {
  tier1: 200,
  tier2: 800,
};

export function videoEditorBonusAmountUsd(opts: {
  tier: "tier1" | "tier2";
  approval: "approved_full" | "approved_half";
}): number {
  const base = VIDEO_EDITOR_RATES[opts.tier];
  return opts.approval === "approved_half" ? base / 2 : base;
}

/** Pre-approval full amount for seeding pending rows (mirrors
 * bonusAmountAtFullUsd in bonus-tiers.ts). */
export function videoEditorBonusAmountAtFullUsd(opts: {
  tier: "tier1" | "tier2";
}): number {
  return VIDEO_EDITOR_RATES[opts.tier];
}
