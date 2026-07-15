# Dev vs Prod — the two databases and the guard rails

## The trap this documents

`.env` in this repo points `DATABASE_URL` at a LOCAL postgres
(`localhost:5432/skybrook_dev`). The production database lives on Railway
and its URL is NOT in `.env`. On 2026-07-13 a migration plus a 26k-row
backfill "against prod" silently landed in the local database because
psql, drizzle-kit, and tsx scripts all default to `.env`.

## Canonical way to reach prod

```bash
# Fetch the prod URL (never commit it; it embeds the password):
railway variables --service Postgres --kv | grep ^DATABASE_PUBLIC_URL

# Then explicitly for any prod operation:
DATABASE_URL='<that url>' pnpm db:migrate
DATABASE_URL='<that url>' pnpm tsx scripts/whatever.ts
```

If the Railway CLI says Unauthorized, DON'T bother with `railway login` —
the OAuth session churns constantly (three logouts in two days as of
2026-07-15, not fixed by the 5.26 upgrade). Use the project token instead:
`.env` carries `RAILWAY_TOKEN` (project token "skybrook-agent-cli",
production env, created 2026-07-15). Export it and every project-scoped
command works regardless of login state:

```bash
export RAILWAY_TOKEN=$(grep ^RAILWAY_TOKEN= .env | cut -d= -f2)
railway variables --service skybrook-backend --kv
railway logs --service skybrook-backend
railway deployment list --service skybrook-backend --json
```

Account-scoped commands (`railway whoami`, cross-project) still need a
real login. If the token is ever compromised, revoke it in the dashboard:
project Settings > Tokens.

Rule of thumb: `source .env` is never sufficient evidence you are on prod.
Check the host before destructive work: prod is `*.rlwy.net`, local is
`localhost`.

## Guard rails in code

- **Alert suppression** (`lib/notifications/slack.ts alertingSuppressed()`):
  `next dev` / `SKYBROOK_DEV_BYPASS=1` processes never post to Slack and
  never write `alert_events` rows — a dev-session error paged the real
  alerts channel on 2026-07-13. Set `SKYBROOK_ALERTS_FORCE=1` to test real
  alerting from dev on purpose. Vitest is unaffected (`NODE_ENV=test`;
  `tests/setup.ts` blanks the webhook URLs instead).
- **Prod-data banner** (`app/(dashboard)/layout.tsx`): a dev server whose
  `DATABASE_URL` is non-local renders a red "DEV SERVER ON PRODUCTION
  DATA" stripe across every page.
- **CI gate** (`.github/workflows/ci.yml`): typecheck + full suite against
  a fresh migrated postgres on every push to main. Enable "Wait for CI" on
  the Railway service so deploys hold until the check passes.

## Backups + restore drill

Railway keeps its own Postgres backups (check status in the dashboard:
Postgres service, Backups tab — the CLI has no backup command). Belt and
braces: an off-platform logical dump lives in
`~/Desktop/Active/Everdries/Skybrook/db-backups/`.

Drill (verified 2026-07-14 — full dump + restore + row-count parity on
loox_reviews / bonus_awards / fb_ad_spend_daily / stock_snapshots /
alert_events / product_launches):

```bash
# Server is Postgres 18; Homebrew's default pg_dump is 14 and refuses.
# Use libpq's client tools (brew install libpq):
/opt/homebrew/opt/libpq/bin/pg_dump "$PROD_URL" -Fc \
  -f ~/Desktop/Active/Everdries/Skybrook/db-backups/skybrook_prod_$(date +%F).dump

# Restore drill into a scratch local DB (the transaction_timeout SET fails
# against local PG14 — one ignorable error):
createdb skybrook_restore_drill
/opt/homebrew/opt/libpq/bin/pg_restore --no-owner --no-privileges \
  -d skybrook_restore_drill <dump file>
# spot-check counts vs prod, then: dropdb skybrook_restore_drill
```

Dump takes ~2 min, ~50 MB. Worth re-running before risky migrations and
monthly-ish otherwise.

## Which database for what

| Operation | Database |
| --- | --- |
| `pnpm test` (integration tests write + truncate tables) | local (`.env` default) |
| Local dev server page views | prod (the dev script overrides `DATABASE_URL`) |
| Migrations, backfills, psql spot checks for real data | prod, explicit `DATABASE_URL` |
