import { describe, it, expect } from "vitest";
import { decomposePackSku } from "@/lib/domain/sku-pack";

describe("decomposePackSku", () => {
  it("decomposes 10-pack SKUs to 5-pack with multiplier 2", () => {
    expect(decomposePackSku("ev-9055-10x-l")).toEqual({
      canonicalSku: "ev-9055-5x-l",
      multiplier: 2,
    });
    expect(decomposePackSku("ev-bshort-10x-xxl")).toEqual({
      canonicalSku: "ev-bshort-5x-xxl",
      multiplier: 2,
    });
  });

  it("decomposes 15-pack SKUs to 5-pack with multiplier 3", () => {
    expect(decomposePackSku("ev-9055-15x-l")).toEqual({
      canonicalSku: "ev-9055-5x-l",
      multiplier: 3,
    });
  });

  it("preserves multi-token suffixes (color/HF) when decomposing", () => {
    expect(decomposePackSku("ev-bshort-10x-beige-HF-l")).toEqual({
      canonicalSku: "ev-bshort-5x-beige-hf-l",
      multiplier: 2,
    });
  });

  it("returns null for SKUs that don't have a pack token to decompose", () => {
    expect(decomposePackSku("ev-9055-5x-l")).toBeNull();
    expect(decomposePackSku("ev-og-1x-beige-l")).toBeNull(); // 1-pack is separate inventory
    expect(decomposePackSku("ev-bshort-HF-5x-l")).toBeNull();
  });

  it("returns null for unparseable SKUs", () => {
    expect(decomposePackSku("not-a-sku")).toBeNull();
    expect(decomposePackSku("")).toBeNull();
    expect(decomposePackSku("ev-9055-l")).toBeNull(); // missing pack token
  });

  it("is case-insensitive on input but emits lowercase canonical", () => {
    expect(decomposePackSku("EV-9055-10X-L")).toEqual({
      canonicalSku: "ev-9055-5x-l",
      multiplier: 2,
    });
  });
});
