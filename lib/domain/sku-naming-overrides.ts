// Runtime overrides for SKU family naming. Backed by the
// sku_family_overrides table; managed via /admin/product-names.
//
// Replaces the manual edit-commit-deploy loop on
// lib/domain/sku-naming.ts when a new family appears in production.
// Each override entry can supply any of three independent knobs:
//   - displayLabel: overrides FAMILY_LABELS[family]
//   - isImplicit5pack: overrides IMPLICIT_5PACK_FAMILIES.has(family)
//   - aliasOf: overrides FAMILY_ALIAS[family]
//
// deriveProductName accepts the loaded Map and consults overrides
// before the hardcoded constants. Without an override, behavior is
// unchanged.

import { db } from "@/lib/db";
import { skuFamilyOverrides } from "@/lib/db/schema";

export type FamilyOverride = {
  displayLabel: string;
  isImplicit5pack: boolean;
  aliasOf: string | null;
};

export type FamilyOverrideMap = Map<string, FamilyOverride>;

export async function loadFamilyOverrides(): Promise<FamilyOverrideMap> {
  const rows = await db.select().from(skuFamilyOverrides);
  const map: FamilyOverrideMap = new Map();
  for (const r of rows) {
    map.set(r.family, {
      displayLabel: r.displayLabel,
      isImplicit5pack: r.isImplicit5pack,
      aliasOf: r.aliasOf,
    });
  }
  return map;
}
