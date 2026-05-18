/**
 * Admin → Data Sources reference page.
 *
 * Maps each dashboard tab to the source it ultimately reads from
 * (Google Sheet, Shopify API, or derived from other tables). Each
 * source row has a direct "Open" link so the team can check the live
 * sheet without having to dig through env vars or memory.
 *
 * Server component — env vars are read at request time so links
 * always reflect the current Railway config (e.g., FB_ADS_TAB_NAME
 * was just flipped 5/18 from Sheet7 → Sheet6).
 */

export const dynamic = "force-dynamic";

type Source = {
  /** Short label, e.g., "Google Sheet — Daily Inventory Log" */
  label: string;
  /** Direct URL to the source, or null if there isn't a clickable one. */
  url: string | null;
  /** One-line context: tab name, channel, etc. */
  note?: string;
};

type TabRow = {
  /** Skybrook page name. */
  page: string;
  /** Skybrook in-app path. */
  href: string;
  /** Sources the page ultimately reads from. */
  sources: Source[];
  /** Free-form notes — when the data is derived, this is where we say so. */
  notes?: string;
};

function sheetUrl(envVarName: string): string | null {
  const id = process.env[envVarName]?.trim();
  if (!id) return null;
  return `https://docs.google.com/spreadsheets/d/${id}/edit`;
}

function envValue(name: string): string | null {
  const v = process.env[name]?.trim();
  return v || null;
}

function buildTabs(): TabRow[] {
  const inventorySheet = sheetUrl("INVENTORY_SHEET_ID");
  const incomingSheet = sheetUrl("INCOMING_PO_SHEET_ID");
  const adSpendSheet = sheetUrl("AD_SPEND_SHEET_ID");
  const fbAdsSheet = sheetUrl("FB_ADS_SHEET_ID");
  const fbAdsTab = envValue("FB_ADS_TAB_NAME") ?? "Sheet7";
  const velocitySheet = sheetUrl("EVERDRIES_VELOCITY_SHEET_ID");
  const costSheet = sheetUrl("EVERDRIES_COST_SHEET_ID");
  const shopifyUsStore = envValue("SHOPIFY_US_STORE");
  const shopifyIntlStore = envValue("SHOPIFY_INTL_STORE");

  const shopifyUsAdmin = shopifyUsStore
    ? `https://${shopifyUsStore}/admin/orders`
    : null;
  const shopifyIntlAdmin = shopifyIntlStore
    ? `https://${shopifyIntlStore}/admin/orders`
    : null;

  return [
    {
      page: "Inventory",
      href: "/inventory",
      sources: [
        {
          label: "Google Sheet — Daily Inventory Log",
          url: inventorySheet,
          note: "Tabs: EV Main US/CN, EV HF US/CN, EV Sec US/CN",
        },
        {
          label: "Shopify Admin — sales velocity (US store)",
          url: shopifyUsAdmin,
          note: shopifyUsStore ?? "—",
        },
        {
          label: "Shopify Admin — sales velocity (INTL store)",
          url: shopifyIntlAdmin,
          note: shopifyIntlStore ?? "—",
        },
      ],
      notes:
        "Stock per warehouse from the inventory sheet; velocity comes from Shopify orders aggregated daily into daily_sales.",
    },
    {
      page: "Incoming",
      href: "/incoming",
      sources: [
        {
          label: "Google Sheet — Monthly Secondary Order (EV)",
          url: incomingSheet,
          note: "Tab: Incoming_new",
        },
      ],
      notes:
        "Pending POs with ETAs. Receipt confirmations are written back from /incoming and stored in incoming_receipts.",
    },
    {
      page: "Sustainability",
      href: "/sustainability",
      sources: [
        {
          label: "Google Sheet — Daily Inventory Log",
          url: inventorySheet,
          note: "Stock on hand input",
        },
        {
          label: "Shopify Admin — sales velocity (US store)",
          url: shopifyUsAdmin,
          note: shopifyUsStore ?? "—",
        },
        {
          label: "Shopify Admin — sales velocity (INTL store)",
          url: shopifyIntlAdmin,
          note: shopifyIntlStore ?? "—",
        },
      ],
      notes:
        "Derived. Combines stock + 7d velocity + incoming POs to flag SKUs as healthy / watch / at-risk / overstocked.",
    },
    {
      page: "Overstock",
      href: "/overstock",
      sources: [
        {
          label: "Google Sheet — Daily Inventory Log",
          url: inventorySheet,
        },
        {
          label: "Shopify Admin — sales velocity (US store)",
          url: shopifyUsAdmin,
          note: shopifyUsStore ?? "—",
        },
        {
          label: "Shopify Admin — sales velocity (INTL store)",
          url: shopifyIntlAdmin,
          note: shopifyIntlStore ?? "—",
        },
      ],
      notes:
        "Derived. Phase 2 rollup: a product is overstocked when its combined stock-across-SKUs ÷ combined-7d-velocity exceeds 300 days.",
    },
    {
      page: "Stock value",
      href: "/stock-value",
      sources: [
        {
          label: "Google Sheet — Daily Inventory Log",
          url: inventorySheet,
          note: "Units on hand",
        },
        {
          label: "Google Sheet — EV SKU Map (landed cost)",
          url: costSheet,
          note: "Tab: EVSKUmap (US DDP + INTL FOB)",
        },
      ],
    },
    {
      page: "Performance",
      href: "/performance",
      sources: [
        {
          label: "Shopify Admin — daily sales (US store)",
          url: shopifyUsAdmin,
          note: shopifyUsStore ?? "—",
        },
        {
          label: "Shopify Admin — daily sales (INTL store)",
          url: shopifyIntlAdmin,
          note: shopifyIntlStore ?? "—",
        },
        {
          label: "Google Sheet — Supermetrics daily ad spend",
          url: adSpendSheet,
          note: "Aggregate FB ad spend, refreshed 4am Asunción",
        },
      ],
    },
    {
      page: "Launches",
      href: "/launches",
      sources: [
        {
          label: "Google Sheet — Daily Inventory Log",
          url: inventorySheet,
          note: "Stock-presence transitions drive auto-populate",
        },
        {
          label: "Shopify Admin — first-sale dates (US store)",
          url: shopifyUsAdmin,
          note: shopifyUsStore ?? "—",
        },
      ],
      notes:
        "Derived. Detects when a SKU first appears in stock and/or sales — those events become candidate launch rows.",
    },
    {
      page: "FB Ads Tracker",
      href: "/fb-ads",
      sources: [
        {
          label: "Google Sheet — FB Ads Tracker",
          url: fbAdsSheet,
          note: `Tab: ${fbAdsTab}`,
        },
      ],
    },
    {
      page: "Bonus Tracker",
      href: "/bonus-tracker",
      sources: [
        {
          label: "Google Sheet — FB Ads Tracker",
          url: fbAdsSheet,
          note: `Tab: ${fbAdsTab} (same source as FB Ads Tracker page)`,
        },
      ],
      notes:
        "Derived. Detects when an ad × marketer × tier combination crosses a bonus threshold and writes a pending row to bonus_awards.",
    },
    {
      page: "Shipping",
      href: "/shipping-performance",
      sources: [
        {
          label: "Shopify Admin — orders + fulfillments (US store)",
          url: shopifyUsAdmin,
          note: shopifyUsStore ?? "—",
        },
      ],
      notes:
        "Two daily checks (fulfilment SLA + carrier transit >10d) and a 30d stats panel, US-only. Live-fetched each page load; 30d stats also snapshotted nightly into shipping_stats_daily.",
    },
    {
      page: "Admin → Product names",
      href: "/admin/product-names",
      sources: [
        {
          label: "Google Sheet — Inventory Report - EV (Velocity Report)",
          url: velocitySheet,
          note: "Tab: EV Main — col B = style label, col C = SKU code",
        },
      ],
      notes:
        "Pattern parser is canonical for known product families; the sheet override fills the gaps for jac / mlb / new / etc.",
    },
  ];
}

