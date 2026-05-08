"use client";
import { useMemo, useState } from "react";
import { InventoryTable } from "@/components/inventory/InventoryTable";
import { ProductRollupTable } from "@/components/inventory/ProductRollupTable";
import { KpiCard } from "@/components/inventory/KpiCard";
import {
  WarehouseToggle,
  type WarehouseSelection,
} from "@/components/inventory/WarehouseToggle";
import { trpc } from "@/lib/trpc/client";
import type { NumberTrace } from "@/lib/queries/inventory";
import {
  applyAtRiskWindow,
  AT_RISK_HORIZON_DAYS,
} from "@/lib/domain/at-risk-window";
import { isMainColor } from "@/lib/domain/sku-naming";

function moneyCompact(n: number): string {
  if (n === 0) return "$0";
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toLocaleString()}`;
}

// Trace popovers want a precise dollar figure even when the KPI card
// shows the compact form ($1.2M). Render whole dollars with commas.
function stockValueDisplay(n: number): string {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

export default function InventoryPage() {
  const [selection, setSelection] = useState<WarehouseSelection>("US");
  const isAll = selection === "All";
  // Default to grouped — Scott 2026-05-05: "make the default view 1 row per
  // product (not per sku) with an option to click expand to see all SKUs."
  // Flat per-SKU view stays one toggle away for engineering / CSV export.
  const [groupByProduct, setGroupByProduct] = useState(true);
  // Scott 2026-05-07: filter out alt-color OG / HW / 9055 SKUs so the
  // at-risk view focuses on currently-advertised colorways. Defaults
  // off so total counts still match other tabs by default.
  const [mainColorOnly, setMainColorOnly] = useState(false);

  // Two parallel queries — `enabled` gates each so single-warehouse
  // mode only fires the matching one. React Query dedupes + caches both
  // so toggling between US/CN/All doesn't re-fetch.
  const usQuery = trpc.inventory.getInventoryRows.useQuery(
    { location: "US" },
    {
      refetchOnWindowFocus: false,
      enabled: isAll || selection === "US",
    },
  );
  const cnQuery = trpc.inventory.getInventoryRows.useQuery(
    { location: "CN" },
    {
      refetchOnWindowFocus: false,
      enabled: isAll || selection === "CN",
    },
  );

  const rows = useMemo(() => {
    const raw = isAll
      ? [...(usQuery.data ?? []), ...(cnQuery.data ?? [])]
      : (selection === "US" ? usQuery.data : cnQuery.data) ?? [];
    // Scott 2026-05-06: at-risk on /inventory means "running out within
    // 45 days" per the sustainability projection — different rule than
    // the underlying flag (which is preserved on other tabs).
    const today = new Date().toISOString().slice(0, 10);
    const filtered = mainColorOnly ? raw.filter((r) => isMainColor(r.sku)) : raw;
    return applyAtRiskWindow(filtered, today);
  }, [isAll, selection, usQuery.data, cnQuery.data, mainColorOnly]);

  const isLoading = isAll
    ? usQuery.isLoading || cnQuery.isLoading
    : (selection === "US" ? usQuery : cnQuery).isLoading;
  const error = isAll
    ? usQuery.error ?? cnQuery.error
    : (selection === "US" ? usQuery : cnQuery).error;

  const kpis = useMemo(() => {
    const stockValue = rows.reduce((n, x) => n + x.stockValueUsd, 0);
    const atRisk = rows.filter((x) => x.flag === "at_risk").length;
    const watch = rows.filter((x) => x.flag === "watch").length;
    const overstocked = rows.filter((x) => x.flag === "overstocked").length;
    const incoming = rows.reduce((n, x) => n + x.incomingUnits, 0);
    const totalUnits = rows.reduce((n, x) => n + x.onHand, 0);
    const pricedRows = rows.filter((x) => (x.unitCostUsd ?? 0) > 0).length;
    return {
      stockValue,
      atRisk,
      watch,
      overstocked,
      incoming,
      skuCount: rows.length,
      totalUnits,
      pricedRows,
    };
  }, [rows]);

  const scopeRefLabel = isAll ? "All warehouses (US + CN)" : `${selection} warehouse`;

  // Click-to-inspect traces for the KPI strip. Mirrors the per-row
  // traces on the inventory table — formula + inputs + sources.
  // Recomputed off the same `rows` the cards display so the math
  // displayed in the popover always reconciles.
  const stockValueTrace: NumberTrace = {
    label: `Stock value — ${scopeRefLabel}`,
    formula: "Σ on_hand × unit_cost across the displayed rows",
    inputs: [
      { label: "Rows summed", value: kpis.skuCount.toLocaleString() },
      { label: "Total on-hand units", value: kpis.totalUnits.toLocaleString() },
      { label: "Rows with a unit cost", value: kpis.pricedRows.toLocaleString() },
      { label: "Stock value", value: stockValueDisplay(kpis.stockValue) },
    ],
    sources: [
      { label: "Stock", ref: "stock_snapshots (latest per sku, location)" },
      { label: "Cost", ref: "skus.unit_cost_usd / unit_cost_intl_usd" },
    ],
    note:
      kpis.pricedRows < kpis.skuCount
        ? `${kpis.skuCount - kpis.pricedRows} row(s) have no unit cost; their stock value contribution is $0.`
        : undefined,
  };
  const atRiskTrace: NumberTrace = {
    label: `SKUs at risk — ${scopeRefLabel}`,
    formula: `count of (sku, location) rows projected to run out within the next ${AT_RISK_HORIZON_DAYS} days`,
    inputs: [
      { label: "Rows scanned", value: kpis.skuCount.toLocaleString() },
      { label: "At risk", value: kpis.atRisk.toLocaleString() },
      { label: "Watch (out beyond 45d)", value: kpis.watch.toLocaleString() },
      { label: "Horizon", value: `${AT_RISK_HORIZON_DAYS} days` },
    ],
    sources: [
      { label: "Source", ref: "sustainability_flags + runOutDate (latest per sku, location)" },
      {
        label: "Rule",
        ref:
          "at_risk = projected runOutDate ≤ today + 45d. " +
          "Overstocked rows are excluded. " +
          "Rows with no projected run-out date (PO coverage holds through horizon) are NOT at risk.",
      },
      { label: "Scott", ref: "2026-05-07: at risk should mean projected to run out per sustainability check, not raw weeks-of-stock" },
    ],
  };
  const overstockedTrace: NumberTrace = {
    label: `Overstocked SKUs — ${scopeRefLabel}`,
    formula:
      "count of (sku, location) rows where sustainability flag = 'overstocked'",
    inputs: [
      { label: "Rows scanned", value: kpis.skuCount.toLocaleString() },
      { label: "Overstocked", value: kpis.overstocked.toLocaleString() },
    ],
    sources: [
      { label: "Source", ref: "sustainability_flags (latest per sku, location)" },
      {
        label: "Threshold",
        ref: "overstocked = projected days of stock > 90d (per spec §4.3)",
      },
    ],
  };
  const incomingTrace: NumberTrace = {
    label: `Incoming units — ${scopeRefLabel}`,
    formula: "Σ pending PO quantities across the displayed rows",
    inputs: [
      { label: "Rows summed", value: kpis.skuCount.toLocaleString() },
      { label: "Total incoming", value: kpis.incoming.toLocaleString() },
    ],
    sources: [
      { label: "Source", ref: "incoming_shipments where status != 'arrived'" },
      { label: "Filtered to", ref: scopeRefLabel },
    ],
  };

  // Header label: "all warehouses" reads better than "All" inline.
  const scopeLabel = isAll ? "all warehouses" : `${selection} warehouse`;
  // KPI hint distinguishes "X SKUs" from "X (sku × warehouse) rows" in
  // All mode — a SKU stocked in both warehouses contributes 2 rows.
  const skuCountHint = isAll
    ? `${kpis.skuCount} (SKU × warehouse) rows`
    : `${kpis.skuCount} SKUs`;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-neutral-900">Inventory</h1>
          <p className="text-sm text-neutral-500">
            {isLoading ? "Loading…" : `${kpis.skuCount} ${isAll ? "rows" : "SKUs"} in ${scopeLabel}`}
          </p>
        </div>
        <WarehouseToggle value={selection} onChange={setSelection} showAll />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          label="Stock value"
          value={moneyCompact(kpis.stockValue)}
          hint={skuCountHint}
          trace={stockValueTrace}
        />
        <KpiCard
          label={`SKUs at risk (${AT_RISK_HORIZON_DAYS}d)`}
          value={kpis.atRisk}
          tone={kpis.atRisk > 0 ? "danger" : "neutral"}
          hint={kpis.watch > 0 ? `+${kpis.watch} runs out beyond ${AT_RISK_HORIZON_DAYS}d` : undefined}
          trace={atRiskTrace}
        />
        <KpiCard
          label="Overstocked SKUs"
          value={kpis.overstocked}
          trace={overstockedTrace}
        />
        <KpiCard
          label="Incoming units"
          value={kpis.incoming.toLocaleString()}
          trace={incomingTrace}
        />
      </div>

      <div className="flex items-center justify-end gap-4">
        <label
          className="inline-flex items-center gap-2 text-xs text-neutral-700"
          title="Hide alt colorways of OG / HW / 9055 (clearance / aging stock). Boyshort + Super HW colors all count as main."
        >
          <input
            type="checkbox"
            checked={mainColorOnly}
            onChange={(e) => setMainColorOnly(e.target.checked)}
            className="h-3.5 w-3.5"
          />
          Main colors only
        </label>
        <label className="inline-flex items-center gap-2 text-xs text-neutral-700">
          <input
            type="checkbox"
            checked={groupByProduct}
            onChange={(e) => setGroupByProduct(e.target.checked)}
            className="h-3.5 w-3.5"
          />
          Group by product
        </label>
      </div>

      {error ? (
        <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          Failed to load inventory: {error.message}
        </div>
      ) : groupByProduct ? (
        <ProductRollupTable warehouse={selection} rows={rows} />
      ) : (
        <InventoryTable warehouse={selection} rows={rows} />
      )}
    </div>
  );
}
