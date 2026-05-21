// One-shot backfill of historical paid bonuses from the
// "Ads Bonus Tracking 3" Google Sheet into `bonus_awards`. Spec is
// the Bonus Tracker v2 plan, ask #5 (Scott WhatsApp 2026-05-20).
//
// Approach:
//   1. For each of the 6 active marketer tabs, parse rows where the
//      "13K Bonus" or "65K Bonus" column holds a paid-date string.
//   2. Filter out ads below each marketer's BONUS_AD_FLOOR (Jacob 1896,
//      Dan 1944, JW 1907) — those were either mis-attributed or
//      pre-date the program.
//   3. Insert one synthetic `bonus_notification_batches` row tagged
//      "Historical backfill 2026-05-21" so the awards have a batch to
//      hang off (the UI groups by batch in the ledger).
//   4. Insert each historical award as `approved_full`. The Summary
//      tab tracks halves separately but with no ad-level mapping, so
//      perfect half-vs-full reconstruction isn't possible. Mismatches
//      between per-marketer tab counts and Summary's full/half split
//      are emitted as a follow-up report — Jasper flips a handful of
//      rows to `approved_half` via the existing approval UI.
//   5. Idempotent via the (ad_number, marketer, tier) unique index —
//      reruns insert nothing on already-backfilled rows.
//
// Run:  pnpm tsx lib/jobs/backfill-historical-bonuses.ts --dry-run
//       pnpm tsx lib/jobs/backfill-historical-bonuses.ts --apply

import { sql } from "drizzle-orm";
import { google, type sheets_v4 } from "googleapis";
import {
  BONUS_AD_FLOOR,
  BONUS_MARKETERS,
  bonusAmountUsd,
  isAboveBonusFloor,
  type BonusMarketer,
} from "@/lib/domain/bonus-tiers";

// Local sheets client — mirrors lib/sources/sheets.ts buildSheetsClient
// but inlined here so the dry-run path doesn't drag in `@/lib/db`
// (which throws on missing DATABASE_URL at import time).
function buildSheetsClient(): sheets_v4.Sheets {
  const scopes = ["https://www.googleapis.com/auth/spreadsheets.readonly"];
  const jsonContent = process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
  const keyFile = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  if (jsonContent) {
    return google.sheets({
      version: "v4",
      auth: new google.auth.GoogleAuth({
        credentials: JSON.parse(jsonContent),
        scopes,
      }),
    });
  }
  if (keyFile) {
    return google.sheets({
      version: "v4",
      auth: new google.auth.GoogleAuth({ keyFile, scopes }),
    });
  }
  throw new Error(
    "backfill-historical-bonuses: set GOOGLE_APPLICATION_CREDENTIALS or GOOGLE_SERVICE_ACCOUNT_JSON",
  );
}

export const HISTORICAL_SHEET_ID =
  "19sLag1dApWVJn8t7VzGd0sKsJBcsRt5huIj5byAcJCw";

// Tab title in the workbook → canonical BONUS_MARKETERS name. The "2"
// suffix on Craig2/Raul2 is the v2 versions of those tabs; older
// "(ss)" tabs use "Yes" flags instead of dates and are out of scope.
export const HISTORICAL_TABS: ReadonlyArray<{
  tab: string;
  marketer: BonusMarketer;
}> = [
  { tab: "Craig2", marketer: "Craig" },
  { tab: "Raul2", marketer: "Raul" },
  { tab: "Tyler", marketer: "Tyler" },
  { tab: "Jacob", marketer: "Jacob" },
  { tab: "J Weston", marketer: "JW" },
  { tab: "Dan", marketer: "Dan" },
];

export const SUMMARY_TAB = "Summary";
export const BATCH_LABEL = "Historical backfill 2026-05-21";

const TIER1_HEADER = "13K Bonus";
const TIER2_HEADER = "65K Bonus";

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  january: 1, february: 2, march: 3, april: 4, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

