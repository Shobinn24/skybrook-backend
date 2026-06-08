import { describe, expect, it } from "vitest";
import { compareWithinProduct } from "@/lib/domain/sku-sort";

const sorted = (skus: string[]) => [...skus].sort(compareWithinProduct);

describe("compareWithinProduct", () => {
  it("orders sizes largest to smallest within one variant", () => {
    expect(sorted(["ev-9055-5x-m", "ev-9055-5x-xxl", "ev-9055-5x-s", "ev-9055-5x-l"])).toEqual([
      "ev-9055-5x-xxl",
      "ev-9055-5x-l",
      "ev-9055-5x-m",
      "ev-9055-5x-s",
    ]);
  });

  it("covers the full ladder 5XL down to XXS", () => {
    const all = ["ev-x-5x-xxs", "ev-x-5x-3xl", "ev-x-5x-s", "ev-x-5x-5xl", "ev-x-5x-xl", "ev-x-5x-xs", "ev-x-5x-l", "ev-x-5x-4xl", "ev-x-5x-m", "ev-x-5x-xxl"];
    expect(sorted(all)).toEqual([
      "ev-x-5x-5xl",
      "ev-x-5x-4xl",
      "ev-x-5x-3xl",
      "ev-x-5x-xxl",
      "ev-x-5x-xl",
      "ev-x-5x-l",
      "ev-x-5x-m",
      "ev-x-5x-s",
      "ev-x-5x-xs",
      "ev-x-5x-xxs",
    ]);
  });

  it("groups by color alphabetically, each color block largest to smallest", () => {
    expect(
      sorted(["ev-hw-5x-pink-s", "ev-hw-5x-gray-xl", "ev-hw-5x-pink-xxl", "ev-hw-5x-gray-m"]),
    ).toEqual([
      "ev-hw-5x-gray-xl",
      "ev-hw-5x-gray-m",
      "ev-hw-5x-pink-xxl",
      "ev-hw-5x-pink-s",
    ]);
  });

  it("treats 2xl as xxl and xxxl as 3xl (size aliases)", () => {
    // 3xl/xxxl rank above xxl/2xl
    expect(sorted(["ev-x-5x-xxl", "ev-x-5x-xxxl", "ev-x-5x-xl"])).toEqual([
      "ev-x-5x-xxxl",
      "ev-x-5x-xxl",
      "ev-x-5x-xl",
    ]);
    expect(sorted(["ev-x-5x-2xl", "ev-x-5x-3xl", "ev-x-5x-l"])).toEqual([
      "ev-x-5x-3xl",
      "ev-x-5x-2xl",
      "ev-x-5x-l",
    ]);
  });

  it("handles no-color bare-size SKUs (ev-mixed-{size})", () => {
    expect(sorted(["ev-mixed-m", "ev-mixed-3xl", "ev-mixed-xs"])).toEqual([
      "ev-mixed-3xl",
      "ev-mixed-m",
      "ev-mixed-xs",
    ]);
  });
});
