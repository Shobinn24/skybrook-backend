import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import {
  dailySales,
  incomingShipments,
  productLaunches,
  rawPulls,
  skus,
  stockSnapshots,
} from "@/lib/db/schema";
import {
  cleanupStaleDefaultLaunches,
  collapseMultiShipmentAutoLaunches,
  runLaunchAutoPopulate,
} from "@/lib/jobs/launches";
import { resetDb } from "@/tests/fixtures/seed";

async function seedRawPull(): Promise<string> {
  const [r] = await db
    .insert(rawPulls)
    .values({
      source: "sheets_inventory",
      pullBatchId: randomUUID(),
      payload: {},
      rowCount: 0,
      schemaFingerprint: "fp",
    })
    .returning({ id: rawPulls.id });
  return r.id;
}

/** Today minus N days, as YYYY-MM-DD. */
function ymdDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

describe("runLaunchAutoPopulate", () => {
  beforeAll(() => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set in test env");
  });

  beforeEach(async () => {
    await resetDb();
  });

  it("creates a launch row for a brand-new product (no stock at destination, no recent sales)", async () => {
    const rawId = await seedRawPull();
    await db.insert(skus).values([
      { sku: "ev-newprod-5x-l", productName: "Brand New Product", productLine: "Core", firstSeenAt: "2026-05-06", active: true },
    ]);
    await db.insert(incomingShipments).values([
      { sku: "ev-newprod-5x-l", shipmentName: "KAI New 1", destination: "CN", expectedArrival: "2026-06-01", quantity: 500, status: "po", sourcePullId: rawId, sourceRowRef: "row-1" },
    ]);

    const result = await runLaunchAutoPopulate();
    expect(result.inserted).toBe(1);

    const launches = await db.select().from(productLaunches);
    expect(launches).toHaveLength(1);
    expect(launches[0].productName).toBe("Brand New Product");
    expect(launches[0].shipmentName).toBe("KAI New 1");
    expect(launches[0].note).toMatch(/Auto-added/i);
  });

  it("does NOT create a launch when the SKU has stock at the destination", async () => {
    const rawId = await seedRawPull();
    await db.insert(skus).values([
      { sku: "ev-bshort-5x-l", productName: "Boyshort", productLine: "Core", firstSeenAt: "2026-04-01", active: true },
    ]);
    await db.insert(stockSnapshots).values([
      { sku: "ev-bshort-5x-l", location: "CN", snapshotDate: "2026-04-15", onHand: 100, sourcePullId: rawId },
    ]);
    await db.insert(incomingShipments).values([
      { sku: "ev-bshort-5x-l", shipmentName: "KAI Bshort May", destination: "CN", expectedArrival: "2026-06-01", quantity: 1000, status: "po", sourcePullId: rawId, sourceRowRef: "row-1" },
    ]);

    const result = await runLaunchAutoPopulate();
    expect(result.inserted).toBe(0);
    expect(result.skippedHasStock).toBe(1);

    const launches = await db.select().from(productLaunches);
    expect(launches).toHaveLength(0);
  });

  it("does NOT create a launch when the SKU had recent sales on the destination's channel", async () => {
    const rawId = await seedRawPull();
    await db.insert(skus).values([
      { sku: "ev-bshort-5x-l", productName: "Boyshort", productLine: "Core", firstSeenAt: "2026-04-01", active: true },
    ]);
    // 0 stock at CN but recent INTL sales → established product, no launch.
    await db.insert(dailySales).values([
      { channel: "shopify_intl", sku: "ev-bshort-5x-l", salesDate: ymdDaysAgo(7), unitsSold: 50, netSalesUsd: "1000.00", sourcePullId: rawId },
    ]);
    await db.insert(incomingShipments).values([
      { sku: "ev-bshort-5x-l", shipmentName: "KAI Bshort May", destination: "CN", expectedArrival: "2026-06-01", quantity: 1000, status: "po", sourcePullId: rawId, sourceRowRef: "row-1" },
    ]);

    const result = await runLaunchAutoPopulate();
    expect(result.inserted).toBe(0);
    expect(result.skippedHasSales).toBe(1);
  });

  it("treats pre-created zero-stock snapshot rows as 'no stock' (Scott 2026-05-08 fix)", async () => {
    // The inventory sheet pre-creates onHand=0 rows for upcoming SKUs.
    // Pre-2026-05-08 logic treated ANY snapshot row as "established"
    // and the SKU never surfaced as a launch. New rule: only non-zero
    // current stock blocks the launch.
    const rawId = await seedRawPull();
    await db.insert(skus).values([
      { sku: "ev-newprod-5x-l", productName: "Brand New Product", productLine: "Core", firstSeenAt: "2026-05-06", active: true },
    ]);
    await db.insert(stockSnapshots).values([
      { sku: "ev-newprod-5x-l", location: "CN", snapshotDate: "2026-05-01", onHand: 0, sourcePullId: rawId },
    ]);
    await db.insert(incomingShipments).values([
      { sku: "ev-newprod-5x-l", shipmentName: "KAI New 1", destination: "CN", expectedArrival: "2026-06-01", quantity: 500, status: "po", sourcePullId: rawId, sourceRowRef: "row-1" },
    ]);

    const result = await runLaunchAutoPopulate();
    expect(result.inserted).toBe(1);
  });

  it("doesn't duplicate when an existing launch row already exists for the same (product, shipment)", async () => {
    const rawId = await seedRawPull();
    await db.insert(skus).values([
      { sku: "ev-newprod-5x-l", productName: "Brand New Product", productLine: "Core", firstSeenAt: "2026-05-06", active: true },
    ]);
    await db.insert(incomingShipments).values([
      { sku: "ev-newprod-5x-l", shipmentName: "KAI New 1", destination: "CN", expectedArrival: "2026-06-01", quantity: 500, status: "po", sourcePullId: rawId, sourceRowRef: "row-1" },
    ]);
    // Pre-existing manual launch
    await db.insert(productLaunches).values({
      productName: "Brand New Product",
      shipmentName: "KAI New 1",
      intlLaunchDate: "2026-07-01",
    });

    const result = await runLaunchAutoPopulate();
    expect(result.inserted).toBe(0);
    expect(result.skippedAlreadyLaunched).toBe(1);

    const launches = await db.select().from(productLaunches);
    expect(launches).toHaveLength(1);
    expect(launches[0].intlLaunchDate).toBe("2026-07-01");
  });

  it("inserts default-named SKUs (productName === sku) with the SKU as placeholder name (Scott 2026-05-07)", async () => {
    const rawId = await seedRawPull();
    await db.insert(skus).values([
      { sku: "ev-mystery-5x-l", productName: "ev-mystery-5x-l", productLine: "Core", firstSeenAt: "2026-05-06", active: true },
    ]);
    await db.insert(incomingShipments).values([
      { sku: "ev-mystery-5x-l", shipmentName: "KAI Mystery", destination: "CN", expectedArrival: "2026-06-01", quantity: 100, status: "po", sourcePullId: rawId, sourceRowRef: "row-1" },
    ]);

    const result = await runLaunchAutoPopulate();
    expect(result.inserted).toBe(1);

    const launches = await db.select().from(productLaunches);
    expect(launches).toHaveLength(1);
    expect(launches[0].productName).toBe("ev-mystery-5x-l");
    expect(launches[0].shipmentName).toBe("KAI Mystery");
  });

  it("creates one launch per (product, shipment) pair when many SKUs of the new product land in the same PO", async () => {
    const rawId = await seedRawPull();
    await db.insert(skus).values([
      { sku: "ev-newprod-5x-s", productName: "Brand New Product", productLine: "Core", firstSeenAt: "2026-05-06", active: true },
      { sku: "ev-newprod-5x-m", productName: "Brand New Product", productLine: "Core", firstSeenAt: "2026-05-06", active: true },
      { sku: "ev-newprod-5x-l", productName: "Brand New Product", productLine: "Core", firstSeenAt: "2026-05-06", active: true },
      { sku: "ev-newprod-5x-xl", productName: "Brand New Product", productLine: "Core", firstSeenAt: "2026-05-06", active: true },
    ]);
    await db.insert(incomingShipments).values(
      ["ev-newprod-5x-s", "ev-newprod-5x-m", "ev-newprod-5x-l", "ev-newprod-5x-xl"].map((sku) => ({
        sku,
        shipmentName: "KAI New 1",
        destination: "CN" as const,
        expectedArrival: "2026-06-01",
        quantity: 200,
        status: "po" as const,
        sourcePullId: rawId, sourceRowRef: "row-1",
      })),
    );

    const result = await runLaunchAutoPopulate();
    expect(result.inserted).toBe(1);

    const launches = await db.select().from(productLaunches);
    expect(launches).toHaveLength(1);
  });

  // Scott 2026-05-08: a new colorway of an established product (e.g.
  // Shapewear Black where Shapewear is an existing product) surfaces
  // under its colorway-suffixed name.
  it("surfaces a new colorway of an advertised product as 'ParentName Color' launch", async () => {
    const rawId = await seedRawPull();
    await db.insert(skus).values([
      { sku: "ev-sw-5x-l", productName: "Shapewear", productLine: "Core", firstSeenAt: "2026-04-01", active: true },
      { sku: "ev-sw-black-5x-l", productName: "Shapewear", productLine: "Core", firstSeenAt: "2026-05-07", active: true },
    ]);
    // Established Shapewear has stock + sales at CN. New black colorway has neither.
    await db.insert(stockSnapshots).values([
      { sku: "ev-sw-5x-l", location: "CN", snapshotDate: "2026-04-15", onHand: 200, sourcePullId: rawId },
    ]);
    await db.insert(dailySales).values([
      { channel: "shopify_intl", sku: "ev-sw-5x-l", salesDate: ymdDaysAgo(5), unitsSold: 30, netSalesUsd: "600.00", sourcePullId: rawId },
    ]);
    await db.insert(incomingShipments).values([
      { sku: "ev-sw-5x-l", shipmentName: "KAI Apr26", destination: "CN", expectedArrival: "2026-06-01", quantity: 1000, status: "po", sourcePullId: rawId, sourceRowRef: "row-1" },
      { sku: "ev-sw-black-5x-l", shipmentName: "KAI Apr26", destination: "CN", expectedArrival: "2026-06-01", quantity: 500, status: "po", sourcePullId: rawId, sourceRowRef: "row-2" },
    ]);

    const result = await runLaunchAutoPopulate();
    expect(result.inserted).toBe(1);
    expect(result.skippedHasStock).toBe(1); // ev-sw-5x-l blocked by stock at CN

    const launches = await db.select().from(productLaunches);
    expect(launches).toHaveLength(1);
    expect(launches[0].productName).toBe("Shapewear Black");
    expect(launches[0].shipmentName).toBe("KAI Apr26");
  });

  it("composes 'Multi Color' suffix for fc-tagged new colorways (Super HW Multi Color)", async () => {
    const rawId = await seedRawPull();
    await db.insert(skus).values([
      { sku: "ev-suphw-fc-5x-l", productName: "Super High-Waist", productLine: "Core", firstSeenAt: "2026-05-07", active: true },
    ]);
    await db.insert(incomingShipments).values([
      { sku: "ev-suphw-fc-5x-l", shipmentName: "KAI Jan26", destination: "CN", expectedArrival: "2026-06-01", quantity: 500, status: "po", sourcePullId: rawId, sourceRowRef: "row-1" },
    ]);

    const result = await runLaunchAutoPopulate();
    expect(result.inserted).toBe(1);

    const launches = await db.select().from(productLaunches);
    expect(launches[0].productName).toBe("Super High-Waist Multi Color");
  });

  // Scott 2026-05-08: alt-color SKUs of OG / HW / 9055 are NOT launches
  // even if they're brand-new SKUs in incoming. The parent products are
  // old and these colorways aren't independently advertised.
  it("does NOT create a launch for alt-color SKUs of OG / HW / 9055 (FAMILY_ALIAS rewrites)", async () => {
    const rawId = await seedRawPull();
    await db.insert(skus).values([
      { sku: "ev-pp-hw-l", productName: "HW", productLine: "Core", firstSeenAt: "2026-05-07", active: true },
      { sku: "ev-pp-og-l", productName: "OG", productLine: "Core", firstSeenAt: "2026-05-07", active: true },
      { sku: "ev-bp-9055-5x-l", productName: "Style 9055", productLine: "Core", firstSeenAt: "2026-05-07", active: true },
    ]);
    await db.insert(incomingShipments).values([
      { sku: "ev-pp-hw-l", shipmentName: "KAI 26", destination: "CN", expectedArrival: "2026-06-01", quantity: 100, status: "po", sourcePullId: rawId, sourceRowRef: "row-1" },
      { sku: "ev-pp-og-l", shipmentName: "KAI 26", destination: "CN", expectedArrival: "2026-06-01", quantity: 100, status: "po", sourcePullId: rawId, sourceRowRef: "row-2" },
      { sku: "ev-bp-9055-5x-l", shipmentName: "KAI 26", destination: "CN", expectedArrival: "2026-06-01", quantity: 100, status: "po", sourcePullId: rawId, sourceRowRef: "row-3" },
    ]);

    const result = await runLaunchAutoPopulate();
    expect(result.inserted).toBe(0);
    expect(result.skippedAltColor).toBe(3);

    const launches = await db.select().from(productLaunches);
    expect(launches).toHaveLength(0);
  });

  it("does NOT create a launch for color-token SKUs in og / hw / 9055 families (e.g. ev-og-5x-beige-l)", async () => {
    const rawId = await seedRawPull();
    await db.insert(skus).values([
      { sku: "ev-og-1x-beige-l", productName: "OG", productLine: "Core", firstSeenAt: "2026-05-07", active: true },
      { sku: "ev-9055-black-5x-l", productName: "Style 9055", productLine: "Core", firstSeenAt: "2026-05-07", active: true },
    ]);
    await db.insert(incomingShipments).values([
      { sku: "ev-og-1x-beige-l", shipmentName: "KAI 26", destination: "CN", expectedArrival: "2026-06-01", quantity: 100, status: "po", sourcePullId: rawId, sourceRowRef: "row-1" },
      { sku: "ev-9055-black-5x-l", shipmentName: "KAI 26", destination: "CN", expectedArrival: "2026-06-01", quantity: 100, status: "po", sourcePullId: rawId, sourceRowRef: "row-2" },
    ]);

    const result = await runLaunchAutoPopulate();
    expect(result.skippedAltColor).toBe(2);
  });

  // Scott 2026-05-08: stale-placeholder cleanup, plus blocklist
  // cleanup for HW / OG / Style 9055 auto-added launches.
  it("cleanupStaleDefaultLaunches drops ev-* placeholders whose SKU now has a friendly name", async () => {
    await db.insert(skus).values([
      { sku: "ev-hrshort-5x-l", productName: "High Rise Short", productLine: "Core", firstSeenAt: "2026-05-07", active: true },
      { sku: "ev-newfam-5x-l", productName: "ev-newfam-5x-l", productLine: "Core", firstSeenAt: "2026-05-07", active: true },
    ]);
    await db.insert(productLaunches).values([
      { productName: "ev-hrshort-5x-l", shipmentName: "KAI Sec Mar26", note: "Auto-added: new variant detected in incoming shipment" },
      { productName: "ev-newfam-5x-l", shipmentName: "KAI Mar26", note: "Auto-added: new variant detected in incoming shipment" },
      { productName: "Boyshort", shipmentName: "KAI Apr26", note: "Auto-added: new variant detected in incoming shipment" },
    ]);

    const deleted = await cleanupStaleDefaultLaunches();
    expect(deleted).toBe(1);

    const remaining = await db.select().from(productLaunches);
    expect(remaining).toHaveLength(2);
    const names = remaining.map((r) => r.productName).sort();
    expect(names).toEqual(["Boyshort", "ev-newfam-5x-l"]);
  });

  it("cleanupStaleDefaultLaunches drops auto-added HW / OG / Style 9055 launches (alt-color blocklist)", async () => {
    await db.insert(productLaunches).values([
      { productName: "HW", shipmentName: "KAI 24", note: "Auto-added: new variant detected in incoming shipment" },
      { productName: "OG", shipmentName: "KAI 26", note: "Auto-added: new variant detected in incoming shipment" },
      { productName: "Style 9055", shipmentName: "KAI 24", note: "Auto-added: new variant detected in incoming shipment" },
      // Manually-added launch under one of the blocklist names: preserved.
      { productName: "HW", shipmentName: "KAI 27", note: "Manually added by Scott" },
      // Other launches: preserved.
      { productName: "Boyshort", shipmentName: "KAI Apr26", note: "Auto-added: new variant detected in incoming shipment" },
    ]);

    const deleted = await cleanupStaleDefaultLaunches();
    expect(deleted).toBe(3);

    const remaining = await db.select().from(productLaunches);
    expect(remaining).toHaveLength(2);
    const names = remaining.map((r) => `${r.productName}|${r.shipmentName}`).sort();
    expect(names).toEqual(["Boyshort|KAI Apr26", "HW|KAI 27"]);
  });

  it("cleanupStaleDefaultLaunches is idempotent (running twice deletes nothing the second time)", async () => {
    await db.insert(skus).values([
      { sku: "ev-hrshort-5x-l", productName: "High Rise Short", productLine: "Core", firstSeenAt: "2026-05-07", active: true },
    ]);
    await db.insert(productLaunches).values([
      { productName: "ev-hrshort-5x-l", shipmentName: "KAI Sec Mar26", note: "Auto-added: new variant detected in incoming shipment" },
      { productName: "HW", shipmentName: "KAI 24", note: "Auto-added: new variant detected in incoming shipment" },
    ]);

    expect(await cleanupStaleDefaultLaunches()).toBe(2);
    expect(await cleanupStaleDefaultLaunches()).toBe(0);
  });

  it("runLaunchAutoPopulate runs cleanup at start (combined: stale removed + properly-named inserted)", async () => {
    const rawId = await seedRawPull();
    await db.insert(skus).values([
      { sku: "ev-hrshort-5x-l", productName: "High Rise Short", productLine: "Core", firstSeenAt: "2026-05-07", active: true },
    ]);
    await db.insert(productLaunches).values([
      { productName: "ev-hrshort-5x-l", shipmentName: "KAI Sec Mar26", note: "Auto-added: stale placeholder" },
    ]);
    await db.insert(incomingShipments).values([
      { sku: "ev-hrshort-5x-l", shipmentName: "KAI Sec Mar26", destination: "CN", expectedArrival: "2026-06-10", quantity: 200, status: "po", sourcePullId: rawId, sourceRowRef: "row-1" },
    ]);

    const result = await runLaunchAutoPopulate();
    expect(result.staleDeleted).toBe(1);
    expect(result.inserted).toBe(1);

    const launches = await db.select().from(productLaunches);
    expect(launches).toHaveLength(1);
    expect(launches[0].productName).toBe("High Rise Short");
  });

  // Scott 2026-05-08: "Why is each product in there multiple times?"
  // A product launches once. Multiple incoming shipments of the same
  // product collapse to one row at the earliest expected_arrival.
  it("inserts ONE launch row per product even when multiple shipments are pending (earliest ETA wins)", async () => {
    const rawId = await seedRawPull();
    await db.insert(skus).values([
      { sku: "ev-sw-black-5x-l", productName: "Shapewear", productLine: "Core", firstSeenAt: "2026-05-07", active: true },
    ]);
    await db.insert(incomingShipments).values([
      { sku: "ev-sw-black-5x-l", shipmentName: "KAI Sec Apr26", destination: "CN", expectedArrival: "2026-08-15", quantity: 200, status: "po", sourcePullId: rawId, sourceRowRef: "row-3" },
      { sku: "ev-sw-black-5x-l", shipmentName: "KAI Sec Feb26", destination: "CN", expectedArrival: "2026-06-15", quantity: 200, status: "po", sourcePullId: rawId, sourceRowRef: "row-1" },
      { sku: "ev-sw-black-5x-l", shipmentName: "KAI Sec Mar26", destination: "CN", expectedArrival: "2026-07-15", quantity: 200, status: "po", sourcePullId: rawId, sourceRowRef: "row-2" },
    ]);

    const result = await runLaunchAutoPopulate();
    expect(result.inserted).toBe(1);

    const launches = await db.select().from(productLaunches);
    expect(launches).toHaveLength(1);
    expect(launches[0].productName).toBe("Shapewear Black");
    expect(launches[0].shipmentName).toBe("KAI Sec Feb26");
  });

  // Scott 2026-05-08: self-heal pre-existing duplicate auto-added rows
  // for the same product down to one row at the earliest ETA. Manual
  // launches with non-default note are preserved.
  it("collapseMultiShipmentAutoLaunches drops duplicate auto-added rows of the same product (earliest ETA wins)", async () => {
    const rawId = await seedRawPull();
    await db.insert(incomingShipments).values([
      { sku: "ev-sw-black-5x-l", shipmentName: "KAI Sec Feb26", destination: "CN", expectedArrival: "2026-06-15", quantity: 200, status: "po", sourcePullId: rawId, sourceRowRef: "row-1" },
      { sku: "ev-sw-black-5x-l", shipmentName: "KAI Sec Mar26", destination: "CN", expectedArrival: "2026-07-15", quantity: 200, status: "po", sourcePullId: rawId, sourceRowRef: "row-2" },
      { sku: "ev-sw-black-5x-l", shipmentName: "KAI Sec Apr26", destination: "CN", expectedArrival: "2026-08-15", quantity: 200, status: "po", sourcePullId: rawId, sourceRowRef: "row-3" },
    ]);
    await db.insert(productLaunches).values([
      { productName: "Shapewear Black", shipmentName: "KAI Sec Apr26", note: "Auto-added: new variant detected in incoming shipment" },
      { productName: "Shapewear Black", shipmentName: "KAI Sec Feb26", note: "Auto-added: new variant detected in incoming shipment" },
      { productName: "Shapewear Black", shipmentName: "KAI Sec Mar26", note: "Auto-added: new variant detected in incoming shipment" },
      // Manual launch with non-default note — must be preserved.
      { productName: "Manual Launch X", shipmentName: "KAI Other", note: "manually added" },
    ]);

    const deleted = await collapseMultiShipmentAutoLaunches();
    expect(deleted).toBe(2);

    const launches = await db.select().from(productLaunches);
    expect(launches).toHaveLength(2);
    const black = launches.find((l) => l.productName === "Shapewear Black");
    expect(black?.shipmentName).toBe("KAI Sec Feb26");
    const manual = launches.find((l) => l.productName === "Manual Launch X");
    expect(manual?.shipmentName).toBe("KAI Other");

    // Idempotent: second run is a no-op.
    expect(await collapseMultiShipmentAutoLaunches()).toBe(0);
  });
});
