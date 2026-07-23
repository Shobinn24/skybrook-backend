import { describe, expect, it } from "vitest";
import { HISTORY_SIZE_CAP, resolveBoughtSizes } from "@/lib/queries/review-sizes";

// Size-per-review priority logic (Scott 2026-07-23). The SQL feeds this
// helper the matched order lines; these tests pin the resolution rules.

describe("resolveBoughtSizes", () => {
  it("uses the linked order's family lines when the review has a loox order id", () => {
    const out = resolveBoughtSizes(
      "5551234",
      [
        { variantTitle: "M", inFamily: true },
        { variantTitle: "S / Beige", inFamily: false }, // other product on same order
      ],
      ["L"], // history must be ignored on the exact path
    );
    expect(out).toEqual({ boughtSizes: ["M"], sizeSource: "order" });
  });

  it("falls back to ALL lines of the linked order when no line is in the family", () => {
    // Bundle listings may carry product ids the family map has never seen.
    const out = resolveBoughtSizes(
      "5551234",
      [
        { variantTitle: "M / Beige", inFamily: false },
        { variantTitle: "M / Beige", inFamily: false },
        { variantTitle: "L / Black", inFamily: false },
      ],
      [],
    );
    expect(out.boughtSizes).toEqual(["M / Beige", "L / Black"]);
    expect(out.sizeSource).toBe("order");
  });

  it("resolves nothing when the linked order has no size rows yet", () => {
    // order_line_sizes is empty until the first sync runs.
    expect(resolveBoughtSizes("5551234", [], ["M"])).toEqual({
      boughtSizes: [],
      sizeSource: null,
    });
  });

  it("uses order history when there is no linked order", () => {
    const out = resolveBoughtSizes(null, [], ["M", "L"]);
    expect(out).toEqual({ boughtSizes: ["M", "L"], sizeSource: "history" });
  });

  it("caps history sizes and keeps most-recent-first order", () => {
    const out = resolveBoughtSizes(null, [], ["XL", "L", "M", "S", "XS", "XXS"]);
    expect(out.boughtSizes).toEqual(["XL", "L", "M", "S"]);
    expect(out.boughtSizes).toHaveLength(HISTORY_SIZE_CAP);
    expect(out.sizeSource).toBe("history");
  });

  it("dedupes while preserving first occurrence", () => {
    const out = resolveBoughtSizes(null, [], ["M", "M", "L", "M"]);
    expect(out.boughtSizes).toEqual(["M", "L"]);
  });

  it("resolves nothing without an order or history", () => {
    expect(resolveBoughtSizes(null, [], [])).toEqual({ boughtSizes: [], sizeSource: null });
  });
});
