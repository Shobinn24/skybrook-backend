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

  it("accepts the dash-form pack token (Shopify uses both 10x and 10)", () => {
    // Production has rows like `EV-hw-10-l` alongside `ev-9055-10x-l`.
    expect(decomposePackSku("EV-hw-10-l")).toEqual({
      canonicalSku: "ev-hw-5x-l",
      multiplier: 2,
    });
    expect(decomposePackSku("EV-OG-15-xxl")).toEqual({
      canonicalSku: "ev-og-5x-xxl",
      multiplier: 3,
    });
  });

  it("handles HF-in-family pack SKUs (e.g. EV-9055-HF-10-xl)", () => {
    expect(decomposePackSku("EV-9055-HF-10-xl")).toEqual({
      canonicalSku: "ev-9055-hf-5x-xl",
      multiplier: 2,
    });
    expect(decomposePackSku("EV-HW-HF-10-xxl")).toEqual({
      canonicalSku: "ev-hw-hf-5x-xxl",
      multiplier: 2,
    });
  });

  it("renames dash-form 5-pack to x-form without multiplying (cosmetic only)", () => {
    // Shopify emits both `ev-9055-hf-5-xl` and `ev-9055-hf-5x-xl` for
    // the same garment — the dash form must fold into the canonical x form.
    expect(decomposePackSku("ev-9055-hf-5-xl")).toEqual({
      canonicalSku: "ev-9055-hf-5x-xl",
      multiplier: 1,
    });
    expect(decomposePackSku("EV-bshort-hf-5-xxl")).toEqual({
      canonicalSku: "ev-bshort-hf-5x-xxl",
      multiplier: 1,
    });
  });

  it("renames dash-form 1-pack to x-form (cosmetic, multiplier 1)", () => {
    expect(decomposePackSku("ev-hw-hf-1-black-xl")).toEqual({
      canonicalSku: "ev-hw-hf-1x-black-xl",
      multiplier: 1,
    });
  });

  it("returns null for already-canonical x-form SKUs (no work to do)", () => {
    expect(decomposePackSku("ev-9055-hf-5x-xl")).toBeNull();
    expect(decomposePackSku("ev-og-1x-beige-l")).toBeNull();
  });

  it("canonicalizes trailing 2xl to xxl on already-canonical pack tokens", () => {
    // The velocity sheet uses `2xl` for the 9055 line while Shopify uses
    // `xxl`. Without this alias the same physical garment shows as two
    // unrelated SKUs and Skybrook double-orphans it.
    expect(decomposePackSku("ev-9055-5x-2xl")).toEqual({
      canonicalSku: "ev-9055-5x-xxl",
      multiplier: 1,
    });
    expect(decomposePackSku("ev-suphw-fc-5x-2xl")).toEqual({
      canonicalSku: "ev-suphw-fc-5x-xxl",
      multiplier: 1,
    });
  });

  it("canonicalizes 2xl when also decomposing pack token", () => {
    expect(decomposePackSku("ev-9055-10x-2xl")).toEqual({
      canonicalSku: "ev-9055-5x-xxl",
      multiplier: 2,
    });
    expect(decomposePackSku("ev-9055-15-2xl")).toEqual({
      canonicalSku: "ev-9055-5x-xxl",
      multiplier: 3,
    });
  });

  it("does not touch xxl SKUs (already canonical for size)", () => {
    expect(decomposePackSku("ev-9055-5x-xxl")).toBeNull();
    expect(decomposePackSku("ev-9055-10x-xxl")).toEqual({
      canonicalSku: "ev-9055-5x-xxl",
      multiplier: 2,
    });
  });
});
