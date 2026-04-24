# Skybrook Backend

Internal operations dashboard for Everdries. Consolidates inventory and sales data into a single daily-refreshing view.

**v1 MVP scope:**
- Pull inventory from the Everdries daily inventory Google Sheet
- Pull sales data from Shopify (Reports API)
- Output **weeks of stock** per SKU per location (US / CN)
- Output a **sustainability report** — flags SKUs at risk of stocking out before the next PO arrives, using a projection-based algorithm that walks forward through upcoming incoming shipments

Planning artifacts (spec, design doc, implementation plan, open questions) are maintained outside this repo by the project owner. Engineering-facing metric definitions live in [`docs/metric-definitions.md`](docs/metric-definitions.md).

## Stack

- Next.js 15 (App Router) + TypeScript
- Postgres + Drizzle ORM
- tRPC + Zod for the API layer
- Tailwind CSS + shadcn/ui patterns
- Vitest for unit and integration tests
- Deployed on Railway (app + Postgres + Cron)

## Local dev

Prereqs: Node 20+, pnpm (`corepack enable pnpm`), Postgres 14 or newer running locally.

```bash
pnpm install
cp .env.example .env
# Edit .env with local DATABASE_URL, APP_PASSWORD, Google service account JSON,
# Shopify access tokens, etc.
pnpm db:migrate
pnpm dev
```

Open http://localhost:3000 — you'll be redirected to `/inventory`.

## Tests

```bash
pnpm test          # unit + integration, requires local Postgres
pnpm test:watch    # watch mode
pnpm typecheck     # strict TS check
pnpm build         # production build
```

## Data pipeline

- **Phase 1 (ingest):** daily cron POSTs `/api/cron/ingest` at 10am EST with `Authorization: Bearer $CRON_SECRET`. Pulls are failure-isolated — one source going down doesn't block the others.
  - `sheets_inventory` — daily stock levels per SKU per location (awaiting Scott's service-account credentials)
  - `sheets_incoming` — incoming PO quantities + ETAs (same sheet suite)
  - `shopify_us` / `shopify_intl` — sales data from both Shopify stores via the Reports API (`read_reports` scope only)
- **Phase 2 (derive):** computes sales velocity (3d / 7d / 30d), days of stock, weeks of stock, and sustainability flags. Runs after Phase 1 completes. Always runs; per-SKU rows with missing inputs are skipped and logged.

## Auth (MVP)

Shared-password gate. Set `APP_PASSWORD` in the environment; users enter it once and get a signed session cookie. Per-user auth comes later.

## Project structure

```
app/                  Next.js App Router (pages + API routes + cron endpoint)
components/           Shared React components (shell, inventory, sustainability, trace)
lib/
  db/                 Drizzle schema + client
  domain/             Pure business logic (velocity, days-of-stock, sustainability, routing)
  sources/            Per-source ingestion (sheets, shopify)
  jobs/               Phase 1 (ingest) and Phase 2 (derive) orchestrators
  queries/            Reusable DB query functions, also the tRPC procedure bodies
  trpc/               tRPC server + routers + client
  auth.ts             Password-gate helper
  tz.ts               EST day-boundary helpers
config/
  thresholds.ts       Sustainability + velocity knobs
tests/
  unit/               Domain logic tests
  integration/        Full pipeline tests against a seeded Postgres
```
