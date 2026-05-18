import { describe, expect, it } from "vitest";

import {
  CALCULATED_GROUPS,
  STANDARD_10_CURVE,
  skuMatchesGroup,
} from "@/config/factory-order-groups";
import {
  distributeAcrossSizes,
  runCalculation,
  type CalcInputs,
  type SkuFacts,
} from "@/lib/domain/factory-order-calc";
import { EMPTY_INPUTS } from "@/lib/queries/factory-order";

// ---------------------------------------------------------------------
// SKU → group matching
// ---------------------------------------------------------------------

describe("skuMatchesGroup", () => {
  const og = CALCULATED_GROUPS.find((g) => g.name === "OG Main")!;
  const ogBlack1x = CALCULATED_GROUPS.find((g) => g.name === "OG Black 1-Pack")!;

  it("matches a SKU whose size suffix is in the group's size list", () => {
    expect(skuMatchesGroup("ev-mixed-m", og)).toBe(true);
  });
  it("rejects a SKU whose suffix is not a recognised size", () => {
    expect(skuMatchesGroup("ev-mixed-wrong", og)).toBe(false);
  });
  it("rejects a SKU that doesn't start with the prefix", () => {
    expect(skuMatchesGroup("ev-hw-1x-black-m", og)).toBe(false);
  });
  it("keeps 1-Pack SKUs out of the Main group", () => {
    expect(skuMatchesGroup("ev-og-1x-black-m", og)).toBe(false);
    expect(skuMatchesGroup("ev-og-1x-black-m", ogBlack1x)).toBe(true);
  });
  it("is case-insensitive", () => {
    expect(skuMatchesGroup("EV-MIXED-M", og)).toBe(true);
  });
});

// ---------------------------------------------------------------------
// Size distribution
// ---------------------------------------------------------------------

describe("distributeAcrossSizes", () => {
  const sizes = ["xxs", "xs", "s", "m", "l", "xl", "xxl", "3xl", "4xl", "5xl"];

  it("sums to the requested total exactly (after re-balance)", () => {
    for (const total of [1000, 3000, 1234, 7]) {
      const out = distributeAcrossSizes({
        totalQty: total,
        sizes,
        curve: STANDARD_10_CURVE,
      });
      const summed = Object.values(out).reduce((s, n) => s + n, 0);
      expect(summed).toBe(total);
    }
  });

  it("returns all-zero allocations when total is 0", () => {
    const out = distributeAcrossSizes({
      totalQty: 0,
      sizes,
      curve: STANDARD_10_CURVE,
    });
    for (const s of sizes) expect(out[s]).toBe(0);
  });

  it("distributes per the curve percentages", () => {
    const out = distributeAcrossSizes({
      totalQty: 1000,
      sizes,
      curve: STANDARD_10_CURVE,
    });
    // L gets the largest share (25.13%).
    expect(out.l).toBeGreaterThanOrEqual(out.xl);
    // XXS gets a small share.
    expect(out.xxs).toBeLessThan(out.l / 5);
  });

  it("re-balances drift onto the largest-percentage bucket (L for standard10)", () => {
    // Pick a total where ordinary rounding overshoots/undershoots so
    // the rebalance lands on L.
    const out = distributeAcrossSizes({
      totalQty: 33,
      sizes,
      curve: STANDARD_10_CURVE,
    });
    expect(Object.values(out).reduce((s, n) => s + n, 0)).toBe(33);
  });
});

// ---------------------------------------------------------------------
// MOS chain — calculated group
// ---------------------------------------------------------------------

function buildFacts(rows: SkuFacts[]): Map<string, SkuFacts> {
  return new Map(rows.map((r) => [r.sku, r]));
}

function inputsWithRevenue(
  rev: number,
  forecast: { us: number[]; intl: number[] },
  splits: Record<string, number> = {},
) {
  return {
    ...EMPTY_INPUTS,
    revenueUs: rev,
    revenueIntl: 0,
    revenueAmazon: 0,
    forecast,
    splits: { us: splits, intl: {} },
  };
}

