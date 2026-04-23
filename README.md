# Skybrook

Internal ops dashboard for Everdries. v1 MVP scope: pull inventory from Google Sheets, pull sales from Shopify, output weeks of stock + sustainability report.

- Owner spec: `../SPEC.md`
- Engineering design: `../2026-04-22-skybrook-inventory-design.pdf`
- Implementation plan: `../2026-04-22-inventory-implementation-plan.md`
- Open questions + decisions log: `../QUESTIONS.md`

## Local dev

Prereqs: Node 20+, pnpm (via `corepack enable pnpm`), Postgres running locally.

```bash
pnpm install
cp .env.example .env
# Edit .env with local DATABASE_URL, APP_PASSWORD, etc.
pnpm db:migrate
pnpm dev
```

## Test

```bash
pnpm test
```

## Data pipeline (MVP)

- Daily cron fires `/api/cron/ingest` at 10am EST.
- Pulls inventory from the Everdries Google Sheet and sales from Shopify.
- Phase 2 computes sales velocity, days of stock, and sustainability flags.