/**
 * Parse a paid-bonus date cell. Observed formats in the sheet:
 *   - "30 Jan 25"          (DMY, 2-digit year)
 *   - "30 Mar 2026"        (DMY, 4-digit year)
 *   - "30 Apr 26"          (DMY, 2-digit year)
 *   - "1/30/2026"          (MDY slash — defensive, not yet observed
 *                           in marketer tabs, but used in some headers)
 *
 * Returns ISO date string `YYYY-MM-DD` or null when the cell is
 * empty, a non-date marker ("Yes", "TBD", etc.), or unparseable.
 * Two-digit years <70 map to 2000s, >=70 map to 1900s — consistent
 * with the rest of the codebase's date handling.
 */
export function parsePaidDateCell(raw: unknown): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;

  const dmy = s.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{2,4})$/);
  if (dmy) {
    const day = parseInt(dmy[1], 10);
    const month = MONTHS[dmy[2].toLowerCase()];
    let year = parseInt(dmy[3], 10);
    if (!month || day < 1 || day > 31) return null;
    if (dmy[3].length === 2) year = year < 70 ? 2000 + year : 1900 + year;
    return iso(year, month, day);
  }

  const mdy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (mdy) {
    const month = parseInt(mdy[1], 10);
    const day = parseInt(mdy[2], 10);
    let year = parseInt(mdy[3], 10);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    if (mdy[3].length === 2) year = year < 70 ? 2000 + year : 1900 + year;
    return iso(year, month, day);
  }

  return null;
}

function iso(year: number, month: number, day: number): string {
  const m = String(month).padStart(2, "0");
  const d = String(day).padStart(2, "0");
  return `${year}-${m}-${d}`;
}

export type ParsedAward = {
  marketer: BonusMarketer;
  adNumber: string;
  tier: "tier1" | "tier2";
  paidDate: string; // ISO YYYY-MM-DD
};

export type TabParseResult = {
  marketer: BonusMarketer;
  tab: string;
  awards: ParsedAward[];
  skipped: Array<{ adNumber: string; reason: string }>;
};

/**
 * Pure parser — takes the raw grid from `spreadsheets.values.get`
 * and returns the awards + skip diagnostics. Column positions for
 * "13K Bonus" / "65K Bonus" vary across tabs (Craig2/Raul2 have an
 * extra Note+Editor pair before them) so header lookup is dynamic.
 */
export function parseMarketerTab(opts: {
  marketer: BonusMarketer;
  tab: string;
  grid: ReadonlyArray<ReadonlyArray<unknown>>;
}): TabParseResult {
  const { marketer, tab, grid } = opts;
  const skipped: TabParseResult["skipped"] = [];
  const awards: ParsedAward[] = [];

  const header = (grid[0] ?? []).map((c) => String(c ?? "").trim());
  const t1Idx = header.indexOf(TIER1_HEADER);
  const t2Idx = header.indexOf(TIER2_HEADER);
  if (t1Idx < 0 || t2Idx < 0) {
    skipped.push({
      adNumber: "<header>",
      reason: `missing tier headers (got: ${JSON.stringify(header.slice(0, 10))})`,
    });
    return { marketer, tab, awards, skipped };
  }

  for (let r = 1; r < grid.length; r++) {
    const row = grid[r] ?? [];
    const rawAd = String(row[0] ?? "").trim();
    if (!rawAd) continue;
    // Ad numbers in the sheet may render as "1234" or "1234.0" — strip
    // trailing .0 so the text matches fb_ad_spend_daily.ad_number.
    const adNumber = rawAd.replace(/\.0+$/, "");
    if (!/^\d+$/.test(adNumber)) {
      skipped.push({ adNumber: rawAd, reason: "non-numeric ad number" });
      continue;
    }
    if (!isAboveBonusFloor(marketer, adNumber)) {
      skipped.push({
        adNumber,
        reason: `below floor ${BONUS_AD_FLOOR[marketer]}`,
      });
      continue;
    }

    const t1Cell = row[t1Idx];
    const t2Cell = row[t2Idx];
    const t1Date = parsePaidDateCell(t1Cell);
    const t2Date = parsePaidDateCell(t2Cell);

    if (t1Cell && !t1Date) {
      skipped.push({
        adNumber,
        reason: `unparseable tier1 cell: ${JSON.stringify(t1Cell)}`,
      });
    }
    if (t2Cell && !t2Date) {
      skipped.push({
        adNumber,
        reason: `unparseable tier2 cell: ${JSON.stringify(t2Cell)}`,
      });
    }

    if (t1Date) awards.push({ marketer, adNumber, tier: "tier1", paidDate: t1Date });
    if (t2Date) awards.push({ marketer, adNumber, tier: "tier2", paidDate: t2Date });
  }
  return { marketer, tab, awards, skipped };
}

