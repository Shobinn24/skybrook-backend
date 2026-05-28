// Reconcile bonus_awards against the historical paid sheet (Ads Bonus
// Tracking 3) using a COMPLETE parser that handles every cell format
// observed in production:
//
//   "Yes"                    → paid full (no date provided)
//   "NA"                     → not awarded (reject)
//   "30 Jul 25"              → paid full on that date
//   "30 Jul 25 50%"          → paid HALF on that date
//   "1/30/2026"              → paid full on that date (defensive)
//   ""                       → no record (leave row alone)
//
// The existing backfill parser (`lib/jobs/backfill-historical-bonuses.ts`)
// only handles the date-format cells — it silently skipped "Yes" and
// "X 50%" cells. Caught 2026-05-28 when Jasper flagged ad #230 as
// already paid; cross-reference revealed I'd wrongly rejected 13 of
// 14 phantom-crossings (and 9 pending rows also needed flips).
//
// This script reads Craig2 + Raul2 (the only marketers with phantom or
// pending rows surfaced by today's cron) and rewrites bonus_awards to
// match. Idempotent — safe to dry-run and re-run. Links each updated
// row to the most recent system_backfill notification batch for ledger
// audit-trail consistency.
//
// Run:
//   DATABASE_URL=<public> pnpm tsx scripts/apply_paid_sheet_corrections_2026_05_28.ts
//   DATABASE_URL=<public> pnpm tsx scripts/apply_paid_sheet_corrections_2026_05_28.ts --apply
//
// Follow-up: patch `lib/jobs/backfill-historical-bonuses.ts` parsePaidDateCell
// to handle these cell shapes so future re-imports don't re-introduce
// the gap.

import "dotenv/config";
import { google } from "googleapis";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { bonusAwards, bonusNotificationBatches } from "@/lib/db/schema";
import {
  HISTORICAL_SHEET_ID,
} from "@/lib/jobs/backfill-historical-bonuses";
import {
  bonusAmountUsd,
  type BonusMarketer,
} from "@/lib/domain/bonus-tiers";

type Verdict =
  | { kind: "paid_full"; paidDate: string | null }
  | { kind: "paid_half"; paidDate: string | null }
  | { kind: "reject" }
  | { kind: "leave" };

type Row = {
  marketer: BonusMarketer;
  adNumber: string;
  tier1Verdict: Verdict;
  tier2Verdict: Verdict;
};

// Reuse the same MONTHS table as the backfill parser. Duplicated here
// instead of imported so this script stays standalone even if the
// backfill module evolves.
const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  january: 1, february: 2, march: 3, april: 4, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

function isoDate(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function parseCell(raw: string): Verdict {
  const s = (raw ?? "").trim();
  if (!s) return { kind: "leave" };
  if (s.toUpperCase() === "NA") return { kind: "reject" };
  if (s.toLowerCase() === "yes") return { kind: "paid_full", paidDate: null };

  // Detect 50% suffix BEFORE date parsing so "30 Jul 25 50%" doesn't fall
  // through. The historical sheet's half-bonus convention is the literal
  // "50%" trailing the date.
  const halfRe = /(.+?)\s+50\s*%\s*$/i;
  const halfM = s.match(halfRe);
  const dateStr = halfM ? halfM[1].trim() : s;
  const isHalf = !!halfM;

  // DMY: "30 Jul 25" / "30 Mar 2026" / "30 Apr 26"
  const dmy = dateStr.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{2,4})$/);
  if (dmy) {
    const day = parseInt(dmy[1], 10);
    const month = MONTHS[dmy[2].toLowerCase()];
    let year = parseInt(dmy[3], 10);
    if (month && day >= 1 && day <= 31) {
      if (dmy[3].length === 2) year = year < 70 ? 2000 + year : 1900 + year;
      const iso = isoDate(year, month, day);
      return isHalf ? { kind: "paid_half", paidDate: iso } : { kind: "paid_full", paidDate: iso };
    }
  }

  // MDY: "1/30/2026"
  const mdy = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (mdy) {
    const month = parseInt(mdy[1], 10);
    const day = parseInt(mdy[2], 10);
    let year = parseInt(mdy[3], 10);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      if (mdy[3].length === 2) year = year < 70 ? 2000 + year : 1900 + year;
      const iso = isoDate(year, month, day);
      return isHalf ? { kind: "paid_half", paidDate: iso } : { kind: "paid_full", paidDate: iso };
    }
  }

  // Unparseable shape — leave the bonus row alone rather than guess. Log
  // so the operator notices any new cell format that arrives in the
  // sheet.
  console.warn(`  ! unparseable cell "${s}" — leaving as-is`);
  return { kind: "leave" };
}

