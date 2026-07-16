import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  uuid,
  timestamp,
  integer,
  date,
  numeric,
  jsonb,
  boolean,
  pgEnum,
  primaryKey,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

// Enums
export const sourceEnum = pgEnum("source", [
  "sheets_inventory",
  "sheets_incoming",
  "sheets_ad_spend",
  "sheets_fb_ads",
  "sheets_fb_campaigns",
  "sheets_applovin",
  "sheets_fb_geo",
  "sheets_fb_url_map",
  "sheets_fb_product_map",
  "sheets_launch_info",
  "shopify_us",
  "shopify_intl",
]);
export const locationEnum = pgEnum("location", ["US", "CN"]);
export const channelEnum = pgEnum("channel", ["shopify_us", "shopify_intl"]);
export const orderStatusEnum = pgEnum("order_status", ["open", "fulfilled", "cancelled", "refunded"]);
export const incomingStatusEnum = pgEnum("incoming_status", ["po", "dispatched", "in_transit", "arrived"]);
export const flagEnum = pgEnum("flag", ["healthy", "watch", "at_risk", "overstocked"]);
export const pullStatusEnum = pgEnum("pull_status", ["success", "failed", "partial"]);
export const alertSeverityEnum = pgEnum("alert_severity", ["p0", "p1", "p2", "p3"]);
export const bonusTierEnum = pgEnum("bonus_tier", ["tier1", "tier2"]);
export const bonusStatusEnum = pgEnum(
  "bonus_status",
  ["pending", "approved_full", "approved_half", "rejected"],
);
export const factoryOrderStatusEnum = pgEnum(
  "factory_order_status",
  ["draft", "approved"],
);

// --- Raw layer ---
export const rawPulls = pgTable("raw_pulls", {
  id: uuid("id").primaryKey().defaultRandom(),
  source: sourceEnum("source").notNull(),
  pulledAt: timestamp("pulled_at", { withTimezone: true }).notNull().defaultNow(),
  pullBatchId: uuid("pull_batch_id").notNull(),
  payload: jsonb("payload").notNull(),
  rowCount: integer("row_count").notNull().default(0),
  schemaFingerprint: text("schema_fingerprint").notNull(),
});

// --- Normalized layer ---
export const skus = pgTable("skus", {
  sku: text("sku").primaryKey(),
  productName: text("product_name").notNull(),
  productLine: text("product_line"),
  unitCostUsd: numeric("unit_cost_usd", { precision: 12, scale: 4 }),
  // Per-warehouse cost. Cost sheet `EVSKUmap` tab pairs every date column
  // with a US/INTL pair; INTL maps to the CN warehouse in our Location
  // enum. Queries route by stock_snapshot.location and fall back to
  // unit_cost_usd when this column is null (e.g. SKUs Scott hasn't yet
  // priced internationally).
  unitCostIntlUsd: numeric("unit_cost_intl_usd", { precision: 12, scale: 4 }),
  firstSeenAt: date("first_seen_at").notNull(),
  active: boolean("active").notNull().default(true),
});

export const stockSnapshots = pgTable(
  "stock_snapshots",
  {
    sku: text("sku").notNull(),
    location: locationEnum("location").notNull(),
    snapshotDate: date("snapshot_date").notNull(),
    onHand: integer("on_hand").notNull(),
    sourcePullId: uuid("source_pull_id").notNull().references(() => rawPulls.id),
  },
  (t) => ({ pk: primaryKey({ columns: [t.sku, t.location, t.snapshotDate] }) })
);

export const incomingShipments = pgTable(
  "incoming_shipments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sku: text("sku").notNull(),
    destination: locationEnum("destination").notNull(),
    shipmentName: text("shipment_name").notNull(),
    quantity: integer("quantity").notNull(),
    expectedArrival: date("expected_arrival").notNull(),
    status: incomingStatusEnum("status").notNull().default("po"),
    sourcePullId: uuid("source_pull_id").notNull().references(() => rawPulls.id),
    sourceRowRef: text("source_row_ref").notNull(),
  },
  (t) => ({
    // Natural-key uniqueness. The table is truncate-replaced per ingest,
    // but with only a UUID PK two overlapping ingests could silently
    // double every PO quantity (overlap-doubling is blocked first by the
    // runIngest advisory lock; this index is the backstop). The ingest
    // pre-aggregates intra-pull duplicates and inserts with
    // onConflictDoNothing, so a conflict can only mean a concurrent
    // writer — dropping the duplicate row is exactly right.
    naturalKey: uniqueIndex("incoming_shipments_natural_key").on(
      t.sku,
      t.destination,
      t.shipmentName,
      t.expectedArrival,
    ),
  }),
);

// Manual receipt confirmations for incoming POs. Lives in its own table so
// state survives the truncate-replace ingest of `incoming_shipments`. Keyed
// by the natural shipment identity (name + destination + ETA) — the same
// triple Scott uses to refer to a PO. Status display on /incoming joins
// against this table: row exists ⇒ "received", missing + ETA past ⇒
// "overdue", missing + ETA future ⇒ "pending".
export const incomingReceipts = pgTable(
  "incoming_receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    shipmentName: text("shipment_name").notNull(),
    destination: locationEnum("destination").notNull(),
    expectedArrival: date("expected_arrival").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    note: text("note"),
  },
  (t) => ({
    unq: uniqueIndex("incoming_receipts_natural_uq").on(
      t.shipmentName,
      t.destination,
      t.expectedArrival,
    ),
  })
);

// Daily Facebook ad spend per product, sourced from the Supermetrics FB
// Google Sheet that Scott maintains (one tab per product). Powers the
// /performance page (Scott 2026-05-05). `product` is the tab name —
// "Men", "Shapewear", "SuperHW", "Super HW AL" — kept verbatim so the
// page can show the same labels Scott already uses; mapping to Shopify
// product families happens at query time. Truncate-replace per ingest
// to match the rest of the sheet pipeline; a same-day re-pull of the
// sheet just refreshes the table.
export const adSpendDaily = pgTable(
  "ad_spend_daily",
  {
    product: text("product").notNull(),
    spendDate: date("spend_date").notNull(),
    costUsd: numeric("cost_usd", { precision: 14, scale: 4 }).notNull(),
    sourcePullId: uuid("source_pull_id").notNull().references(() => rawPulls.id),
  },
  (t) => ({ pk: primaryKey({ columns: [t.product, t.spendDate] }) })
);

