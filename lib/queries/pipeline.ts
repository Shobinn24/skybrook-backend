import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { dataPulls } from "@/lib/db/schema";

export async function getLatestPullsPerSource() {
  const rows = await db.select().from(dataPulls).orderBy(desc(dataPulls.startedAt));
  const seen = new Set<string>();
  const latest: typeof rows = [];
  for (const r of rows) {
    if (seen.has(r.source)) continue;
    seen.add(r.source);
    latest.push(r);
  }
  return latest;
}

const PULL_HISTORY_DEFAULT_LIMIT = 30;
const PULL_HISTORY_MAX_LIMIT = 200;

export type PullHistoryRow = typeof dataPulls.$inferSelect;

/** Most-recent N pulls for one source, newest first. Used by the
 * Pipeline status page to show per-source history (SPEC §3.6).
 */
export async function getPullHistoryForSource(
  source: PullHistoryRow["source"],
  limit: number = PULL_HISTORY_DEFAULT_LIMIT,
): Promise<PullHistoryRow[]> {
  const safeLimit = Math.max(1, Math.min(limit, PULL_HISTORY_MAX_LIMIT));
  return db
    .select()
    .from(dataPulls)
    .where(eq(dataPulls.source, source))
    .orderBy(desc(dataPulls.startedAt))
    .limit(safeLimit);
}

/** Per-source pull histories keyed by source enum value. The page
 * renders one section per source even when a source has zero pulls
 * (so a misconfigured source still surfaces visually, rather than
 * silently disappearing from the page).
 */
export async function getPullHistoryAllSources(
  limitPerSource: number = PULL_HISTORY_DEFAULT_LIMIT,
): Promise<Record<PullHistoryRow["source"], PullHistoryRow[]>> {
  const sources: PullHistoryRow["source"][] = [
    "sheets_inventory",
    "sheets_incoming",
    "shopify_us",
    "shopify_intl",
  ];
  const entries = await Promise.all(
    sources.map(async (s) => [s, await getPullHistoryForSource(s, limitPerSource)] as const),
  );
  return Object.fromEntries(entries) as Record<PullHistoryRow["source"], PullHistoryRow[]>;
}
