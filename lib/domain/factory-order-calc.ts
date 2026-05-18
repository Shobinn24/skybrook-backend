/**
 * Pure calculation engine for the Factory Order Automation feature.
 *
 * Spec: docs/factory-order-spec/factory-order-automation.md §3, §4
 *
 * The 23-step MOS formula chain runs per-SKU for "calculated" groups;
 * "custom" groups skip the MOS math and distribute a manual total
 * across sizes via a standard curve. Main-line groups (9055 / OG /
 * HW) additionally redistribute demand across the three via the
 * split mechanism.
 *
 * No I/O. Caller (`lib/queries/factory-order-calc.ts`) is responsible
 * for assembling the inputs.
 */

import {
  ALL_GROUPS,
  CALCULATED_GROUPS,
  SIZE_CURVES,
  skuMatchesGroup,
  type CalculatedGroup,
  type CustomGroup,
  type ProductGroup,
} from "@/config/factory-order-groups";
import type {
  AmazonDataJson,
  CommentsJson,
  CustomQtysJson,
  FactoryOrderInputs,
  ScalingJson,
  SplitsJson,
} from "@/lib/queries/factory-order";

// ---------------------------------------------------------------------
// Per-SKU input bundle (DB → engine)
// ---------------------------------------------------------------------

/** What the caller hands the engine for each SKU. */
export type SkuFacts = {
  sku: string;
  /** Trailing 30D US Shopify units (from `daily_sales`). */
  shopifyUs30d: number;
  /** Trailing 30D INTL Shopify units. */
  shopifyIntl30d: number;
  /** Latest on-hand at US warehouse (PD Stock). */
  pdStock: number;
  /** Latest on-hand at INTL warehouse (Ant Stock). */
  antStock: number;
  /** Sum of still-incoming POs to US (excludes received). */
  incomingUs: number;
  /** Sum of still-incoming POs to INTL. */
  incomingIntl: number;
  /** DDP price (US destination order amounts). */
  unitCostUs: number;
  /** Cost price (INTL destination order amounts). */
  unitCostIntl: number;
};

// ---------------------------------------------------------------------
// Output shape
// ---------------------------------------------------------------------

/** Per-(group × side) summary used by the dashboard table and the
 *  Excel total. */
export type GroupSummary = {
  groupName: string;
  kind: "calculated" | "custom";
  /** "US" → SB / Skybrook order; "INTL" → MV / Manora order. */
  side: "US" | "INTL";
  /** Raw 30D sales (Shopify + Amazon for US, Shopify only for INTL). */
  sales30dTotal: number;
  /** After split/scaling adjustment. */
  sales30dAdjusted: number;
  /** PD or Ant + Amazon stock (US side). */
  currentStock: number;
  /** futureStock = currentStock + incoming. */
  futureStock: number;
  /** currentStock / sales30dAdjusted (days/30 i.e. months). */
  currentMos: number | null;
  /** futureStock / sales30dAdjusted. */
  futureMos: number | null;
  /** Sum of per-SKU Qty_To_Order. */
  qtyToOrder: number;
  /** Sum of per-SKU (Qty * unit cost). */
  orderAmount: number;
};

export type Line = {
  sku: string;
  groupName: string;
  side: "US" | "INTL";
  qty: number;
  unitCost: number;
  amount: number;
};

/** Snapshot of a single SKU's per-SKU MOS chain row. Powers the
 *  expanded detail view (Spec §7.1 detail table). */
export type SkuDetail = {
  sku: string;
  groupName: string;
  side: "US" | "INTL";
  shopify30d: number;
  amazon30d: number;
  total30d: number;
  adjustedSales: number;
  pdStock: number;
  amazonHold: number;
  amazonStock: number;
  currentStock: number;
  incoming: number;
  futureStock: number;
  currentMos: number | null;
  futureMos: number | null;
  mosNeeded: number;
  mosToOrder: number;
  qtyToOrder: number;
  unitCost: number;
  amount: number;
};

export type CalculationResult = {
  summaries: GroupSummary[];
  lines: Line[];
  /** Detailed per-SKU breakdown for the dashboard's expandable detail
   *  rows. Phase 4's Excel generator reads from `lines` only. */
  details: SkuDetail[];
  /** Current Split per warehouse for the 3 Main Line groups,
   *  pre-applied. Lets the UI show "current" alongside the user's
   *  Change Split override. */
  currentSplits: {
    us: Record<string, number>;
    intl: Record<string, number>;
  };
  /** Total order amounts per side, for the bottom-of-page summary. */
  totals: {
    usAmount: number;
    intlAmount: number;
    combinedAmount: number;
  };
};

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function safeDiv(a: number, b: number): number | null {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return null;
  return a / b;
}