// Daily AppLovin (Axon) ad spend per product family, sourced from the
// dedicated "AppLovin Live" Supermetrics sheet (3-account profile, long
// format: Ad name | Date | Country | Spend). Unlike ad_spend_daily (one row per
// sheet TAB), AppLovin carries the product inside the ad name's pipe segment, so
// the ingest attributes each ad to a product family (attributeAppLovinAd) and
// aggregates to (product, country_code, spend_date) here. `product` is a
// canonical family label ("9055", "HW", "Clearance / Mixed", "Unmapped", ...) —
// the same labels getAllProductsRollup uses. country_code is the 2-letter Meta/
// AXON delivery code (uppercased; "" for legacy rows pulled before the Country
// column was added 2026-06-27) so the all-products view can split AppLovin
// US-vs-non-US alongside FB. Windowed delete-replace per ingest.
export const applovinAdSpendDaily = pgTable(
  "applovin_ad_spend_daily",
  {
    product: text("product").notNull(),
    countryCode: text("country_code").notNull().default(""),
    spendDate: date("spend_date").notNull(),
    costUsd: numeric("cost_usd", { precision: 14, scale: 4 }).notNull(),
    sourcePullId: uuid("source_pull_id").notNull().references(() => rawPulls.id),
  },
  (t) => ({ pk: primaryKey({ columns: [t.product, t.countryCode, t.spendDate] }) })
);

// FB per-ad delivery-country spend — a 30-day WINDOW SNAPSHOT (no date
// dimension: a daily x country x ad-level Supermetrics query ScriptErrors the
// interactive pull, so we pull a window total per ad x country). Full
// delete-replace each ingest. Joined to fb_ad_url_map on ad_id to derive a
// per-(ad_number, ad_prefix) US-vs-non-US fraction that getAllProductsRollup
// applies to the date-flexible daily FB spend in fb_ad_spend_daily. country_code
// is the 2-letter Meta delivery code ("US", "GB", ...); bucket US vs the rest.
export const fbGeoSpend = pgTable(
  "fb_geo_spend",
  {
    adId: text("ad_id").notNull(),
    countryCode: text("country_code").notNull(),
    costUsd: numeric("cost_usd", { precision: 14, scale: 4 }).notNull(),
    sourcePullId: uuid("source_pull_id").notNull().references(() => rawPulls.id),
  },
  (t) => ({ pk: primaryKey({ columns: [t.adId, t.countryCode] }) })
);

// FB per-ad destination URL map — a 30-day WINDOW SNAPSHOT, full delete-replace
// each ingest. dest_url is the coalesced landing page (Promoted post dest URL ->
// External dest URL -> catch-all Destination URL), null when an ad has no usable
// website URL. ad_name carries the "(PREFIX) Ad NNN" tag, so getAllProductsRollup
// derives (ad_number, ad_prefix) from it to apply URL-first attribution onto the
// daily FB spend, with the ad-name prefix as fallback. cost_usd weights the
// dominant URL when one (ad_number, ad_prefix) spans >1 ad_id (rare, ~0.16%).
export const fbAdUrlMap = pgTable(
  "fb_ad_url_map",
  {
    adId: text("ad_id").notNull(),
    adName: text("ad_name").notNull(),
    destUrl: text("dest_url"),
    costUsd: numeric("cost_usd", { precision: 14, scale: 4 }).notNull(),
    sourcePullId: uuid("source_pull_id").notNull().references(() => rawPulls.id),
  },
  (t) => ({ pk: primaryKey({ columns: [t.adId] }) })
);

// Jasper-maintained "FB Product Map" sheet (URL | US/INTL | Product). The
// single source of truth for All-products FB attribution: each landing URL
// -> product family + funnel region (everdries.com = US, shop.everdries.com =
// INTL). getAllProductsRollup looks each ad's normalized dest_url up here for
// BOTH product and region; misses fall back to ad-name + geo and are surfaced
// by the fb-url-coverage check so Jasper knows what to add. Window snapshot:
// full delete-replace each ingest. normalized_url is the lookup key (see
// normalizeFunnelUrl); raw_url is kept for display.
export const fbProductMap = pgTable(
  "fb_product_map",
  {
    normalizedUrl: text("normalized_url").notNull(),
    rawUrl: text("raw_url").notNull(),
    region: text("region").notNull(), // "US" | "INTL"
    productLabel: text("product_label").notNull(),
    sourcePullId: uuid("source_pull_id").notNull().references(() => rawPulls.id),
  },
  (t) => ({ pk: primaryKey({ columns: [t.normalizedUrl] }) })
);

// "Launch Info" tab of the same workbook — launch-prep facts the team
// maintains IN THE SHEET (owner decision 2026-07-08): external name,
// 5-pack price, colours, main/liner composition, Drive links for the
// China photoshoot + image-tool content. /launches displays these
// read-only via the launch-info-mapping alias table. Small snapshot,
// full delete-replace each ingest, keyed by trimmed Product name.
export const launchInfo = pgTable(
  "launch_info",
  {
    product: text("product").notNull(),
    externalName: text("external_name"),
    packPriceUsd: numeric("pack_price_usd", { precision: 10, scale: 2 }),
    colours: text("colours"),
    mainComposition: text("main_composition"),
    linerComposition: text("liner_composition"),
    chinaPhotoshootUrl: text("china_photoshoot_url"),
    imageToolUrl: text("image_tool_url"),
    sourcePullId: uuid("source_pull_id").notNull().references(() => rawPulls.id),
  },
  (t) => ({ pk: primaryKey({ columns: [t.product] }) })
);