// --- Summary-tab cross-check ---

const SUMMARY_TIER_TYPES = new Set([
  "13K Bonus",
  "13K 50% Bonus",
  "65K Bonus",
  "65K 50% Bonus",
]);

export type SummaryCount = {
  month: string; // e.g. "Feb 2026"
  marketer: BonusMarketer;
  tier: "tier1" | "tier2";
  fullCount: number;
  halfCount: number;
};

/**
 * Parse the Summary tab's pivot (Month × Marketer × Type) into
 * per-month/per-marketer/per-tier full+half counts. Used to detect
 * half-bonus ambiguity after the per-marketer tabs are parsed.
 */
export function parseSummaryTab(
  grid: ReadonlyArray<ReadonlyArray<unknown>>,
): SummaryCount[] {
  const header = (grid[0] ?? []).map((c) => String(c ?? "").trim());
  // Header: ["Month","Type","Craig","Raul","Tyler","Jacob","J Weston","Dan"]
  const marketerCols: Array<{ idx: number; name: BonusMarketer }> = [];
  for (let i = 2; i < header.length; i++) {
    const h = header[i];
    const canon = h === "J Weston" ? "JW" : h;
    if (BONUS_MARKETERS.includes(canon as BonusMarketer)) {
      marketerCols.push({ idx: i, name: canon as BonusMarketer });
    }
  }

  const buckets = new Map<string, SummaryCount>();
  let currentMonth = "";
  for (let r = 1; r < grid.length; r++) {
    const row = grid[r] ?? [];
    const monthCell = String(row[0] ?? "").trim();
    const typeCell = String(row[1] ?? "").trim();
    if (monthCell) currentMonth = monthCell;
    if (!currentMonth || !SUMMARY_TIER_TYPES.has(typeCell)) continue;

    const tier: "tier1" | "tier2" = typeCell.startsWith("13K") ? "tier1" : "tier2";
    const isHalf = typeCell.includes("50%");

    for (const { idx, name } of marketerCols) {
      const cellRaw = String(row[idx] ?? "").trim();
      if (!cellRaw) continue;
      const n = parseInt(cellRaw, 10);
      if (!Number.isFinite(n) || n <= 0) continue;
      const key = `${currentMonth}|${name}|${tier}`;
      const cur = buckets.get(key) ?? {
        month: currentMonth,
        marketer: name,
        tier,
        fullCount: 0,
        halfCount: 0,
      };
      if (isHalf) cur.halfCount += n;
      else cur.fullCount += n;
      buckets.set(key, cur);
    }
  }
  return [...buckets.values()];
}

/**
 * Compare what the per-marketer tabs say (we treat every paid-date row
 * as "full") against Summary's split. Mismatches indicate ads that
 * should be `approved_half` instead of `approved_full` — surfaced for
 * Jasper to flip via the existing UI.
 */
export type Mismatch = {
  month: string;
  marketer: BonusMarketer;
  tier: "tier1" | "tier2";
  inTabs: number;
  summaryFull: number;
  summaryHalf: number;
  note: string;
};