describe("runCalculation — calculated chain", () => {
  it("produces a non-zero Qty to Order when futureMos < mosNeeded", () => {
    // Single SKU in OG Main, US side only.
    const facts = buildFacts([
      {
        sku: "ev-mixed-m",
        shopifyUs30d: 100,
        shopifyIntl30d: 0,
        pdStock: 200,
        antStock: 0,
        incomingUs: 0,
        incomingIntl: 0,
        unitCostUs: 6.25,
        unitCostIntl: 5.65,
      },
    ]);
    const result = runCalculation({
      inputs: inputsWithRevenue(100_000, { us: [200_000, 200_000, 200_000, 200_000], intl: [0, 0, 0] }),
      skuFacts: facts,
      catalog: ["ev-mixed-m"],
    });

    // mosNeeded = forecast / revenue = 800k / 100k = 8 months.
    // adjustedSales = 100 (split=1, scaling=1, no main-line split since
    // only OG Main exists in the catalog → currentSplit = 1.0).
    // futureMos = 200 / 100 = 2 months.
    // mosToOrder = 8 - 2 = 6 months → qty = round(6 * 100) = 600 units.
    const ogMainUs = result.summaries.find(
      (s) => s.groupName === "OG Main" && s.side === "US",
    );
    expect(ogMainUs?.qtyToOrder).toBe(600);
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toEqual({
      sku: "ev-mixed-m",
      groupName: "OG Main",
      side: "US",
      qty: 600,
      unitCost: 6.25,
      amount: 600 * 6.25,
    });
  });

  it("returns zero qty when FUT MOS already exceeds MOS needed", () => {
    const facts = buildFacts([
      {
        sku: "ev-mixed-m",
        shopifyUs30d: 100,
        shopifyIntl30d: 0,
        pdStock: 1000, // way more than needed
        antStock: 0,
        incomingUs: 500,
        incomingIntl: 0,
        unitCostUs: 6.25,
        unitCostIntl: 5.65,
      },
    ]);
    const result = runCalculation({
      inputs: inputsWithRevenue(100_000, { us: [200_000, 200_000, 200_000, 200_000], intl: [0, 0, 0] }),
      skuFacts: facts,
      catalog: ["ev-mixed-m"],
    });

    // futureMos = 1500 / 100 = 15 months; mosNeeded = 8 months → no order.
    expect(
      result.summaries.find((s) => s.groupName === "OG Main" && s.side === "US")
        ?.qtyToOrder,
    ).toBe(0);
    expect(result.lines).toHaveLength(0);
  });

  it("applies the main-line Change Split override per spec §3.2", () => {
    // Two Main Line groups in the catalog: 9055 Main and OG Main.
    // Sales split ~equally → Current Split = 0.5 / 0.5.
    // Override 9055 to 0.7 → its adjustedSales scales up by 0.7/0.5 = 1.4.
    const facts = buildFacts([
      {
        sku: "ev-9055-5x-m",
        shopifyUs30d: 100,
        shopifyIntl30d: 0,
        pdStock: 0, // force qty to be driven by adjustedSales
        antStock: 0,
        incomingUs: 0,
        incomingIntl: 0,
        unitCostUs: 6.41,
        unitCostIntl: 5.9,
      },
      {
        sku: "ev-mixed-m",
        shopifyUs30d: 100,
        shopifyIntl30d: 0,
        pdStock: 0,
        antStock: 0,
        incomingUs: 0,
        incomingIntl: 0,
        unitCostUs: 6.25,
        unitCostIntl: 5.65,
      },
    ]);
    const result = runCalculation({
      inputs: inputsWithRevenue(
        100_000,
        { us: [200_000, 200_000, 200_000, 200_000], intl: [0, 0, 0] },
        { "9055 Main": 0.7, "OG Main": 0.3 },
      ),
      skuFacts: facts,
      catalog: ["ev-9055-5x-m", "ev-mixed-m"],
    });

    // Current split for both = 0.5 (each group is half the main-line total).
    expect(result.currentSplits.us["9055 Main"]).toBeCloseTo(0.5, 4);
    expect(result.currentSplits.us["OG Main"]).toBeCloseTo(0.5, 4);

    const og = result.summaries.find(
      (s) => s.groupName === "OG Main" && s.side === "US",
    );
    const main9055 = result.summaries.find(
      (s) => s.groupName === "9055 Main" && s.side === "US",
    );

    // 9055 should be ordered MORE than OG after override.
    expect(main9055?.qtyToOrder ?? 0).toBeGreaterThan(
      og?.qtyToOrder ?? 0,
    );
    // 9055 adjustedSales = 100 * (0.7/0.5) * 1 = 140 → qtyToOrder = mosNeeded * 140
    //   = 8 * 140 = 1120.
    expect(main9055?.sales30dAdjusted).toBe(140);
    expect(main9055?.qtyToOrder).toBe(1120);
    // OG adjustedSales = 100 * (0.3/0.5) = 60 → qty = 8 * 60 = 480.
    expect(og?.sales30dAdjusted).toBe(60);
    expect(og?.qtyToOrder).toBe(480);
  });

  it("scaling factor multiplies adjustedSales for non-main-line groups", () => {
    const facts = buildFacts([
      {
        sku: "ev-bik-5x-m",
        shopifyUs30d: 100,
        shopifyIntl30d: 0,
        pdStock: 0,
        antStock: 0,
        incomingUs: 0,
        incomingIntl: 0,
        unitCostUs: 5.0,
        unitCostIntl: 4.5,
      },
    ]);
    const base = runCalculation({
      inputs: inputsWithRevenue(100_000, { us: [200_000, 200_000, 200_000, 200_000], intl: [0, 0, 0] }),
      skuFacts: facts,
      catalog: ["ev-bik-5x-m"],
    });
    const scaled = runCalculation({
      inputs: {
        ...inputsWithRevenue(100_000, { us: [200_000, 200_000, 200_000, 200_000], intl: [0, 0, 0] }),
        scaling: { Bikini: 0.5 },
      },
      skuFacts: facts,
      catalog: ["ev-bik-5x-m"],
    });
    const baseQty = base.summaries.find(
      (s) => s.groupName === "Bikini" && s.side === "US",
    )?.qtyToOrder;
    const scaledQty = scaled.summaries.find(
      (s) => s.groupName === "Bikini" && s.side === "US",
    )?.qtyToOrder;
    expect(baseQty).toBe(800); // 100 units/mo * 8 mo
    expect(scaledQty).toBe(400); // half
  });

  it("includes Amazon manual sales + stock in the US-side MOS chain", () => {
    const facts = buildFacts([
      {
        sku: "ev-bik-5x-m",
        shopifyUs30d: 50,
        shopifyIntl30d: 0,
        pdStock: 0,
        antStock: 0,
        incomingUs: 0,
        incomingIntl: 0,
        unitCostUs: 5.0,
        unitCostIntl: 4.5,
      },
    ]);
    const result = runCalculation({
      inputs: {
        ...inputsWithRevenue(100_000, { us: [200_000, 200_000, 200_000, 200_000], intl: [0, 0, 0] }),
        amazonData: {
          "ev-bik-5x-m": { sales30d: 50, stock: 30, hold: 20 },
        },
      },
      skuFacts: facts,
      catalog: ["ev-bik-5x-m"],
    });
    const detail = result.details.find(
      (d) => d.sku === "ev-bik-5x-m" && d.side === "US",
    );
    expect(detail?.amazon30d).toBe(50);
    expect(detail?.total30d).toBe(100);
    expect(detail?.amazonStock).toBe(30);
    expect(detail?.amazonHold).toBe(20);
    expect(detail?.currentStock).toBe(50); // 0 + 20 + 30
  });
});