// Per-ad daily spend from the standalone "FB Ads Tracker" sheet (Sheet7
// of spreadsheet id `1lya_...`). Distinct from `ad_spend_daily` which
// pivots by product category — this table pivots by individual ad ID.
// The source sheet's column A has names like "(OG Lav CC) Ad 537 -
// OG Lavender images" or "(LAV ASC) DCA 537 - …"; the trailing number
// after "Ad " or "DCA " is the canonical ad identifier and the same
// number can run inside multiple campaigns. We aggregate to
// (ad_number, ad_prefix, spend_date) at ingest — one row per product
// PREFIX an ad ran under — so homepage/brand spend on a shared creative
// isn't absorbed into the dominant product bucket (HOME-undercount fix,
// 2026-06-25). The "canonical" ad_name + ad_name_raw + ad_link +
// marketers shown to operators are taken from the highest-spending source
// row for the WHOLE ad_number and repeated on every prefix row, so the
// bonus + /fb-ads consumers that group by ad_number (sum cost, min
// marketers, max name) are byte-for-byte unaffected. ad_prefix + cost_usd
// carry the per-variant truth; product attribution reads ad_prefix.
// Truncate-replace per pull like the rest of the sheet pipeline.
export const fbAdSpendDaily = pgTable(
  "fb_ad_spend_daily",
  {
    adNumber: text("ad_number").notNull(),
    adName: text("ad_name").notNull(),
    adNameRaw: text("ad_name_raw").notNull(),
    // Variant product prefix — inner "(...)" text, e.g. "9055 CC" /
    // "HOME US BAU"; "" when the ad name has no leading prefix. Part of
    // the PK so an ad_number's distinct prefixes coexist on the same date.
    adPrefix: text("ad_prefix").notNull().default(""),
    adLink: text("ad_link"),
    // Marketer names extracted from ad_name_raw via word-boundary
    // substring match against the 8-marketer roster (Craig, Nate, Raul,
    // Tyler, Scotty, Jacob, Dan, JW). Multi-marketer ads carry every
    // matched name and show up in each marketer's filtered view.
    // Empty array → "Unassigned" bucket in the UI filter. Canonical
    // (ad_number level) — identical on every prefix row of an ad.
    marketers: text("marketers").array().notNull().default([]),
    spendDate: date("spend_date").notNull(),
    costUsd: numeric("cost_usd", { precision: 14, scale: 4 }).notNull(),
    sourcePullId: uuid("source_pull_id").notNull().references(() => rawPulls.id),
  },
  (t) => ({ pk: primaryKey({ columns: [t.adNumber, t.adPrefix, t.spendDate] }) }),
);

// Per-location scaling factors that adjust sales velocity inside a date
// range. Scott 2026-05-05: "we use what we call a 'scaling factor' to
// say essentially 'in the future period between shipment 2 and shipment
// 3 we want to scale up 20%'". A follow-up clarified scope:
// "Scaling factor should be adjustable at product level".
//
// `productName` is nullable. Null = brand-level (applies to every SKU
// at the location); set = applies only to SKUs whose `skus.product_name`
// matches. Product-scoped overrides win over null/brand-level for the
// same day, so operators can layer "everyone +10%" with "Mens +30%"
// for a launch ramp.
// Product launch metadata. Powers the /launches page (Scott 2026-05-05).
// Each row pairs a product (productName, e.g. "Boyshort Beige" — a new
// colorway counts as a launch per Scott) with the inbound shipment that
// triggers the launch (shipmentName as we ingest it from Incoming_new,
// e.g. "KAI Mens Apr26"). ETA Ant + ETA PD are derived at read time
// from `incoming_shipments` so they stay live with the source sheet;
// only the manual launch dates live in this table.
export const productLaunches = pgTable(
  "product_launches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productName: text("product_name").notNull(),
    shipmentName: text("shipment_name").notNull(),
    intlSiteLive: date("intl_site_live"),
    intlLaunchDate: date("intl_launch_date"),
    usSiteLive: date("us_site_live"),
    usLaunchDate: date("us_launch_date"),
    note: text("note"),
    // Manual launch-prep fields (owner request 2026-07-07): selling price,
    // the customer-facing product name, and Drive links to launch content
    // (factory-shot vs image-tool renders). All optional, filled in as the
    // launch approaches. Landed COGS is NOT stored here — it's derived at
    // read time from skus.unit_cost_usd so it stays live with the cost sheet.
    sellingPriceUsd: numeric("selling_price_usd", { precision: 10, scale: 2 }),
    externalProductName: text("external_product_name"),
    factoryContentUrl: text("factory_content_url"),
    imageToolContentUrl: text("image_tool_content_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    unq: uniqueIndex("product_launches_natural_uq").on(t.productName, t.shipmentName),
  })
);

export const velocityOverrides = pgTable("velocity_overrides", {
  id: uuid("id").primaryKey().defaultRandom(),
  location: locationEnum("location").notNull(),
  productName: text("product_name"),
  startDate: date("start_date").notNull(),
  endDate: date("end_date").notNull(),
  multiplier: numeric("multiplier", { precision: 10, scale: 4 }).notNull(),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const salesLineItems = pgTable(
  "sales_line_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    channel: channelEnum("channel").notNull(),
    sourceOrderId: text("source_order_id").notNull(),
    sourceLineId: text("source_line_id").notNull(),
    sku: text("sku").notNull(),
    quantity: integer("quantity").notNull(),
    unitPriceUsd: numeric("unit_price_usd", { precision: 12, scale: 4 }).notNull(),
    orderDateEst: date("order_date_est").notNull(),
    fulfillmentDateEst: date("fulfillment_date_est"),
    shipToCountry: text("ship_to_country").notNull(),
    routedLocation: locationEnum("routed_location").notNull(),
    orderStatus: orderStatusEnum("order_status").notNull(),
    refundedAtEst: date("refunded_at_est"),
    sourcePullId: uuid("source_pull_id").notNull().references(() => rawPulls.id),
  },
  (t) => ({ unq: uniqueIndex("sales_line_items_channel_src_uq").on(t.channel, t.sourceLineId) })
);

// Aggregated daily sales per SKU per (channel × routed warehouse).
//
// `routedLocation` is the WAREHOUSE the order shipped from, determined
// by `routeOrder({ channel, shipToCountry })`:
//   - shopify_us + ship-to US        → US warehouse
//   - shopify_us + ship-to non-US    → CN warehouse  (was mis-routed pre-2026-05-12)
//   - shopify_intl + any ship-to     → CN warehouse
//
// Pre-2026-05-12 ingest didn't pull `shippingAddress.countryCode` from
// the Shopify orders query, so every shopify_us row was attributed to
// the US warehouse regardless of where it shipped. After Scott approved
// the fix (5/12), the column was added with a default backfill of
// `channelToLocation(channel)` (preserves pre-fix behavior on historical
// rows), then a one-shot backfill re-pulled the trailing 30 days from
// Shopify with the new query so velocity rebases correctly. Going
// forward each ingest cycle bucketed by the real ship-to country.
export const dailySales = pgTable(
  "daily_sales",
  {
    channel: channelEnum("channel").notNull(),
    routedLocation: locationEnum("routed_location").notNull(),
    sku: text("sku").notNull(),
    salesDate: date("sales_date").notNull(),
    unitsSold: integer("units_sold").notNull(),
    netSalesUsd: numeric("net_sales_usd", { precision: 14, scale: 4 }).notNull().default("0"),
    // Exact product revenue (unit price x qty, post-discount) and the
    // pro-rated order-level ancillary (shipping + tax + tips) that together
    // sum to net_sales_usd. Split out so /performance can show product
    // revenue that ties to Shopify's by-product number, with shipping/tax
    // broken out (2026-06-25). net_sales_usd is unchanged (Scott-approved).
    // Back-populates over the rolling 35-day Shopify window; frozen history
    // stays 0 on these two columns until re-aggregated.
    productSalesUsd: numeric("product_sales_usd", { precision: 14, scale: 4 }).notNull().default("0"),
    ancillaryUsd: numeric("ancillary_usd", { precision: 14, scale: 4 }).notNull().default("0"),
    sourcePullId: uuid("source_pull_id").notNull().references(() => rawPulls.id),
  },
  (t) => ({
    pk: primaryKey({
      columns: [t.channel, t.routedLocation, t.sku, t.salesDate],
    }),
    // The dominant query shapes filter by sku + date range (velocity,
    // /performance, SKU detail) or bare date (freshness max(sales_date),
    // cashflow actuals). sku is 3rd in the PK so neither could use it.
    skuDateIdx: index("daily_sales_sku_date_idx").on(t.sku, t.salesDate),
    dateIdx: index("daily_sales_date_idx").on(t.salesDate),
  }),
);

// --- Derived layer ---
export const salesVelocity = pgTable(
  "sales_velocity",
  {
    sku: text("sku").notNull(),
    channel: text("channel").notNull(), // 'shopify_us' | 'shopify_intl' | 'all'
    windowDays: integer("window_days").notNull(),
    asOfDate: date("as_of_date").notNull(),
    unitsPerDay: numeric("units_per_day", { precision: 12, scale: 4 }).notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.sku, t.channel, t.windowDays, t.asOfDate] }) })
);

