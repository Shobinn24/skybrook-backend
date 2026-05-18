# Shipping Performance Checks — Spec for the Ops Tool

**Author:** Jasper (via Claude)
**Audience:** Shobinn
**Status:** Ready to implement
**Last updated:** 2026-05-12

---

## 1. What we're building

Two automated daily checks plus a stats panel, added to the existing internal ops dashboard. They watch end-to-end delivery performance for `incontinencepanties.myshopify.com` (display name: Everdries) and surface anything that's off.

| # | Check | Trigger | Flags |
|---|---|---|---|
| A | **Fulfilment SLA** — 3PL slow to ship | Daily, Mon–Fri | US orders past their expected ship date that are still unfulfilled (and not OOS, not cancelled) |
| B | **Carrier transit** — package in transit too long | Daily, Mon–Fri | US orders fulfilled >10 days ago that are still not marked delivered |
| C | **Stats panel** | Live (cached daily) | 30-day rolling averages + distribution histogram, compared against the prior 30-day window |

All flagged orders, plus the stats panel, render in a new "**Shipping Performance**" section of the ops dashboard.

---

## 2. Data sources

### 2.1 Shopify Admin API

**Auth:** Use the **client_credentials grant** against the existing "Ops Internal Tool" Dev Dashboard app. Tokens last 24h; mint a fresh one at the start of each scheduled job (and cache for the run).

```
POST https://incontinencepanties.myshopify.com/admin/oauth/access_token
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials&client_id=<CID>&client_secret=<SECRET>
```

Response: `{ "access_token": "shpat_…", "scope": "…", "expires_in": 86399 }`

Use the token in `X-Shopify-Access-Token: shpat_…` header for all subsequent Admin API calls. The app currently has `read_orders` and `read_fulfillments` scopes (and `read_all_orders`, useful if we ever need >60-day history).

**API version:** `2026-04` (current stable as of writing).
**Endpoint:** `https://incontinencepanties.myshopify.com/admin/api/2026-04/graphql.json` (POST GraphQL).

A working reference implementation lives at `~/shipping-audit/shipping_times.py` on Jasper's machine — same auth, same query shape. Treat it as a verified blueprint, not as production code to copy verbatim.

### 2.2 Internal inventory (already in the ops tool)

