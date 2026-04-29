"use client";
import { useMemo, useState } from "react";
import { InventoryTable } from "@/components/inventory/InventoryTable";
import { KpiCard } from "@/components/inventory/KpiCard";
import {
  WarehouseToggle,
  type WarehouseSelection,
} from "@/components/inventory/WarehouseToggle";
import { trpc } from "@/lib/trpc/client";

function moneyCompact(n: number): string {
  if (n === 0) return "$0";
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toLocaleString()}`;
}

export default function InventoryPage() {
  const [selection, setSelection] = useState<WarehouseSelection>("US");
  const isAll = selection === "All";

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
    if (isAll) return [...(usQuery.data ?? []), ...(cnQuery.data ?? [])];
    return (selection === "US" ? usQuery.data : cnQuery.data) ?? [];
  }, [isAll, selection, usQuery.data, cnQuery.data]);

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
    return { stockValue, atRisk, watch, overstocked, incoming, skuCount: rows.length };
  }, [rows]);

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
        />
        <KpiCard
          label="SKUs at risk"
          value={kpis.atRisk}
          tone={kpis.atRisk > 0 ? "danger" : "neutral"}
          hint={kpis.watch > 0 ? `+${kpis.watch} on watch` : undefined}
        />
        <KpiCard label="Overstocked SKUs" value={kpis.overstocked} />
        <KpiCard label="Incoming units" value={kpis.incoming.toLocaleString()} />
      </div>

      {error ? (
        <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          Failed to load inventory: {error.message}
        </div>
      ) : (
        <InventoryTable warehouse={selection} rows={rows} />
      )}
    </div>
  );
}