export const daysOfStock = pgTable(
  "days_of_stock",
  {
    sku: text("sku").notNull(),
    location: locationEnum("location").notNull(),
    asOfDate: date("as_of_date").notNull(),
    velocityWindowDays: integer("velocity_window_days").notNull(),
    daysOfStock: numeric("days_of_stock", { precision: 12, scale: 2 }).notNull(),
    sourceRefs: jsonb("source_refs").notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.sku, t.location, t.asOfDate, t.velocityWindowDays] }) })
);

export const sustainabilityFlags = pgTable(
  "sustainability_flags",
  {
    sku: text("sku").notNull(),
    location: locationEnum("location").notNull(),
    asOfDate: date("as_of_date").notNull(),
    flag: flagEnum("flag").notNull(),
    reasoning: text("reasoning").notNull(),
    runOutDate: date("run_out_date"),       // null when stock projected to hold through horizon
    afterNextPoDate: date("after_next_po_date"), // next PO ETA used in the projection
    sourceRefs: jsonb("source_refs").notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.sku, t.location, t.asOfDate] }) })
);

// --- Ops layer ---
export const dataPulls = pgTable("data_pulls", {
  id: uuid("id").primaryKey().defaultRandom(),
  pullBatchId: uuid("pull_batch_id").notNull(),
  source: sourceEnum("source").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  status: pullStatusEnum("status").notNull(),
  rowCount: integer("row_count").notNull().default(0),
  errorMessage: text("error_message"),
  rawPullId: uuid("raw_pull_id").references(() => rawPulls.id),
});

