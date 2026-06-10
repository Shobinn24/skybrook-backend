import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import { adSpendDaily } from "@/lib/db/schema";
import type { SourceRunner } from "@/lib/jobs/ingest";
import { postAlert } from "@/lib/notifications/slack";
import { buildSheetsClient } from "./client";

// ============================================================================
// Ad spend (Supermetrics FB sheet) — one tab per product, two columns
// (Date, Cost). Refreshed by Supermetrics at 4am Asuncion time daily
// (= 3am EDT / 7am UTC); we re-pull at the regular 09:00 UTC cron run,
// giving Supermetrics a 2h completion buffer. Schedule updated
// 2026-05-14 — see SESSION_HANDOFF and scripts/README for the
// rationale + Paraguay DST gotcha.
//
// Tab list is intentionally hardcoded so a typo / renamed tab fails
// loud instead of silently dropping a product. Update here when Scott
// adds a new tab.
// ============================================================================
export const AD_SPEND_TABS = [
  "Men",
  "Shapewear",
  "SuperHW",
  "HRS",
  "Men AL",
  "Shapewear AL",
  "Super HW AL",
  "HRS AL",
] as const;

export type AdSpendTab = (typeof AD_SPEND_TABS)[number];

// Tabs wired into the ingest before any spend exists yet (newly connected
// data sources). They are pulled normally, but stale-signals — the per-tab
// freshness P1 (freshness-check.ts) and the /performance per-tab badge
// (performance.ts) — are SUPPRESSED while the tab has zero rows, so a tab
// connected ahead of its first dollar doesn't page on a null max(date).
// The moment the tab has any dated row, full staleness coverage resumes.
// "HRS AL": HRS AppLovin connected 2026-06-03 so spend imports the day it
// starts, even though AppLovin HRS spend is $0 today.
export const AD_SPEND_TABS_STALE_EXEMPT_UNTIL_FIRST_DATA: ReadonlySet<string> =
  new Set(["HRS AL"]);

// Supermetrics returns error messages INLINE in the value cells when a
// data source goes offline (license lapse, quota exceeded, connector
// auth expired). E.g. on 2026-05-05 the AppLovin license was dropped
// and all 3 AL tabs started returning "Error: Your license doesn't
// include the Axon by AppLovin data source (user: scott@..., team: ...,
// team ID: ...). Learn more at: https://hub.supermetrics.com".
//
// We detect these explicitly so the ingest can surface a Slack alert
// instead of silently treating the row as "unparseable date" and
// dropping it (which masks the outage — see 2026-05-22 incident).
const SUPERMETRICS_ERROR_PREFIX = /^Error[:\s]/i;
const SUPERMETRICS_HINT = /license|data source|quota|Supermetrics/i;
// A query that runs fine but whose filter matches nothing makes Supermetrics
// write "Error: No data found. Your filters excluded all data..." into the
// cell. That's a benign empty result (e.g. a product tab connected ahead of
// its first spend, like HRS AppLovin), NOT an upstream outage — so it must
// not raise a P1 source-error alert. Genuine staleness on a tab that SHOULD
// have data is caught by the per-product date freshness check instead.
const SUPERMETRICS_BENIGN_NO_DATA =
  /no data found|filters? excluded all data|returned no data/i;

