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

  it("parser-derived names win for known families (color-consolidated rollup)", async () => {
    // Scott 2026-05-06: parser is canonical because it strips color so
    // colorways merge under one product. Sheet labels for known families
    // (which may include colors) are overridden by the parser.
    await seedDefaultNames([{ sku: "ev-9055-5x-l" }, { sku: "ev-og-1x-beige-m" }]);
    const result = await syncProductNames({
      mappingProvider: async () =>
        new Map<string, string>([
          ["ev-9055-5x-l", "Style 9055"],
          ["ev-og-1x-beige-m", "OG Beige 1-Pack"], // sheet has color; parser drops it
        ]),
    });
    expect(result.fromPattern).toBe(2);
    expect(result.fromSheet).toBe(0);
    const out = await db.select().from(skus);
    expect(out.find((r) => r.sku === "ev-9055-5x-l")?.productName).toBe("Style 9055");
    expect(out.find((r) => r.sku === "ev-og-1x-beige-m")?.productName).toBe("OG 1-Pack");
  });

  it("falls back to the SKU pattern parser for SKUs the sheet doesn't cover", async () => {
    await seedDefaultNames([{ sku: "ev-bshort-beige-HF-5x-xxl" }, { sku: "ev-hw-1x-black-3xl" }]);
    const result = await syncProductNames({
      mappingProvider: async () => new Map<string, string>(), // empty — every SKU goes through parser
    });
    expect(result.fromPattern).toBe(2);
    expect(result.fromSheet).toBe(0);
    const out = await db.select().from(skus);
    // Color-consolidated rollup names per Scott 2026-05-06: color is
    // dropped from productName so colorways merge into one product.
    expect(out.find((r) => r.sku === "ev-bshort-beige-HF-5x-xxl")?.productName).toBe(
      "Boyshort HF"
    );
    expect(out.find((r) => r.sku === "ev-hw-1x-black-3xl")?.productName).toBe(
      "HW 1-Pack"
    );
  });

  it("pattern parser overwrites stale productName for known families", async () => {
    // Under the parser-canonical model the parser-derived name wins,
    // so a stale color-specific label like "Boyshort Beige" gets
    // normalized to "Boyshort" on the next sync.
    await seedDefaultNames([
      { sku: "ev-bshort-beige-5x-l", productName: "Boyshort Beige" },
    ]);
    const result = await syncProductNames({
      mappingProvider: async () => new Map<string, string>(),
    });
    expect(result.fromPattern).toBe(1);
    const out = await db.select().from(skus);
    expect(out.find((r) => r.sku === "ev-bshort-beige-5x-l")?.productName).toBe("Boyshort");
  });

  it("sheet mapping is the authority for unknown families", async () => {
    // Parser returns null for unrecognized families; sheet fills the gap.
    await seedDefaultNames([{ sku: "ev-customfamily-5x-l" }]);
    const result = await syncProductNames({
      mappingProvider: async () =>
        new Map([["ev-customfamily-5x-l", "Custom Brand Item"]]),
    });
    expect(result.fromSheet).toBe(1);
    const out = await db.select().from(skus);
    expect(out.find((r) => r.sku === "ev-customfamily-5x-l")?.productName).toBe(
      "Custom Brand Item",
    );
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
