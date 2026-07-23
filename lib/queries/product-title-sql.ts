import { sql, type SQL } from "drizzle-orm";

// SQL mirror of displayNameForProduct (lib/jobs/loox-api-sync.ts): strip
// the "NEW:" prefix, one trailing parenthetical, and bare pack-size
// suffixes, then lowercase/trim. Order lines carry listings that may never
// have received a review (packs, bundles), so their product ids are absent
// from the review-derived family map — normalizing the order line's TITLE
// to a display name is the only way those purchases can match a family.
// Keep in lockstep with displayNameForProduct; regex changes go to both.
export function normalizedTitleSql(col: SQL): SQL {
  return sql`lower(btrim(regexp_replace(regexp_replace(regexp_replace(${col}, '^new:\\s*', '', 'i'), '\\s*\\([^)]*\\)\\s*$', ''), '[\\s-]*\\d+[\\s-]?packs?([\\s-]*\\d+)?\\s*$', '', 'i')))`;
}
