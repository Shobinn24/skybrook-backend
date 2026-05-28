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
 * Parse a paid-bonus cell. Observed formats in the sheet:
 *   - ""                   → no record. Skip this tier.
 *   - "Yes"                → paid full, no date provided.
 *   - "NA"                 → explicitly not awarded → reject.
 *   - "30 Jan 25"          → paid full on 2025-01-30.
 *   - "30 Apr 2026"        → paid full on 2026-04-30.
 *   - "30 Jul 25 50%"      → paid HALF on 2025-07-30.
 *   - "1/30/2026"          → paid full on 2026-01-30 (MDY slash).
 *
 * Returned `CellVerdict` carries the bonus disposition (paid_full /
 * paid_half / reject / skip) plus an optional date. Two-digit years
 * <70 → 2000s, ≥70 → 1900s.
 *
 * 2026-05-28: extended from the previous date-only `parsePaidDateCell`
 * after the Jasper incident revealed the original parser silently
 * skipped "Yes" + "50%" + "NA" cells, leaving 22 historical awards
 * unbackfilled (7 fulls + 6 halves needed restoring from rejected,
 * 8 halves needed flipping from pending, 1 NA was a real reject).
 * The corrective state was applied via apply_paid_sheet_corrections;
 * this patch closes the underlying parser gap so any future re-run
 * lands the same outcome natively.
 */
export type CellVerdict =
  | { kind: "skip" }
  | { kind: "reject" }
  | { kind: "paid_full"; paidDate: string | null }
  | { kind: "paid_half"; paidDate: string | null };

export function parsePaidCell(raw: unknown): CellVerdict {
  if (raw == null) return { kind: "skip" };
  const s = String(raw).trim();
  if (!s) return { kind: "skip" };

  if (s.toUpperCase() === "NA") return { kind: "reject" };
  if (s.toLowerCase() === "yes") return { kind: "paid_full", paidDate: null };

  // Detect a "50%" suffix BEFORE date parsing. Cells like "30 Jul 25 50%"
  // are paid HALF on the same date — the % marker must not bleed into the
  // date matcher (it would fail the strict end-anchor and fall through
  // unparseable).
  const halfMatch = s.match(/(.+?)\s+50\s*%\s*$/i);
  const dateStr = halfMatch ? halfMatch[1].trim() : s;
  const isHalf = !!halfMatch;

  const dmy = dateStr.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{2,4})$/);
  if (dmy) {
    const day = parseInt(dmy[1], 10);
    const month = MONTHS[dmy[2].toLowerCase()];
    let year = parseInt(dmy[3], 10);
    if (month && day >= 1 && day <= 31) {
      if (dmy[3].length === 2) year = year < 70 ? 2000 + year : 1900 + year;
      const paidDate = iso(year, month, day);
      return isHalf ? { kind: "paid_half", paidDate } : { kind: "paid_full", paidDate };
    }
  }

  const mdy = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (mdy) {
    const month = parseInt(mdy[1], 10);
    const day = parseInt(mdy[2], 10);
    let year = parseInt(mdy[3], 10);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      if (mdy[3].length === 2) year = year < 70 ? 2000 + year : 1900 + year;
      const paidDate = iso(year, month, day);
      return isHalf ? { kind: "paid_half", paidDate } : { kind: "paid_full", paidDate };
    }
  }

  // Unparseable shape — caller decides whether to log it. Tab parser
  // emits a skipped diagnostic so unknown cell formats don't pass
  // silently.
  return { kind: "skip" };
}

/** Kept for back-compat with tests + any external caller that only
 *  needs a date. Returns null for non-date verdicts (Yes / NA / empty).
 *  New code should call parsePaidCell directly for the richer verdict. */
