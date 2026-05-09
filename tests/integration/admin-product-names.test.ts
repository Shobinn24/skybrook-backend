import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { TRPCError } from "@trpc/server";
import { randomUUID } from "node:crypto";
import { resetDb } from "@/tests/fixtures/seed";
import { db } from "@/lib/db";
import { rawPulls, skus, skuFamilyOverrides } from "@/lib/db/schema";
import { appRouter } from "@/lib/trpc/routers";
import { syncProductNames } from "@/lib/jobs/product-names";

async function seedSkus(rows: Array<{ sku: string; productName?: string }>) {
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
  if (rows.length > 0) {
    await db.insert(skus).values(
      rows.map((r) => ({
        sku: r.sku,
        productName: r.productName ?? r.sku,
        productLine: "Core",
        firstSeenAt: "2026-04-01",
        active: true,
      }))
    );
  }
  return raw.id;
}

const callerWith = (email: string | null) =>
  appRouter.createCaller({ email });

describe("admin.product-names tRPC procedures", () => {
  beforeAll(() => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set in test env");
  });

  beforeEach(async () => {
    await resetDb();
  });

  it("upsertOverride writes a row attributed to ctx.email", async () => {
    const caller = callerWith("admin@skybrookecommerce.com");
    const r = await caller.admin.upsertOverride({
      family: "cottonhip",
      displayLabel: "Cotton Hipster",
      isImplicit5pack: true,
      aliasOf: null,
    });
    expect(r.ok).toBe(true);
    const rows = await db.select().from(skuFamilyOverrides);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      family: "cottonhip",
      displayLabel: "Cotton Hipster",
      isImplicit5pack: true,
      aliasOf: null,
      updatedBy: "admin@skybrookecommerce.com",
    });
  });

  it("upsertOverride updates an existing row in place (true upsert)", async () => {
    const caller = callerWith("scott@skybrookecommerce.com");
    await caller.admin.upsertOverride({
      family: "cottonhip",
      displayLabel: "Cotton Hipster",
      isImplicit5pack: true,
      aliasOf: null,
    });
    await caller.admin.upsertOverride({
      family: "cottonhip",
      displayLabel: "Cotton Hipster Premium",
      isImplicit5pack: false,
      aliasOf: null,
    });
    const rows = await db.select().from(skuFamilyOverrides);
    expect(rows).toHaveLength(1);
    expect(rows[0].displayLabel).toBe("Cotton Hipster Premium");
    expect(rows[0].isImplicit5pack).toBe(false);
  });

  it("upsertOverride throws UNAUTHORIZED when ctx.email is null", async () => {
    const caller = callerWith(null);
    await expect(
      caller.admin.upsertOverride({
        family: "cottonhip",
        displayLabel: "Cotton Hipster",
        isImplicit5pack: true,
        aliasOf: null,
      })
    ).rejects.toThrow(TRPCError);
  });

  it("upsertOverride rejects aliasOf === family (self-loop)", async () => {
    const caller = callerWith("admin@skybrookecommerce.com");
    await expect(
      caller.admin.upsertOverride({
        family: "og",
        displayLabel: "OG",
        isImplicit5pack: false,
        aliasOf: "og",
      })
    ).rejects.toThrow(TRPCError);
  });

  it("listOverrides returns all rows", async () => {
    const caller = callerWith("admin@skybrookecommerce.com");
    await caller.admin.upsertOverride({
      family: "cottonhip",
      displayLabel: "Cotton Hipster",
      isImplicit5pack: true,
      aliasOf: null,
    });
    await caller.admin.upsertOverride({
      family: "flybrief",
      displayLabel: "Mens Brief with Fly",
      isImplicit5pack: false,
      aliasOf: null,
    });
    const list = await caller.admin.listOverrides();
    expect(list).toHaveLength(2);
    const families = list.map((r) => r.family).sort();
    expect(families).toEqual(["cottonhip", "flybrief"]);
  });

  it("deleteOverride removes the row", async () => {
    const caller = callerWith("admin@skybrookecommerce.com");
    await caller.admin.upsertOverride({
      family: "cottonhip",
      displayLabel: "Cotton Hipster",
      isImplicit5pack: true,
      aliasOf: null,
    });
    await caller.admin.deleteOverride({ family: "cottonhip" });
    const list = await caller.admin.listOverrides();
    expect(list).toHaveLength(0);
  });

  it("listUnmappedFamilies returns unresolved SKU family tokens grouped with sample SKUs", async () => {
    const caller = callerWith("admin@skybrookecommerce.com");
    await seedSkus([
      // Known families — should NOT appear
      { sku: "ev-9055-5x-l" },
      { sku: "ev-bshort-5x-m" },
      { sku: "ev-og-1x-beige-l" },
      // Unknown families — should appear
      { sku: "ev-cottonhip-5x-l" },
      { sku: "ev-cottonhip-5x-m" },
      { sku: "ev-cottonhip-5x-xl" },
      { sku: "ev-flybrief-3x-l" },
      { sku: "ev-flybrief-3x-m" },
    ]);
    const unmapped = await caller.admin.listUnmappedFamilies();
    expect(unmapped.map((u) => u.family).sort()).toEqual(["cottonhip", "flybrief"]);
    const cottonhip = unmapped.find((u) => u.family === "cottonhip")!;
    expect(cottonhip.skuCount).toBe(3);
    expect(cottonhip.sampleSkus.length).toBeGreaterThan(0);
    const flybrief = unmapped.find((u) => u.family === "flybrief")!;
    expect(flybrief.skuCount).toBe(2);
  });

  it("listUnmappedFamilies hides families that have an override", async () => {
    const caller = callerWith("admin@skybrookecommerce.com");
    await seedSkus([
      { sku: "ev-cottonhip-5x-l" },
      { sku: "ev-cottonhip-5x-m" },
    ]);
    const before = await caller.admin.listUnmappedFamilies();
    expect(before.map((u) => u.family)).toContain("cottonhip");

    await caller.admin.upsertOverride({
      family: "cottonhip",
      displayLabel: "Cotton Hipster",
      isImplicit5pack: true,
      aliasOf: null,
    });

    const after = await caller.admin.listUnmappedFamilies();
    expect(after.map((u) => u.family)).not.toContain("cottonhip");
  });

  it("listKnownFamilies returns the snapshot of constants", async () => {
    const caller = callerWith("admin@skybrookecommerce.com");
    const snap = await caller.admin.listKnownFamilies();
    expect(snap.find((s) => s.family === "og")).toMatchObject({
      kind: "label",
      displayLabel: "OG",
    });
    expect(snap.find((s) => s.family === "pp-og")).toMatchObject({
      kind: "alias",
      aliasOf: "og",
    });
  });

  it("runProductNamesSync rejects null email", async () => {
    const caller = callerWith(null);
    await expect(caller.admin.runProductNamesSync()).rejects.toThrow(TRPCError);
  });

  it("runProductNamesSync resolves placeholder names end-to-end (override + sync)", async () => {
    // Reproduces the exact production flow: SKU rows with raw-SKU
    // placeholder names, no override, then admin upserts an override
    // and runs sync — all 3 rows resolve.
    const caller = callerWith("admin@skybrookecommerce.com");
    await seedSkus([
      { sku: "ev-cottonhip-5x-l" },
      { sku: "ev-cottonhip-5x-m" },
      { sku: "ev-cottonhip-5x-xl" },
    ]);
    await caller.admin.upsertOverride({
      family: "cottonhip",
      displayLabel: "Cotton Hipster",
      isImplicit5pack: true,
      aliasOf: null,
    });
    const result = await caller.admin.runProductNamesSync();
    expect(result.fromPattern).toBe(3);
    const rows = await db.select().from(skus);
    for (const r of rows) {
      expect(r.productName).toBe("Cotton Hipster");
    }
  });
});