export function detectHalfBonusMismatches(opts: {
  awards: ParsedAward[];
  summary: SummaryCount[];
}): Mismatch[] {
  // Group tab awards into the same month label format Summary uses
  // ("Feb 2026"). Crossings happen on the paid date.
  const monthLabel = (iso: string) => {
    const [y, m] = iso.split("-").map((x) => parseInt(x, 10));
    const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return `${names[m - 1]} ${y}`;
  };

  const tabBuckets = new Map<string, number>();
  for (const a of opts.awards) {
    const key = `${monthLabel(a.paidDate)}|${a.marketer}|${a.tier}`;
    tabBuckets.set(key, (tabBuckets.get(key) ?? 0) + 1);
  }

  const mismatches: Mismatch[] = [];
  const summaryByKey = new Map<string, SummaryCount>();
  for (const s of opts.summary) {
    summaryByKey.set(`${s.month}|${s.marketer}|${s.tier}`, s);
  }

  // Summary only spans Feb 2026+ (it's a recent addition). For older
  // months the per-marketer tabs are the sole source of truth — there
  // is nothing to cross-check against, so we silently take the tab
  // values as truth. Only flag rows in months Summary actually covers.
  const summaryMonths = new Set(opts.summary.map((s) => s.month));

  const seenKeys = new Set<string>();
  for (const [key, inTabs] of tabBuckets) {
    seenKeys.add(key);
    const [monthForKey] = key.split("|");
    if (!summaryMonths.has(monthForKey)) continue;
    const s = summaryByKey.get(key);
    const sumFull = s?.fullCount ?? 0;
    const sumHalf = s?.halfCount ?? 0;
    const expected = sumFull + sumHalf;
    if (inTabs !== expected || sumHalf > 0) {
      const [month, marketer, tier] = key.split("|");
      mismatches.push({
        month,
        marketer: marketer as BonusMarketer,
        tier: tier as "tier1" | "tier2",
        inTabs,
        summaryFull: sumFull,
        summaryHalf: sumHalf,
        note:
          sumHalf > 0 && inTabs === expected
            ? `${sumHalf} of these ${inTabs} need flipping to approved_half`
            : inTabs !== expected
              ? `count mismatch: tabs ${inTabs} vs summary ${expected}`
              : "ok",
      });
    }
  }
  // Also surface Summary buckets we never saw in the tabs
  for (const [key, s] of summaryByKey) {
    if (seenKeys.has(key)) continue;
    if (s.fullCount + s.halfCount === 0) continue;
    mismatches.push({
      month: s.month,
      marketer: s.marketer,
      tier: s.tier,
      inTabs: 0,
      summaryFull: s.fullCount,
      summaryHalf: s.halfCount,
      note: "summary has rows but per-marketer tab has none",
    });
  }
  return mismatches;
}

// --- IO + apply ---

async function fetchTabGrid(
  sheets: ReturnType<typeof buildSheetsClient>,
  tab: string,
  range = "A1:AP",
): Promise<unknown[][]> {
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: HISTORICAL_SHEET_ID,
    range: `'${tab}'!${range}`,
  });
  return (resp.data.values ?? []) as unknown[][];
}

export async function loadAllParseResults(): Promise<{
  awards: ParsedAward[];
  perTab: TabParseResult[];
  summary: SummaryCount[];
}> {
  const sheets = buildSheetsClient();
  const perTab: TabParseResult[] = [];
  for (const { tab, marketer } of HISTORICAL_TABS) {
    const grid = await fetchTabGrid(sheets, tab);
    perTab.push(parseMarketerTab({ marketer, tab, grid }));
  }
  const sumGrid = await fetchTabGrid(sheets, SUMMARY_TAB, "A1:Z");
  const summary = parseSummaryTab(sumGrid);
  return {
    awards: perTab.flatMap((p) => p.awards),
    perTab,
    summary,
  };
}

export type ApplyResult = {
  batchId: string;
  inserted: number;
  skippedDuplicates: number;
};

export async function applyBackfill(awards: ParsedAward[]): Promise<ApplyResult> {
  const { db } = await import("@/lib/db");
  const { bonusAwards, bonusNotificationBatches } = await import("@/lib/db/schema");
  return await db.transaction(async (tx) => {
    const [batch] = await tx
      .insert(bonusNotificationBatches)
      .values({
        periodLabel: BATCH_LABEL,
        messageBody:
          `Synthetic batch created by lib/jobs/backfill-historical-bonuses.ts. ` +
          `Anchors ${awards.length} historical approved_full awards imported from ` +
          `Ads Bonus Tracking 3 sheet. Reruns are no-ops via the ` +
          `(ad_number, marketer, tier) unique index.`,
        totalsJson: summarizeTotals(awards),
        sentBy: "system_backfill",
        whatsappStatus: "skipped",
      })
      .returning({ id: bonusNotificationBatches.id });

    let inserted = 0;
    for (const a of awards) {
      const amountUsd = bonusAmountUsd({
        marketer: a.marketer,
        tier: a.tier,
        approval: "approved_full",
      });
      const result = await tx
        .insert(bonusAwards)
        .values({
          adNumber: a.adNumber,
          marketer: a.marketer,
          tier: a.tier,
          crossedAt: a.paidDate,
          status: "approved_full",
          amountUsd: amountUsd.toString(),
          approvedAt: new Date(`${a.paidDate}T00:00:00Z`),
          approvedBy: "system_backfill",
          notificationBatchId: batch.id,
          notes: `Backfilled from "${BATCH_LABEL}" sheet row`,
        })
        .onConflictDoNothing({
          target: [bonusAwards.adNumber, bonusAwards.marketer, bonusAwards.tier],
        })
        .returning({ id: bonusAwards.id });
      if (result.length > 0) inserted++;
    }
    return {
      batchId: batch.id,
      inserted,
      skippedDuplicates: awards.length - inserted,
    };
  });
}

