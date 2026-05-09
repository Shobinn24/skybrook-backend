import { describe, it, expect } from "vitest";
import { deriveProductName, snapshotKnownFamilies } from "@/lib/domain/sku-naming";
import type { FamilyOverrideMap } from "@/lib/domain/sku-naming-overrides";

describe("deriveProductName — color-consolidated rollup names", () => {
  // Scott 2026-05-06: combine color variants under one product. Color
  // and FC tokens are parsed but dropped at the productName level so
  // /inventory rolls up correctly. SKU codes remain visible in the
  // expanded view for variant disambiguation.

  it("returns 'Style 9055' for the canonical 5-pack family (any color)", () => {
    expect(deriveProductName("ev-9055-5x-l")).toBe("Style 9055");
    expect(deriveProductName("ev-9055-5x-xxl")).toBe("Style 9055");
    expect(deriveProductName("ev-9055-beige-5x-l")).toBe("Style 9055");
    expect(deriveProductName("ev-9055-black-5x-m")).toBe("Style 9055");
  });

  it("appends pack label for non-default 9055 packs", () => {
    expect(deriveProductName("ev-9055-10x-l")).toBe("Style 9055 10-Pack");
    expect(deriveProductName("ev-9055-15x-m")).toBe("Style 9055 15-Pack");
  });

  it("collapses bshort colors and FC under one 'Boyshort' product", () => {
    expect(deriveProductName("ev-bshort-5x-m")).toBe("Boyshort");
    expect(deriveProductName("ev-bshort-l")).toBe("Boyshort");
    expect(deriveProductName("ev-bshort-beige-5x-m")).toBe("Boyshort");
    expect(deriveProductName("ev-bshort-fc-5x-l")).toBe("Boyshort");
  });

  it("keeps Boyshort HF separate from regular Boyshort", () => {
    expect(deriveProductName("ev-bshort-HF-5x-l")).toBe("Boyshort HF");
    expect(deriveProductName("ev-bshort-beige-HF-5x-l")).toBe("Boyshort HF");
    expect(deriveProductName("ev-bshort-fc-HF-5x-l")).toBe("Boyshort HF");
  });

  it("collapses og 5-pack colors under 'OG 5-Pack' (multi-pack family keeps pack label)", () => {
    expect(deriveProductName("ev-og-5x-beige-l")).toBe("OG 5-Pack");
    expect(deriveProductName("ev-og-5x-black-3xl")).toBe("OG 5-Pack");
    expect(deriveProductName("ev-og-5x-l")).toBe("OG 5-Pack");
  });

  it("keeps og 1-pack distinct from og 5-pack", () => {
    expect(deriveProductName("ev-og-1x-beige-l")).toBe("OG 1-Pack");
    expect(deriveProductName("ev-og-1x-black-3xl")).toBe("OG 1-Pack");
    expect(deriveProductName("ev-og-10x-beige-l")).toBe("OG 10-Pack");
  });

  it("collapses hw colors per pack tier", () => {
    expect(deriveProductName("ev-hw-1x-beige-m")).toBe("HW 1-Pack");
    expect(deriveProductName("ev-hw-1x-black-l")).toBe("HW 1-Pack");
    expect(deriveProductName("ev-hw-15x-black-m")).toBe("HW 15-Pack");
  });

  it("collapses Shapewear colors and HF stays separate", () => {
    expect(deriveProductName("ev-sw-5x-l")).toBe("Shapewear");
    expect(deriveProductName("ev-sw-black-5x-m")).toBe("Shapewear");
    expect(deriveProductName("ev-sw-beige-5x-xl")).toBe("Shapewear");
  });

  it("collapses Super High-Waist regular + FC + colors per pack tier", () => {
    expect(deriveProductName("ev-suphw-fc-l")).toBe("Super High-Waist");
    expect(deriveProductName("ev-suphw-beige-5x-m")).toBe("Super High-Waist 5-Pack");
    expect(deriveProductName("ev-suphw-black-5x-xl")).toBe("Super High-Waist 5-Pack");
  });

  it("keeps mens packs distinct (3/6/9-pack)", () => {
    expect(deriveProductName("ev-mens-3x-l")).toBe("Mens 3-Pack");
    expect(deriveProductName("ev-mens-6x-l")).toBe("Mens 6-Pack");
    expect(deriveProductName("ev-mens-9x-m")).toBe("Mens 9-Pack");
  });

  it("keeps cb packs distinct", () => {
    expect(deriveProductName("ev-cb-3x-s")).toBe("CB 3-Pack");
    expect(deriveProductName("ev-cb-6x-l")).toBe("CB 6-Pack");
    expect(deriveProductName("ev-cb-12x-xl")).toBe("CB 12-Pack");
  });

  it("handles new families: hipster / bikini / french with HF separation", () => {
    expect(deriveProductName("ev-hip-5x-l")).toBe("Hipster");
    expect(deriveProductName("ev-hip-hf-5x-l")).toBe("Hipster HF");
    expect(deriveProductName("ev-bik-5x-l")).toBe("Bikini");
    expect(deriveProductName("ev-bik-hf-5x-l")).toBe("Bikini HF");
    expect(deriveProductName("ev-french-5x-l")).toBe("French");
    expect(deriveProductName("ev-french-hf-5x-l")).toBe("French HF");
  });

  it("aliases new-* and bp-* into the parent product (Scott 2026-05-06)", () => {
    // new-og + new-9055 = newer colorways of OG / Style 9055
    expect(deriveProductName("ev-new-og-5x-l")).toBe("OG 5-Pack");
    expect(deriveProductName("ev-new-9055-5x-l")).toBe("Style 9055");
    // bp-9055 = Beige Pink colorway of 9055
    expect(deriveProductName("ev-bp-9055-5x-l")).toBe("Style 9055");
  });

  it("Seamless families: sl-bik and sl-hw are 2 separate products", () => {
    expect(deriveProductName("ev-sl-bik-pink-5x-l")).toBe("Seamless Bikini");
    expect(deriveProductName("ev-sl-bik-beige-5x-l")).toBe("Seamless Bikini");
    expect(deriveProductName("ev-sl-hw-pink-5x-l")).toBe("Seamless High Waisted");
    expect(deriveProductName("ev-sl-hw-beige-5x-l")).toBe("Seamless High Waisted");
  });

  it("handles jac (Jacquard) and mlb single-segment families", () => {
    expect(deriveProductName("ev-jac-5x-beige-l")).toBe("Jacquard");
    expect(deriveProductName("ev-jac-5x-lilac-l")).toBe("Jacquard");
    expect(deriveProductName("ev-mlb-3x-l")).toBe("MLB 3-Pack");
  });

  it("returns null for unknown families so the caller can fall back", () => {
    expect(deriveProductName("ev-unknown-5x-l")).toBeNull();
    expect(deriveProductName("not-a-sku")).toBeNull();
    expect(deriveProductName("")).toBeNull();
  });

  it("is case-insensitive on input", () => {
    expect(deriveProductName("EV-9055-5X-L")).toBe("Style 9055");
    expect(deriveProductName("Ev-Bshort-Beige-Hf-5x-L")).toBe("Boyshort HF");
  });

  it("maps ev-mixed-{size} (no-color default OG 5-pack) to 'OG 5-Pack'", () => {
    expect(deriveProductName("ev-mixed-xl")).toBe("OG 5-Pack");
    expect(deriveProductName("ev-mixed-xxs")).toBe("OG 5-Pack");
    expect(deriveProductName("ev-mixed-3xl")).toBe("OG 5-Pack");
    expect(deriveProductName("EV-mixed-l")).toBe("OG 5-Pack");
  });

  // Scott 2026-05-07: hrshort = High Rise Short (new family)
  it("maps ev-hrshort-5x-{size} to 'High Rise Short' (5-pack implicit)", () => {
    expect(deriveProductName("ev-hrshort-5x-l")).toBe("High Rise Short");
    expect(deriveProductName("ev-hrshort-5x-xxl")).toBe("High Rise Short");
    expect(deriveProductName("ev-hrshort-5x-xs")).toBe("High Rise Short");
    expect(deriveProductName("EV-hrshort-5x-3xl")).toBe("High Rise Short");
  });

  // Scott 2026-05-07: pp-hw / pp-og are colorway variants of HW / OG.
  // No pack token in the SKU, so output has no pack label — matches
  // existing FAMILY_ALIAS behavior for new-og / new-9055.
  it("collapses pp-hw under 'HW' via FAMILY_ALIAS", () => {
    expect(deriveProductName("ev-pp-hw-l")).toBe("HW");
    expect(deriveProductName("ev-pp-hw-xl")).toBe("HW");
    expect(deriveProductName("ev-pp-hw-xxl")).toBe("HW");
    expect(deriveProductName("ev-pp-hw-xxs")).toBe("HW");
  });

  it("collapses pp-og under 'OG' via FAMILY_ALIAS", () => {
    expect(deriveProductName("ev-pp-og-l")).toBe("OG");
    expect(deriveProductName("ev-pp-og-xs")).toBe("OG");
    expect(deriveProductName("ev-pp-og-xxl")).toBe("OG");
    expect(deriveProductName("ev-pp-og-xxxl")).toBe("OG");
  });
});

