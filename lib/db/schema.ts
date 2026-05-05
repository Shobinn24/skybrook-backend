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
export const sourceEnum = pgEnum("source", ["sheets_inventory", "sheets_incoming", "shopify_us", "shopify_intl"]);
export const locationEnum = pgEnum("location", ["US", "CN"]);
export const channelEnum = pgEnum("channel", ["shopify_us", "shopify_intl"]);
export const orderStatusEnum = pgEnum("order_status", ["open", "fulfilled", "cancelled", "refunded"]);
export const incomingStatusEnum = pgEnum("incoming_status", ["po", "dispatched", "in_transit", "arrived"]);
export const flagEnum = pgEnum("flag", ["healthy", "watch", "at_risk", "overstocked"]);
export const pullStatusEnum = pgEnum("pull_status", ["success", "failed", "partial"]);

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

// Aggregated daily sales per SKU per channel — output of the Shopify Reports API via ShopifyQL.
// Scope `read_reports` returns this shape; order-level detail (line items) would require
// `read_all_orders` which Scott opted not to grant.
export const dailySales = pgTable(
  "daily_sales",
  {
    channel: channelEnum("channel").notNull(),
    sku: text("sku").notNull(),
    salesDate: date("sales_date").notNull(),
    unitsSold: integer("units_sold").notNull(),
    netSalesUsd: numeric("net_sales_usd", { precision: 14, scale: 4 }).notNull().default("0"),
    sourcePullId: uuid("source_pull_id").notNull().references(() => rawPulls.id),
  },
  (t) => ({ pk: primaryKey({ columns: [t.channel, t.sku, t.salesDate] }) })
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