// SKU family overrides — DB-backed naming for /launches productName
// resolution. Replaces the manual edit-commit-deploy loop on
// lib/domain/sku-naming.ts when a new SKU family appears in production.
// Managed via /admin/product-names. Read by deriveProductName: the
// override map is consulted before the FAMILY_LABELS / FAMILY_ALIAS /
// IMPLICIT_5PACK_FAMILIES constants in sku-naming.ts.
export const skuFamilyOverrides = pgTable("sku_family_overrides", {
  family: text("family").primaryKey(),
  displayLabel: text("display_label").notNull(),
  isImplicit5pack: boolean("is_implicit_5pack").notNull().default(false),
  // When set, this family redirects to another family (parallels FAMILY_ALIAS).
  // E.g. alias_of='og' on family='new-og' makes ev-new-og-* resolve as OG.
  aliasOf: text("alias_of"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: text("updated_by").notNull(),
});

// Slack-fanout alerts. Each row is one "incident": a unique problem
// identified by `dedupKey` (e.g. "ingest.source.failed:shopify_intl",
// "freshness:daily_sales:shopify_intl"). While an alert is open
// (`resolvedAt IS NULL`), repeat fires within the dedup window are
// suppressed — preventing every cron tick from re-paging the channel
// about the same stale source. When the underlying check passes again,
// the open row is marked resolved and a thread reply is posted.
// `slackMessageTs` is the Slack-returned message timestamp, used to
// thread the resolve reply onto the original alert.
export const alertEvents = pgTable("alert_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  dedupKey: text("dedup_key").notNull(),
  severity: alertSeverityEnum("severity").notNull(),
  title: text("title").notNull(),
  payload: jsonb("payload").notNull(),
  channel: text("channel").notNull(),
  firedAt: timestamp("fired_at", { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  slackMessageTs: text("slack_message_ts"),
}, (t) => ({
  // Fast lookup for dedup check: "is there an open alert with this key?"
  openByKey: uniqueIndex("alert_events_open_by_key_uq")
    .on(t.dedupKey)
    .where(sql`${t.resolvedAt} IS NULL`),
}));

// One row per (ad × marketer × tier) bonus eligibility event. Inserted as
// `pending` when a marketer's lifetime FB ad spend on a given ad first
// crosses $13k or $65k (Jasper 2026-05-13). Status flips to
// `approved_full` / `approved_half` / `rejected` when Jasper reviews
// the pending queue in /bonus-tracker. `notification_batch_id` is
// stamped when the monthly WhatsApp goes out, marking the bonus as
// "paid" by Jasper's convention (notification == payment trigger).
//
// `marketer` is stored as text rather than an enum so the bonus roster
// stays a domain-layer concept — easy to add/remove names without a
// schema migration. The set of valid values is enforced at the tRPC
// boundary against BONUS_MARKETERS in lib/domain/bonus-tiers.ts.
//
// `amount_usd` is frozen at approval time: $500 / $3000 for main
// (Craig, Raul, Tyler), $250 / $1500 for secondary (Jacob, JW, Dan).
// The 50% modifier is encoded by the approved_half status rather than
// halving the amount post-hoc, so the audit trail reads cleanly.
export const bonusAwards = pgTable(
  "bonus_awards",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    adNumber: text("ad_number").notNull(),
    marketer: text("marketer").notNull(),
    tier: bonusTierEnum("tier").notNull(),
    crossedAt: date("crossed_at").notNull(),
    status: bonusStatusEnum("status").notNull().default("pending"),
    amountUsd: numeric("amount_usd", { precision: 10, scale: 2 }).notNull(),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedBy: text("approved_by"),
    notificationBatchId: uuid("notification_batch_id"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // One award per (ad, marketer, tier) — prevents duplicate pending
    // rows if the crossing detector runs more than once per day.
    uniq: uniqueIndex("bonus_awards_ad_marketer_tier_uq").on(
      t.adNumber,
      t.marketer,
      t.tier,
    ),
  }),
);

// One row per "Generate notification" button-press. Locks the set of
// approved bonuses included in the WhatsApp message so re-runs are
// idempotent and the audit trail shows what was paid when.
export const bonusNotificationBatches = pgTable("bonus_notification_batches", {
  id: uuid("id").primaryKey().defaultRandom(),
  periodLabel: text("period_label").notNull(), // e.g. "April 2026"
  // Renders the actual WhatsApp message body. Stored so the UI can show
  // exactly what was sent without recomputing from awards (which may
  // have changed since).
  messageBody: text("message_body").notNull(),
  // Aggregated totals per marketer at send time. Lets the UI show a
  // historic ledger without re-querying awards.
  totalsJson: jsonb("totals_json").notNull(),
  sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
  sentBy: text("sent_by").notNull(),
  whatsappStatus: text("whatsapp_status"), // "sent" | "skipped" | "failed:<reason>"
});

// --- Shipping Performance Checks (spec: docs/shipping-checks-spec) ---

// Persisted daily snapshot of the 30-day-trailing-window shipping
// stats. Stored so the prior-30d comparison + delta math can avoid
// re-aggregating 60 days of Shopify orders on every page load. The
// stats are derived from delivered US orders only (per spec §5.3).
// One row per `snapshot_date`, idempotent on upsert.
export const shippingStatsDaily = pgTable("shipping_stats_daily", {
  snapshotDate: date("snapshot_date").primaryKey(),
  // Window end is `snapshot_date - 0d`, window start is `snapshot_date - 30d`.
  // Denormalized counts so the UI can call out small-sample windows.
  deliveredCount: integer("delivered_count").notNull(),
  // Mean(fulfilled_at - order_created_at) in hours. Null when
  // delivered_count is 0.
  avgFulfilmentHours: numeric("avg_fulfilment_hours", { precision: 8, scale: 2 }),
  // Mean(delivered_at - fulfilled_at) in days.
  avgTransitDays: numeric("avg_transit_days", { precision: 6, scale: 2 }),
  // Mean(delivered_at - order_created_at) in days.
  avgTotalDays: numeric("avg_total_days", { precision: 6, scale: 2 }),
  // Histogram bins for the carrier-transit distribution chart. Keys
  // are day-bucket integers as strings (e.g., "0".."20", ">20"); values
  // are counts. Persisted with the snapshot so the prior-30d overlay
  // doesn't have to re-fetch.
  transitHistogram: jsonb("transit_histogram").notNull(),
  computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  // Persisted flag lists computed by the same nightly cron that fills
  // the stats columns above. Stored as JSONB arrays so the page-level
  // tRPC view can read them without re-fetching from Shopify on every
  // page load (the 2026-05-29 audit found that path took ~6 minutes
  // and rendered the page indistinguishable from broken). Nullable
  // for backward compatibility with pre-2026-05-29 rows; the query
  // layer defaults to [] when missing.
  fulfilmentFlags: jsonb("fulfilment_flags"),
  carrierFlags: jsonb("carrier_flags"),
  // When the flags column was last computed. Renders as the "Last
  // updated" line on the dashboard so users can see how fresh the
  // flag list is. Separate from computed_at because the stats column
  // and the flags column can drift in failure scenarios (we may
  // compute stats fresh today but skip the flag detection on a
  // Shopify timeout, etc.).
  flagsComputedAt: timestamp("flags_computed_at", { withTimezone: true }),
});

// First-flagged timestamp per (order_id, check_type) so the UI can
// show "flagged 3 days ago" badges without persisting the flag list
// itself (flags are re-derived from live Shopify state on every page
// load — see spec §7.2). Lightly persisted: an INSERT-IF-NOT-EXISTS
// per flag per day. Composite PK ensures idempotency across runs.
export const shippingFlagFirstSeen = pgTable(
  "shipping_flag_first_seen",
  {
    // Shopify GID, e.g., gid://shopify/Order/12345
    orderId: text("order_id").notNull(),
    // "fulfilment_sla" | "carrier_transit" — text rather than enum so
    // adding a new check class doesn't need a migration.
    checkType: text("check_type").notNull(),
    firstFlaggedAt: timestamp("first_flagged_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.orderId, t.checkType] }),
  }),
);

// --- Factory Order Automation (spec: docs/factory-order-spec) ---

// One row per monthly secondary factory order. The user-facing
// concept is "the May 2026 order"; we key on the first-of-month
// date for cheap uniqueness checks. Draft state allows iterating
// on inputs; approval freezes the calculated lines into
// `factory_order_lines` so the Excel generator has a stable
// snapshot to render even if upstream sales/stock numbers shift.
export const factoryOrders = pgTable("factory_orders", {
  id: uuid("id").primaryKey().defaultRandom(),
  orderMonth: date("order_month").notNull().unique(), // first of month
  status: factoryOrderStatusEnum("status").notNull().default("draft"),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  approvedBy: text("approved_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// All manual inputs for an order kept as JSON blobs — keyed by month
// rather than by line. The full panel of inputs auto-saves on every
// edit; a single row per order keeps the round-trip small. Shapes
// live in the calc engine (`lib/domain/factory-order-calc.ts`) and
// are validated with Zod on the way in.
export const factoryOrderInputs = pgTable("factory_order_inputs", {
  id: uuid("id").primaryKey().defaultRandom(),
  orderId: uuid("order_id")
    .notNull()
    .unique()
    .references(() => factoryOrders.id, { onDelete: "cascade" }),
  // 30D actuals (user-confirmed or auto-populated then edited).
  revenueUs: numeric("revenue_us", { precision: 14, scale: 2 }),
  revenueIntl: numeric("revenue_intl", { precision: 14, scale: 2 }),
  revenueAmazon: numeric("revenue_amazon", { precision: 14, scale: 2 }),
  // Forward forecast (US 4 months, INTL 3 months):
  // `{ us: [m1..m4], intl: [m1..m3] }`
  forecastJson: jsonb("forecast_json").notNull().default({}),
  // Main-line split overrides per warehouse:
  // `{ us: { "9055 Main": 0.55, ... }, intl: { ... } }`
  splitsJson: jsonb("splits_json").notNull().default({}),
  // Per-product-group multipliers: `{ [productGroup]: 1.0 }`
  scalingJson: jsonb("scaling_json").notNull().default({}),
  // Per-custom-product manual totals: `{ [productGroup]: 3000 }`
  customQtysJson: jsonb("custom_qtys_json").notNull().default({}),
  // Per-custom-product US share, 0..1 (e.g., 0.7 = 70% US / 30% INTL).
  // Defaults to 1.0 (all US) when a group is missing from the map so
  // existing drafts stay backwards-compatible.
  // `{ [productGroup]: 0.7 }`
  customUsShareJson: jsonb("custom_us_share_json").notNull().default({}),
  // Per-SKU Amazon inputs (US only):
  // `{ [sku]: { sales30d, stock, hold } }`
  amazonDataJson: jsonb("amazon_data_json").notNull().default({}),
  // Per-product-group free-text comments: `{ [productGroup]: "…" }`
  commentsJson: jsonb("comments_json").notNull().default({}),
  // General order-level note: "This needs to last until 4 Aug" etc.
  orderNotes: text("order_notes"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Snapshot of computed order lines, frozen on approval. Phase 4
// (Excel generation) reads from this table so the file always
// reflects what was actually approved, not whatever the live
// calculation would produce today.
export const factoryOrderLines = pgTable(
  "factory_order_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => factoryOrders.id, { onDelete: "cascade" }),
    sku: text("sku").notNull(),
    // Where the order goes — US warehouse (Skybrook / "SB" file)
    // or CN warehouse (Manora / "MV" file).
    destination: locationEnum("destination").notNull(),
    qty: integer("qty").notNull(),
    // DDP price for US destination, Cost price for CN.
    unitCost: numeric("unit_cost", { precision: 10, scale: 4 }).notNull(),
    amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
    // Product-group label snapshotted at approval time so the Excel
    // generator can group rows without re-deriving from the SKU.
    productGroup: text("product_group").notNull(),
  },
  (t) => ({
    // One line per (order × sku × destination). Prevents duplicate
    // snapshots if the approve flow ever runs twice.
    uniq: uniqueIndex("factory_order_lines_order_sku_dest_uq").on(
      t.orderId,
      t.sku,
      t.destination,
    ),
  }),
);

// ============================================================================
// Cashflow forecast (requests #10). Single events table + editable assumptions
// + per-week manual inputs. See docs/superpowers/specs/2026-06-03-cashflow-...
// ============================================================================
export const cashflowKindEnum = pgEnum("cashflow_kind", ["forecast", "actual"]);
export const cashflowDirectionEnum = pgEnum("cashflow_direction", ["in", "out"]);
export const cashflowCategoryEnum = pgEnum("cashflow_category", [
  "revenue_ev", "revenue_jm", "revenue_ewc", "cogs_addback", "profit_payout",
  "bulk_order", "ad_spend_google", "ad_spend_meta", "sales_tax", "tax",
  "payroll", "whitelisting", "software", "tatari", "agency", "one_off",
]);
export const cashflowSourceEnum = pgEnum("cashflow_source", [
  "manual", "auto_revenue", "auto_accrual", "sheet_pull", "recurring",
]);
export const cashflowVarianceReasonEnum = pgEnum("cashflow_variance_reason", [
  "volume", "spending", "timing",
]);

export const cashflowEvents = pgTable(
  "cashflow_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: cashflowKindEnum("kind").notNull(),
    forecastEventId: uuid("forecast_event_id"),
    category: cashflowCategoryEnum("category").notNull(),
    direction: cashflowDirectionEnum("direction").notNull(),
    amountUsd: numeric("amount_usd", { precision: 14, scale: 2 }).notNull(),
    accrualDate: date("accrual_date").notNull(),
    cashDate: date("cash_date").notNull(),
    source: cashflowSourceEnum("source").notNull(),
    sourceRef: text("source_ref"),
    description: text("description").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: text("created_by").notNull().default("system"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: text("updated_by").notNull().default("system"),
  },
  (t) => ({
    uxSourceRef: uniqueIndex("cashflow_events_source_ref_ux")
      .on(t.source, t.sourceRef)
      .where(sql`${t.source} <> 'manual' AND ${t.sourceRef} IS NOT NULL`),
    cashDateIdx: index("cashflow_events_cash_date_idx").on(t.cashDate),
  }),
);

export const cashflowAssumptions = pgTable("cashflow_assumptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  evRevenueStart: numeric("ev_revenue_start", { precision: 14, scale: 2 }).notNull().default("0"),
  evWeeklyGrowth: numeric("ev_weekly_growth", { precision: 8, scale: 4 }).notNull().default("1"),
  evNetMargin: numeric("ev_net_margin", { precision: 6, scale: 4 }).notNull().default("0"),
  jmRevenueStart: numeric("jm_revenue_start", { precision: 14, scale: 2 }).notNull().default("0"),
  jmWeeklyGrowth: numeric("jm_weekly_growth", { precision: 8, scale: 4 }).notNull().default("1"),
  jmNetMargin: numeric("jm_net_margin", { precision: 6, scale: 4 }).notNull().default("0"),
  ewcRevenueStart: numeric("ewc_revenue_start", { precision: 14, scale: 2 }).notNull().default("0"),
  ewcWeeklyGrowth: numeric("ewc_weekly_growth", { precision: 8, scale: 4 }).notNull().default("1"),
  ewcNetMargin: numeric("ewc_net_margin", { precision: 6, scale: 4 }).notNull().default("0"),
  cogsPct: numeric("cogs_pct", { precision: 6, scale: 4 }).notNull().default("0.15"),
  profitPayoutPct: numeric("profit_payout_pct", { precision: 6, scale: 4 }).notNull().default("0.90"),
  varianceThresholdUsd: numeric("variance_threshold_usd", { precision: 14, scale: 2 }).notNull().default("30000"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: text("updated_by").notNull().default("system"),
});

export const cashflowWeekly = pgTable("cashflow_weekly", {
  id: uuid("id").primaryKey().defaultRandom(),
  weekStart: date("week_start").notNull().unique(),
  actualTotalCashUsd: numeric("actual_total_cash_usd", { precision: 14, scale: 2 }),
  payoutOverrideUsd: numeric("payout_override_usd", { precision: 14, scale: 2 }),
  payoutSkipped: boolean("payout_skipped").notNull().default(false),
  varianceReason: cashflowVarianceReasonEnum("variance_reason"),
  varianceNote: text("variance_note"),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  recordedBy: text("recorded_by").notNull().default("system"),
});

// Campaign-level daily FB spend + FB-attributed purchase value, sourced from
// the "Campaign Daily" Supermetrics tab of the FB Ads Tracker sheet (long
// format: Date | Campaign name | Cost | Website purchases conversion value).
// Built 2026-07-06 for the ops-tool Campaign Tracker page: daily spend + ROAS
// per campaign bucket with Mon–Sun 7D rollups. ROAS is DERIVED
// (purchase_value / cost) — website purchase conversion value was verified
// identical to Ads Manager "Purchase ROAS" numerator to 4dp on settled days.
// FB restates the trailing ~2 days, so the source query pulls a rolling
// 14-day window and ingest does a windowed delete-replace (same pattern as
// applovin_ad_spend_daily); history older than the window is frozen.
// Campaign names are ingested VERBATIM — bucket mapping to the tracker's
// columns lives in lib/domain/campaign-buckets.ts, so re-bucketing never
// needs a re-pull.
export const fbCampaignDaily = pgTable(
  "fb_campaign_daily",
  {
    campaignName: text("campaign_name").notNull(),
    spendDate: date("spend_date").notNull(),
    costUsd: numeric("cost_usd", { precision: 14, scale: 4 }).notNull(),
    purchaseValueUsd: numeric("purchase_value_usd", { precision: 14, scale: 4 }).notNull(),
    sourcePullId: uuid("source_pull_id").notNull().references(() => rawPulls.id),
  },
  (t) => ({ pk: primaryKey({ columns: [t.campaignName, t.spendDate] }) }),
);

// Free-text weekly notes column on the Campaign Tracker page. One row per
// Mon-anchored week; the ops team pastes a chunk of commentary in weekly.
export const campaignTrackerNotes = pgTable("campaign_tracker_notes", {
  weekStart: date("week_start").primaryKey(),
  note: text("note").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: text("updated_by").notNull().default("system"),
});

// Near-real-time sheet sync (Todo #36): one row per sheet-fed source. The
// poll job reads each sheet's Drive `modifiedTime` every few minutes and
// compares it to `lastModifiedTime` here; a difference means the sheet was
// edited since our last pull, so the poller fires a targeted re-ingest
// instead of waiting for the next scheduled cron. `lastTriggeredAt` backs a
// short lock that stops consecutive polls from stacking ingests.
export const sheetPollState = pgTable("sheet_poll_state", {
  source: text("source").primaryKey(),
  sheetId: text("sheet_id").notNull(),
  lastModifiedTime: text("last_modified_time"),
  lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
  lastTriggeredAt: timestamp("last_triggered_at", { withTimezone: true }),
});

// ── Loox reviews (Scott 2026-07-13, upgrading the 2026-05-23 ask) ─────────────
// One row per customer review, from either source: `api` (Loox Merchant API
// poller over both stores, the primary path) or `email` (forwarded
// notification emails, the pre-API fallback). Scott bulk-imports main-store
// reviews into the intl store, and Loox assigns the copies NEW review ids —
// verified 2026-07-13 (305/305 recent cross-store matches shared email+date
// with identical rating and body, zero id overlap). So cross-store dedup
// keys on `dedupKey` = "email|date" (falling back to name|date|text-hash
// when email is missing); the main store syncs first so its copy wins.
// `externalId` (the Loox review id) is unique per store. Email rows dedup
// on `emailMessageId`. Parsing is best-effort for email rows: rows the
// parser can't fully extract keep `parsed=false` with the raw text
// preserved, so format drift is visible in the UI instead of silently lost.
export const looxReviews = pgTable(
  "loox_reviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    emailMessageId: text("email_message_id"),
    externalId: text("external_id"),
    source: text("source").notNull().default("email"), // 'api' | 'email'
    store: text("store"), // 'main' | 'intl' | null (email rows)
    dedupKey: text("dedup_key"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    // When the customer actually left the review (Loox's own timestamp);
    // email rows fall back to receivedAt for date-range queries.
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    productTitle: text("product_title"),
    productHandle: text("product_handle"),
    productId: text("product_id"), // Shopify product id (per store)
    rating: integer("rating"),
    reviewerName: text("reviewer_name"),
    reviewerEmail: text("reviewer_email"),
    reviewText: text("review_text"),
    verified: boolean("verified"),
    // Loox moderation status: 'published' | 'unpublished' | 'pending'.
    // KPIs count published plus legacy email rows where status is unknown.
    status: text("status"),
    rawText: text("raw_text"),
    parsed: boolean("parsed").notNull().default(false),
    // Did this reviewer actually buy this product? Stamped by
    // verifyReviewPurchases against order_emails:
    //   'verified'   — email ordered this product family on/before review
    //   'unverified' — order coverage exists for the period, no match
    //   'unknown'    — review predates order coverage, or no email
    // Null = not yet evaluated.
    purchaseVerified: text("purchase_verified"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("loox_reviews_email_message_id_uq").on(t.emailMessageId),
    uniqueIndex("loox_reviews_store_external_id_uq").on(t.store, t.externalId),
    uniqueIndex("loox_reviews_dedup_key_uq").on(t.dedupKey),
    index("loox_reviews_product_handle_idx").on(t.productHandle),
    index("loox_reviews_reviewed_at_idx").on(t.reviewedAt),
  ],
);

// Last-seen state of every backend-feeding Supermetrics query, upserted by
// the cron's feeder-query freshness sweep (supermetrics-query-freshness.ts).
// Exists so /api/health — which is DB-only by design (pinged every minute;
// no Sheets API budget) — can answer "did Supermetrics actually run, and
// when?" on demand instead of only when a query trips the 48h staleness
// alert. This closes the 2026-07-14 diagnostic gap where fb_ad_spend data
// sat a day stale and the only option was to wait and see.
export const supermetricsQueryState = pgTable("supermetrics_query_state", {
  label: text("label").primaryKey(),
  tabName: text("tab_name").notNull(),
  lastRefreshedAt: timestamp("last_refreshed_at", { withTimezone: true }),
  status: text("status").notNull(), // 'pass' | 'fail'
  checkedAt: timestamp("checked_at", { withTimezone: true }).notNull(),
});

// Acknowledged health checks: a failing check whose name matches an active
// row here still reports status=fail in /api/health but no longer flips
// `overall` (and therefore no longer 503s the endpoint). This keeps "red"
// meaning NEW problems — known items (a vendor queue, a long-running data
// gap) stay visible in the payload without training everyone to ignore a
// permanently red overall. `pattern` is an exact check name, or a prefix
// when it ends with '*' (e.g. 'fb_url_unmapped.*'); sources ack as
// 'source:<name>'. `expiresAt` auto-unacks so nothing is muted forever by
// accident. Manage with scripts/ack_check.ts.
export const acknowledgedChecks = pgTable("acknowledged_checks", {
  pattern: text("pattern").primaryKey(),
  reason: text("reason").notNull(),
  ackedBy: text("acked_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
});

// One row per Shopify product handle seen in the review data: the display
// name Scott sees in the KPI table, which line it belongs to (std | heavy),
// and whether it's included in the table at all. Seeded automatically by
// the API sync from distinct handles (line guessed from the product name);
// edits are data-only so the mapping can be corrected without a deploy.
// Main and intl handles for the same product both get rows; `displayName`
// is the grouping key in the KPI table, so pointing two handles at the
// same display name merges them into one line.
export const looxProducts = pgTable("loox_products", {
  handle: text("handle").primaryKey(),
  displayName: text("display_name").notNull(),
  line: text("line"), // 'std' | 'heavy' | null (unclassified)
  include: boolean("include").notNull().default(true),
  // Manually curated row: the post-sync unify pass (rename auto-merge +
  // noise rules) never touches pinned rows, so a hand-set merge or
  // include decision survives every future sync.
  pinned: boolean("pinned").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// One row per (store, buyer email, Shopify product id, order date) pulled
// from the Shopify Admin API — the purchase side of review verification
// (Scott 2026-07-14: "cross reference whether a customer has actually
// bought the specific product they're leaving a review on"; pilot on the
// cotton launch found 0 of 5 reviewers had bought it). Standard
// read_orders scope reaches ~60 days of history, so coverage is a rolling
// window; verifyReviewPurchases treats reviews older than the window's
// start as 'unknown' rather than 'unverified'.
export const orderEmails = pgTable(
  "order_emails",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    store: text("store").notNull(), // 'main' | 'intl' (matches loox_reviews.store)
    email: text("email").notNull(), // lowercased
    productId: text("product_id").notNull(),
    orderDate: date("order_date").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("order_emails_grain_uq").on(t.store, t.email, t.productId, t.orderDate),
    index("order_emails_email_idx").on(t.email),
  ],
);

// ── Sizing exchange analysis (Scott 2026-07-15) ─────────────────────
// Source: the CS returns/replacements workbook, tab EV (one workbook per
// year). Raw columns are kept verbatim; label/size/direction are derived
// at ingest by lib/sizing/mapper.ts (spec: docs/SIZING.md). Rows that the
// spec excludes are kept with `excluded` set instead of being dropped, so
// counts are auditable. Dedupe grain extends the spec's year-overlap rule
// (order + sizes) with description, so distinct events on one order (a
// refund and a separate exchange) both survive.
export const csExchanges = pgTable(
  "cs_exchanges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceYear: integer("source_year").notNull(), // which workbook the row came from
    rowDate: date("row_date"), // defensively parsed; the sheet has junk values
    orderNo: text("order_no").notNull(),
    email: text("email"), // lowercased
    country: text("country"),
    process: text("process"), // replace | refund | cancel (lowercased)
    styleRaw: text("style_raw"),
    sizeOrderedRaw: text("size_ordered_raw"),
    sizeReplacedRaw: text("size_replaced_raw"),
    description: text("description"), // lowercased + trimmed
    amount: numeric("amount", { precision: 10, scale: 2 }),
    // Derived by the mapper at ingest:
    label: text("label"), // e.g. 'High Waisted Std' — null when unmapped
    sizeOrdered: text("size_ordered"), // normalized (2XL canon), null unparseable
    sizeReplaced: text("size_replaced"),
    direction: text("direction"), // up | down | same | unknown
    // Why the row is out of scope, null = in scope:
    // seamless | multi_product | fulfillment_error | other_brand | unmapped
    excluded: text("excluded"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("cs_exchanges_dedupe_uq").on(
      t.orderNo,
      t.sizeOrderedRaw,
      t.sizeReplacedRaw,
      t.description,
    ),
    index("cs_exchanges_label_idx").on(t.label),
  ],
);

// Units sold per product label × size × calendar month, built from
// Shopify order line items (both stores). Monthly grain is what makes
// rolling 30/60/90-day sales-weighted exchange rates possible — the
// manual analysis only had a cumulative export (spec issue 4.5).
export const variantSalesMonthly = pgTable(
  "variant_sales_monthly",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    store: text("store").notNull(), // 'main' | 'intl'
    month: date("month").notNull(), // first of month
    label: text("label").notNull(), // same product labels as cs_exchanges
    size: text("size").notNull(), // normalized size
    units: integer("units").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("variant_sales_grain_uq").on(t.store, t.month, t.label, t.size)],
);

// Size-chart change log (manual, data-only): direction stats are only
// comparable within one chart version (spec interpretation caveat 2).
export const sizeChartNotes = pgTable("size_chart_notes", {
  id: uuid("id").primaryKey().defaultRandom(),
  effectiveDate: date("effective_date").notNull(),
  note: text("note").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// One row per (product, analysis run): Claude's read of that product's
// reviews — summary, themes, complaints, improvement ideas — plus the
// KPIs computed in SQL (count / average) frozen at generation time so the
// display never mixes an old analysis with new numbers.
export const looxReviewAnalyses = pgTable("loox_review_analyses", {
  id: uuid("id").primaryKey().defaultRandom(),
  productTitle: text("product_title").notNull(),
  reviewCount: integer("review_count").notNull(),
  avgRating: numeric("avg_rating", { precision: 3, scale: 2 }),
  analysis: jsonb("analysis").notNull(),
  model: text("model").notNull(),
  generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
});
