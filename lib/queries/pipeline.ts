import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { dataPulls, rawPulls } from "@/lib/db/schema";

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

/** A pull row with schema-drift annotations attached. `schemaDrifted` is
 * true when this pull's fingerprint differs from the most recent
 * preceding successful pull's fingerprint for the same source — the
 * signal Scott needs to know "the upstream source changed shape."
 */
export type PullHistoryRowWithDrift = PullHistoryRow & {
  /** This pull's schema fingerprint (from rawPulls). null when the
   * pull failed before raw was written, or for legacy rows. */
  fingerprint: string | null;
  /** True when the fingerprint differs from the prior successful pull
   * for the same source. */
  schemaDrifted: boolean;
  /** The fingerprint we compared against — useful for showing
   * "changed from X to Y" tooltips. null when nothing prior exists
   * (so the very first pull is never marked as drifted). */
  priorFingerprint: string | null;
};

/** Most-recent N pulls for one source, newest first, with the raw
 * pull's schema fingerprint joined in. Used directly by callers that
 * want to compute drift themselves; the with-drift variant below is
 * the page-feeding shape.
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

/** Same as getPullHistoryForSource but also computes the drift flag
 * per row by walking pulls oldest → newest and comparing each
 * successful pull's fingerprint against the previous successful
 * pull's fingerprint for the same source.
 */
export async function getPullHistoryWithDriftForSource(
  source: PullHistoryRow["source"],
  limit: number = PULL_HISTORY_DEFAULT_LIMIT,
): Promise<PullHistoryRowWithDrift[]> {
  const safeLimit = Math.max(1, Math.min(limit, PULL_HISTORY_MAX_LIMIT));
  // Pull dataPulls + rawPulls.fingerprint in a single query so we don't
  // round-trip per row. Left join because rawPullId can be null on
  // failed pulls that errored before the raw payload was written.
  const rows = await db
    .select({
      // dataPulls fields — keep names matching PullHistoryRow shape.
      id: dataPulls.id,
      pullBatchId: dataPulls.pullBatchId,
      source: dataPulls.source,
      startedAt: dataPulls.startedAt,
      finishedAt: dataPulls.finishedAt,
      status: dataPulls.status,
      rowCount: dataPulls.rowCount,
      errorMessage: dataPulls.errorMessage,
      rawPullId: dataPulls.rawPullId,
      fingerprint: rawPulls.schemaFingerprint,
    })
    .from(dataPulls)
    .leftJoin(rawPulls, eq(dataPulls.rawPullId, rawPulls.id))
    .where(eq(dataPulls.source, source))
    .orderBy(desc(dataPulls.startedAt))
    .limit(safeLimit);

  return annotateDrift(rows);
}

/** Walk the pulls oldest → newest, compare each successful pull's
 * fingerprint against the previous successful pull's fingerprint, and
 * flag drift. Pure function — split out so the test suite can verify
 * the drift logic without setting up the join.
 */
export function annotateDrift(
  rowsNewestFirst: Array<PullHistoryRow & { fingerprint: string | null }>,
): PullHistoryRowWithDrift[] {
  // Oldest first so we can carry "prior successful fingerprint" forward.
  const oldestFirst = [...rowsNewestFirst].reverse();
  let priorFp: string | null = null;
  const annotated = oldestFirst.map((r): PullHistoryRowWithDrift => {
    const drifted =
      r.status === "success" &&
      r.fingerprint !== null &&
      priorFp !== null &&
      r.fingerprint !== priorFp;
    const result: PullHistoryRowWithDrift = {
      ...r,
      schemaDrifted: drifted,
      priorFingerprint: drifted ? priorFp : null,
    };
    if (r.status === "success" && r.fingerprint !== null) {
      priorFp = r.fingerprint;
    }
    return result;
  });
  // Restore the newest-first order the page expects.
  return annotated.reverse();
}

/** Per-source pull histories keyed by source enum value, with drift
 * flags computed per row. The page renders one section per source
 * even when a source has zero pulls (so a misconfigured source still
 * surfaces visually rather than silently disappearing).
 */
export async function getPullHistoryAllSources(
  limitPerSource: number = PULL_HISTORY_DEFAULT_LIMIT,
): Promise<Record<PullHistoryRow["source"], PullHistoryRowWithDrift[]>> {
  const sources: PullHistoryRow["source"][] = [
    "sheets_inventory",
    "sheets_incoming",
    "shopify_us",
    "shopify_intl",
  ];
  const entries = await Promise.all(
    sources.map(
      async (s) =>
        [s, await getPullHistoryWithDriftForSource(s, limitPerSource)] as const,
    ),
  );
  return Object.fromEntries(entries) as Record<
    PullHistoryRow["source"],
    PullHistoryRowWithDrift[]
  >;
}