async function readMarketerTab(
  sheets: ReturnType<typeof google.sheets>,
  marketer: BonusMarketer,
  tabName: string,
): Promise<Row[]> {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: HISTORICAL_SHEET_ID,
    range: `'${tabName}'!A1:H2000`,
  });
  const out: Row[] = [];
  const rows = res.data.values ?? [];
  for (const r of rows) {
    const adRaw = String(r[0] ?? "").trim();
    if (!adRaw) continue;
    if (!/^\d+$/.test(adRaw)) continue; // skip headers / total rows
    out.push({
      marketer,
      adNumber: adRaw,
      tier1Verdict: parseCell(String(r[5] ?? "")),
      tier2Verdict: parseCell(String(r[6] ?? "")),
    });
  }
  return out;
}

async function loadAllVerdicts(): Promise<Row[]> {
  const auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  const sheets = google.sheets({ version: "v4", auth });

  // Only the tabs whose marketers have rows that need correction. (Tyler,
  // Jacob, J Weston, Dan are unaffected by today's incident — their
  // entries already match the sheet.)
  const tabs: Array<{ marketer: BonusMarketer; tab: string }> = [
    { marketer: "Craig", tab: "Craig2" },
    { marketer: "Raul", tab: "Raul2" },
  ];
  const all: Row[] = [];
  for (const t of tabs) {
    const rows = await readMarketerTab(sheets, t.marketer, t.tab);
    all.push(...rows);
  }
  return all;
}

type Action = {
  adNumber: string;
  marketer: BonusMarketer;
  tier: "tier1" | "tier2";
  currentStatus: string | null;
  newStatus: "approved_full" | "approved_half" | "rejected";
  amountUsd: number;
  paidDate: string | null;
  reason: string;
};

async function computeActions(): Promise<Action[]> {
  const verdicts = await loadAllVerdicts();
  console.log(`Loaded ${verdicts.length} ad rows from Craig2 + Raul2 tabs`);

  // Existing DB state for every (ad, marketer, tier) we care about.
  // Pull all bonus_awards for these marketers; cheap, ~160 rows total.
  const existing = await db
    .select({
      adNumber: bonusAwards.adNumber,
      marketer: bonusAwards.marketer,
      tier: bonusAwards.tier,
      status: bonusAwards.status,
    })
    .from(bonusAwards);
  const dbByKey = new Map<string, string>(); // "ad|marketer|tier" -> status
  for (const e of existing) {
    dbByKey.set(`${e.adNumber}|${e.marketer}|${e.tier}`, e.status);
  }

  const actions: Action[] = [];
  for (const r of verdicts) {
    for (const tier of ["tier1", "tier2"] as const) {
      const v = tier === "tier1" ? r.tier1Verdict : r.tier2Verdict;
      const key = `${r.adNumber}|${r.marketer}|${tier}`;
      const cur = dbByKey.get(key) ?? null;

      // Skip leave-alone (no sheet record) and skip rows already in the
      // correct state. The only thing we mutate is genuine corrections.
      if (v.kind === "leave") continue;

      let newStatus: "approved_full" | "approved_half" | "rejected";
      let amount: number;
      let reason: string;
      let paidDate: string | null = null;

      if (v.kind === "paid_full") {
        newStatus = "approved_full";
        amount = bonusAmountUsd({ marketer: r.marketer, tier, approval: "approved_full" });
        paidDate = v.paidDate;
        reason = "paid_full per Ads Bonus Tracking 3 sheet";
      } else if (v.kind === "paid_half") {
        newStatus = "approved_half";
        amount = bonusAmountUsd({ marketer: r.marketer, tier, approval: "approved_half" });
        paidDate = v.paidDate;
        reason = "paid_half per Ads Bonus Tracking 3 sheet";
      } else {
        newStatus = "rejected";
        amount = bonusAmountUsd({ marketer: r.marketer, tier, approval: "approved_full" });
        reason = "NA per Ads Bonus Tracking 3 sheet";
      }

      if (cur === newStatus) continue;
      // Only correct rows that already exist in bonus_awards. Don't
      // synthesize missing rows from the sheet — the detector only
      // creates a row when an ad actually crossed the threshold in our
      // own data, so a sheet record for a tier we never tracked is
      // either pre-program activity or a sheet artifact (e.g., 943 +
      // 973 tier2 NAs on ads that never crossed $65k).
      if (cur === null) continue;
      // Only correct rows that are currently pending or rejected. Don't
      // touch already-approved rows even if the sheet now disagrees —
      // any reversal of an existing approval is a manual decision.
      if (cur !== "pending" && cur !== "rejected") continue;

      actions.push({
        adNumber: r.adNumber,
        marketer: r.marketer,
        tier,
        currentStatus: cur,
        newStatus,
        amountUsd: amount,
        paidDate,
        reason,
      });
    }
  }
  return actions;
}