describe("syncProductNames respects sku_family_overrides", () => {
  beforeAll(() => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set in test env");
  });

  beforeEach(async () => {
    await resetDb();
  });

  it("does not resolve unmapped families when no override exists (placeholder names persist)", async () => {
    await seedSkus([{ sku: "ev-cottonhip-5x-l" }]);
    const result = await syncProductNames({
      mappingProvider: async () => new Map(),
      overridesProvider: async () => new Map(),
    });
    expect(result.fromPattern).toBe(0);
    expect(result.fromSheet).toBe(0);
    expect(result.unchanged).toBe(1);
    const out = await db.select().from(skus);
    // productName remains the SKU placeholder.
    expect(out[0].productName).toBe("ev-cottonhip-5x-l");
  });

  it("resolves an unmapped family once an override is added", async () => {
    await seedSkus([
      { sku: "ev-cottonhip-5x-l" },
      { sku: "ev-cottonhip-5x-m" },
      { sku: "ev-cottonhip-5x-xl" },
    ]);
    const result = await syncProductNames({
      mappingProvider: async () => new Map(),
      overridesProvider: async () =>
        new Map([
          [
            "cottonhip",
            { displayLabel: "Cotton Hipster", isImplicit5pack: true, aliasOf: null },
          ],
        ]),
    });
    expect(result.fromPattern).toBe(3);
    const out = await db.select().from(skus);
    for (const r of out) {
      expect(r.productName).toBe("Cotton Hipster");
    }
  });

  it("override label wins over an existing FAMILY_LABELS entry", async () => {
    // Scott renames OG → Original via the admin UI.
    await seedSkus([{ sku: "ev-og-5x-beige-l" }]);
    const result = await syncProductNames({
      mappingProvider: async () => new Map(),
      overridesProvider: async () =>
        new Map([
          ["og", { displayLabel: "Original", isImplicit5pack: false, aliasOf: null }],
        ]),
    });
    expect(result.fromPattern).toBe(1);
    const out = await db.select().from(skus);
    expect(out[0].productName).toBe("Original 5-Pack");
  });

  it("default (no overrides arg) loads from DB and applies overrides end-to-end", async () => {
    await seedSkus([
      { sku: "ev-flybrief-3x-l" },
      { sku: "ev-flybrief-3x-m" },
    ]);
    // Insert override directly to simulate admin-page write.
    await db.insert(skuFamilyOverrides).values({
      family: "flybrief",
      displayLabel: "Mens Brief with Fly",
      isImplicit5pack: false,
      aliasOf: null,
      updatedBy: "test@skybrookecommerce.com",
    });

    const result = await syncProductNames({
      mappingProvider: async () => new Map(),
      // overridesProvider intentionally omitted — falls through to
      // loadFamilyOverrides() which reads the DB.
    });
    expect(result.fromPattern).toBe(2);
    const out = await db.select().from(skus);
    for (const r of out) {
      expect(r.productName).toBe("Mens Brief with Fly 3-Pack");
    }
  });
});
