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

If the Railway CLI says Unauthorized, the token lapsed (it does this every
few weeks): `railway login`, or `railway login --browserless` from an
agent session and click the printed activate link.

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

## Which database for what

| Operation | Database |
| --- | --- |
| `pnpm test` (integration tests write + truncate tables) | local (`.env` default) |
| Local dev server page views | prod (the dev script overrides `DATABASE_URL`) |
| Migrations, backfills, psql spot checks for real data | prod, explicit `DATABASE_URL` |
