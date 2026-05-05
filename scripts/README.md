# scripts/

Two kinds of scripts live here.

## Tracked

Smoke checks and one-off setup that operators are expected to share:

- `dev-seed.ts` — seeds the dev DB. Run via `pnpm dev:seed`.
- `smoke-shopify-orders.ts` — pulls a tiny Shopify orders page to verify auth.
- `smoke-shopify-intl.ts` — same but for the INTL store.
- `smoke_incoming_parse.mjs` — parses the Incoming_new tab and dumps a sample.
- `velocity_recheck.mjs` — reconcile the velocity sheet's 4-week sum against Skybrook's 30d `daily_sales` (US block col D + INTL block col P). Run when Scott asks "is the sales data accurate" or after parser changes. Needs `CRON_SECRET` in env. Expected ratio sky/sheet ≈ 1.07 (30d window vs sheet's 28d). Outliers grouped by SKU at the bottom.
- `cron_run_ingest.mjs` — primary daily-ingest scheduler entrypoint, run by **Railway native cron**. Calls `/api/cron/ingest` then verifies via `/api/admin/data-snapshot`. Replaces the `.github/workflows/cron-ingest.yml` workflow as the primary trigger after the 2026-05-05 GH Actions runner-allocation failure. Needs `CRON_SECRET`; reads `APP_URL` or falls back to `RAILWAY_PUBLIC_DOMAIN`. See "Daily ingest cron architecture" below for setup.

## Daily ingest cron architecture

**Primary trigger: Railway native cron** (added 2026-05-05). A separate Railway service named `skybrook-cron` is linked to this same repo, with cron schedule `0 14 * * *` and start command `node scripts/cron_run_ingest.mjs`. The cron service deploys, runs the script, exits. Doesn't affect the main `skybrook-backend` web service.

**Why this over GH Actions:** Railway native cron eliminates the runner-allocation failure mode. On 2026-05-05 GH Actions failed to acquire a hosted runner for 15 min and gave up, missing that day's ingest. Railway runs in our service container — no external runner needed.

**Fallback: GH Actions workflow** (`.github/workflows/cron-ingest.yml`) still exists, scheduled 1 hour AFTER Railway's run, as belt-and-suspenders. Skips work if Railway already succeeded today.

**Setup steps** (Railway dashboard, one-time):
1. In Railway project "Skybrook Backend", click `+ Create` → `Empty Service`. Name it `skybrook-cron`.
2. Settings → Source → connect to the same GitHub repo (`skybrook-backend`).
3. Settings → Deploy → Cron Schedule → `0 14 * * *`
4. Settings → Deploy → Start Command → `node scripts/cron_run_ingest.mjs`
5. Settings → Networking → disable public networking (cron has no inbound traffic).
6. Variables → reference shared `CRON_SECRET` from the main service.
7. Variables → set `APP_URL=https://skybrook-backend-production.up.railway.app` (or the canonical URL).

After setup, manually trigger once to verify; thereafter it runs daily at 14:00 UTC.

**Monitoring: healthchecks.io** (added 2026-05-05). `cron_run_ingest.mjs` pings a healthchecks.io check on start (`/start`), success (base URL), and failure (`/fail`). If healthchecks.io doesn't see a success ping within the configured period + grace window, it sends an alert via the configured channel (email/Slack/etc.). This catches both runner failures (Railway can't acquire compute) AND silent failures (script runs but never pings, e.g., infinite hang).

**Healthchecks.io setup** (one-time):
1. Sign up at https://healthchecks.io (free tier covers this — 20 checks).
2. Create a new check: name `skybrook-daily-ingest`, period 1 day, grace time 1 hour. Pick "Cron" schedule type and use `0 14 * * *` if you want exact-time matching.
3. Copy the ping URL (looks like `https://hc-ping.com/<uuid>`).
4. Configure an alert channel (email is simplest; Slack/Discord also supported).
5. In Railway → `skybrook-cron` service → Variables → add `HEALTHCHECKS_URL` = the ping URL from step 3.

The script silently skips ping logic when `HEALTHCHECKS_URL` is unset, so this is fully optional and won't break anything during initial deploy.

## Untracked diagnostics

The `*.mjs` peek/check scripts are intentionally untracked — they're investigation tools that get rewritten per question, not reusable infrastructure. They're useful enough to keep around locally; not useful enough to commit and maintain.

Reusable across sessions (worth re-running when investigating data drift):

- `check_sec_coverage.mjs` — diff every SKU on the 6 EV inventory tabs against Skybrook's `skus` catalog. Surfaces SKUs the parser silently dropped.
- `list_inventory_tabs.mjs` — enumerate every tab in the inventory sheet and flag which contain `ev-og-5x-*` rows. Useful when Scott adds/renames tabs.
- `list_incoming_tabs.mjs` — same for the incoming-PO sheet.
- `peek_intl_costs.mjs` — sample the EVSKUmap INTL cost columns; useful when the cost cron has gaps.

Investigation-specific (kept for archival, but probably stale):

- `peek_*.mjs` — narrow snapshots taken during a specific question. Re-read before re-running; they often have hardcoded SKU lists.
- `compare.mjs` — superseded by `velocity_recheck.mjs` (had a column bug that double-counted US block — see memory 5068).
- `sheet_inspect.mjs` — generic A1-range dumper.

## Env required

All scripts that hit Google Sheets need either:
- `GOOGLE_SERVICE_ACCOUNT_JSON` (json string), or
- `GOOGLE_APPLICATION_CREDENTIALS` (path to keyfile)

Plus the relevant sheet ID env vars (see `.env.example`).

Scripts that hit production Skybrook (`check_sec_coverage.mjs`) also need `CRON_SECRET`.