import { deriveLaunchName, isMainColor } from "@/lib/domain/sku-naming";

describe("isMainColor — Scott's main-color filter", () => {
  it("og / hw / 9055 base colorway returns true", () => {
    expect(isMainColor("ev-og-5x-l")).toBe(true);
    expect(isMainColor("ev-og-1x-l")).toBe(true);
    expect(isMainColor("ev-hw-l")).toBe(true);
    expect(isMainColor("ev-hw-5x-l")).toBe(true);
    expect(isMainColor("ev-9055-5x-l")).toBe(true);
  });

  it("og / hw / 9055 with explicit color token returns false", () => {
    expect(isMainColor("ev-og-5x-beige-l")).toBe(false);
    expect(isMainColor("ev-og-1x-beige-l")).toBe(false);
    expect(isMainColor("ev-hw-pink-l")).toBe(false);
    expect(isMainColor("ev-9055-black-5x-l")).toBe(false);
    expect(isMainColor("ev-9055-lilac-5x-l")).toBe(false);
  });

  it("FAMILY_ALIAS rewrites (new-og, pp-hw, bp-9055, etc.) return false", () => {
    expect(isMainColor("ev-new-og-5x-l")).toBe(false);
    expect(isMainColor("ev-new-9055-5x-l")).toBe(false);
    expect(isMainColor("ev-bp-9055-5x-l")).toBe(false);
    expect(isMainColor("ev-pp-hw-l")).toBe(false);
    expect(isMainColor("ev-pp-og-l")).toBe(false);
  });

  it("Boyshort all colorways count as main", () => {
    expect(isMainColor("ev-bshort-5x-l")).toBe(true);
    expect(isMainColor("ev-bshort-fc-5x-l")).toBe(true);
    expect(isMainColor("ev-bshort-beige-5x-l")).toBe(true);
    expect(isMainColor("ev-bshort-black-hf-5x-l")).toBe(true);
  });

  it("Super HW (suphw) all colorways count as main", () => {
    expect(isMainColor("ev-suphw-5x-l")).toBe(true);
    expect(isMainColor("ev-suphw-pink-5x-l")).toBe(true);
    expect(isMainColor("ev-suphw-beige-5x-l")).toBe(true);
  });

  it("other families (sw, mens, cb, hip, bik, hrshort, etc.) are all main", () => {
    expect(isMainColor("ev-sw-5x-l")).toBe(true);
    expect(isMainColor("ev-mens-3x-l")).toBe(true);
    expect(isMainColor("ev-cb-5x-l")).toBe(true);
    expect(isMainColor("ev-hip-5x-l")).toBe(true);
    expect(isMainColor("ev-bik-5x-l")).toBe(true);
    expect(isMainColor("ev-hrshort-5x-l")).toBe(true);
    expect(isMainColor("ev-sl-bik-5x-l")).toBe(true);
  });

  it("non-parseable / unknown SKUs default to main (defensive)", () => {
    expect(isMainColor("ev-unknown-l")).toBe(true);
    expect(isMainColor("gift-card-1")).toBe(true);
    expect(isMainColor("ev")).toBe(true);
  });

  it("case-insensitive", () => {
    expect(isMainColor("EV-OG-5X-L")).toBe(true);
    expect(isMainColor("EV-OG-5X-BEIGE-L")).toBe(false);
    expect(isMainColor("EV-PP-HW-L")).toBe(false);
  });
});

