import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { resetDb } from "@/tests/fixtures/seed";
import { db } from "@/lib/db";
import { rawPulls, skus } from "@/lib/db/schema";
import { syncProductNames } from "@/lib/jobs/product-names";
import { randomUUID } from "node:crypto";

async function seedDefaultNames(rows: Array<{ sku: string; productName?: string }>) {
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
  await db.insert(skus).values(
    rows.map((r) => ({
      sku: r.sku,
      // Default productName=SKU mirrors what sheets_inventory ingest writes.
      productName: r.productName ?? r.sku,
      productLine: "Core",
      firstSeenAt: "2026-04-01",
      active: true,
    }))
  );
  return raw.id;
}

describe("syncProductNames", () => {
  beforeAll(() => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set in test env");
  });

  beforeEach(async () => {
    await resetDb();
  });

  it("upserts sheet-supplied names over the default SKU-as-name", async () => {
    await seedDefaultNames([{ sku: "ev-9055-5x-l" }, { sku: "ev-og-1x-beige-m" }]);
    const result = await syncProductNames({
      mappingProvider: async () =>
        new Map<string, string>([
          ["ev-9055-5x-l", "Style 9055"],
          ["ev-og-1x-beige-m", "OG Beige 1-Pack"],
        ]),
    });
    expect(result.fromSheet).toBe(2);
    const out = await db.select().from(skus);
    expect(out.find((r) => r.sku === "ev-9055-5x-l")?.productName).toBe("Style 9055");
    expect(out.find((r) => r.sku === "ev-og-1x-beige-m")?.productName).toBe("OG Beige 1-Pack");
  });

  it("falls back to the SKU pattern parser for SKUs the sheet doesn't cover", async () => {
    await seedDefaultNames([{ sku: "ev-bshort-beige-HF-5x-xxl" }, { sku: "ev-hw-1x-black-3xl" }]);
    const result = await syncProductNames({
      mappingProvider: async () => new Map<string, string>(), // empty — every SKU goes through parser
    });
    expect(result.fromPattern).toBe(2);
    expect(result.fromSheet).toBe(0);
    const out = await db.select().from(skus);
    expect(out.find((r) => r.sku === "ev-bshort-beige-HF-5x-xxl")?.productName).toBe(
      "Boyshort Beige HF"
    );
    expect(out.find((r) => r.sku === "ev-hw-1x-black-3xl")?.productName).toBe(
      "HW Black 1-Pack"
    );
  });

  it("does not overwrite a non-default productName via the pattern parser", async () => {
    // Scott (or a previous sheet sync) already set this — don't clobber.
    await seedDefaultNames([
      { sku: "ev-9055-5x-l", productName: "Custom Override" },
    ]);
    const result = await syncProductNames({
      mappingProvider: async () => new Map<string, string>(),
    });
    expect(result.fromPattern).toBe(0);
    expect(result.unchanged).toBe(1);
    const out = await db.select().from(skus);
    expect(out.find((r) => r.sku === "ev-9055-5x-l")?.productName).toBe("Custom Override");
  });

  it("sheet mapping always wins, even over a non-default productName", async () => {
    // Sheet is canonical — if Scott's sheet says X, prefer X over a stale custom value.
    await seedDefaultNames([{ sku: "ev-9055-5x-l", productName: "Stale Manual Edit" }]);
    const result = await syncProductNames({
      mappingProvider: async () => new Map([["ev-9055-5x-l", "Style 9055"]]),
    });
    expect(result.fromSheet).toBe(1);
    const out = await db.select().from(skus);
    expect(out.find((r) => r.sku === "ev-9055-5x-l")?.productName).toBe("Style 9055");
  });

  it("unmapped + unparseable SKUs are left alone", async () => {
    await seedDefaultNames([{ sku: "ev-unknownfamily-5x-l" }, { sku: "weird-sku-format" }]);
    const result = await syncProductNames({
      mappingProvider: async () => new Map<string, string>(),
    });
    expect(result.fromSheet).toBe(0);
    expect(result.fromPattern).toBe(0);
    expect(result.unchanged).toBe(2);
    const out = await db.select().from(skus);
    // productName stays as the SKU itself
    for (const r of out) expect(r.productName).toBe(r.sku);
  });
});
