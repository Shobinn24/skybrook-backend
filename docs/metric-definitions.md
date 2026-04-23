# Skybrook — metric definitions

Every number in the dashboard comes from a formula below. This doc is the living record of what each metric means, which definitions are locked, and which are placeholders.

> **Source of truth for open decisions:** `../../QUESTIONS.md` in the parent Skybrook folder. This doc mirrors answered items into code-facing form.

## Conventions

- **Timezone:** every date/day boundary is EST (`America/New_York`). UTC timestamps are stored in the DB; the UI renders EST.
- **Units:** units of a product variant unless noted.
- **Currency:** USD. `net_sales_usd` comes directly from Shopify's Reports API.
- **Data window:** backfill from **2026-03-01**.

---

## Sustainability thresholds (SPEC §5.3)

Locked **2026-04-23** by Scott (used my suggested defaults; revisit later if needed).

| Flag | Meaning | Trigger |
|---|---|---|
| 🟢 **Healthy** | Enough stock and incoming to hold through the next two PO arrivals | Projection survives 2 POs, OR (no/partial incoming) remaining DOS > 14 |
| 🟡 **Watch** | Stock will run out **between** the next PO and the PO after | Projection stocks out after PO₁ but before PO₂, OR (fallback) `7 ≤ DOS ≤ 14` |
| 🔴 **At risk** | Stock will run out **before** the next PO arrives | Projection stocks out before PO₁, OR (no incoming) `DOS < 7` |
| ⚫ **Overstocked** | Stock significantly exceeds projected demand | Current DOS on 30-day velocity > 90 (regardless of incoming) |

Stored in `config/thresholds.ts` as `{ watchDays: 14, atRiskDays: 7, overstockDays: 90 }`.

**Projection algorithm** (`lib/domain/sustainability.ts`): walk forward from `today`, subtract daily velocity, add each future PO's quantity on its ETA, look for the first day stock ≤ 0. If such a day exists before any PO → at_risk. Between first and second PO → watch. No stockout within the projection → healthy (provided current DOS is also within healthy range).

---

## Units sold

Locked **2026-04-23**: cancelled and refunded orders **both count as sales**.

- Source: Shopify Reports API, `shopifyqlQuery` with `FROM sales SHOW units_sold`.
- `units_sold` in ShopifyQL does not net out refunds — so it aligns with Scott's rule automatically.
- Stored in `daily_sales.units_sold` per (channel, sku, sales_date).

---

## Current stock

Locked **2026-04-23**: ignore reserved / allocated / unfulfillable columns. We don't see those in our pipeline anyway (Amazon deferred past MVP).

- Source: Google Sheets `10zgTSE...` daily inventory log (Task 11 — still blocked on tab structure from Scott).
- Stored in `stock_snapshots.on_hand` per (sku, location, snapshot_date).
- "Current" = latest row per (sku, location).

---

## Incoming stock

Locked **2026-04-23**: counted from **PO creation** with its **expected arrival date**. Scott is still confirming the exact sheet/tab — leading candidate is the "Incoming Stock" view in sheet `1NaDU...`.

- `incoming_shipments.expected_arrival` is what the sustainability projection uses to advance stock forward.
- Rows with `status = 'arrived'` are excluded from future-incoming sums (already reflected in on-hand).

---

## Sales velocity

Locked **2026-04-23**: **order date** (not fulfillment date).

- Windows: 3, 7, 30 days (SPEC §5.2).
- Default window for days-of-stock: 7 days.
- Aggregated across all channels as `channel = "all"`; per-channel/per-location velocity is recomputed on demand from `daily_sales` events.
- Formula: sum of `units_sold` in window ÷ window days.

Stored in `sales_velocity` per (sku, channel, window_days, as_of_date).

---

## Days of stock / Weeks of stock

- `days_of_stock = on_hand ÷ velocity_per_day`
  - If velocity is 0 and stock > 0: `Infinity` (overstocked).
  - If stock is 0 or negative: 0.
- `weeks_of_stock = days_of_stock ÷ 7`. Scott prefers weeks for UI display.

Stored in `days_of_stock` per (sku, location, as_of_date, velocity_window_days).

---

## Refunds and inventory

Locked **2026-04-23**: refunded units **do not add stock back**. Treated as lost at ship time.

- Enforced by the data model: `stock_snapshots` reflects what the warehouse actually has; we never bump it up based on refund events.
- For revenue: `daily_sales.net_sales_usd` comes straight from Shopify's `net_sales` which does net out refunds — intentionally different from `units_sold`.

---

## Reconciliation tolerance (SPEC §5.6)

Locked **2026-04-22**: `|delta| > 1% × |expected_end_stock|`. No minimum unit floor.

- **Moot in MVP** — reconciliation itself is deferred. Tolerance is captured here for when we bring reconciliation back.
- When applied: if `expected = 0`, any nonzero delta is flagged above tolerance.

Stored in `config/thresholds.ts` as `reconFraction: 0.01`.

---

## Bulk order recommendations (SPEC §5.4)

Deferred past MVP. Formula lives in Scott's sheet `1NaDU...` on the "April 26 US" tab. When we revisit, the implementation slot is `lib/queries/bulk-order.ts`.

---

## Metrics explicitly out of MVP

- **Revenue (performance module)** — deferred with Performance Dashboard
- **Ad spend / ROAS / iROAS** — deferred pending Meta ingestion decision
- **FBA inventory, FBA sales, FBA inbound transfers** — Amazon deferred past MVP
- **Reconciliation deltas** — deferred past MVP
- **Ship-to country per order** — not available under the `read_reports`-only Shopify scope Scott chose (tradeoff logged in `QUESTIONS.md` §3)

---

## Quick reference — where each metric lives in code

| Metric | Formula location | Source table | Exposed via tRPC |
|---|---|---|---|
| Stock levels | `lib/queries/stock.ts` | `stock_snapshots` | `inventory.getStockLevels` |
| Stock value | `lib/queries/stock.ts` | `stock_snapshots` × `skus.unit_cost_usd` | `inventory.getStockValue` |
| Sales velocity | `lib/domain/velocity.ts` | `daily_sales` | `inventory.getSalesVelocity` |
| Days of stock | `lib/domain/days-of-stock.ts` | `days_of_stock` | `inventory.getDaysOfStock` |
| Sustainability flag | `lib/domain/sustainability.ts` | `sustainability_flags` | `inventory.getSustainabilityStatus`, `.listLatestSustainabilityFlags` |
| Incoming stock | `lib/queries/incoming.ts` | `incoming_shipments` | `inventory.getIncomingStock` |
| Combined inventory view | `lib/queries/inventory.ts` | multi-join | `inventory.getInventoryRows` |
| Pipeline freshness | `lib/queries/pipeline.ts` | `data_pulls` | `pipeline.getLatestPullsPerSource` |
