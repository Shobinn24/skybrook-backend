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

  it("decomposes mens 6-pack to 3-pack with multiplier 2", () => {
    // Scott 2026-04-29: "Men's 6 and 9 pack are multiples of the 3 pack".
    // Mens family tracks inventory at 3-pack base, not 5-pack.
    expect(decomposePackSku("ev-mens-6x-l")).toEqual({
      canonicalSku: "ev-mens-3x-l",
      multiplier: 2,
    });
    expect(decomposePackSku("ev-mens-6-xxl")).toEqual({
      canonicalSku: "ev-mens-3x-xxl",
      multiplier: 2,
    });
  });

  it("decomposes mens 9-pack to 3-pack with multiplier 3", () => {
    expect(decomposePackSku("ev-mens-9x-l")).toEqual({
      canonicalSku: "ev-mens-3x-l",
      multiplier: 3,
    });
    expect(decomposePackSku("EV-MENS-9-3xl")).toEqual({
      canonicalSku: "ev-mens-3x-3xl",
      multiplier: 3,
    });
  });

  it("renames dash-form mens 3-pack to x-form (cosmetic only)", () => {
    expect(decomposePackSku("ev-mens-3-l")).toEqual({
      canonicalSku: "ev-mens-3x-l",
      multiplier: 1,
    });
  });

  it("decomposes cb 6-pack to 3-pack with multiplier 2 and 12-pack with multiplier 4", () => {
    // Scott 2026-04-29: cb 6 and 12-pack SKUs are multiples of the 3-pack.
    expect(decomposePackSku("ev-cb-6x-l")).toEqual({
      canonicalSku: "ev-cb-3x-l",
      multiplier: 2,
    });
    expect(decomposePackSku("ev-cb-12x-xxl")).toEqual({
      canonicalSku: "ev-cb-3x-xxl",
      multiplier: 4,
    });
    expect(decomposePackSku("ev-cb-12-l")).toEqual({
      canonicalSku: "ev-cb-3x-l",
      multiplier: 4,
    });
  });

  it("returns null for already-canonical mens/cb 3-pack SKUs", () => {
    expect(decomposePackSku("ev-mens-3x-l")).toBeNull();
    expect(decomposePackSku("ev-cb-3x-xxl")).toBeNull();
  });

  it("does not apply default 5-pack rules to mens/cb families", () => {
    // Family-specific rules are exclusive — mens has no 5/10/15 rules,
    // so an unexpected `ev-mens-10x-l` (which shouldn't exist) returns
    // null rather than wrongly decomposing to 5-pack base.
    expect(decomposePackSku("ev-mens-10x-l")).toBeNull();
    expect(decomposePackSku("ev-cb-10x-l")).toBeNull();
    expect(decomposePackSku("ev-mens-5x-l")).toBeNull();
  });

  it("does not apply mens/cb 3-pack rules to other families", () => {
    // Other families don't have `3` in their default ruleset, so e.g.
    // `ev-hw-hf-3-l` (which exists in inventory as a dash-form 3-pack)
    // is left alone — its inventory is tracked at 3-pack but it's not
    // in the family-rules map, so no decomposition or rename runs.
    expect(decomposePackSku("ev-hw-hf-3-l")).toBeNull();
    expect(decomposePackSku("ev-hw-hf-6-s")).toBeNull();
  });
});
