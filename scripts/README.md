# scripts/

Two kinds of scripts live here.

## Tracked

Smoke checks and one-off setup that operators are expected to share:

- `dev-seed.ts` — seeds the dev DB. Run via `pnpm dev:seed`.
- `smoke-shopify-orders.ts` — pulls a tiny Shopify orders page to verify auth.
- `smoke-shopify-intl.ts` — same but for the INTL store.
- `smoke_incoming_parse.mjs` — parses the Incoming_new tab and dumps a sample.

## Untracked diagnostics

The `*.mjs` peek/check scripts are intentionally untracked — they're investigation tools that get rewritten per question, not reusable infrastructure. They're useful enough to keep around locally; not useful enough to commit and maintain.

Reusable across sessions (worth re-running when investigating data drift):

- `check_sec_coverage.mjs` — diff every SKU on the 6 EV inventory tabs against Skybrook's `skus` catalog. Surfaces SKUs the parser silently dropped.
- `velocity_recheck.mjs` — reconcile the velocity sheet's 4-week sum against Skybrook's 30d `daily_sales`. Reads both US and INTL blocks (col D and col P).
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