describe("deriveLaunchName — colorway-suffixed launch labels", () => {
  it("returns baseName unchanged when SKU has no color token", () => {
    expect(deriveLaunchName("ev-bshort-5x-l", "Boyshort")).toBe("Boyshort");
    expect(deriveLaunchName("ev-hrshort-5x-l", "High Rise Short")).toBe("High Rise Short");
    expect(deriveLaunchName("ev-sw-5x-l", "Shapewear")).toBe("Shapewear");
  });

  it("appends colorway label when SKU carries a known color token", () => {
    expect(deriveLaunchName("ev-sw-black-5x-l", "Shapewear")).toBe("Shapewear Black");
    expect(deriveLaunchName("ev-bshort-pink-5x-l", "Boyshort")).toBe("Boyshort Pink");
    expect(deriveLaunchName("ev-suphw-fc-5x-l", "Super High-Waist")).toBe("Super High-Waist Multi Color");
    expect(deriveLaunchName("ev-bshort-beige-5x-l", "Boyshort")).toBe("Boyshort Beige");
    expect(deriveLaunchName("ev-bshort-lilac-5x-l", "Boyshort")).toBe("Boyshort Lilac");
  });

  it("works for HF SKUs (color token before HF)", () => {
    expect(deriveLaunchName("ev-bshort-black-hf-5x-l", "Boyshort")).toBe("Boyshort Black");
  });

  it("returns baseName as-is when baseName is a placeholder (starts with ev-)", () => {
    // Don't decorate placeholder names; the cleanup pass replaces these
    // once a proper label is added to FAMILY_LABELS / FAMILY_ALIAS.
    expect(deriveLaunchName("ev-mystery-5x-l", "ev-mystery-5x-l")).toBe("ev-mystery-5x-l");
    expect(deriveLaunchName("ev-newfam-black-5x-l", "ev-newfam-black-5x-l")).toBe("ev-newfam-black-5x-l");
  });

  it("case-insensitive on the SKU input", () => {
    expect(deriveLaunchName("EV-SW-BLACK-5X-L", "Shapewear")).toBe("Shapewear Black");
  });

  it("uses the first color token encountered (deterministic on weird multi-color SKUs)", () => {
    // Defensive — real SKUs don't carry two color tokens, but if one
    // ever did the function should still return one stable label.
    expect(deriveLaunchName("ev-bshort-black-pink-5x-l", "Boyshort")).toBe("Boyshort Black");
  });
});

