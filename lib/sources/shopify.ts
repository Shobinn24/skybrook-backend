import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { dailySales } from "@/lib/db/schema";
import type { SourceRunner } from "@/lib/jobs/ingest";

// Shopify Admin GraphQL API version — bump when needed.
const API_VERSION = "2025-01";

type Channel = "shopify_us" | "shopify_intl";

// ShopifyQL response shape we care about.
type TableResponse = {
  data: {
    shopifyqlQuery:
      | {
          __typename: "TableResponse";
          tableData: {
            columns: { name: string }[];
            rowData: (string | number)[][];
          };
        }
      | {
          __typename: "ParseError" | "SchemaError" | "AccessError";
          parseErrors?: { message: string }[];
          message?: string;
        };
  };
  errors?: { message: string }[];
};

export type ShopifyDailySale = {
  sku: string;
  salesDate: string; // YYYY-MM-DD
  unitsSold: number;
  netSalesUsd: number;
};

/**
 * Run a ShopifyQL query against the Admin GraphQL API.
 * Scope required: read_reports (no read_orders / read_all_orders needed).
 */
async function runShopifyQl(store: string, token: string, shopifyql: string): Promise<TableResponse> {
  const url = `https://${store}/admin/api/${API_VERSION}/graphql.json`;
  const body = {
    query: `
      query($q: String!) {
        shopifyqlQuery(query: $q) {
          __typename
          ... on TableResponse {
            tableData { columns { name } rowData }
          }
          ... on ParseError {
            parseErrors { message }
          }
          ... on SchemaError { message }
          ... on AccessError { message }
        }
      }
    `,
    variables: { q: shopifyql },
  };
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`shopify ${store}: HTTP ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as TableResponse;
}

/**
 * Parse a ShopifyQL TableResponse into our daily-sales shape.
 * Expects columns: product_variant_sku, day, units_sold, net_sales (order-insensitive).
 */
export function parseDailySales(tr: TableResponse): ShopifyDailySale[] {
  const q = tr.data?.shopifyqlQuery;
  if (!q) throw new Error("shopify: empty shopifyqlQuery response");
  if (q.__typename !== "TableResponse") {
    const msg =
      q.parseErrors?.map((e) => e.message).join("; ") ??
      q.message ??
      `shopify: ${q.__typename}`;
    throw new Error(`shopify: ${msg}`);
  }

  const cols = q.tableData.columns.map((c) => c.name);
  const skuIdx = cols.findIndex((c) => c === "product_variant_sku" || c === "variant_sku");
  const dayIdx = cols.findIndex((c) => c === "day" || c === "sales_date");
  const unitsIdx = cols.findIndex((c) => c === "units_sold" || c === "net_items_sold");
  const netIdx = cols.findIndex((c) => c === "net_sales" || c === "total_sales");

  if (skuIdx < 0 || dayIdx < 0 || unitsIdx < 0) {
    throw new Error(`shopify: missing expected columns in response: ${cols.join(",")}`);
  }

  const out: ShopifyDailySale[] = [];
  for (const row of q.tableData.rowData) {
    const sku = String(row[skuIdx] ?? "").trim();
    const day = String(row[dayIdx] ?? "").slice(0, 10);
    const units = Number(row[unitsIdx] ?? 0);
    const net = netIdx >= 0 ? Number(row[netIdx] ?? 0) : 0;
    if (!sku || !day || !Number.isFinite(units)) continue;
    out.push({ sku, salesDate: day, unitsSold: units, netSalesUsd: net });
  }
  return out;
}

function buildShopifyql(since: string, until: string): string {
  // Scott 2026-04-23: cancelled + refunded both count as sales. ShopifyQL `units_sold`
  // uses the raw ordered quantity and does NOT net out refunds, so it matches that intent.
  // `net_sales` is used only for the dollar view.
  return `FROM sales
    SHOW product_variant_sku, day, units_sold, net_sales
    SINCE ${since}
    UNTIL ${until}
    ORDER BY day ASC`;
}

function makeRunner(channel: Channel): SourceRunner {
  return async (_batchId) => {
    const store =
      channel === "shopify_us" ? process.env.SHOPIFY_US_STORE : process.env.SHOPIFY_INTL_STORE;
    const token =
      channel === "shopify_us"
        ? process.env.SHOPIFY_US_ACCESS_TOKEN
        : process.env.SHOPIFY_INTL_ACCESS_TOKEN;
    if (!store) throw new Error(`${channel}: missing store URL`);
    if (!token) throw new Error(`${channel}: missing access token`);

    // Backfill from 2026-03-01 per SPEC §13. Until = today (EST).
    const today = new Date().toISOString().slice(0, 10);
    const since = "2026-03-01";

    const raw = await runShopifyQl(store, token, buildShopifyql(since, today));
    const sales = parseDailySales(raw);

    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify(
          raw.data?.shopifyqlQuery && "tableData" in raw.data.shopifyqlQuery
            ? raw.data.shopifyqlQuery.tableData.columns
            : []
        )
      )
      .digest("hex")
      .slice(0, 16);

    return {
      ok: true,
      rowCount: sales.length,
      rawPayload: raw,
      schemaFingerprint: fingerprint,
      async normalize(rawId) {
        for (const s of sales) {
          await db
            .insert(dailySales)
            .values({
              channel,
              sku: s.sku,
              salesDate: s.salesDate,
              unitsSold: s.unitsSold,
              netSalesUsd: String(s.netSalesUsd),
              sourcePullId: rawId,
            })
            .onConflictDoUpdate({
              target: [dailySales.channel, dailySales.sku, dailySales.salesDate],
              set: {
                unitsSold: sql`excluded.units_sold`,
                netSalesUsd: sql`excluded.net_sales_usd`,
                sourcePullId: rawId,
              },
            });
        }
      },
    };
  };
}

export const shopifyUsRunner: SourceRunner = makeRunner("shopify_us");
export const shopifyIntlRunner: SourceRunner = makeRunner("shopify_intl");