function summarizeTotals(awards: ParsedAward[]): Record<string, { count: number; usd: number }> {
  const out: Record<string, { count: number; usd: number }> = {};
  for (const a of awards) {
    const amt = bonusAmountUsd({
      marketer: a.marketer,
      tier: a.tier,
      approval: "approved_full",
    });
    const cur = out[a.marketer] ?? { count: 0, usd: 0 };
    cur.count++;
    cur.usd += amt;
    out[a.marketer] = cur;
  }
  return out;
}

// --- CLI ---

async function main() {
  // Load .env when invoked as a CLI. Kept inside main() rather than at
  // module top-level so unit tests and library imports don't get an
  // unexpected dotenv side-effect.
  await import("dotenv/config");

  const args = new Set(process.argv.slice(2));
  const apply = args.has("--apply");
  const dryRun = args.has("--dry-run") || !apply;

  console.log(`[backfill-historical-bonuses] mode: ${apply ? "APPLY" : "dry-run"}\n`);

  const { awards, perTab, summary } = await loadAllParseResults();

  console.log("=== Per-tab parse ===");
  for (const p of perTab) {
    console.log(
      `  ${p.tab} (${p.marketer}): ${p.awards.length} awards, ${p.skipped.length} skipped`,
    );
    for (const sk of p.skipped.slice(0, 5)) {
      console.log(`    skip ad ${sk.adNumber}: ${sk.reason}`);
    }
    if (p.skipped.length > 5) console.log(`    ... +${p.skipped.length - 5} more skips`);
  }

  const totals = summarizeTotals(awards);
  console.log("\n=== Totals if applied as approved_full ===");
  for (const m of BONUS_MARKETERS) {
    const t = totals[m] ?? { count: 0, usd: 0 };
    console.log(`  ${m}: ${t.count} awards, $${t.usd.toLocaleString()}`);
  }

  const mismatches = detectHalfBonusMismatches({ awards, summary });
  if (mismatches.length > 0) {
    console.log("\n=== Half-bonus mismatch report (manual flip via UI) ===");
    for (const m of mismatches) {
      console.log(
        `  ${m.month} ${m.marketer} ${m.tier}: tabs=${m.inTabs} summary=${m.summaryFull}/${m.summaryHalf}H — ${m.note}`,
      );
    }
  } else {
    console.log("\n=== No half-bonus mismatches detected ===");
  }

  if (dryRun) {
    console.log("\n[dry-run] No DB writes. Re-run with --apply to insert.");
    return;
  }

  const { db } = await import("@/lib/db");
  const existing = (await db.execute(
    sql`SELECT COUNT(*)::int AS n FROM bonus_awards WHERE approved_by = 'system_backfill'`,
  )) as unknown as Array<{ n: number }>;
  const prior = existing[0]?.n ?? 0;
  console.log(`\n=== Applying (${prior} prior system_backfill rows already in DB) ===`);
  const result = await applyBackfill(awards);
  console.log(
    `  inserted: ${result.inserted}, skipped (already present): ${result.skippedDuplicates}, batch: ${result.batchId}`,
  );
}

// Run when invoked directly via `tsx`. The `import.meta.url` check
// keeps tests safe — they import the parsing functions without
// triggering DB writes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(() => process.exit(0)).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
