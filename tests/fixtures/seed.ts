import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  dailySales,
  incomingShipments,
  rawPulls,
  skus,
  stockSnapshots,
} from "@/lib/db/schema";

export async function resetDb() {
  await db.execute(sql`
    TRUNCATE TABLE
      sustainability_flags,
      days_of_stock,
      sales_velocity,
      data_pulls,
      daily_sales,
      sales_line_items,
      incoming_receipts,
      incoming_shipments,
      ad_spend_daily,
      product_launches,
      stock_snapshots,
      velocity_overrides,
      skus,
      raw_pulls
    CASCADE
  `);
}

export async function seedBasic() {
  const [raw] = await db
    .insert(rawPulls)
    .values({
      source: "sheets_inventory",
      pullBatchId: randomUUID(),
      payload: {},
      rowCount: 0,
      schemaFingerprint: "fp",
    })
    .returning({ id: rawPulls.id });

  await db.insert(skus).values([
    {
      sku: "EV-A",
      productName: "Alpha",
      productLine: "Core",
      unitCostUsd: "5",
      firstSeenAt: "2026-04-01",
      active: true,
    },
    {
      sku: "EV-B",
      productName: "Beta",
      productLine: "Core",
      unitCostUsd: "8",
      firstSeenAt: "2026-04-01",
      active: true,
    },
  ]);

  // Current stock at both locations.
  await db.insert(stockSnapshots).values([
    { sku: "EV-A", location: "US", snapshotDate: "2026-04-23", onHand: 100, sourcePullId: raw.id },
    { sku: "EV-A", location: "CN", snapshotDate: "2026-04-23", onHand: 500, sourcePullId: raw.id },
    { sku: "EV-B", location: "US", snapshotDate: "2026-04-23", onHand: 20, sourcePullId: raw.id },
  ]);

  // 7-day sales history (shopify_us only for now).
  const start = new Date("2026-04-17T00:00:00Z");
  const rows: Array<{
    channel: "shopify_us" | "shopify_intl";
    sku: string;
    salesDate: string;
    unitsSold: number;
    netSalesUsd: string;
    sourcePullId: string;
  }> = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    const ymd = d.toISOString().slice(0, 10);
    rows.push({ channel: "shopify_us", sku: "EV-A", salesDate: ymd, unitsSold: 5, netSalesUsd: "100", sourcePullId: raw.id });
    rows.push({ channel: "shopify_us", sku: "EV-B", salesDate: ymd, unitsSold: 3, netSalesUsd: "60", sourcePullId: raw.id });
    rows.push({ channel: "shopify_intl", sku: "EV-A", salesDate: ymd, unitsSold: 2, netSalesUsd: "40", sourcePullId: raw.id });
  }
  await db.insert(dailySales).values(rows);

  // One future incoming PO for EV-A (CN) arriving in 10 days.
  await db.insert(incomingShipments).values([
    {
      sku: "EV-A",
      destination: "CN",
      shipmentName: "KAI Test 1",
      quantity: 200,
      expectedArrival: "2026-05-03",
      status: "in_transit",
      sourcePullId: raw.id,
      sourceRowRef: "test!fixture",
    },
  ]);

  return { rawId: raw.id };
}
