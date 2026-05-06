import { describe, it, expect } from "vitest";
import { deriveProductName } from "@/lib/domain/sku-naming";

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
});