function round0(n: number): number {
  return Math.round(n);
}

function sum<T>(arr: ReadonlyArray<T>, fn: (t: T) => number): number {
  return arr.reduce((s, t) => s + fn(t), 0);
}

/**
 * Compute Current Split for the three Main Line groups per warehouse.
 * `splitBase[groupName] = group's total 30D sales / SUM(all 3 main-line totals)`
 */
function computeCurrentSplit(
  groupTotals: Map<string, number>,
): Record<string, number> {
  const mainNames = CALCULATED_GROUPS.filter((g) => g.isMainLine).map(
    (g) => g.name,
  );
  const total = mainNames.reduce((s, n) => s + (groupTotals.get(n) ?? 0), 0);
  const out: Record<string, number> = {};
  for (const n of mainNames) {
    out[n] = total > 0 ? (groupTotals.get(n) ?? 0) / total : 0;
  }
  return out;
}

/**
 * Per-SKU Adjusted Sales (Spec §3.1 step 7):
 *   Main Line:    Total_30D × (Change_Split / Current_Split) × Scaling
 *   Other:        Total_30D × Scaling
 *
 * If Current_Split is zero (no sales for any main-line group),
 * fall back to Total_30D × Scaling so we don't divide by zero.
 */
function adjustedSales(opts: {
  total30d: number;
  group: ProductGroup;
  currentSplit: number; // 0 for non-main-line
  changeSplit: number; // 0 for non-main-line
  scaling: number;
}): number {
  const isMain =
    opts.group.kind === "calculated" && opts.group.isMainLine === true;
  let base = opts.total30d;
  if (isMain && opts.currentSplit > 0) {
    base = opts.total30d * (opts.changeSplit / opts.currentSplit);
  }
  return round0(base * opts.scaling);
}

// ---------------------------------------------------------------------
// Size distribution (Spec §4.3)
// ---------------------------------------------------------------------

/**
 * Allocate `totalQty` across `sizes` using `curve`. After rounding
 * each size, adjust the largest-percentage bucket by ±1 so the
 * resulting per-size sum exactly equals `totalQty` (spec §4.3).
 */
export function distributeAcrossSizes(opts: {
  totalQty: number;
  sizes: ReadonlyArray<string>;
  curve: Record<string, number>;
}): Record<string, number> {
  const { totalQty, sizes, curve } = opts;
  const allocations: Record<string, number> = {};
  if (totalQty <= 0) {
    for (const s of sizes) allocations[s] = 0;
    return allocations;
  }

  let allocatedSum = 0;
  let biggestSize = sizes[0];
  let biggestPct = curve[sizes[0]] ?? 0;
  for (const s of sizes) {
    const pct = curve[s] ?? 0;
    const qty = round0((totalQty * pct) / 100);
    allocations[s] = qty;
    allocatedSum += qty;
    if (pct > biggestPct) {
      biggestPct = pct;
      biggestSize = s;
    }
  }
  // Balance to exact total via the largest-curve-bucket.
  const drift = totalQty - allocatedSum;
  if (drift !== 0) {
    allocations[biggestSize] = (allocations[biggestSize] ?? 0) + drift;
  }
  return allocations;
}

// ---------------------------------------------------------------------
// Main calculation entry point
// ---------------------------------------------------------------------

export type CalcInputs = {
  inputs: FactoryOrderInputs;
  /** SKU → facts. Caller assembles from DB. */
  skuFacts: Map<string, SkuFacts>;
  /** Full SKU catalog so we can group-match. */
  catalog: ReadonlyArray<string>;
};