async function main() {
  const apply = process.argv.includes("--apply");
  console.log(`mode: ${apply ? "APPLY" : "dry-run"}`);
  console.log(`DB: ${process.env.DATABASE_URL?.replace(/:\/\/[^@]*@/, "://***@")}`);

  const actions = await computeActions();
  console.log(`\n${actions.length} correction action(s):\n`);
  for (const a of actions) {
    console.log(
      `  ${a.adNumber.padEnd(5)} ${a.marketer.padEnd(6)} ${a.tier}  ` +
        `${(a.currentStatus ?? "(missing)").padEnd(15)} -> ${a.newStatus.padEnd(14)} ` +
        `$${String(a.amountUsd).padStart(5)}  paid_date=${a.paidDate ?? "(none)"}  ` +
        `(${a.reason})`,
    );
  }

  // Net dollar impact.
  const sums: Record<string, number> = { approved_full: 0, approved_half: 0, rejected: 0 };
  for (const a of actions) sums[a.newStatus] += a.amountUsd;
  console.log(`\nNet impact: +$${sums.approved_full.toFixed(0)} approved_full, ` +
    `+$${sums.approved_half.toFixed(0)} approved_half, ` +
    `+$${sums.rejected.toFixed(0)} into rejected (was pending/rejected)`);

  if (!apply) {
    console.log(`\n[dry-run] no writes. Re-run with --apply to update bonus_awards.`);
    return;
  }

  // Find the system_backfill batch to link audit notes to.
  const [batch] = await db
    .select({ id: bonusNotificationBatches.id })
    .from(bonusNotificationBatches)
    .where(eq(bonusNotificationBatches.sentBy, "system_backfill"))
    .orderBy(desc(bonusNotificationBatches.sentAt))
    .limit(1);

  let flipped = 0;
  for (const a of actions) {
    const approvedAt = a.paidDate
      ? new Date(`${a.paidDate}T00:00:00Z`)
      : new Date();
    const note =
      `Reconciled ${a.currentStatus ?? "missing"} -> ${a.newStatus} from ` +
      `"Ads Bonus Tracking 3" sheet (Craig2/Raul2 cell parser recheck ` +
      `2026-05-28 — original backfill parser skipped Yes/50% cells).`;
    const res = await db
      .update(bonusAwards)
      .set({
        status: a.newStatus,
        amountUsd: a.amountUsd.toFixed(2),
        approvedAt,
        approvedBy: "system_paid_sheet_recheck_2026-05-28",
        notificationBatchId: batch?.id ?? null,
        notes: note,
      })
      .where(
        and(
          eq(bonusAwards.adNumber, a.adNumber),
          eq(bonusAwards.marketer, a.marketer),
          eq(bonusAwards.tier, a.tier),
        ),
      )
      .returning({ id: bonusAwards.id });
    flipped += res.length;
  }
  console.log(`\n[applied] updated ${flipped} bonus_awards row(s) (batch ${batch?.id ?? "none"})`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
