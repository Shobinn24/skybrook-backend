// Feeder-query freshness — reads each backend-feeding Supermetrics query's
// `updated` timestamp straight from its sheet's `SupermetricsQueries`
// metadata tab and fails when a query hasn't refreshed in maxAgeHours.
//
// Why this exists (2026-07-06): the FB Ad URL Map query silently stopped
// refreshing for 2 days. Nothing errored — the two heavier queries ahead
// of it (AppLovin last60days, FB Geo last30days) ate the nightly trigger's
// execution budget, so the third query was simply skipped. Its lastStatus
// still read "Refreshed successfully" (from the last completed run), the
// spreadsheet's Drive modifiedTime kept moving because the sibling tabs
// DID refresh, and the URL-map tab has no date column — so the DB
// freshness checks, the sheet-poll modifiedTime comparison, and the
// reference-tab sweep all stayed green while URL attribution quietly aged.
// The query metadata's own `updated` column is the only signal that sees
// this failure mode, and it covers every feeder uniformly.
//
// p2 → #skybrook-digest (data degrades gracefully: URL-map misses fall
// back to ad-name + geo attribution; spend tables have their own date-
// based checks that escalate independently if the DB actually goes stale).
import { db } from "@/lib/db";
import { supermetricsQueryState } from "@/lib/db/schema";
import { buildSheetsClient } from "@/lib/sources/sheets";
import { logger } from "@/lib/logger";
import type { EvaluatedCheck } from "@/lib/jobs/freshness-check";

type SheetsClient = ReturnType<typeof buildSheetsClient>;

export type MonitoredSupermetricsQuery = {
  /** Stable slug — becomes the check name + alert dedup key. Don't rename casually. */
  label: string;
  /** Env var holding the spreadsheet id (matches the ingest source config). */
  sheetIdEnv: string;
  /** The query's target tab, as written in the metadata `sheetName` column. */
  tabName: string;
  maxAgeHours: number;
};

// Every Supermetrics query the backend ingests from. Scott's manual
// reference queries (Sheet4/5/6/10 on the FB Ads Tracker sheet) are
// deliberately NOT here — whether those live or die is his call.
export const MONITORED_SUPERMETRICS_QUERIES: ReadonlyArray<MonitoredSupermetricsQuery> = [
  { label: "fb_ads_tracker.fb_ads_live", sheetIdEnv: "FB_ADS_SHEET_ID", tabName: "FB Ads Live", maxAgeHours: 48 },
  { label: "fb_ads_tracker.campaign_daily", sheetIdEnv: "FB_ADS_SHEET_ID", tabName: "Campaign Daily", maxAgeHours: 48 },
  { label: "applovin_live.applovin", sheetIdEnv: "APPLOVIN_ADS_SHEET_ID", tabName: "AppLovin", maxAgeHours: 48 },
  { label: "applovin_live.fb_geo_spend", sheetIdEnv: "APPLOVIN_ADS_SHEET_ID", tabName: "FB Geo Spend", maxAgeHours: 48 },
  { label: "applovin_live.fb_ad_url_map", sheetIdEnv: "APPLOVIN_ADS_SHEET_ID", tabName: "FB Ad URL Map", maxAgeHours: 48 },
  // Ad-spend sheet per-product tabs (added 2026-07-14 — these feed the
  // ad_spend_daily tables but had no query-level coverage; a silent-skip
  // there looked identical to "no spend yet"). Same tab list as
  // AD_SPEND_TABS in the ingest.
  { label: "ad_spend.men", sheetIdEnv: "AD_SPEND_SHEET_ID", tabName: "Men", maxAgeHours: 48 },
  { label: "ad_spend.shapewear", sheetIdEnv: "AD_SPEND_SHEET_ID", tabName: "Shapewear", maxAgeHours: 48 },
  { label: "ad_spend.superhw", sheetIdEnv: "AD_SPEND_SHEET_ID", tabName: "SuperHW", maxAgeHours: 48 },
  { label: "ad_spend.hrs", sheetIdEnv: "AD_SPEND_SHEET_ID", tabName: "HRS", maxAgeHours: 48 },
  { label: "ad_spend.men_al", sheetIdEnv: "AD_SPEND_SHEET_ID", tabName: "Men AL", maxAgeHours: 48 },
  { label: "ad_spend.shapewear_al", sheetIdEnv: "AD_SPEND_SHEET_ID", tabName: "Shapewear AL", maxAgeHours: 48 },
  { label: "ad_spend.super_hw_al", sheetIdEnv: "AD_SPEND_SHEET_ID", tabName: "Super HW AL", maxAgeHours: 48 },
  { label: "ad_spend.hrs_al", sheetIdEnv: "AD_SPEND_SHEET_ID", tabName: "HRS AL", maxAgeHours: 48 },
];

