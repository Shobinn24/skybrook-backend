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
# Edit .env with local DATABASE_URL, Google OAuth client, Google service
# account JSON, Shopify access tokens, etc.
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

## Auth (Google Workspace SSO)

Sign-in is restricted to the Everdries Google Workspace. Users click "Sign in with Google" on `/login`, get redirected through Google's OAuth consent screen, and the callback verifies the Workspace domain (`hd` claim on the ID token) before issuing an HMAC-signed session cookie.

**One-time Google Cloud Console setup (done in the existing `everdries-drive` project, which lives under Shobinn's personal Google account — NOT inside the Everdries Workspace org):**
1. `everdries-drive` project → APIs & Services → OAuth consent screen → **External** (Internal is only available when the project is inside a Workspace org — it isn't here). App name "Skybrook". Scopes: `openid`, `email`, `profile`. User type stays in Testing or is Published without verification (4 users, non-sensitive scopes).
2. Credentials → Create OAuth client ID → **Web application**, name "Skybrook".
3. Authorized redirect URIs:
   - `https://skybrook-backend-production.up.railway.app/api/auth/google/callback`
   - `http://localhost:3000/api/auth/google/callback` (dev)
4. Copy Client ID + Secret into Railway env as `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.
5. Set `GOOGLE_WORKSPACE_DOMAIN` to the Everdries workspace domain (the `hd` claim — confirm with Scott, likely `everdries.com`). This is the real security gate; External consent screen does not weaken it.
6. Optionally set `ALLOWED_EMAILS` (comma-separated) as a second gate on top of the domain check.
7. Optionally set `EXTERNAL_ALLOWED_EMAILS` (comma-separated) for external collaborators whose login email is outside the workspace domain (e.g. a personal gmail). These emails bypass the `hd` + suffix check entirely; still require `email_verified` on the OAuth claim.
8. Set `APP_URL` to the public origin of the deploy.

Session cookies are 30-day HMAC tokens signed with `SESSION_SECRET`. OAuth state tokens (CSRF protection) use the same secret and expire after 10 min.

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
  auth.ts             Session cookie + Google OAuth helpers (edge-compat)
  tz.ts               EST day-boundary helpers
config/
  thresholds.ts       Sustainability + velocity knobs
tests/
  unit/               Domain logic tests
  integration/        Full pipeline tests against a seeded Postgres
```
