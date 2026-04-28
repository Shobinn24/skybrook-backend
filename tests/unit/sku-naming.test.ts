import { describe, it, expect } from "vitest";
import { deriveProductName } from "@/lib/domain/sku-naming";

describe("deriveProductName", () => {
  it("returns 'Style 9055' for the canonical 5-pack family", () => {
    expect(deriveProductName("ev-9055-5x-l")).toBe("Style 9055");
    expect(deriveProductName("ev-9055-5x-xxl")).toBe("Style 9055");
  });

  it("appends pack label for non-default 9055 packs", () => {
    expect(deriveProductName("ev-9055-10x-l")).toBe("Style 9055 10-Pack");
    expect(deriveProductName("ev-9055-15x-m")).toBe("Style 9055 15-Pack");
  });

  it("matches velocity-sheet style names for bshort family", () => {
    // 5-pack is implicit, no pack suffix
    expect(deriveProductName("ev-bshort-5x-m")).toBe("Boyshort");
    expect(deriveProductName("ev-bshort-beige-5x-m")).toBe("Boyshort Beige");
    expect(deriveProductName("ev-bshort-fc-5x-l")).toBe("Boyshort FC");
    expect(deriveProductName("ev-bshort-HF-5x-l")).toBe("Boyshort HF");
    expect(deriveProductName("ev-bshort-beige-HF-5x-l")).toBe("Boyshort Beige HF");
    expect(deriveProductName("ev-bshort-fc-HF-5x-l")).toBe("Boyshort FC HF");
  });

  it("matches velocity-sheet style names for og 1-pack family", () => {
    expect(deriveProductName("ev-og-1x-beige-l")).toBe("OG Beige 1-Pack");
    expect(deriveProductName("ev-og-1x-black-3xl")).toBe("OG Black 1-Pack");
  });

  it("matches velocity-sheet style names for hw 1-pack family", () => {
    expect(deriveProductName("ev-hw-1x-beige-m")).toBe("HW Beige 1-Pack");
    expect(deriveProductName("ev-hw-1x-black-l")).toBe("HW Black 1-Pack");
  });

  it("handles 10/15-pack OG/HW variants gracefully", () => {
    expect(deriveProductName("ev-og-10x-beige-l")).toBe("OG Beige 10-Pack");
    expect(deriveProductName("ev-hw-15x-black-m")).toBe("HW Black 15-Pack");
  });

  it("returns null for unknown families so the caller can fall back", () => {
    expect(deriveProductName("ev-unknown-5x-l")).toBeNull();
    expect(deriveProductName("not-a-sku")).toBeNull();
    expect(deriveProductName("")).toBeNull();
  });

  it("is case-insensitive on input", () => {
    expect(deriveProductName("EV-9055-5X-L")).toBe("Style 9055");
    expect(deriveProductName("Ev-Bshort-Beige-Hf-5x-L")).toBe("Boyshort Beige HF");
  });
});
