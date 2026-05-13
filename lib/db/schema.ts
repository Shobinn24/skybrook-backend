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
} from "drizzle-orm/pg-core";

// Enums
export const sourceEnum = pgEnum("source", [
  "sheets_inventory",
  "sheets_incoming",
  "sheets_ad_spend",
  "sheets_fb_ads",
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

export const incomingShipments = pgTable("incoming_shipments", {
  id: uuid("id").primaryKey().defaultRandom(),
  sku: text("sku").notNull(),
  destination: locationEnum("destination").notNull(),
  shipmentName: text("shipment_name").notNull(),
  quantity: integer("quantity").notNull(),
  expectedArrival: date("expected_arrival").notNull(),
  status: incomingStatusEnum("status").notNull().default("po"),
  sourcePullId: uuid("source_pull_id").notNull().references(() => rawPulls.id),
  sourceRowRef: text("source_row_ref").notNull(),
});

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

// Per-ad daily spend from the standalone "FB Ads Tracker" sheet (Sheet7
// of spreadsheet id `1lya_...`). Distinct from `ad_spend_daily` which
// pivots by product category — this table pivots by individual ad ID.
// The source sheet's column A has names like "(OG Lav CC) Ad 537 -
// OG Lavender images" or "(LAV ASC) DCA 537 - …"; the trailing number
// after "Ad " or "DCA " is the canonical ad identifier and the same
// number can run inside multiple campaigns, so we aggregate to
// (ad_number, spend_date) at ingest. The "canonical" ad_name + ad_link
// shown to operators is taken from the highest-spending source row for
// each ad_number. Truncate-replace per pull like the rest of the sheet
// pipeline.
export const fbAdSpendDaily = pgTable(
  "fb_ad_spend_daily",
  {
    adNumber: text("ad_number").notNull(),
    adName: text("ad_name").notNull(),
    adNameRaw: text("ad_name_raw").notNull(),
    adLink: text("ad_link"),
    // Marketer names extracted from ad_name_raw via word-boundary
    // substring match against the 8-marketer roster (Craig, Nate, Raul,
    // Tyler, Scotty, Jacob, Dan, JW). Multi-marketer ads carry every
    // matched name and show up in each marketer's filtered view.
    // Empty array → "Unassigned" bucket in the UI filter.
    marketers: text("marketers").array().notNull().default([]),
    spendDate: date("spend_date").notNull(),
    costUsd: numeric("cost_usd", { precision: 14, scale: 4 }).notNull(),
    sourcePullId: uuid("source_pull_id").notNull().references(() => rawPulls.id),
  },
  (t) => ({ pk: primaryKey({ columns: [t.adNumber, t.spendDate] }) }),
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
    sourcePullId: uuid("source_pull_id").notNull().references(() => rawPulls.id),
  },
  (t) => ({
    pk: primaryKey({
      columns: [t.channel, t.routedLocation, t.sku, t.salesDate],
    }),
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
