// Admin tRPC procedures for /admin/* dashboard pages. Currently scoped
// to SKU family naming overrides (Auto-naming Option B).

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { skuFamilyOverrides, skus } from "@/lib/db/schema";
import { deriveProductName, snapshotKnownFamilies } from "@/lib/domain/sku-naming";
import { loadFamilyOverrides } from "@/lib/domain/sku-naming-overrides";
import { runLaunchAutoPopulate } from "@/lib/jobs/launches";
import { syncProductNames } from "@/lib/jobs/product-names";
import { opsProcedure, router } from "@/lib/trpc/server";

const upsertInput = z.object({
  family: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9-]+$/, "family must be lowercase letters, digits, and hyphens"),
  displayLabel: z.string().min(1).max(120),
  isImplicit5pack: z.boolean(),
  aliasOf: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9-]+$/)
    .nullable(),
});

export const adminRouter = router({
  // Snapshot of the constants in lib/domain/sku-naming.ts — for the
  // "All entries" panel that lets Scott edit existing labels by
  // upserting an override. Returned alongside listOverrides on the
  // page; an override row supersedes the constant.
  listKnownFamilies: opsProcedure.query(() => snapshotKnownFamilies()),

  // DB-backed overrides.
  listOverrides: opsProcedure.query(async () => {
    const rows = await db.select().from(skuFamilyOverrides);
    return rows.map((r) => ({
      family: r.family,
      displayLabel: r.displayLabel,
      isImplicit5pack: r.isImplicit5pack,
      aliasOf: r.aliasOf,
      updatedAt: r.updatedAt.toISOString(),
      updatedBy: r.updatedBy,
    }));
  }),

  // Family tokens from skus.sku that don't currently resolve to a
  // productName via constants OR overrides — i.e. the candidates that
  // need a label entered. Grouped by single-segment family. Sample
  // SKUs help the admin decide what label to assign.
  listUnmappedFamilies: opsProcedure.query(async () => {
    const overrides = await loadFamilyOverrides();
    const all = await db.select({ sku: skus.sku }).from(skus);
    const unresolved = new Map<
      string,
      { family: string; sampleSkus: string[]; skuCount: number }
    >();
    for (const r of all) {
      const lower = r.sku.toLowerCase();
      const parts = lower.split("-");
      if (parts[0] !== "ev" || parts.length < 3) continue;
      // Only count SKUs the parser cannot resolve.
      if (deriveProductName(r.sku, overrides) !== null) continue;
      // Group by single-segment family token. Admin can also enter a
      // two-segment family token directly into the form when needed.
      const family = parts[1];
      const existing = unresolved.get(family);
      if (existing) {
        existing.skuCount++;
        if (existing.sampleSkus.length < 5) existing.sampleSkus.push(r.sku);
      } else {
        unresolved.set(family, {
          family,
          sampleSkus: [r.sku],
          skuCount: 1,
        });
      }
    }
    return [...unresolved.values()].sort((a, b) =>
      a.family.localeCompare(b.family)
    );
  }),

  upsertOverride: opsProcedure.input(upsertInput).mutation(async ({ ctx, input }) => {
    if (!ctx.email) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: "session has no email",
      });
    }
    if (input.aliasOf === input.family) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "aliasOf cannot equal family",
      });
    }
    await db
      .insert(skuFamilyOverrides)
      .values({
        family: input.family,
        displayLabel: input.displayLabel,
        isImplicit5pack: input.isImplicit5pack,
        aliasOf: input.aliasOf,
        updatedBy: ctx.email,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: skuFamilyOverrides.family,
        set: {
          displayLabel: input.displayLabel,
          isImplicit5pack: input.isImplicit5pack,
          aliasOf: input.aliasOf,
          updatedBy: ctx.email,
          updatedAt: new Date(),
        },
      });
    return { ok: true as const };
  }),

  deleteOverride: opsProcedure
    .input(z.object({ family: z.string().min(1).max(64) }))
    .mutation(async ({ input }) => {
      await db
        .delete(skuFamilyOverrides)
        .where(eq(skuFamilyOverrides.family, input.family));
      return { ok: true as const };
    }),

  // Manually run the post-ingest sync pipeline so the admin page can
  // apply overrides immediately instead of waiting for the next cron
  // tick. Two stages, mirrors /api/cron/ingest:
  //   1. syncProductNames — propagates overrides into skus.productName
  //   2. runLaunchAutoPopulate — drops stale ev-* placeholder rows in
  //      product_launches whose underlying SKU now resolves to a
  //      friendly name, and inserts fresh launches with the new label
  // Without (2), /launches keeps showing raw SKU codes after an
  // override is added — which is exactly what bit us on cottonhip
  // and flybrief on 2026-05-09.
  runProductNamesSync: opsProcedure.mutation(async ({ ctx }) => {
    if (!ctx.email) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: "session has no email",
      });
    }
    const productNames = await syncProductNames();
    const launches = await runLaunchAutoPopulate();
    return { productNames, launches };
  }),
});