// ---------------------------------------------------------------------
// Custom-product path
// ---------------------------------------------------------------------

describe("runCalculation — custom-input chain", () => {
  it("distributes a manual total across sizes via the configured curve", () => {
    const facts = new Map<string, SkuFacts>();
    const sizes = ["xxs", "xs", "s", "m", "l", "xl", "xxl", "3xl", "4xl", "5xl"];
    const catalog: string[] = [];
    for (const sz of sizes) {
      const sku = `ev-hrshort-5x-${sz}`;
      catalog.push(sku);
      facts.set(sku, {
        sku,
        shopifyUs30d: 0,
        shopifyIntl30d: 0,
        pdStock: 0,
        antStock: 0,
        incomingUs: 0,
        incomingIntl: 0,
        unitCostUs: 9.0,
        unitCostIntl: 8.0,
      });
    }
    const result = runCalculation({
      inputs: {
        ...EMPTY_INPUTS,
        customQtys: { "High Rise Short": 3000 },
      },
      skuFacts: facts,
      catalog,
    });
    const hrsLines = result.lines.filter(
      (l) => l.groupName === "High Rise Short",
    );
    const totalQty = hrsLines.reduce((s, l) => s + l.qty, 0);
    expect(totalQty).toBe(3000);
    // Largest bucket should be L (25.13% of 3000 ≈ 754, ± balance).
    const lLine = hrsLines.find((l) => l.sku === "ev-hrshort-5x-l");
    expect(lLine?.qty).toBeGreaterThanOrEqual(750);
    expect(lLine?.qty).toBeLessThanOrEqual(760);
    // All lines should be on the US side per the v1 convention.
    expect(hrsLines.every((l) => l.side === "US")).toBe(true);
  });

  it("splits the custom total across US/INTL when customUsShare is set", () => {
    const facts = new Map<string, SkuFacts>();
    const sizes = ["xxs", "xs", "s", "m", "l", "xl", "xxl", "3xl", "4xl", "5xl"];
    const catalog: string[] = [];
    for (const sz of sizes) {
      const sku = `ev-hrshort-5x-${sz}`;
      catalog.push(sku);
      facts.set(sku, {
        sku,
        shopifyUs30d: 0,
        shopifyIntl30d: 0,
        pdStock: 0,
        antStock: 0,
        incomingUs: 0,
        incomingIntl: 0,
        unitCostUs: 9.0,
        unitCostIntl: 8.0,
      });
    }
    const result = runCalculation({
      inputs: {
        ...EMPTY_INPUTS,
        customQtys: { "High Rise Short": 1000 },
        customUsShare: { "High Rise Short": 0.7 },
      },
      skuFacts: facts,
      catalog,
    });
    const usLines = result.lines.filter(
      (l) => l.groupName === "High Rise Short" && l.side === "US",
    );
    const intlLines = result.lines.filter(
      (l) => l.groupName === "High Rise Short" && l.side === "INTL",
    );
    const usTotal = usLines.reduce((s, l) => s + l.qty, 0);
    const intlTotal = intlLines.reduce((s, l) => s + l.qty, 0);
    expect(usTotal).toBe(700);
    expect(intlTotal).toBe(300);
    // Both sides should use the configured curve so L gets the
    // biggest bucket on each.
    const usL = usLines.find((l) => l.sku === "ev-hrshort-5x-l");
    const intlL = intlLines.find((l) => l.sku === "ev-hrshort-5x-l");
    expect(usL?.qty).toBeGreaterThan(0);
    expect(intlL?.qty).toBeGreaterThan(0);
  });

  it("defaults to 100% US when customUsShare is missing for the group", () => {
    const facts = new Map<string, SkuFacts>();
    facts.set("ev-hrshort-5x-m", {
      sku: "ev-hrshort-5x-m",
      shopifyUs30d: 0,
      shopifyIntl30d: 0,
      pdStock: 0,
      antStock: 0,
      incomingUs: 0,
      incomingIntl: 0,
      unitCostUs: 9.0,
      unitCostIntl: 8.0,
    });
    const result = runCalculation({
      inputs: {
        ...EMPTY_INPUTS,
        customQtys: { "High Rise Short": 500 },
      },
      skuFacts: facts,
      catalog: ["ev-hrshort-5x-m"],
    });
    expect(
      result.lines.filter(
        (l) => l.groupName === "High Rise Short" && l.side === "INTL",
      ),
    ).toHaveLength(0);
  });

  it("emits zero lines when the custom total is 0", () => {
    const facts = new Map<string, SkuFacts>();
    const catalog: string[] = ["ev-hrshort-5x-m"];
    facts.set("ev-hrshort-5x-m", {
      sku: "ev-hrshort-5x-m",
      shopifyUs30d: 0,
      shopifyIntl30d: 0,
      pdStock: 0,
      antStock: 0,
      incomingUs: 0,
      incomingIntl: 0,
      unitCostUs: 9.0,
      unitCostIntl: 8.0,
    });
    const result = runCalculation({
      inputs: { ...EMPTY_INPUTS, customQtys: { "High Rise Short": 0 } },
      skuFacts: facts,
      catalog,
    });
    expect(
      result.lines.filter((l) => l.groupName === "High Rise Short"),
    ).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------
// Totals
// ---------------------------------------------------------------------

describe("runCalculation — totals roll up correctly", () => {
  it("totals.usAmount = sum of US-side line amounts", () => {
    const facts = buildFacts([
      {
        sku: "ev-mixed-m",
        shopifyUs30d: 100,
        shopifyIntl30d: 0,
        pdStock: 0,
        antStock: 0,
        incomingUs: 0,
        incomingIntl: 0,
        unitCostUs: 6.25,
        unitCostIntl: 5.65,
      },
    ]);
    const r = runCalculation({
      inputs: inputsWithRevenue(100_000, { us: [200_000, 200_000, 200_000, 200_000], intl: [0, 0, 0] }),
      skuFacts: facts,
      catalog: ["ev-mixed-m"],
    });
    const lineSum = r.lines
      .filter((l) => l.side === "US")
      .reduce((s, l) => s + l.amount, 0);
    expect(r.totals.usAmount).toBeCloseTo(lineSum, 2);
    expect(r.totals.combinedAmount).toBeCloseTo(
      r.totals.usAmount + r.totals.intlAmount,
      2,
    );
  });
});
