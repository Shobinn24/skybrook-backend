// Lineage — the 5th data-observability pillar (Freshness, Volume, Schema,
// Distribution, Lineage). The other four tell you that SOMETHING upstream
// broke; lineage tells you WHAT DOWNSTREAM it breaks, so an alert can name
// the dashboard pages a triager should sanity-check (or warn Scott off)
// instead of leaving them to trace the dependency by hand.
//
// Hand-curated map, derived by tracing lib/queries/* → the drizzle tables
// each reads → the dashboard route that calls that query. Verified
// 2026-06-23 against app/(dashboard)/*/page.tsx tRPC calls and
// lib/trpc/routers/inventory.ts (the catch-all router most pages use).
// Intentionally STATIC (the upgrade-research calls for a "static
// source→dashboard map"): the page set changes rarely, and a wrong
// auto-derived edge is worse than a slightly stale curated one.
//
// UPDATE THIS when a new page starts reading a table, or a shared query
// helper (queries/stock.ts, queries/velocity-range.ts) gains a consumer —
// those propagate a table to every page that imports the helper.

export type DashboardRoute = `/${string}`;

// Derived TABLE → dashboard routes that render data from it (directly or
// via a shared query helper). Keys are the canonical table names embedded
// in check `name`s / dedup keys.
const TABLE_DASHBOARDS: Record<string, DashboardRoute[]> = {
  // getStockLevels (queries/stock.ts) → inventory.ts → /inventory,
  // /overstock; getStockValueByProduct → /stock-value; sku-detail → /sku;
  // sustainability-timeline → /sustainability; factory-order-calc →
  // /factory-orders.
  stock_snapshots: [
    "/inventory",
    "/overstock",
    "/stock-value",
    "/sku",
    "/sustainability",
    "/factory-orders",
  ],
  incoming_shipments: [
    "/incoming",
    "/inventory",
    "/overstock",
    "/stock-value",
    "/sku",
    "/launches",
    "/sustainability",
    "/factory-orders",
  ],
  ad_spend_daily: ["/performance"],
  fb_ad_spend_daily: ["/fb-ads", "/bonus-tracker"],
  // velocity-range (queries/velocity-range.ts) reads daily_sales and is
  // pulled into inventory.ts (→ /inventory, /overstock), plus direct
  // reads in performance / sku-detail / sustainability / factory-order-calc.
  daily_sales: [
    "/performance",
    "/inventory",
    "/overstock",
    "/sku",
    "/sustainability",
    "/factory-orders",
  ],
  shipping_stats_daily: ["/shipping-performance"],
  factory_orders: ["/factory-orders"],
  // unit_cost on skus drives every dollar-valued view.
  skus: ["/factory-orders", "/stock-value", "/inventory", "/sku"],
};

// Ingestion SOURCE → table(s) it populates. Source-level checks (schema
// drift, volume) resolve through this to the same dashboards.
const SOURCE_TABLES: Record<string, string[]> = {
  sheets_inventory: ["stock_snapshots"],
  sheets_incoming: ["incoming_shipments"],
  sheets_ad_spend: ["ad_spend_daily"],
  sheets_fb_ads: ["fb_ad_spend_daily"],
  shopify_us: ["daily_sales"],
  shopify_intl: ["daily_sales"],
};

function dashboardsForTable(table: string): DashboardRoute[] {
  return TABLE_DASHBOARDS[table] ?? [];
}

function dashboardsForSource(source: string): DashboardRoute[] {
  const set = new Set<DashboardRoute>();
  for (const t of SOURCE_TABLES[source] ?? [])
    for (const d of dashboardsForTable(t)) set.add(d);
  return [...set];
}

export type Lineage = {
  // The data subject the check is about (a table or an ingestion source).
  subject: string;
  // Dashboard routes that render data derived from the subject.
  dashboards: DashboardRoute[];
  // Set when the subject is NOT a dashboard input (e.g. a reference tab
  // Scott reads directly), so the alert can say so instead of "<none>".
  note?: string;
};

// Match the longest known table prefix so "ad_spend_daily.product.men"
// and "daily_sales.shopify_us" both resolve. The trailing-dot boundary
// keeps "fb_ad_spend_daily" from being captured by "ad_spend_daily".
const TABLE_PREFIXES = [
  "ad_spend_daily",
  "fb_ad_spend_daily",
  "stock_snapshots",
  "daily_sales",
  "shipping_stats_daily",
];

// Map a check `name` (as produced by evaluateFreshness / evaluateVolume)
// to its downstream dashboards. Pure + synchronous — trivially unit-
// testable and safe to call in the alert-firing hot path.
export function lineageForCheck(name: string): Lineage {
  // Source-level checks: schema_drift.<source>, volume.<source>.
  const srcMatch = /^(?:schema_drift|volume)\.(.+)$/.exec(name);
  if (srcMatch) {
    const source = srcMatch[1];
    return { subject: source, dashboards: dashboardsForSource(source) };
  }

  // Reference tabs are Scott's direct sheet views, not Skybrook pages.
  if (name.startsWith("reference_tab.")) {
    return {
      subject: name.slice("reference_tab.".length),
      dashboards: [],
      note: "reference sheet tab (viewed directly, no Skybrook page)",
    };
  }

  for (const t of TABLE_PREFIXES) {
    if (name === t || name.startsWith(`${t}.`)) {
      return { subject: t, dashboards: dashboardsForTable(t) };
    }
  }

  // Column-quality checks. Today the only one is fb marketer attribution,
  // an fb_ad_spend_daily-derived column.
  if (name.startsWith("column_quality.") && name.includes("marketer")) {
    return {
      subject: "fb_ad_spend_daily",
      dashboards: dashboardsForTable("fb_ad_spend_daily"),
    };
  }

  // Factory-order integrity checks.
  if (name.startsWith("factory_orders.")) {
    // active_skus_missing_cost is really a skus.unit_cost gap; route it to
    // the dollar views, not only /factory-orders.
    const subject = name.includes("missing_cost") ? "skus" : "factory_orders";
    return { subject, dashboards: dashboardsForTable(subject) };
  }

  return { subject: name, dashboards: [] };
}

// Convenience for alert fields / health output: the affected routes as a
// single readable string, or the note (or "<none>") when there are none.
export function affectedLabel(name: string): string {
  const { dashboards, note } = lineageForCheck(name);
  if (dashboards.length) return dashboards.join(", ");
  return note ?? "<none>";
}