describe("deriveProductName — DB-backed overrides (Auto-naming Option B)", () => {
  // Override map is loaded once at the start of syncProductNames and
  // passed through. Each entry can independently set displayLabel,
  // isImplicit5pack, and aliasOf. Without the second arg, behavior is
  // unchanged.

  function ovr(entries: Array<[string, { displayLabel: string; isImplicit5pack: boolean; aliasOf: string | null }]>): FamilyOverrideMap {
    return new Map(entries);
  }

  it("backwards compatible — omitting overrides arg behaves exactly like before", () => {
    expect(deriveProductName("ev-9055-5x-l")).toBe("Style 9055");
    expect(deriveProductName("ev-bshort-fc-HF-5x-l")).toBe("Boyshort HF");
    expect(deriveProductName("ev-cottonhip-5x-l")).toBeNull();
  });

  it("override displayLabel resolves a previously-unmapped family", () => {
    const overrides = ovr([
      ["cottonhip", { displayLabel: "Cotton Hipster", isImplicit5pack: true, aliasOf: null }],
    ]);
    expect(deriveProductName("ev-cottonhip-5x-l", overrides)).toBe("Cotton Hipster");
    expect(deriveProductName("ev-cottonhip-5x-m", overrides)).toBe("Cotton Hipster");
  });

  it("isImplicit5pack=true on override drops the 5-Pack suffix", () => {
    const overrides = ovr([
      ["cottonhip", { displayLabel: "Cotton Hipster", isImplicit5pack: true, aliasOf: null }],
    ]);
    expect(deriveProductName("ev-cottonhip-5x-l", overrides)).toBe("Cotton Hipster");
  });

  it("isImplicit5pack=false on override keeps the 5-Pack suffix", () => {
    const overrides = ovr([
      ["cottonhip", { displayLabel: "Cotton Hipster", isImplicit5pack: false, aliasOf: null }],
    ]);
    expect(deriveProductName("ev-cottonhip-5x-l", overrides)).toBe("Cotton Hipster 5-Pack");
  });

  it("override label wins over an existing FAMILY_LABELS entry", () => {
    // Scott decides to rename OG → Original via the admin UI.
    const overrides = ovr([
      ["og", { displayLabel: "Original", isImplicit5pack: false, aliasOf: null }],
    ]);
    expect(deriveProductName("ev-og-5x-beige-l", overrides)).toBe("Original 5-Pack");
    expect(deriveProductName("ev-og-1x-black-l", overrides)).toBe("Original 1-Pack");
  });

  it("override isImplicit5pack flips an existing family's pack-suffix behavior", () => {
    // Scott decides to drop the 5-Pack suffix on OG.
    const overrides = ovr([
      ["og", { displayLabel: "OG", isImplicit5pack: true, aliasOf: null }],
    ]);
    expect(deriveProductName("ev-og-5x-beige-l", overrides)).toBe("OG");
    // Non-5-pack tiers still keep their pack label.
    expect(deriveProductName("ev-og-1x-black-l", overrides)).toBe("OG 1-Pack");
  });

  it("override aliasOf redirects a two-segment family to another family", () => {
    // Scott discovers a new alt-color prefix "np-og" for OG.
    const overrides = ovr([
      ["np-og", { displayLabel: "np-og", isImplicit5pack: false, aliasOf: "og" }],
    ]);
    expect(deriveProductName("ev-np-og-5x-beige-l", overrides)).toBe("OG 5-Pack");
    expect(deriveProductName("ev-np-og-1x-black-l", overrides)).toBe("OG 1-Pack");
  });

  it("override aliasOf can chain into another override label", () => {
    // Override chain: aliasOf points to another override that supplies
    // the canonical display label.
    const overrides = ovr([
      ["np-cottonhip", { displayLabel: "np-cottonhip", isImplicit5pack: false, aliasOf: "cottonhip" }],
      ["cottonhip", { displayLabel: "Cotton Hipster", isImplicit5pack: true, aliasOf: null }],
    ]);
    expect(deriveProductName("ev-np-cottonhip-5x-l", overrides)).toBe("Cotton Hipster");
  });

  it("constants still apply when no override exists for that family", () => {
    // Adding an override for cottonhip doesn't affect og / bshort.
    const overrides = ovr([
      ["cottonhip", { displayLabel: "Cotton Hipster", isImplicit5pack: true, aliasOf: null }],
    ]);
    expect(deriveProductName("ev-9055-5x-l", overrides)).toBe("Style 9055");
    expect(deriveProductName("ev-og-5x-beige-l", overrides)).toBe("OG 5-Pack");
    expect(deriveProductName("ev-bshort-5x-m", overrides)).toBe("Boyshort");
  });

  it("returns null for unknown family without an override", () => {
    const overrides = ovr([
      ["cottonhip", { displayLabel: "Cotton Hipster", isImplicit5pack: true, aliasOf: null }],
    ]);
    expect(deriveProductName("ev-mystery-5x-l", overrides)).toBeNull();
  });

  it("override on a multi-segment family creates a new multi-family label", () => {
    // Like FAMILY_ALIAS / MULTI_FAMILY_LABELS, override keys can be
    // two-segment family tokens. Treat them the same as the constant
    // path: middleStart=3, label resolved from the override.
    const overrides = ovr([
      ["nx-bik", { displayLabel: "Next-Gen Bikini", isImplicit5pack: true, aliasOf: null }],
    ]);
    expect(deriveProductName("ev-nx-bik-5x-l", overrides)).toBe("Next-Gen Bikini");
    expect(deriveProductName("ev-nx-bik-1x-pink-l", overrides)).toBe("Next-Gen Bikini 1-Pack");
  });
});

describe("snapshotKnownFamilies", () => {
  it("includes FAMILY_LABELS entries with isImplicit5pack derived from membership", () => {
    const snap = snapshotKnownFamilies();
    const og = snap.find((s) => s.family === "og");
    expect(og).toMatchObject({ kind: "label", displayLabel: "OG", isImplicit5pack: false });
    const bshort = snap.find((s) => s.family === "bshort");
    expect(bshort).toMatchObject({ kind: "label", displayLabel: "Boyshort", isImplicit5pack: true });
  });

  it("includes MULTI_FAMILY_LABELS entries", () => {
    const snap = snapshotKnownFamilies();
    expect(snap.find((s) => s.family === "sl-bik")).toMatchObject({
      kind: "label",
      displayLabel: "Seamless Bikini",
      source: "MULTI_FAMILY_LABELS",
    });
  });

  it("includes FAMILY_ALIAS entries with aliasOf populated", () => {
    const snap = snapshotKnownFamilies();
    expect(snap.find((s) => s.family === "pp-og")).toMatchObject({
      kind: "alias",
      aliasOf: "og",
      source: "FAMILY_ALIAS",
    });
  });
});
