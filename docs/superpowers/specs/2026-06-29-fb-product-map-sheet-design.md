# FB Product Map Sheet — Design

**Goal:** Make All-products Facebook attribution (product family AND US/INTL region) read from a Jasper-maintained Google Sheet instead of hardcoded rules, add it as an ingested data source, and surface ad links that are missing from the sheet.

**Requested by:** Jasper (via Shobinn), 2026-06-29.

## Background

Today the All-products view attributes FB spend two ways:
- **Product:** `attributeUrlProduct(destUrl)` — hardcoded URL-path rules in `lib/domain/fb-product-attribution.ts`.
- **US/non-US:** `fb_geo_spend` — the audience's actual country per ad (a fraction per ad).

Jasper wants both driven by one sheet he can edit. The sheet (`URL | US/INTL | Product`) keys region off the **funnel** (`everdries.com` = US, `shop.everdries.com` = INTL), which is a different definition than audience-country. Per Jasper's instruction we adopt the sheet's funnel-based definition. Trust Jasper's URL->product mappings (no confirm step) per existing policy.

## Decisions (confirmed)

1. **US/INTL = sheet funnel-based**, replacing the geo-based split for mapped ads. `fb_geo_spend` is kept ingesting and used ONLY as the region fallback for the small tail of URL-unmapped ads (see #2).
2. **Unmapped URL fallback:** spend whose destination URL is not in the sheet keeps the existing ad-name prefix attribution (`attributeFbPrefix`) for product, and the geo fraction for region — so nothing disappears. Every such URL with real spend is surfaced by the missing-links check.
3. **Missing-links surfacing:** both a section at the bottom of `/performance` AND a Slack digest alert (mirrors `fb-prefix-check`).

## The sheet

`URL | US/INTL | Product`, ~89 rows. Notes from the live data:
- Hosts: `everdries.com`, `www.everdries.com`, `shop.everdries.com`, and advertorial `www.womansdailynews.com`. Region is read from the row, not inferred from host.
- Products seen: `9055`, `9055 HF`, `Boyshort`, `Mens`, `Shapewear`, `Super HW`, `High Rise Short`, `OG`, `HW`, `Home`, `Clearance`, `NA` (some have trailing spaces — trim).
- Duplicate rows exist (agree on values) — dedupe by normalized URL; conflicting duplicates are a parse skip + surfaced.

## Architecture

### 1. New ingested source `sheets_fb_product_map`

- **Table `fb_product_map`** (full delete-replace window snapshot, same shape as `fb_ad_url_map`):
  - `normalized_url` text PRIMARY KEY — lookup key
  - `raw_url` text — as entered (for display)
  - `region` text — `"US"` | `"INTL"`
  - `product_label` text — canonical family label (post-normalization)
  - `source_pull_id` uuid
- **`sourceEnum`** gains `"sheets_fb_product_map"`.
- **Env:** `FB_PRODUCT_MAP_SHEET_ID` (+ optional `FB_PRODUCT_MAP_TAB_NAME`, default first tab). Range `A:C`.
- **Runner `sheetsFbProductMapRunner`** in `lib/sources/sheets/fb-product-map.ts`, registered in `app/api/cron/refresh-ad-spend/route.ts` and `app/api/cron/ingest/route.ts`.
- **Volume check** entry in `lib/jobs/volume-check.ts` (floor 0.5, minHistory 5).

### 2. URL normalization (one shared helper)

`normalizeFunnelUrl(raw): string | null` in `fb-product-attribution.ts`:
- parse; lowercase host; strip leading `www.`; keep host (so `shop.` stays distinct); path without trailing slash; ignore scheme/query/hash.
- return `null` for unparseable or social permalinks (`facebook.com`, `fb.me`, `instagram.com`, `l.facebook.com`, `lm.facebook.com`) — these never name a landing page.
- Examples: `https://everdries.com/comfortplus` -> `everdries.com/comfortplus`; `http://www.everdries.com/boyshort` -> `everdries.com/boyshort`; `https://shop.everdries.com/` -> `shop.everdries.com`.

### 3. Product label normalization (sheet label -> canonical family)

`canonicalProductLabel(sheetLabel): { label: string; kind: FbBucket }`:
- `Super HW` -> `Super High-Waist`; `Home` -> `Brand / Homepage` (kind brand); `Clearance` -> `Clearance / Mixed` (kind clearance); `NA` -> `Other (NA)` (kind unmapped, but intentionally-mapped — NOT surfaced by missing-links).
- `9055`, `9055 HF`, `Boyshort`, `Mens`, `Shapewear`, `High Rise Short`, `OG`, `HW` -> unchanged (kind product).
- Anything unrecognized -> kept verbatim, kind product (so a new label Jasper adds flows straight through and merges with revenue if the name matches).

### 4. Broaden `fb_ad_url_map` capture

`coalesceEverdriesUrl` -> `coalesceLandingUrl`: keep the first candidate that is a real landing page (parses + not a social permalink), regardless of host, so advertorial URLs (womansdailynews) are captured. `dest_url` may now hold non-everdries URLs; that is fine because product attribution no longer uses `extractEverdriesPath`.

### 5. `getAllProductsRollup` change

Replace the `attributeUrlProduct` overlay with a `fb_product_map` lookup:
- Load `fb_product_map` into `Map<normalized_url, {label, region, kind}>`.
- For each `fb_ad_url_map` row: `normalizeFunnelUrl(dest_url)` -> lookup. Build per-(ad_number, ad_prefix) dominant-cost vote for BOTH product label and region (same vote pattern as today).
- Spend loop per (ad_number, ad_prefix):
  - product = `productByKey.get(key)` else `attributeFbPrefix(prefix).product` (ad-name fallback).
  - region: if `regionByKey.get(key)` -> 100% to US or INTL; else fall back to `usFractionForKey(key)` (geo) for the unmapped tail.
- `nonUsSpendUsd` now means INTL. UI label updated `non-US` -> `INTL`.

### 6. Missing-links check

`lib/jobs/fb-url-coverage-check.ts` (mirrors `fb-prefix-check`):
- Over the recent window, sum `fb_ad_url_map` cost by `normalizeFunnelUrl(dest_url)` for rows whose normalized URL is non-null and NOT in `fb_product_map`.
- Fire one p2 -> `#skybrook-digest` per missing URL with cumulative spend >= threshold ($500, window 14d, anchored on latest fb spend_date). Auto-resolves when added to the sheet or spend stops.
- Health endpoint: `column_quality.fb_url_map_coverage` style count row (number of unmapped URLs with spend over window).
- **Page section:** new tRPC query `performance.unmappedFbUrls` returning `{ url, spendUsd }[]` (current range); render a small table at the bottom of `/performance` titled "Ad links not in the product sheet" with a one-line explainer.

## Testing

- `tests/unit/fb-product-attribution.test.ts`: `normalizeFunnelUrl` (scheme/www/trailing-slash/shop./permalink/non-everdries), `canonicalProductLabel` (each special label + passthrough + trim).
- `tests/unit/fb-product-map.test.ts`: `parseFbProductMapSheet` (header detect, dedupe agree, conflicting-dupe skip, NA, trailing spaces, blank rows).
- `tests/integration/fb-product-map-rollup.test.ts`: seed url-map + product-map + geo + daily spend; assert product + region come from the sheet, unmapped URL falls back to ad-name + geo, NA bucketed, totals reconcile (us+intl == spend).
- `tests/integration/fb-url-coverage-check.test.ts`: a mapped URL is silent; an unmapped URL with spend >= threshold fires; below threshold or after-add is silent.

## Out of scope

- AppLovin attribution (no URL; stays ad-name pipe-segment based).
- Retiring `fb_geo_spend` (kept as the region fallback; removable in a later PR).
- Backfilling historical region under the new definition (read-time attribution applies the current sheet to all history, as today).
