# FB Ads Tracker 2 — Apps Script setup

Sheet: `FB Ads Tracker 2`
URL: https://docs.google.com/spreadsheets/d/1L-1NUuB46Vi4yzTCmzFG1f8MptEsr44ewKsVqlDfGOI/edit

## What it does
- **`appendDailyTo2026`** — once per day, takes the single date in `Daily`,
  finds (or appends) that date column on `2026`, then writes spend per ad.
  New ads in `Daily` that aren't in `2026` get appended as new rows.
  Idempotent — safe to re-run the same day.
- **`runDivergenceCheck`** — compares overlap dates between `2026` and
  `30D Check`. Flags every (ad, date) cell where the two disagree by both
  ≥ `$1` absolute AND ≥ `5%` relative. Writes results to a `Divergence
  Flags` tab (created if missing, overwritten each run).
- Top-level entrypoint **`dailyAppendAndCheck`** chains both.

## Install

1. Open the spreadsheet → **Extensions → Apps Script**.
2. Replace any boilerplate code with the contents of `fb-ads-daily.gs`.
3. Save (cmd-S).
4. Add a time-driven trigger:
   - Sidebar **Triggers** (clock icon) → **Add Trigger**.
   - Function: `dailyAppendAndCheck`
   - Event source: **Time-driven**
   - Type: **Day timer**
   - Time of day: **8am to 9am** (the script's project timezone should
     be set to `America/Argentina/Buenos_Aires` GMT-3, or pick the UTC
     11am–12pm slot if you'd rather keep the project on UTC).
5. First run will prompt for OAuth — grant the script access to the
   spreadsheet only.

## Tuning the divergence thresholds
Edit the two constants at the top of `fb-ads-daily.gs`:
```
const DIVERGENCE_ABS_THRESHOLD = 1.0;   // dollars
const DIVERGENCE_PCT_THRESHOLD = 0.05;  // 5%
```
Both must be crossed for a row to be flagged (so noisy pennies on
near-zero days don't pollute the output).

## Manual run for testing
From the Apps Script editor, pick `dailyAppendAndCheck` in the function
dropdown and click ▶. Logs visible under **Executions** in the left
sidebar.
