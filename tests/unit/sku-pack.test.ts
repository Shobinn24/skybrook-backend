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
    // hw bare-size rows additionally collapse to no-pack form per the
    // HW-specific rule below — `EV-hw-10-l` lands on `ev-hw-l` × 2.
    expect(decomposePackSku("EV-hw-10-l")).toEqual({
      canonicalSku: "ev-hw-l",
      multiplier: 2,
    });
    // No-color OG: 15-pack decomposes to 3× 5-packs, then the bare-size
    // 5-pack rename folds the result onto the canonical OG 5-Pack row
    // `ev-mixed-{size}` (Scott 2026-05-26). 1× 15-pack = 3× ev-mixed-xxl.
    expect(decomposePackSku("EV-OG-15-xxl")).toEqual({
      canonicalSku: "ev-mixed-xxl",
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

  it("canonicalizes UK grey to US gray on pack-token SKUs", () => {
    // Production tabs use `gray`; the (ss) checkpoint mirror uses `grey`.
    // Defensive normalization at decompose so both sheet and Shopify
    // ingest paths land on the same canonical color token.
    expect(decomposePackSku("ev-og-5x-grey-xl")).toEqual({
      canonicalSku: "ev-og-5x-gray-xl",
      multiplier: 1,
    });
    expect(decomposePackSku("ev-og-10x-grey-l")).toEqual({
      canonicalSku: "ev-og-5x-gray-l",
      multiplier: 2,
    });
  });

  it("normalizes grey case-insensitively", () => {
    expect(decomposePackSku("ev-og-5x-Grey-xl")).toEqual({
      canonicalSku: "ev-og-5x-gray-xl",
      multiplier: 1,
    });
  });

  it("does not touch existing gray SKUs", () => {
    expect(decomposePackSku("ev-og-5x-gray-xl")).toBeNull();
  });

  it("does not touch substrings that contain grey but aren't the color token", () => {
    // Imaginary SKU with `greyish` in the rest — must not mangle. The
    // regex requires `grey` to be a full dash-bounded token.
    expect(decomposePackSku("ev-og-5x-greyish-xl")).toBeNull();
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

  it("decomposes hw-hf and og-hf 6/9-pack to 3x base (assumed parallel to mens)", () => {
    // hw-hf and og-hf inventory mirror mens/cb structure: dash-form
    // 3-pack rows in the sheet, plus tiny-volume 6/9-pack sales (3 units
    // total over 30d) that have no inventory match. Volume is too small
    // to wait for explicit confirmation; the structural symmetry with
    // Scott-confirmed mens 6/9 → 3 makes the rule safe.
    expect(decomposePackSku("ev-hw-hf-3-l")).toEqual({
      canonicalSku: "ev-hw-hf-3x-l",
      multiplier: 1,
    });
    expect(decomposePackSku("ev-hw-hf-6-s")).toEqual({
      canonicalSku: "ev-hw-hf-3x-s",
      multiplier: 2,
    });
    expect(decomposePackSku("ev-hw-hf-9-s")).toEqual({
      canonicalSku: "ev-hw-hf-3x-s",
      multiplier: 3,
    });
    expect(decomposePackSku("ev-og-hf-3-l")).toEqual({
      canonicalSku: "ev-og-hf-3x-l",
      multiplier: 1,
    });
  });

  it("preserves hw-hf and og-hf legit 1/5-pack inventory", () => {
    // These families have full default-style inventory (1, 5, 10, 15)
    // PLUS the 3-pack line. Family rules are exclusive, so defaults
    // had to be re-stated.
    expect(decomposePackSku("ev-hw-hf-5-l")).toEqual({
      canonicalSku: "ev-hw-hf-5x-l",
      multiplier: 1,
    });
    expect(decomposePackSku("ev-og-hf-5-xs")).toEqual({
      canonicalSku: "ev-og-hf-5x-xs",
      multiplier: 1,
    });
    expect(decomposePackSku("ev-og-hf-1-black-l")).toEqual({
      canonicalSku: "ev-og-hf-1x-black-l",
      multiplier: 1,
    });
    expect(decomposePackSku("ev-hw-hf-10-l")).toEqual({
      canonicalSku: "ev-hw-hf-5x-l",
      multiplier: 2,
    });
  });

  it("collapses bare-size hw 5-packs to no-pack form", () => {
    // HW inventory uses the bare `ev-hw-{size}` form (no pack token).
    // Shopify partly mirrors but also writes ev-hw-5x-{size} which has
    // no inventory match. Both paths fold to the same canonical SKU.
    expect(decomposePackSku("ev-hw-5x-l")).toEqual({
      canonicalSku: "ev-hw-l",
      multiplier: 1,
    });
    expect(decomposePackSku("ev-hw-5x-xxl")).toEqual({
      canonicalSku: "ev-hw-xxl",
      multiplier: 1,
    });
    expect(decomposePackSku("ev-hw-5-l")).toEqual({
      canonicalSku: "ev-hw-l",
      multiplier: 1,
    });
  });

  it("preserves hw colored 5-packs (keeps the 5x token)", () => {
    // `ev-hw-5x-black-l` is a separate physical product (colored line)
    // — the collapse only applies when rest is a single size token.
    expect(decomposePackSku("ev-hw-5x-black-l")).toBeNull();
    expect(decomposePackSku("ev-hw-5x-beige-3xl")).toBeNull();
    expect(decomposePackSku("ev-hw-10x-blue-l")).toEqual({
      canonicalSku: "ev-hw-5x-blue-l",
      multiplier: 2,
    });
  });

  it("collapses hw 10/15-pack to bare no-pack form when size is single segment", () => {
    expect(decomposePackSku("ev-hw-10x-l")).toEqual({
      canonicalSku: "ev-hw-l",
      multiplier: 2,
    });
    expect(decomposePackSku("ev-hw-15-xxl")).toEqual({
      canonicalSku: "ev-hw-xxl",
      multiplier: 3,
    });
  });

  it("collapse does not apply to hw-hf or other hw-prefixed families", () => {
    // `family === "hw"` is exact match. hw-hf is a different family
    // and keeps the 5x token (its inventory uses dash-form pack tokens).
    expect(decomposePackSku("ev-hw-hf-5x-l")).toBeNull();
    expect(decomposePackSku("ev-hw-hf-5-l")).toEqual({
      canonicalSku: "ev-hw-hf-5x-l",
      multiplier: 1,
    });
  });

  it("remaps bare-size og 5-packs to the canonical ev-mixed OG 5-Pack (Scott 2026-05-26)", () => {
    // OG no-color sales (`ev-og-5x-{size}`) attribute to `ev-mixed-{size}`
    // — the canonical OG 5-Pack per EVSKUmap + stock_snapshots. Supersedes
    // the earlier ev-pp-og target (which had no matching stock row).
    expect(decomposePackSku("ev-og-5x-l")).toEqual({
      canonicalSku: "ev-mixed-l",
      multiplier: 1,
    });
    expect(decomposePackSku("ev-og-5x-xxl")).toEqual({
      canonicalSku: "ev-mixed-xxl",
      multiplier: 1,
    });
    expect(decomposePackSku("ev-og-5-xs")).toEqual({
      canonicalSku: "ev-mixed-xs",
      multiplier: 1,
    });
  });

  it("normalizes the OG line's 3xl token to ev-mixed's xxxl (Scott 2026-05-26)", () => {
    // The OG/pp-og line writes `3xl`; the canonical ev-mixed OG 5-Pack
    // spells it `xxxl`. Only this remap path normalizes it — 9055 etc.
    // keep their own `3xl`.
    expect(decomposePackSku("ev-og-5x-3xl")).toEqual({
      canonicalSku: "ev-mixed-xxxl",
      multiplier: 1,
    });
    // EV-OG-10 / EV-OG-15 decompose to the 5x base (×2 / ×3) then fold in.
    expect(decomposePackSku("EV-OG-10-3xl")).toEqual({
      canonicalSku: "ev-mixed-xxxl",
      multiplier: 2,
    });
    expect(decomposePackSku("EV-OG-15-l")).toEqual({
      canonicalSku: "ev-mixed-l",
      multiplier: 3,
    });
    // 9055 keeps 3xl (its own stock + inventory use 3xl).
    expect(decomposePackSku("ev-9055-5x-3xl")).toBeNull();
  });

  it("folds the legacy ev-pp-og alias into ev-mixed (incoming-PO sheet)", () => {
    // The incoming-PO sheet still keys on `ev-pp-og-{size}`; fold it onto
    // the canonical OG 5-Pack so incoming matches sales + stock.
    expect(decomposePackSku("ev-pp-og-l")).toEqual({
      canonicalSku: "ev-mixed-l",
      multiplier: 1,
    });
    // pp-og's 3xl also normalizes to xxxl.
    expect(decomposePackSku("ev-pp-og-3xl")).toEqual({
      canonicalSku: "ev-mixed-xxxl",
      multiplier: 1,
    });
    // Already-canonical ev-mixed passes through untouched (no pack token).
    expect(decomposePackSku("ev-mixed-l")).toBeNull();
  });

  it("preserves og colored 5-packs (keeps the 5x token)", () => {
    // `ev-og-5x-black-l` is a separate physical product — remap only
    // applies when rest is a single size token (no color segment).
    expect(decomposePackSku("ev-og-5x-black-l")).toBeNull();
    expect(decomposePackSku("ev-og-5x-beige-3xl")).toBeNull();
    // Colored OG 1-packs are also unaffected.
    expect(decomposePackSku("ev-og-1x-beige-l")).toBeNull();
  });

  it("remap does not apply to og-hf or other og-prefixed families", () => {
    // og-hf has its own family ruleset and uses dash-form 5 tokens.
    expect(decomposePackSku("ev-og-hf-5-l")).toEqual({
      canonicalSku: "ev-og-hf-5x-l",
      multiplier: 1,
    });
  });
});