function SourceItem({ source }: { source: Source }) {
  return (
    <div className="text-sm">
      <div className="font-medium text-neutral-800">
        {source.url ? (
          <a
            href={source.url}
            target="_blank"
            rel="noreferrer"
            className="text-blue-700 hover:underline"
          >
            {source.label} ↗
          </a>
        ) : (
          <span className="text-neutral-500">
            {source.label} <span className="text-xs">(not configured)</span>
          </span>
        )}
      </div>
      {source.note && (
        <div className="text-xs text-neutral-500">{source.note}</div>
      )}
    </div>
  );
}

export default function DataSourcesPage() {
  const tabs = buildTabs();
  const generatedAt = new Date().toISOString().slice(0, 16).replace("T", " ");
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-neutral-900">
          Data sources
        </h1>
        <p className="mt-1 text-sm text-neutral-600">
          Where each dashboard tab gets its data from — Google Sheets,
          Shopify admin, or derived from other tables. Click any source
          to open it in a new tab. Read-only reference; nothing here
          changes pipeline behavior.
        </p>
        <p className="mt-1 text-xs text-neutral-400">
          Generated {generatedAt} UTC from the live Railway env config.
        </p>
      </div>

      <div className="rounded-md border border-neutral-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500">
            <tr>
              <th className="w-48 px-4 py-2">Dashboard tab</th>
              <th className="px-4 py-2">Source(s)</th>
              <th className="px-4 py-2">Notes</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-100">
            {tabs.map((tab) => (
              <tr key={tab.href} className="align-top">
                <td className="px-4 py-3 font-medium text-neutral-900">
                  <a
                    href={tab.href}
                    className="hover:text-neutral-600 hover:underline"
                  >
                    {tab.page}
                  </a>
                </td>
                <td className="px-4 py-3">
                  <div className="space-y-2">
                    {tab.sources.map((source, i) => (
                      <SourceItem key={`${tab.href}-src-${i}`} source={source} />
                    ))}
                  </div>
                </td>
                <td className="px-4 py-3 text-xs text-neutral-600">
                  {tab.notes ?? ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="rounded-md border border-neutral-200 bg-neutral-50 px-4 py-3 text-xs text-neutral-600">
        Service account with read access to these sheets:{" "}
        <code className="rounded bg-white px-1 py-0.5 font-mono">
          everdries-uploader@everdries-drive.iam.gserviceaccount.com
        </code>
        . If a new sheet doesn&apos;t show data, the first thing to
        check is whether that sheet has been shared with this account.
      </div>
    </div>
  );
}
