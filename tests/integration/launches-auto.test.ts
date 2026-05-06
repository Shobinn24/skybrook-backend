import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import {
  incomingShipments,
  productLaunches,
  rawPulls,
  skus,
  stockSnapshots,
} from "@/lib/db/schema";
import { runLaunchAutoPopulate } from "@/lib/jobs/launches";
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

describe("runLaunchAutoPopulate", () => {
  beforeAll(() => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set in test env");
  });

  beforeEach(async () => {
    await resetDb();
  });

  it("creates a launch row for a brand-new product (no stock history)", async () => {
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

  it("does NOT create a launch for restocks of existing products", async () => {
    const rawId = await seedRawPull();
    await db.insert(skus).values([
      { sku: "ev-bshort-5x-l", productName: "Boyshort", productLine: "Core", firstSeenAt: "2026-04-01", active: true },
    ]);
    // Stock history → product is established, not a launch
    await db.insert(stockSnapshots).values([
      { sku: "ev-bshort-5x-l", location: "US", snapshotDate: "2026-04-15", onHand: 100, sourcePullId: rawId },
    ]);
    await db.insert(incomingShipments).values([
      { sku: "ev-bshort-5x-l", shipmentName: "KAI Bshort May", destination: "CN", expectedArrival: "2026-06-01", quantity: 1000, status: "po", sourcePullId: rawId, sourceRowRef: "row-1" },
    ]);

    const result = await runLaunchAutoPopulate();
    expect(result.inserted).toBe(0);
    expect(result.skippedExisting).toBe(1);

    const launches = await db.select().from(productLaunches);
    expect(launches).toHaveLength(0);
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
    // The manually-set date is preserved
    expect(launches[0].intlLaunchDate).toBe("2026-07-01");
  });

  it("skips SKUs whose productName is the default fallback (starts with ev-)", async () => {
    const rawId = await seedRawPull();
    await db.insert(skus).values([
      { sku: "ev-mystery-5x-l", productName: "ev-mystery-5x-l", productLine: "Core", firstSeenAt: "2026-05-06", active: true },
    ]);
    await db.insert(incomingShipments).values([
      { sku: "ev-mystery-5x-l", shipmentName: "KAI Mystery", destination: "CN", expectedArrival: "2026-06-01", quantity: 100, status: "po", sourcePullId: rawId, sourceRowRef: "row-1" },
    ]);

    const result = await runLaunchAutoPopulate();
    expect(result.inserted).toBe(0);

    const launches = await db.select().from(productLaunches);
    expect(launches).toHaveLength(0);
  });

  it("creates one launch per (product, shipment) pair when many SKUs of the new product land in the same PO", async () => {
    const rawId = await seedRawPull();
    // Single new product spread across 4 sizes, all in the same shipment
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
      }))
    );

    const result = await runLaunchAutoPopulate();
    expect(result.inserted).toBe(1);

    const launches = await db.select().from(productLaunches);
    expect(launches).toHaveLength(1);
  });
});