The OOS exclusion uses the inventory data the ops tool already holds. For each order line item, the tool needs to determine whether the SKU was deliverable at order time **or now** — see [Section 3.3](#33-filters--exclusions) for the exact decision rule.

---

## 3. Check A — Fulfilment SLA

### 3.1 The rule, in plain English

The 3PL works Monday through Friday. They commit to a 24-hour fulfilment SLA per business day:

- Order placed **Mon–Thu** → expected to ship the **next day** (Mon→Tue, etc.)
- Order placed **Fri, Sat, or Sun** → expected to ship the **following Monday** (3PL is closed weekends; weekend orders queue for Monday)

If `today (store-local) > expected_ship_date` and the order is still unfulfilled, flag it.

### 3.2 "Expected ship date" function

```
expected_ship_date(order_date) =
    if order_date is Mon, Tue, Wed, or Thu:
        return order_date + 1 calendar day
    if order_date is Fri:
        return next Monday    (i.e., order_date + 3 days)
    if order_date is Sat:
        return next Monday    (order_date + 2 days)
    if order_date is Sun:
        return next Monday    (order_date + 1 day)
```

All dates evaluated in the store's IANA timezone: **`America/New_York`** (queryable via `{ shop { ianaTimezone } }` if you want to avoid hardcoding).

### 3.3 Filters / exclusions

An order is **in scope** for this check only if all are true:

- `shippingAddress.countryCodeV2 == "US"`
- Order is **not cancelled** (`cancelledAt is null`)
- Order is **not on hold** (`displayFulfillmentStatus != "ON_HOLD"`)
- Order is **not fully refunded** (`displayFinancialStatus != "REFUNDED"`)
- Order is **not OOS** — for every line item in the order, the SKU has sufficient on-hand inventory in the ops tool's inventory table to fulfill the ordered quantity. If **any** line item is OOS, exclude the whole order.
- Order is **not a test/draft order** (`test == false`)

### 3.4 Daily schedule

Run the job once per weekday morning (suggest **8:00 AM ET**, after the 3PL's overnight shipping cutoff). The job evaluates *every* order with `expected_ship_date < today_store_local`, in-scope per 3.3, that is still unfulfilled (`displayFulfillmentStatus in ("UNFULFILLED", "PARTIALLY_FULFILLED")`). This naturally handles both "just-due" orders and any backlog from prior days — no separate backlog tracking needed.

Implied daily focus:

| Run day | Order dates flagged (first time) | Backlog re-checks |
|---|---|---|
| Mon | Thu (due Fri) | Anything still unfulfilled from earlier |
| Tue | Fri + Sat + Sun (due Mon) | Same |
| Wed | Mon (due Tue) | Same |
| Thu | Tue (due Wed) | Same |
| Fri | Wed (due Thu) | Same |

(Sat/Sun: no run. Mon run picks up Thu cohort + everything older.)

### 3.5 Flag output (per flagged order)

```
order_name              (e.g., EV975123)
order_id                (Shopify GID)
order_created_at        (ISO 8601, store-local rendering in UI)
expected_ship_date      (date)
days_past_due           (integer; today - expected_ship_date)
customer_name
shipping_state          (US state code)
line_items              [{sku, name, qty}, ...]
current_status          (UNFULFILLED / PARTIALLY_FULFILLED / ON_HOLD)
last_seen_in_3pl        (timestamp of the last `fulfillment_events` entry, if any)
shopify_admin_link      (https://{shop}/admin/orders/{numeric_id})
```

Sort the list by `days_past_due` descending (worst offenders first).

### 3.6 Edge cases to handle gracefully

- **Partial fulfillments.** If part of the order shipped but the rest is still pending past the SLA, flag it (status `PARTIALLY_FULFILLED`) but include only the unshipped line items in `line_items`.
- **Multiple shipping destinations** (rare): use the *primary* shipping address; if non-US, exclude.
- **Pre-orders / scheduled fulfillments** (`fulfillmentOrders.requestStatus == "SCHEDULED"`): exclude — they have a deliberate future fulfill-at date.
- **OOS becomes available.** Once inventory is back, the order re-enters scope on the next run; `days_past_due` will reflect the original order date, not when inventory replenished. That's intentional — surfaces the cumulative delay.

---

## 4. Check B — Carrier transit

### 4.1 The rule

Once an order has been fulfilled (= label generated / picked up by carrier), the carrier should deliver within 10 days. Flag any order where:

- The fulfilment was created **more than 10 days ago** (delay built in — don't flag orders that haven't had a fair shot)
- AND no `DELIVERED` fulfillment event has been recorded
- (OR the `delivered_at` is more than 10 days after `fulfillment.createdAt` — for historical/retroactive flagging)

### 4.2 Detection logic

For each fulfillment on each in-scope order:

```python
days_since_ship = today - fulfillment.createdAt
delivered_at = fulfillment.deliveredAt  # or first event where status == DELIVERED

if days_since_ship > 10:
    if delivered_at is None:
        flag as "in_transit_over_10_days"
    elif (delivered_at - fulfillment.createdAt).days > 10:
        flag as "delivered_late"
```

Same scope filter as Check A: US shipping only, not cancelled, not test.

### 4.3 Schedule

Run alongside the fulfilment check (same daily job, 8:00 AM ET on weekdays). Cheap to compute given a 30–60 day order window.

### 4.4 Flag output (per flagged order)

```
order_name
order_id
order_created_at
fulfilled_at
days_since_ship           (today - fulfilled_at, in days)
delivered_at              (or null)
carrier                   (e.g., "DHL eCommerce", "USPS")
tracking_number
tracking_url
shipping_state
status                    "in_transit_over_10_days" | "delivered_late"
shopify_admin_link
```

Sort by `days_since_ship` descending.

### 4.5 Note on data availability

The `DELIVERED` event only appears in Shopify if the carrier or 3PL pushes tracking updates back. Empirically, DHL eCommerce (which carries ~96% of volume on the test day) does report delivery cleanly. For carriers that don't, the order will stay flagged indefinitely — that's a known limitation, not a bug. Future enhancement: hit the carrier's own tracking API for these orders, but **out of scope for v1**.

---

## 5. Check C — Stats panel

A single dashboard card that always shows three numbers + one chart.

### 5.1 Top-line numbers (refreshed daily)

For **delivered US orders** in the last 30 days (`delivered_at` within `[today - 30d, today)`), compute:

| Metric | Definition |
|---|---|
| **Avg fulfilment time** | `mean(fulfilled_at - order_created_at)` in hours |
| **Avg carrier transit** | `mean(delivered_at - fulfilled_at)` in days |
| **Avg total delivery** | `mean(delivered_at - order_created_at)` in days |

For each metric, also show the value for the **prior 30-day window** (`[today - 60d, today - 30d)`) and the percentage delta. Color the delta green if shipping got faster, red if slower. Magnitude threshold for "significant": >5% change.

### 5.2 Distribution chart

A **histogram of carrier transit time** (`delivered_at - fulfilled_at`, in days), bin width = 1 day, x-axis 0–20 days (+ ">20" overflow bin). Overlay two series:

- **Last 30 days** (filled, primary color)
- **Prior 30 days** (outline only, comparison)

This makes it obvious if the distribution is shifting (e.g., the tail getting longer or the mode moving right). Reference data point from 2026-04-13: median was 144h (6.0d), p90 was 173h (~7.2d) — the bulk should sit in the 5–8d bins.

### 5.3 Scope

Same filters as Checks A/B: US shipping only, non-test, non-cancelled. Use *all* fulfilled orders in window (whether or not they were ever flagged).

---

## 6. Dashboard layout

New section title: **Shipping Performance**

```
+-----------------------------------------------------------+
| Shipping Performance                                       |
|  Last updated: 2026-05-12 08:01 ET   [refresh]            |
+-----------------------------------------------------------+
|  [Card 1: Stats]            [Card 2: Histogram]           |
|  Fulfilment   25h  ↑3%      [bars showing distribution]   |
|  Transit       6d  →                                       |
|  Total         7d  ↓1%                                     |
+-----------------------------------------------------------+
|  Flagged orders — Fulfilment SLA (N)        [expand all]  |
|  [table: order_name, days_past_due, customer, state, …]   |
+-----------------------------------------------------------+
|  Flagged orders — Carrier transit (N)       [expand all]  |
|  [table: order_name, days_since_ship, carrier, …]         |
+-----------------------------------------------------------+
```

Each flagged-order row should be expandable to show line items, tracking detail, and a button that deep-links to the order in Shopify admin (`https://incontinencepanties.myshopify.com/admin/orders/{numeric_id}`).

Suggested empty states:
- No fulfilment flags: "All orders shipping on time. Nothing to action."
- No carrier flags: "No packages over 10 days in transit."

---

## 7. Implementation notes

### 7.1 Query strategy

For both checks, the cheapest path is a **single GraphQL query per run** that pulls all orders created in the last ~30–35 days (covers both the SLA window and the 10-day carrier check with a safety margin). Paginate with cursors; 50 orders per page is fine.

Example query shape (trim/extend as needed):

```graphql
query OrdersWindow($q: String!, $cursor: String) {
  orders(first: 50, query: $q, after: $cursor, sortKey: CREATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      name
      createdAt
      cancelledAt
      test
      displayFinancialStatus
      displayFulfillmentStatus
      shippingAddress { countryCodeV2 provinceCode }
      customer { displayName }
      lineItems(first: 50) {
        nodes { sku name quantity fulfillableQuantity }
      }
      fulfillments {
        createdAt
        deliveredAt
        status
        trackingInfo { number company url }
        events(first: 50, sortKey: HAPPENED_AT) {
          edges { node { status happenedAt } }
        }
      }
    }
  }
}
```

Pass `q = "created_at:>='<today-35d>T00:00:00<tz_offset>' status:any"` to capture the rolling window. Shopify's order search supports the bracket syntax for date ranges directly.

### 7.2 Caching / persistence

- Cache the access token in-memory for the duration of the run (or in Redis for ~23h if you have it).
- Persist daily snapshots of the stats panel (date + the three top-line numbers) so the comparison-window math doesn't have to re-aggregate 60 days every refresh. A small table works.
- Flagged orders **don't** need their own persisted table — they're derived freshly each run from current Shopify state. (If you want a "first flagged at" timestamp on the UI, persist `{order_id, first_flagged_at, check_type}` lightly.)

### 7.3 Rate limits

GraphQL costs are query-cost based. The query in 7.1 costs ~5–10 per page; 30 days of orders at ~800/day means ~24k orders → ~480 pages → well under the 20k-points-per-second bucket (which restores at 1000/s). Adding a basic 429/throttle retry is enough; no exotic pacing needed.

### 7.4 Time zone handling

All "today" / "yesterday" / "expected ship date" calculations should use `America/New_York`. Render timestamps in the dashboard in that same zone unless the user prefers UTC.

### 7.5 OOS join logic

The ops tool already has inventory data. For each candidate flagged order, before including it in the fulfilment-flag list:

```
for each line_item in order:
    available = inventory_table.lookup(line_item.sku).available_qty
    if available < line_item.quantity:
        mark order as OOS and exclude
```

If your inventory table doesn't have a SKU for some line item (custom items, bundles), default to **including** the order in the flagged list (better to false-flag and have ops eyeball it than to silently swallow it). Log these as "no inventory data for SKU X" so Shobinn can patch the mapping.

---

## 8. Open questions

These are non-blocking — pick a default and move forward — but worth confirming with Jasper before going live:

1. **Daily run time.** Spec assumes 8:00 AM ET on weekdays. If the 3PL's "yesterday cutoff" is later (e.g., late-night shipping), shift accordingly.
2. **Should weekend ops see anything?** Spec runs Mon–Fri only. If on-call wants Saturday visibility, easy add — run the same job at 10 AM Sat reading from the cached state.
3. **Notification on flag.** Dashboard surfaces flags; do we also want a Slack ping (#ops or similar) when a *new* flag appears? Recommended for Check A (fulfilment SLA) so the team doesn't have to remember to check the dashboard.
4. **Refund / replacement orders.** If an order is flagged as carrier-stuck and ops issues a replacement, the original stays in the flagged list. Do we want a "snooze" or "resolved" action on each flag row?
5. **International orders.** Spec is US-only as requested. Need a separate, looser SLA check for international? (Different markdown spec — let me know.)

---

## 9. Acceptance criteria

A. Fulfilment check
- [ ] Running the check on Tue catches a known unfulfilled US order placed on Fri, Sat, or Sun
- [ ] OOS orders do **not** appear in the flag list (verify with a manually-set-to-zero SKU)
- [ ] On-hold / cancelled / refunded orders excluded
- [ ] Non-US orders excluded
- [ ] Partial-fulfillment orders surface the *unshipped* line items only
- [ ] Already-flagged orders persist across daily runs until fulfilled or excluded

B. Carrier check
- [ ] An order fulfilled 11 days ago with no `DELIVERED` event flags as `in_transit_over_10_days`
- [ ] An order fulfilled 5 days ago does **not** flag (delay grace period working)
- [ ] An order delivered 15 days after fulfilment (historical) flags as `delivered_late`

C. Stats panel
- [ ] Three numbers match a manual computation from the raw CSV on at least one spot-check day
- [ ] Histogram bins render correctly, with the prior-30d overlay clearly distinguishable
- [ ] Delta arrows render the correct direction (faster = green up-arrow? align with team convention)

---

## 10. Reference: working Python implementation

`~/shipping-audit/shipping_times.py` on Jasper's machine. It already:

- Mints a client_credentials token at startup
- Pulls all orders for a given date in store-local timezone
- Computes fulfilment_hours, shipping_hours, total_hours per order
- Walks `fulfillments[].events[]` looking for `status == DELIVERED`
- Emits a CSV with the per-order columns above (sans the OOS join, since the audit tool doesn't have inventory)

A baseline result on 2026-04-13: 835 orders, 810 delivered (97%). Fulfilment median 20h / p90 46.5h. Transit median 144h / p90 173h. Use these as sanity checks when validating your implementation.

If it would help, ping Jasper and he can share the file or a sample CSV.
