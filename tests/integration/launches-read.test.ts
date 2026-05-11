import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import {
  incomingShipments,
  productLaunches,
  rawPulls,
  skus,
} from "@/lib/db/schema";
import { getDistinctProductNames, getLaunches } from "@/lib/queries/launches";
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

describe("getLaunches", () => {
  beforeAll(() => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set in test env");
  });

  beforeEach(async () => {
    await resetDb();
  });

  // Scott 2026-05-08: Super HW + Shapewear Black were rendering with no
  // ETAs. Root cause: launch productName carries the colorway suffix
  // ("Shapewear Black", "Super High-Waist 5-Pack Multi Color") but the
  // skus catalog stores the BASE name ("Shapewear", "Super High-Waist").
  // ETA join must bucket SKUs by deriveLaunchName, not by raw productName.
  it("resolves ETA Ant + PD for colorway-suffixed launches by deriving each SKU's launchName", async () => {
    const rawId = await seedRawPull();
    await db.insert(skus).values([
      {
        sku: "ev-sw-black-5x-l",
        productName: "Shapewear",
        productLine: "Core",
        firstSeenAt: "2026-05-07",
        active: true,
      },
    ]);
    await db.insert(incomingShipments).values([
      {
        sku: "ev-sw-black-5x-l",
        shipmentName: "KAI Sec Feb26",
        destination: "CN",
        expectedArrival: "2026-06-15",
        quantity: 200,
        status: "po",
        sourcePullId: rawId,
        sourceRowRef: "row-1",
      },
      {
        sku: "ev-sw-black-5x-l",
        shipmentName: "KAI Sec Feb26",
        destination: "US",
        expectedArrival: "2026-07-01",
        quantity: 200,
        status: "po",
        sourcePullId: rawId,
        sourceRowRef: "row-2",
      },
    ]);
    await db.insert(productLaunches).values([
      {
        productName: "Shapewear Black",
        shipmentName: "KAI Sec Feb26",
        note: "Auto-added: new variant detected in incoming shipment",
      },
    ]);

    const rows = await getLaunches();
    expect(rows).toHaveLength(1);
    expect(rows[0].productName).toBe("Shapewear Black");
    expect(rows[0].etaAnt).toBe("2026-06-15");
    expect(rows[0].etaPd).toBe("2026-07-01");
  });

  it("resolves ETAs for base-name launches (e.g. 'High Rise Short') the same way", async () => {
    const rawId = await seedRawPull();
    await db.insert(skus).values([
      {
        sku: "ev-hrshort-5x-l",
        productName: "High Rise Short",
        productLine: "Core",
        firstSeenAt: "2026-05-07",
        active: true,
      },
    ]);
    await db.insert(incomingShipments).values([
      {
        sku: "ev-hrshort-5x-l",
        shipmentName: "KAI Sec Mar26",
        destination: "CN",
        expectedArrival: "2026-07-15",
        quantity: 100,
        status: "po",
        sourcePullId: rawId,
        sourceRowRef: "row-1",
      },
    ]);
    await db.insert(productLaunches).values([
      {
        productName: "High Rise Short",
        shipmentName: "KAI Sec Mar26",
        note: "Auto-added: new variant detected in incoming shipment",
      },
    ]);

    const rows = await getLaunches();
    expect(rows).toHaveLength(1);
    expect(rows[0].etaAnt).toBe("2026-07-15");
    expect(rows[0].etaPd).toBeNull();
  });
});

describe("getDistinctProductNames", () => {
  beforeAll(() => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set in test env");
  });

  beforeEach(async () => {
    await resetDb();
  });

  // The dropdown feeds productLaunches.productName, which must match the
  // launchName getLaunches buckets SKUs into. Returning raw skus.productName
  // ("Shapewear") caused manual launches to insert under a name no SKU
  // resolves to, producing null ETAs.
  it("returns colorway-derived launchNames, not raw productName values", async () => {
    await db.insert(skus).values([
      {
        sku: "ev-sw-black-5x-l",
        productName: "Shapewear",
        productLine: "Core",
        firstSeenAt: "2026-05-07",
        active: true,
      },
      {
        sku: "ev-sw-beige-5x-l",
        productName: "Shapewear",
        productLine: "Core",
        firstSeenAt: "2026-05-07",
        active: true,
      },
    ]);

    const names = await getDistinctProductNames();
    expect(names).toEqual(["Shapewear Beige", "Shapewear Black"]);
    expect(names).not.toContain("Shapewear");
  });

  it("falls back to base name when a SKU has no colorway token", async () => {
    await db.insert(skus).values([
      {
        sku: "ev-hrshort-5x-l",
        productName: "High Rise Short",
        productLine: "Core",
        firstSeenAt: "2026-05-07",
        active: true,
      },
    ]);

    const names = await getDistinctProductNames();
    expect(names).toEqual(["High Rise Short"]);
  });

  it("dedupes when multiple SKUs derive the same launchName", async () => {
    await db.insert(skus).values([
      {
        sku: "ev-sw-black-5x-s",
        productName: "Shapewear",
        productLine: "Core",
        firstSeenAt: "2026-05-07",
        active: true,
      },
      {
        sku: "ev-sw-black-5x-m",
        productName: "Shapewear",
        productLine: "Core",
        firstSeenAt: "2026-05-07",
        active: true,
      },
      {
        sku: "ev-sw-black-5x-l",
        productName: "Shapewear",
        productLine: "Core",
        firstSeenAt: "2026-05-07",
        active: true,
      },
    ]);

    const names = await getDistinctProductNames();
    expect(names).toEqual(["Shapewear Black"]);
  });

  it("excludes 'ev-' placeholder rows where productName matches the sku", async () => {
    await db.insert(skus).values([
      {
        sku: "ev-newproduct-1x-l",
        productName: "ev-newproduct-1x-l",
        productLine: null,
        firstSeenAt: "2026-05-07",
        active: true,
      },
      {
        sku: "ev-sw-black-5x-l",
        productName: "Shapewear",
        productLine: "Core",
        firstSeenAt: "2026-05-07",
        active: true,
      },
    ]);

    const names = await getDistinctProductNames();
    expect(names).toEqual(["Shapewear Black"]);
    expect(names.some((n) => n.startsWith("ev-"))).toBe(false);
  });
});
