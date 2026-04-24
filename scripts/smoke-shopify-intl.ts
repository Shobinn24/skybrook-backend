// Live end-to-end smoke: INTL store OAuth → ShopifyQL → parsed rows.
// Run: npx tsx scripts/smoke-shopify-intl.ts
// Reads .env for SHOPIFY_API_KEY / SHOPIFY_API_SECRET / SHOPIFY_INTL_STORE.
// Window is last 3 days to keep the payload tiny.

import "dotenv/config";
import { getShopifyAccessToken } from "../lib/sources/shopify-auth";

const API_VERSION = "2025-01";

async function main() {
  const store = process.env.SHOPIFY_INTL_STORE;
  if (!store) {
    console.error("SHOPIFY_INTL_STORE missing in .env");
    process.exit(1);
  }

  console.log(`→ Fetching OAuth token for ${store}`);
  const token = await getShopifyAccessToken(store);
  console.log(`  got token (expires_in ~24h), length=${token.length}`);

  const today = new Date().toISOString().slice(0, 10);
  const since = new Date(Date.now() - 3 * 86400_000).toISOString().slice(0, 10);
  const shopifyql = `FROM sales
    SHOW product_variant_sku, day, units_sold, net_sales
    SINCE ${since}
    UNTIL ${today}
    ORDER BY day ASC`;

  console.log(`→ Running ShopifyQL SINCE=${since} UNTIL=${today}`);
  const url = `https://${store}/admin/api/${API_VERSION}/graphql.json`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: `query($q: String!) {
        shopifyqlQuery(query: $q) {
          __typename
          ... on TableResponse { tableData { columns { name } rowData } }
          ... on ParseError { parseErrors { message } }
          ... on SchemaError { message }
          ... on AccessError { message }
        }
      }`,
      variables: { q: shopifyql },
    }),
  });

  if (!res.ok) {
    console.error(`HTTP ${res.status}:`, await res.text());
    process.exit(1);
  }

  const json = (await res.json()) as {
    data?: {
      shopifyqlQuery?: {
        __typename: string;
        tableData?: { columns: { name: string }[]; rowData: unknown[][] };
        parseErrors?: { message: string }[];
        message?: string;
      };
    };
    errors?: unknown;
  };

  const q = json.data?.shopifyqlQuery;
  if (!q) {
    console.error("empty shopifyqlQuery response:", JSON.stringify(json));
    process.exit(1);
  }
  if (q.__typename !== "TableResponse") {
    console.error(
      `got ${q.__typename}:`,
      q.parseErrors?.map((e) => e.message).join("; ") ?? q.message,
    );
    process.exit(1);
  }

  const cols = q.tableData!.columns.map((c) => c.name);
  const rows = q.tableData!.rowData;
  console.log(`\n✓ ${rows.length} rows returned`);
  console.log(`  columns: ${cols.join(", ")}`);
  if (rows.length > 0) {
    console.log(`\n  first 5 rows:`);
    for (const row of rows.slice(0, 5)) {
      console.log(`    ${row.join(" | ")}`);
    }
  } else {
    console.log(`  (no sales in the last 3 days — store may be quiet)`);
  }
}

main().catch((e) => {
  console.error("smoke failed:", e);
  process.exit(1);
});