export function parsePaidDateCell(raw: unknown): string | null {
  const v = parsePaidCell(raw);
  if (v.kind === "paid_full" || v.kind === "paid_half") return v.paidDate;
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
  // 2026-05-28: extended to carry the sheet's bonus disposition. The
  // historical sheet records full-pay ("Yes" or a date), half-pay
  // ("date 50%"), and explicit non-awards ("NA"). Earlier shape was
  // {paidDate} only — every record was treated as approved_full, which
  // left 14 halves and 2 NAs misclassified.
  approval: "approved_full" | "approved_half" | "rejected";
  paidDate: string | null; // ISO YYYY-MM-DD; null when Yes flag (no date) or NA
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
    const t1 = parsePaidCell(t1Cell);
    const t2 = parsePaidCell(t2Cell);

    // Caller skip diagnostics only when a non-empty cell was present
    // but parsePaidCell couldn't classify it — distinguishes "Grace
    // left it blank on purpose" from "the cell text is a new format
    // we should add."
    if (t1Cell != null && String(t1Cell).trim() !== "" && t1.kind === "skip") {
      skipped.push({
        adNumber,
        reason: `unparseable tier1 cell: ${JSON.stringify(t1Cell)}`,
      });
    }
    if (t2Cell != null && String(t2Cell).trim() !== "" && t2.kind === "skip") {
      skipped.push({
        adNumber,
        reason: `unparseable tier2 cell: ${JSON.stringify(t2Cell)}`,
      });
    }

    const verdictToApproval = (v: CellVerdict): ParsedAward["approval"] | null => {
      switch (v.kind) {
        case "paid_full": return "approved_full";
        case "paid_half": return "approved_half";
        case "reject": return "rejected";
        case "skip": return null;
      }
    };

    const t1Approval = verdictToApproval(t1);
    if (t1Approval) {
      const t1Date = t1.kind === "paid_full" || t1.kind === "paid_half" ? t1.paidDate : null;
      awards.push({ marketer, adNumber, tier: "tier1", approval: t1Approval, paidDate: t1Date });
    }
    const t2Approval = verdictToApproval(t2);
    if (t2Approval) {
      const t2Date = t2.kind === "paid_full" || t2.kind === "paid_half" ? t2.paidDate : null;
      awards.push({ marketer, adNumber, tier: "tier2", approval: t2Approval, paidDate: t2Date });
    }
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
    // Reject + Yes-flag awards have no paidDate — skip them from the
    // month-bucket grouping (the summary mismatch detector only
    // compares dated payouts against the dated summary pivot).
    if (a.paidDate === null) continue;
    if (a.approval === "rejected") continue;
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
      // For approved_half / approved_full the dollar amount comes from
      // the (marketer, tier, approval) lookup. For rejected rows we
      // freeze the full amount as the "what we would have paid" — the
      // ledger reads cleaner when the rejected dollar amount is the
      // dollar amount we explicitly declined to pay.
      const amountUsd =
        a.approval === "rejected"
          ? bonusAmountUsd({ marketer: a.marketer, tier: a.tier, approval: "approved_full" })
          : bonusAmountUsd({ marketer: a.marketer, tier: a.tier, approval: a.approval });
      // crossedAt cannot be null per schema. Use the paidDate when
      // available; otherwise pick the batch's run date so the column
      // still anchors to "when this record came into existence."
      const crossedAt = a.paidDate ?? new Date().toISOString().slice(0, 10);
      const approvedAt = a.paidDate
        ? new Date(`${a.paidDate}T00:00:00Z`)
        : new Date();
      const note =
        a.approval === "rejected"
          ? `Backfilled from "${BATCH_LABEL}" sheet (NA cell — explicit non-award)`
          : a.approval === "approved_half"
            ? `Backfilled from "${BATCH_LABEL}" sheet (half-bonus / 50% cell)`
            : a.paidDate
              ? `Backfilled from "${BATCH_LABEL}" sheet row`
              : `Backfilled from "${BATCH_LABEL}" sheet (Yes flag — no date on record)`;
      const result = await tx
        .insert(bonusAwards)
        .values({
          adNumber: a.adNumber,
          marketer: a.marketer,
          tier: a.tier,
          crossedAt,
          status: a.approval,
          amountUsd: amountUsd.toString(),
          approvedAt,
          approvedBy: "system_backfill",
          notificationBatchId: batch.id,
          notes: note,
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

// Matches the canonical NotificationPreview.totals array shape from
// `lib/queries/bonus-tracker.ts`. Earlier this writer used a marketer-keyed
// object, which the bonus tracker history reader couldn't reduce over —
// crashed the /bonus-tracker page on 2026-05-28 right after the 5/27
// system_backfill row landed. Reader is now defensive against both shapes
// AND new writes go through this array form, so the divergence ends here.
function summarizeTotals(awards: ParsedAward[]): Array<{
  marketer: string;
  tier1FullCount: number;
  tier1HalfCount: number;
  tier2FullCount: number;
  tier2HalfCount: number;
  totalUsd: number;
}> {
  type Row = {
    marketer: string;
    tier1FullCount: number;
    tier1HalfCount: number;
    tier2FullCount: number;
    tier2HalfCount: number;
    totalUsd: number;
  };
  const byMarketer = new Map<string, Row>();
  for (const a of awards) {
    // Skip rejected awards entirely — they were explicit non-payments,
    // not real bonuses. They appear in bonus_awards as audit history but
    // shouldn't inflate the totals on the notification batch.
    if (a.approval === "rejected") continue;
    const amt = bonusAmountUsd({
      marketer: a.marketer,
      tier: a.tier,
      approval: a.approval,
    });
    const cur = byMarketer.get(a.marketer) ?? {
      marketer: a.marketer,
      tier1FullCount: 0,
      tier1HalfCount: 0,
      tier2FullCount: 0,
      tier2HalfCount: 0,
      totalUsd: 0,
    };
    if (a.tier === "tier1") {
      if (a.approval === "approved_half") cur.tier1HalfCount++;
      else cur.tier1FullCount++;
    } else {
      if (a.approval === "approved_half") cur.tier2HalfCount++;
      else cur.tier2FullCount++;
    }
    cur.totalUsd += amt;
    byMarketer.set(a.marketer, cur);
  }
  return Array.from(byMarketer.values()).sort((x, y) =>
    x.marketer.localeCompare(y.marketer),
  );
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
  const totalsByMarketer = new Map(totals.map((t) => [t.marketer, t]));
  // Reject counts surface separately so the operator can see them at a
  // glance without inflating the per-marketer payout numbers.
  const rejectCounts = new Map<string, number>();
  for (const a of awards) {
    if (a.approval === "rejected") {
      rejectCounts.set(a.marketer, (rejectCounts.get(a.marketer) ?? 0) + 1);
    }
  }
  console.log("\n=== Totals (full + half) if applied ===");
  for (const m of BONUS_MARKETERS) {
    const t = totalsByMarketer.get(m);
    const fullCount = t ? t.tier1FullCount + t.tier2FullCount : 0;
    const halfCount = t ? t.tier1HalfCount + t.tier2HalfCount : 0;
    const usd = t?.totalUsd ?? 0;
    const rej = rejectCounts.get(m) ?? 0;
    const rejPart = rej > 0 ? `, ${rej} reject` : "";
    console.log(
      `  ${m}: ${fullCount} full + ${halfCount} half = $${usd.toLocaleString()}${rejPart}`,
    );
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
