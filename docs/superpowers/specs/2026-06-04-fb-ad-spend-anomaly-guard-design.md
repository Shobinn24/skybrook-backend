# FB Ad Spend Ingest — Month-Collapse Anomaly Guard

**Date:** 2026-06-04
**Status:** Approved design, pending implementation
**Area:** `lib/sources/sheets.ts` — `replaceFbAdSpendLiveWindow`

## Problem

The per-ad FB ad-spend ingest reads a single Supermetrics tab (prod
`FB_ADS_TAB_NAME=Sheet6`) and persists via `replaceFbAdSpendLiveWindow`,
which **deletes every `fb_ad_spend_daily` row from the pull's earliest
date forward and re-inserts** the freshly parsed rows. Because the source
query covers the current year, the earliest date is Jan 1 — so each run
rebuilds the entire year.

The only existing safety valve is a no-op when the parsed pull is
**totally empty**. A **partially hollow** pull sails straight through.

This was not hypothetical. On 2026-06-04 the source tab's May data
collapsed to ~3% of normal (a full month dropped from ~$879k to ~$26k)
while January–April and June stayed intact. Proven against the real code
path on a throwaway DB seeded with a copy of production: the next ingest
would overwrite the good May (~$879k) with ~$26k — a 97% loss. That table
feeds the bonus tracker's lifetime-cumulative-spend threshold crossings,
so a silent collapse corrupts bonus calculations.

## Goal

Stop a single ingest run from wiping a previously-healthy month of
per-ad spend. Bias toward refusing a suspicious pull (recoverable — data
simply doesn't advance, and the freshness monitor flags it) over letting
a collapse through (unrecoverable — corrupted bonus data).

Non-goals: fixing the upstream source tab, repairing the duplicate
over-count, or per-day granularity. This guard is a safety net only.

## Design

A month-level collapse check inside `replaceFbAdSpendLiveWindow`, run
before the `delete`/`insert`.

### Detection

1. Bucket the **incoming** parsed totals by month (`YYYY-MM`), summing
   `costUsd` across all ads/days in the live window.
2. Query **existing** `fb_ad_spend_daily` totals for the same months
   (`spend_date >= liveMinDate`), bucketed by month.
3. Flag a month as **collapsed** when both hold:
   - existing month total ≥ `MATERIAL_FLOOR_USD` (**$1,000**), and
   - incoming month total < `COLLAPSE_RATIO` (**0.5**) × existing.

Rationale:
- A completed past month re-pulls at ~100% (±small attribution drift); a
  >50% drop is never legitimate.
- The current in-progress month only grows pull-over-pull, so it never
  trips.
- On an empty/cold DB (first run, one-time history import) existing
  totals are $0, below the floor, so the guard never blocks a legitimate
  cold start.

### On trigger

- **Abort the entire replace**: no `delete`, no `insert`. The DB is left
  exactly as it was.
- Fire a **P1 alert** via the existing alert helper, naming the offending
  month(s) and the existing → incoming totals.
- Return cleanly (mirrors the existing empty-pull early-return; not a
  thrown error). The freshness monitor catches the resulting non-advance
  as a backstop.

### Structure

- Pure helper `detectCollapsedMonths(incomingByMonth, existingByMonth)`
  → returns the list of collapsed months (with both totals). No DB, no
  I/O — unit-testable in isolation.
- `replaceFbAdSpendLiveWindow` does: compute `incomingByMonth` from
  `aggregated`, query `existingByMonth`, call the detector, and on any
  hit fire the alert + early-return before the transaction.

### Constants

```
COLLAPSE_RATIO   = 0.5     // block if incoming < 50% of existing
MATERIAL_FLOOR_USD = 1000  // only guard months with material existing spend
```

Named constants, tunable in one place.

## Testing

Per repo test-isolation rule, Slack/external webhooks are clobbered in
`tests/setup.ts`; no test fires a real alert.

- **Unit** (`detectCollapsedMonths`): collapse case; healthy re-pull (no
  flag); empty-DB cold start (no flag); in-progress-month growth (no
  flag); existing-below-floor (no flag); multiple collapsed months.
- **Integration** (`replaceFbAdSpendLiveWindow`): seed a healthy month →
  call with a hollow-month aggregated → assert **DB row count + month
  total unchanged** and **an alert was recorded**. Also assert a healthy
  re-pull writes normally.

## Out of scope / no migration

No schema change. No change to the runner, the source tab, or the
dedup/over-count work (tracked separately).
