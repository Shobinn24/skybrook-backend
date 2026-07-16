import { describe, expect, it } from "vitest";
import { buildDirectionMix, buildSalesWeighted, labelVerdict } from "@/lib/sizing/compute";

const row = (label: string, size: string, up: number, down: number, same = 0) => ({
  label,
  size,
  up,
  down,
  same,
});

describe("buildDirectionMix", () => {
  it("computes percentages with exchanges as denominator (spec step 7)", () => {
    const [cell] = buildDirectionMix([row("High Waisted Std", "M", 6, 3, 1)]);
    expect(cell.total).toBe(10);
    expect(cell.pctUp).toBe(60);
    expect(cell.pctDown).toBe(30);
    expect(cell.pctSame).toBe(10);
    expect(cell.lowConfidence).toBe(false);
  });

  it("flags low-confidence cells under 10 exchanges", () => {
    const [cell] = buildDirectionMix([row("Bikini Std", "S", 4, 3)]);
    expect(cell.lowConfidence).toBe(true);
  });

  it("flags boundary sizes at each end of the product's actual run (spec 4.3)", () => {
    const cells = buildDirectionMix([
      row("Comfort Plus Std", "S", 10, 5),
      row("Comfort Plus Std", "M", 10, 5),
      row("Comfort Plus Std", "5XL", 0, 20),
    ]);
    const bySize = Object.fromEntries(cells.map((c) => [c.size, c]));
    expect(bySize["S"].boundary).toBe(true);
    expect(bySize["M"].boundary).toBe(false);
    expect(bySize["5XL"].boundary).toBe(true);
  });

  it("flags XXS as suspect (spec 4.2) and sorts sizes by rank", () => {
    const cells = buildDirectionMix([
      row("Comfort Plus Std", "M", 10, 5),
      row("Comfort Plus Std", "XXS", 500, 0),
    ]);
    expect(cells[0].size).toBe("XXS"); // rank order
    expect(cells[0].flagged).toBe(true);
    expect(cells[1].flagged).toBe(false);
  });
});

describe("buildSalesWeighted", () => {
  const sales = [
    { label: "High Waisted Std", size: "M", units: 1000 },
    { label: "High Waisted Std", size: "L", units: 500 },
  ];

  it("LEFT joins from sales: zero-exchange sizes show 0%, not missing", () => {
    const cells = buildSalesWeighted(sales, buildDirectionMix([row("High Waisted Std", "M", 60, 40)]));
    const l = cells.find((c) => c.size === "L")!;
    expect(l.exchanges).toBe(0);
    expect(l.pctExch).toBe(0);
    expect(l.severity).toBe("normal");
  });

  it("computes rate with units as denominator and severity thresholds", () => {
    const cells = buildSalesWeighted(sales, buildDirectionMix([row("High Waisted Std", "M", 60, 55)]));
    const m = cells.find((c) => c.size === "M")!;
    expect(m.pctExch).toBeCloseTo(11.5, 1); // 115/1000
    expect(m.severity).toBe("problem"); // > 10%
    const watch = buildSalesWeighted(
      [{ label: "X", size: "M", units: 1000 }],
      buildDirectionMix([row("X", "M", 40, 40)]),
    )[0];
    expect(watch.severity).toBe("watch"); // 8%
  });

  it("guards units == 0 by dropping the cell", () => {
    const cells = buildSalesWeighted(
      [{ label: "X", size: "M", units: 0 }],
      buildDirectionMix([row("X", "M", 5, 5)]),
    );
    expect(cells).toHaveLength(0);
  });
});

describe("labelVerdict (spec section 6 with caveats)", () => {
  it("runs small when up share > 55% among voting cells", () => {
    const cells = buildDirectionMix([
      row("CP Heavy", "S", 20, 5), // boundary (min) — excluded from vote
      row("CP Heavy", "M", 40, 10),
      row("CP Heavy", "L", 35, 10),
      row("CP Heavy", "XL", 30, 12), // boundary (max) — excluded
    ]);
    expect(labelVerdict(cells)).toBe("runs small");
  });

  it("boundary and XXS cells never vote", () => {
    const cells = buildDirectionMix([
      row("X", "XXS", 500, 0), // flagged — would swamp the vote if counted
      row("X", "M", 10, 20),
      row("X", "L", 12, 22),
      row("X", "XL", 9, 18),
      row("X", "2XL", 30, 0), // boundary
    ]);
    expect(labelVerdict(cells)).toBe("runs large");
  });

  it("insufficient data under 30 voting exchanges", () => {
    const cells = buildDirectionMix([
      row("X", "M", 5, 5),
      row("X", "L", 6, 6),
      row("X", "XL", 3, 3),
    ]);
    expect(labelVerdict(cells)).toBe("insufficient data");
  });
});