const SHEETS_SERIAL_EPOCH_MS = Date.UTC(1899, 11, 30);

/** Sheets serial (or ISO-ish string) -> epoch ms, or null when unparseable. */
function updatedToMs(cell: unknown): number | null {
  if (typeof cell === "number" && Number.isFinite(cell) && cell > 0) {
    return SHEETS_SERIAL_EPOCH_MS + cell * 86400000;
  }
  if (typeof cell === "string" && cell.trim()) {
    const t = Date.parse(cell);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

/** Strip the stray quote/apostrophe artifacts Supermetrics writes into
 * sheetName cells (observed: "FB Ads Live'") and normalize spacing. */
function normalizeTabName(v: unknown): string {
  return String(v ?? "").replaceAll("'", "").replaceAll('"', "").trim();
}

function baseCheck(q: MonitoredSupermetricsQuery): Omit<EvaluatedCheck, "status" | "title"> {
  return {
    name: `supermetrics_query.${q.label}`,
    maxDate: null,
    threshold: `${q.maxAgeHours}h`,
    dedupKey: `freshness:supermetrics_query:${q.label}`,
    severity: "p2",
    fields: { label: q.label, tabName: q.tabName, maxAgeHours: q.maxAgeHours },
  };
}

/**
 * Pure evaluator: one sheet's `SupermetricsQueries` grid + the monitored
 * queries that live on that sheet -> checks. The header row is located by
 * its "paramsID" key cell; `sheetName` + `updated` columns are resolved
 * from it (column positions have drifted across add-on versions). When
 * several query rows target the same tab, the newest `updated` wins.
 */
export function evaluateSupermetricsQueryGrid(
  grid: ReadonlyArray<ReadonlyArray<unknown>>,
  queries: ReadonlyArray<MonitoredSupermetricsQuery>,
  nowMs: number,
): EvaluatedCheck[] {
  const headerIdx = grid.findIndex((row) =>
    (row ?? []).some((c) => String(c ?? "").trim() === "paramsID"),
  );
  if (headerIdx < 0) {
    return queries.map((q) => ({
      ...baseCheck(q),
      status: "fail",
      title: `supermetrics query metadata unreadable for ${q.label} (no paramsID header row)`,
    }));
  }
  const header = (grid[headerIdx] ?? []).map((c) => String(c ?? "").trim());
  const nameCol = header.indexOf("sheetName");
  const updatedCol = header.indexOf("updated");
  if (nameCol < 0 || updatedCol < 0) {
    return queries.map((q) => ({
      ...baseCheck(q),
      status: "fail",
      title: `supermetrics query metadata unreadable for ${q.label} (missing sheetName/updated columns)`,
    }));
  }

  // tab -> newest updated ms among its query rows
  const newestByTab = new Map<string, number>();
  for (let r = headerIdx + 1; r < grid.length; r++) {
    const row = grid[r] ?? [];
    const tab = normalizeTabName(row[nameCol]);
    if (!tab) continue;
    const ms = updatedToMs(row[updatedCol]);
    if (ms === null) continue;
    const prev = newestByTab.get(tab);
    if (prev === undefined || ms > prev) newestByTab.set(tab, ms);
  }

  return queries.map((q) => {
    const ms = newestByTab.get(q.tabName);
    if (ms === undefined) {
      return {
        ...baseCheck(q),
        status: "fail",
        title: `no query found targeting tab "${q.tabName}" in SupermetricsQueries (${q.label})`,
      };
    }
    const ageHours = (nowMs - ms) / 3_600_000;
    const updatedIso = new Date(ms).toISOString();
    const stale = ageHours > q.maxAgeHours;
    return {
      ...baseCheck(q),
      status: stale ? "fail" : "pass",
      maxDate: updatedIso.slice(0, 10),
      title: stale
        ? `Supermetrics query for "${q.tabName}" not refreshed in ${Math.round(ageHours)}h (last ${updatedIso}) — ${q.label}`
        : null,
      fields: {
        label: q.label,
        tabName: q.tabName,
        maxAgeHours: q.maxAgeHours,
        lastRefreshed: updatedIso,
        ageHours: Math.round(ageHours * 10) / 10,
      },
    };
  });
}

/**
 * I/O wrapper: reads each configured spreadsheet's SupermetricsQueries tab
 * once and evaluates its monitored queries. Sheets whose env id is unset
 * are skipped silently (matches the ingest sources' behavior); a read
 * failure fails that sheet's checks as unreadable rather than throwing.
 */
export async function evaluateSupermetricsQueryFreshness(opts?: {
  now?: () => Date;
  client?: SheetsClient;
  queries?: ReadonlyArray<MonitoredSupermetricsQuery>;
}): Promise<EvaluatedCheck[]> {
  const nowMs = (opts?.now ?? (() => new Date()))().getTime();
  const queries = opts?.queries ?? MONITORED_SUPERMETRICS_QUERIES;
  const client = opts?.client ?? buildSheetsClient();

  const bySheet = new Map<string, MonitoredSupermetricsQuery[]>();
  for (const q of queries) {
    const sheetId = process.env[q.sheetIdEnv]?.trim();
    if (!sheetId) continue;
    const list = bySheet.get(sheetId) ?? [];
    list.push(q);
    bySheet.set(sheetId, list);
  }

  const checks: EvaluatedCheck[] = [];
  // Sequential — same Sheets-API quota reasoning as the reference-tab sweep.
  for (const [sheetId, sheetQueries] of bySheet) {
    try {
      const resp = await client.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range: "'SupermetricsQueries'!A1:BM100",
        valueRenderOption: "UNFORMATTED_VALUE",
      });
      const grid = (resp.data.values ?? []) as unknown[][];
      checks.push(...evaluateSupermetricsQueryGrid(grid, sheetQueries, nowMs));
    } catch (e) {
      const error = e instanceof Error ? e.message.slice(0, 200) : String(e);
      logger.warn("freshness.supermetrics_queries.sheet_unreadable", { sheetId, error });
      for (const q of sheetQueries) {
        checks.push({
          ...baseCheck(q),
          status: "fail",
          title: `supermetrics query metadata unreadable for ${q.label}: ${error}`,
          fields: { label: q.label, tabName: q.tabName, maxAgeHours: q.maxAgeHours, error },
        });
      }
    }
  }

  // Persist last-seen state so /api/health (DB-only, no Sheets budget) can
  // answer "did Supermetrics run, and when?" on demand. Best-effort — a DB
  // hiccup here must not fail the sweep the checks are for.
  try {
    for (const c of checks) {
      const lastRefreshed =
        typeof c.fields.lastRefreshed === "string" ? new Date(c.fields.lastRefreshed) : null;
      await db
        .insert(supermetricsQueryState)
        .values({
          label: String(c.fields.label),
          tabName: String(c.fields.tabName),
          lastRefreshedAt: lastRefreshed,
          status: c.status,
          checkedAt: new Date(nowMs),
        })
        .onConflictDoUpdate({
          target: supermetricsQueryState.label,
          set: {
            tabName: String(c.fields.tabName),
            lastRefreshedAt: lastRefreshed,
            status: c.status,
            checkedAt: new Date(nowMs),
          },
        });
    }
  } catch (e) {
    logger.warn("freshness.supermetrics_queries.state_persist_failed", {
      error: e instanceof Error ? e.message.slice(0, 200) : String(e),
    });
  }

  return checks;
}