function detectSupermetricsError(
  rawDate: string,
  rawCost: string,
): string | null {
  const combined = `${rawDate} ${rawCost}`.trim();
  if (
    !SUPERMETRICS_ERROR_PREFIX.test(rawDate) &&
    !SUPERMETRICS_ERROR_PREFIX.test(rawCost) &&
    !SUPERMETRICS_HINT.test(combined)
  ) {
    return null;
  }
  // Benign empty-filter result — not an outage. Real license/quota/auth
  // errors use different wording and still fall through to be flagged.
  if (SUPERMETRICS_BENIGN_NO_DATA.test(combined)) return null;
  // Strip parenthetical sub-clauses (user IDs, team IDs vary per env) so
  // the signature is stable for Slack dedup across accounts and re-runs.
  return combined
    .replace(/\([^)]*\)/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

export type AdSpendRow = {
  product: string;
  spendDate: string; // YYYY-MM-DD
  costUsd: number;
  sourceRowRef: string;
};

// Parse a single (Date, Cost|Spend) tab. Supermetrics' FB connector
// labels the value column "Cost"; the AppLovin connector labels it
// "Spend". Both are accepted. Skips header + blank rows. Values
// come back as either plain numbers ("2791.18") or formatted
// currency ("$2,791.18") depending on cell formatting — strip
// non-numeric characters before Number().
export type AdSpendSourceError = {
  rowIdx: number;
  signature: string;
  sample: string;
};

export function parseAdSpendTab(
  tabName: string,
  grid: ReadonlyArray<ReadonlyArray<unknown>>,
): {
  rows: AdSpendRow[];
  skipped: Array<{ rowIdx: number; reason: string }>;
  sourceErrors: AdSpendSourceError[];
} {
  const rows: AdSpendRow[] = [];
  const skipped: Array<{ rowIdx: number; reason: string }> = [];
  const sourceErrors: AdSpendSourceError[] = [];

  // Row 0 is header. Bail if header doesn't look right.
  const header = (grid[0] ?? []).map((c) => String(c ?? "").trim().toLowerCase());
  const valueHeaderOk = header[1] === "cost" || header[1] === "spend";
  if (header[0] !== "date" || !valueHeaderOk) {
    skipped.push({
      rowIdx: 0,
      reason: `unexpected header: ${JSON.stringify(grid[0] ?? [])}`,
    });
    return { rows, skipped, sourceErrors };
  }

  for (let r = 1; r < grid.length; r++) {
    const row = grid[r] ?? [];
    const rawDate = String(row[0] ?? "").trim();
    const rawCost = String(row[1] ?? "").trim();
    if (!rawDate && !rawCost) continue; // blank row

    // Supermetrics surfaces upstream failures (license lapse, quota,
    // auth) as error strings INSIDE the value cells. Detect explicitly
    // so the cron can Slack-alert instead of silently skipping the row
    // as "unparseable date". This is what made the 2026-05-05 AppLovin
    // license lapse invisible for 17 days until Scott eyeballed it.
    const errSig = detectSupermetricsError(rawDate, rawCost);
    if (errSig) {
      sourceErrors.push({
        rowIdx: r,
        signature: errSig,
        sample: `${rawDate} | ${rawCost}`.slice(0, 300),
      });
      continue;
    }

    // Date: accept ISO YYYY-MM-DD verbatim; if it's a different format
    // we flag it (Supermetrics outputs ISO, but defensive in case
    // someone changes the cell format).
    if (!/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
      skipped.push({ rowIdx: r, reason: `unparseable date "${rawDate}"` });
      continue;
    }

    const cleaned = rawCost.replace(/[$,]/g, "");
    const cost = Number(cleaned);
    if (!Number.isFinite(cost)) {
      skipped.push({ rowIdx: r, reason: `unparseable cost "${rawCost}"` });
      continue;
    }

    rows.push({
      product: tabName,
      spendDate: rawDate,
      costUsd: cost,
      sourceRowRef: `${tabName}!A${r + 1}`,
    });
  }

  return { rows, skipped, sourceErrors };
}

/** Collapse rows that share a (product, spendDate) key into a single
 * last-write-wins row, returning the deduped rows alongside metadata
 * about which collisions were collapsed. Supermetrics occasionally
 * emits the same date twice in a single tab (observed 2026-05-10 in
 * SuperHW: rows 7 and 9 both 2026-05-09 = 310.82). Before deduping,
 * the second INSERT collided on the PK (product, spend_date) and the
 * whole truncate-replace transaction rolled back, leaving the table
 * empty and breaking the Performance tab. Last-write-wins matches
 * PostgreSQL's natural ON CONFLICT DO UPDATE semantics; the collapsed
 * dupes flow into rawPayload.dupesCollapsed for diagnostic visibility.
 */
export function dedupeAdSpendRows(rows: ReadonlyArray<AdSpendRow>): {
  dedupedRows: AdSpendRow[];
  dupesCollapsed: Array<{
    product: string;
    spendDate: string;
    firstRowRef: string;
    secondRowRef: string;
  }>;
} {
  const map = new Map<string, AdSpendRow>();
  const dupesCollapsed: Array<{
    product: string;
    spendDate: string;
    firstRowRef: string;
    secondRowRef: string;
  }> = [];
  for (const r of rows) {
    const key = `${r.product}!${r.spendDate}`;
    const prior = map.get(key);
    if (prior) {
      dupesCollapsed.push({
        product: r.product,
        spendDate: r.spendDate,
        firstRowRef: prior.sourceRowRef,
        secondRowRef: r.sourceRowRef,
      });
    }
    map.set(key, r);
  }
  return { dedupedRows: Array.from(map.values()), dupesCollapsed };
}

export const sheetsAdSpendRunner: SourceRunner = async (_batchId) => {
  const sheetId = process.env.AD_SPEND_SHEET_ID;
  if (!sheetId) throw new Error("sheets_ad_spend: missing AD_SPEND_SHEET_ID");

  const sheets = buildSheetsClient();

  // One batchGet round-trip across all tabs — cheaper than per-tab gets
  // when there are 4 tabs.
  const ranges = AD_SPEND_TABS.map((t) => `'${t}'!A1:B400`);
  const resp = await sheets.spreadsheets.values.batchGet({
    spreadsheetId: sheetId,
    ranges,
  });

  const allRows: AdSpendRow[] = [];
  const allSkipped: Array<{ tab: string; rowIdx: number; reason: string }> = [];
  const allSourceErrors: Array<{
    tab: string;
    rowIdx: number;
    signature: string;
    sample: string;
  }> = [];

  // Header row per tab — the SCHEMA signal for drift detection. We
  // deliberately do NOT mix row count into the fingerprint: ad_spend
  // grows by a row every day (MERGE_RESULTS append), so a count-based
  // fingerprint would "drift" on every single pull and make the
  // schema-drift alert useless. Tab set + column headers only.
  const headerByTab: Record<string, string[]> = {};

  for (let i = 0; i < AD_SPEND_TABS.length; i++) {
    const tab = AD_SPEND_TABS[i];
    const grid = (resp.data.valueRanges?.[i]?.values ?? []) as unknown[][];
    headerByTab[tab] = (grid[0] ?? []).map((c) => String(c ?? "").trim());
    const { rows, skipped, sourceErrors } = parseAdSpendTab(tab, grid);
    allRows.push(...rows);
    for (const s of skipped) allSkipped.push({ tab, ...s });
    for (const e of sourceErrors) allSourceErrors.push({ tab, ...e });
  }

  const { dedupedRows, dupesCollapsed } = dedupeAdSpendRows(allRows);

  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        tabs: AD_SPEND_TABS,
        headers: headerByTab,
      }),
    )
    .digest("hex")
    .slice(0, 16);

  return {
    ok: true,
    rowCount: dedupedRows.length,
    rawPayload: {
      tabs: AD_SPEND_TABS,
      sample: dedupedRows.slice(0, 5),
      skipped: allSkipped,
      dupesCollapsed,
      sourceErrors: allSourceErrors,
    },
    schemaFingerprint: fingerprint,
    sourceErrors: allSourceErrors.map((e) => ({
      tab: e.tab,
      signature: e.signature,
      sample: e.sample,
    })),
    async normalize(rawId) {
      // Refuse-to-wipe guard: zero parsed rows across every tab means
      // the read/parse failed (header drift, API error), not that all
      // ad spend history disappeared. Truncating ad_spend_daily on it
      // would show $0 spend / null ROAS on /performance while looking
      // healthy. Keep existing data, page P1, bail.
      if (dedupedRows.length === 0) {
        await postAlert({
          severity: "p1",
          channel: "alerts",
          dedupKey: "sheets_ad_spend.empty_parse",
          title:
            "Ad-spend ingest blocked: parse produced no rows — refusing to truncate ad_spend_daily",
          fields: {
            tabs: AD_SPEND_TABS.join(", "),
            skipped: allSkipped.length,
            firstSkipReason: allSkipped[0]?.reason ?? null,
          },
        });
        return;
      }
      // Truncate-replace per pull. Supermetrics history is ~30-90 days
      // depending on the owner-side query config; refreshing the whole
      // table keeps us aligned without needing change-detection.
      await db.transaction(async (tx) => {
        await tx.delete(adSpendDaily);
        for (const r of dedupedRows) {
          await tx.insert(adSpendDaily).values({
            product: r.product,
            spendDate: r.spendDate,
            costUsd: r.costUsd.toString(),
            sourcePullId: rawId,
          });
        }
      });
    },
  };
};
