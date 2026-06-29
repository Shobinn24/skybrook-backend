# FB Product Map Sheet Implementation Plan

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drive All-products FB product + US/INTL attribution from a Jasper-maintained Google Sheet, ingest it as a source, and surface ad links missing from the sheet.

**Architecture:** New `sheets_fb_product_map` source -> `fb_product_map` table; read-time lookup in `getAllProductsRollup` (ad-name + geo fallback); `fb-url-coverage-check` digest alert + `/performance` section.

**Tech Stack:** Next.js / tRPC / Drizzle / Postgres, vitest, drizzle-kit. Spec: `docs/superpowers/specs/2026-06-29-fb-product-map-sheet-design.md`.

---

## Task 1: Domain helpers (normalize URL + canonical product label)

**Files:** Modify `lib/domain/fb-product-attribution.ts`; Test `tests/unit/fb-product-attribution.test.ts`.

- [ ] Write failing tests for `normalizeFunnelUrl`: scheme/`www.` stripping, trailing slash, `shop.` kept distinct, root `/` -> host only, social permalinks (`facebook.com`/`fb.me`/`instagram.com`) -> null, unparseable -> null, advertorial host kept.
- [ ] Write failing tests for `canonicalProductLabel`: `Super HW`->`Super High-Waist`, `Home`->brand, `Clearance`->clearance, `NA`->`Other (NA)` (kind unmapped), trailing-space trim, passthrough of unknown label as kind product.
- [ ] Run, verify fail.
- [ ] Implement both exported functions.
- [ ] Run, verify pass. Commit.

## Task 2: `fb_product_map` table + enum + migration

**Files:** Modify `lib/db/schema.ts`; generate `drizzle/00NN_*.sql`.

- [ ] Add `"sheets_fb_product_map"` to `sourceEnum`.
- [ ] Add `fbProductMap` pgTable (`normalized_url` PK, `raw_url`, `region`, `product_label`, `source_pull_id`).
- [ ] `pnpm drizzle-kit generate`; review SQL (enum add + create table); commit schema + migration.

## Task 3: Source parser + runner

**Files:** Create `lib/sources/sheets/fb-product-map.ts`; Test `tests/unit/fb-product-map.test.ts`.

- [ ] Failing tests for `parseFbProductMapSheet`: header detect (`URL|US/INTL|Product`), dedupe agreeing rows, conflicting-dupe -> skip + recorded, NA row, trailing spaces, blank/short rows skipped, region normalized to `US`/`INTL`.
- [ ] Run, verify fail.
- [ ] Implement `parseFbProductMapSheet` (uses `normalizeFunnelUrl` + `canonicalProductLabel`), `replaceFbProductMap` (delete-replace, empty=no-op), `sheetsFbProductMapRunner` (reads `FB_PRODUCT_MAP_SHEET_ID`/`FB_PRODUCT_MAP_TAB_NAME`, range `A:C`, schemaFingerprint, rowCount).
- [ ] Run, verify pass. Commit.

## Task 4: Register source (crons + volume check)

**Files:** Modify `app/api/cron/refresh-ad-spend/route.ts`, `app/api/cron/ingest/route.ts`, `lib/jobs/volume-check.ts`.

- [ ] Import + register `sheets_fb_product_map: sheetsFbProductMapRunner` in both cron route source maps.
- [ ] Add volume-check entry `{ source: "sheets_fb_product_map", floorFraction: 0.5, minHistory: 5 }`.
- [ ] `pnpm typecheck`. Commit.

## Task 5: Broaden url-map capture

**Files:** Modify `lib/sources/sheets/fb-ad-url-map.ts`; Test `tests/unit/...` (existing url-map test if present, else add cases).

- [ ] Failing test: a non-everdries landing URL (womansdailynews) is now kept; a facebook permalink is rejected.
- [ ] Rename/replace `coalesceEverdriesUrl` -> `coalesceLandingUrl` (first candidate that parses and is not a social permalink). Keep dedupe-by-adId-highest-cost.
- [ ] Run, verify pass. Commit.

## Task 6: Rollup uses the sheet

**Files:** Modify `lib/queries/performance.ts`; Test `tests/integration/fb-product-map-rollup.test.ts`.

- [ ] Failing integration test: seed `fb_product_map` + `fb_ad_url_map` + `fb_geo_spend` + `fb_ad_spend_daily`; assert (a) product+region from sheet, (b) URL-unmapped ad falls back to ad-name product + geo region, (c) NA -> `Other (NA)` non-product bucket, (d) us+intl == fb spend.
- [ ] Run, verify fail.
- [ ] Replace the `attributeUrlProduct` overlay block (lines ~514-561) with a `fb_product_map` load + per-key dominant-cost vote for product AND region; update the spend loop (region 100% US/INTL when mapped, else `usFractionForKey`). Keep `attributeFbPrefix` product fallback.
- [ ] Run, verify pass; run full `tests/integration/all-products-rollup.test.ts` to catch regressions. Commit.

## Task 7: Missing-links check (job + health)

**Files:** Create `lib/jobs/fb-url-coverage-check.ts`; Modify `app/api/health/route.ts` + wherever digest checks are aggregated; Test `tests/integration/fb-url-coverage-check.test.ts`.

- [ ] Failing test: mapped URL silent; unmapped URL with spend >= threshold fires p2; below threshold silent; NA-mapped URL silent.
- [ ] Run, verify fail.
- [ ] Implement `evaluateFbUrlCoverage` (sum `fb_ad_url_map` cost by `normalizeFunnelUrl`, exclude those in `fb_product_map`, window anchored on latest fb spend_date, threshold $500/14d, p2 digest, slug dedup). Wire into the digest check aggregation + a health count row.
- [ ] Run, verify pass. Commit.

## Task 8: Performance page section + tRPC

**Files:** Modify the performance tRPC router (`lib/trpc/routers/performance.ts` or equivalent), `app/(dashboard)/performance/page.tsx`.

- [ ] Add `unmappedFbUrls` query returning `{ url, spendUsd }[]` for the current range (reuse the coverage logic, range-scoped).
- [ ] Render a section at the bottom of `/performance` ("Ad links not in the product sheet" + one-line explainer + table); relabel the spend split `non-US` -> `INTL`.
- [ ] `pnpm typecheck` + `pnpm build`. Commit.

## Task 9: Full suite + live-after-ship checklist

- [ ] `pnpm test` (full) green; `pnpm typecheck`; `pnpm lint`.
- [ ] Open PR (no person names in title/body). Note in PR: needs `FB_PRODUCT_MAP_SHEET_ID` env + sheet shared with `everdries-drive` SA before it does anything live.
- [ ] Post-merge live verify (separate step, after Shobinn provides sheet access): trigger ingest, confirm `fb_product_map` populated, `/performance` product+region reconcile, coverage check behaves.