export function runCalculation(opts: CalcInputs): CalculationResult {
  const { inputs, skuFacts, catalog } = opts;

  // Sum revenue across channels for the MOS math.
  const totalRev30d =
    (inputs.revenueUs ?? 0) + (inputs.revenueIntl ?? 0) + (inputs.revenueAmazon ?? 0);
  const usForecast = (inputs.forecast.us ?? []).reduce((s, n) => s + n, 0);
  const intlForecast = (inputs.forecast.intl ?? []).reduce((s, n) => s + n, 0);

  // Pre-compute per-group total-30D so we can derive Current Split
  // for the main-line groups.
  const usGroupTotals = new Map<string, number>();
  const intlGroupTotals = new Map<string, number>();

  // Bucket SKUs by group.
  const groupSkus = new Map<string, string[]>();
  for (const group of ALL_GROUPS) {
    const matched: string[] = [];
    for (const sku of catalog) {
      if (skuMatchesGroup(sku, group)) matched.push(sku);
    }
    groupSkus.set(group.name, matched);

    // Only count the calculated entries for the main-line split. The
    // custom-mode entries refer to the same SKUs and would double-count.
    if (group.kind !== "calculated") continue;
    let usSum = 0;
    let intlSum = 0;
    for (const sku of matched) {
      const f = skuFacts.get(sku);
      if (!f) continue;
      const amazonSales = inputs.amazonData[sku]?.sales30d ?? 0;
      usSum += f.shopifyUs30d + amazonSales;
      intlSum += f.shopifyIntl30d;
    }
    usGroupTotals.set(group.name, usSum);
    intlGroupTotals.set(group.name, intlSum);
  }

  const currentSplitsUs = computeCurrentSplit(usGroupTotals);
  const currentSplitsIntl = computeCurrentSplit(intlGroupTotals);

  const summaries: GroupSummary[] = [];
  const lines: Line[] = [];
  const details: SkuDetail[] = [];

  for (const group of ALL_GROUPS) {
    const skusForGroup = groupSkus.get(group.name) ?? [];
    const scaling = inputs.scaling[group.name] ?? 1.0;

    // For each side (US/INTL) compute the group.
    for (const side of ["US", "INTL"] as const) {
      const sideTotals = side === "US" ? usGroupTotals : intlGroupTotals;
      const splits = side === "US" ? inputs.splits.us : inputs.splits.intl;
      const currentSplit =
        (side === "US" ? currentSplitsUs : currentSplitsIntl)[group.name] ?? 0;
      const changeSplit = splits[group.name] ?? currentSplit;
      const forecastSide = side === "US" ? usForecast : intlForecast;

      if (group.kind === "custom") {
        // Custom: total qty × size distribution. The user enters
        // ONE total across both sides; we currently allocate the
        // full custom total to whichever side the user is viewing.
        // Spec §4.1 implies a US/INTL split ratio — but doesn't
        // specify a default. Phase 2 emits the full total on the US
        // side and 0 on INTL; the Phase 3 UI will surface a per-
        // custom-product side toggle if needed.
        const totalQty = inputs.customQtys[group.name] ?? 0;
        if (totalQty <= 0 || side === "INTL") {
          summaries.push(emptySummary(group, side));
          continue;
        }
        const curve = SIZE_CURVES[group.curve];
        const allocations = distributeAcrossSizes({
          totalQty,
          sizes: group.sizes,
          curve,
        });
        let qtySum = 0;
        let amountSum = 0;
        for (const sku of skusForGroup) {
          const f = skuFacts.get(sku);
          if (!f) continue;
          const sizeKey = sku.slice(group.skuPrefix.length).toLowerCase();
          const qty = allocations[sizeKey] ?? 0;
          if (qty <= 0) continue;
          const unitCost = side === "US" ? f.unitCostUs : f.unitCostIntl;
          const amount = qty * unitCost;
          qtySum += qty;
          amountSum += amount;
          lines.push({
            sku,
            groupName: group.name,
            side,
            qty,
            unitCost,
            amount,
          });
          details.push({
            sku,
            groupName: group.name,
            side,
            shopify30d: 0,
            amazon30d: 0,
            total30d: 0,
            adjustedSales: 0,
            pdStock: side === "US" ? f.pdStock : 0,
            amazonHold: 0,
            amazonStock: 0,
            currentStock: side === "US" ? f.pdStock : f.antStock,
            incoming: side === "US" ? f.incomingUs : f.incomingIntl,
            futureStock:
              (side === "US" ? f.pdStock : f.antStock) +
              (side === "US" ? f.incomingUs : f.incomingIntl),
            currentMos: null,
            futureMos: null,
            mosNeeded: 0,
            mosToOrder: 0,
            qtyToOrder: qty,
            unitCost,
            amount,
          });
        }
        summaries.push({
          groupName: group.name,
          kind: "custom",
          side,
          sales30dTotal: 0,
          sales30dAdjusted: 0,
          currentStock: 0,
          futureStock: 0,
          currentMos: null,
          futureMos: null,
          qtyToOrder: qtySum,
          orderAmount: amountSum,
        });
        continue;
      }

      // Calculated path — full MOS chain per SKU.
      let salesTotal = 0;
      let salesAdjTotal = 0;
      let currentStockTotal = 0;
      let futureStockTotal = 0;
      let qtyTotal = 0;
      let amountTotal = 0;

      for (const sku of skusForGroup) {
        const f = skuFacts.get(sku);
        if (!f) continue;
        const amazonInputs = inputs.amazonData[sku] ?? {};
        const amazon30d = side === "US" ? amazonInputs.sales30d ?? 0 : 0;
        const shopify30d = side === "US" ? f.shopifyUs30d : f.shopifyIntl30d;
        const total30d = shopify30d + amazon30d;

        const adjSales = adjustedSales({
          total30d,
          group,
          currentSplit,
          changeSplit,
          scaling,
        });

        const pdStock = side === "US" ? f.pdStock : 0;
        const antStock = side === "INTL" ? f.antStock : 0;
        const amazonStock = side === "US" ? amazonInputs.stock ?? 0 : 0;
        const amazonHold = side === "US" ? amazonInputs.hold ?? 0 : 0;
        const currentStock =
          side === "US" ? pdStock + amazonHold + amazonStock : antStock;
        const incoming = side === "US" ? f.incomingUs : f.incomingIntl;
        const futureStock = currentStock + incoming;

        const currentMos = safeDiv(currentStock, adjSales);
        const futureMos = safeDiv(futureStock, adjSales);

        const mosNeeded =
          totalRev30d > 0 ? forecastSide / totalRev30d : 0;
        // futureMos null = infinite stock vs adj sales = no need to order.
        const mosToOrder =
          futureMos === null ? -Infinity : mosNeeded - futureMos;
        const qtyToOrder =
          mosToOrder <= 0 ? 0 : round0(mosToOrder * adjSales);

        const unitCost = side === "US" ? f.unitCostUs : f.unitCostIntl;
        const amount = qtyToOrder * unitCost;

        salesTotal += total30d;
        salesAdjTotal += adjSales;
        currentStockTotal += currentStock;
        futureStockTotal += futureStock;
        qtyTotal += qtyToOrder;
        amountTotal += amount;

        if (qtyToOrder > 0) {
          lines.push({
            sku,
            groupName: group.name,
            side,
            qty: qtyToOrder,
            unitCost,
            amount,
          });
        }
        details.push({
          sku,
          groupName: group.name,
          side,
          shopify30d,
          amazon30d,
          total30d,
          adjustedSales: adjSales,
          pdStock,
          amazonHold,
          amazonStock,
          currentStock,
          incoming,
          futureStock,
          currentMos,
          futureMos,
          mosNeeded,
          mosToOrder,
          qtyToOrder,
          unitCost,
          amount,
        });
      }

      summaries.push({
        groupName: group.name,
        kind: "calculated",
        side,
        sales30dTotal: salesTotal,
        sales30dAdjusted: salesAdjTotal,
        currentStock: currentStockTotal,
        futureStock: futureStockTotal,
        currentMos: safeDiv(currentStockTotal, salesAdjTotal),
        futureMos: safeDiv(futureStockTotal, salesAdjTotal),
        qtyToOrder: qtyTotal,
        orderAmount: amountTotal,
      });
    }
  }

  const usAmount = sum(
    lines.filter((l) => l.side === "US"),
    (l) => l.amount,
  );
  const intlAmount = sum(
    lines.filter((l) => l.side === "INTL"),
    (l) => l.amount,
  );

  return {
    summaries,
    lines,
    details,
    currentSplits: { us: currentSplitsUs, intl: currentSplitsIntl },
    totals: {
      usAmount,
      intlAmount,
      combinedAmount: usAmount + intlAmount,
    },
  };
}

function emptySummary(
  group: ProductGroup,
  side: "US" | "INTL",
): GroupSummary {
  return {
    groupName: group.name,
    kind: group.kind,
    side,
    sales30dTotal: 0,
    sales30dAdjusted: 0,
    currentStock: 0,
    futureStock: 0,
    currentMos: null,
    futureMos: null,
    qtyToOrder: 0,
    orderAmount: 0,
  };
}

// Re-export so the queries / tests have a single import surface.
export type {
  AmazonDataJson,
  CommentsJson,
  CustomQtysJson,
  FactoryOrderInputs,
  ScalingJson,
  SplitsJson,
  CalculatedGroup,
  CustomGroup,
  ProductGroup,
};
