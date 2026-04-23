"use client";
import { useMemo, useState } from "react";
import { InventoryTable } from "@/components/inventory/InventoryTable";
import { KpiCard } from "@/components/inventory/KpiCard";
import { WarehouseToggle, type Warehouse } from "@/components/inventory/WarehouseToggle";
import { trpc } from "@/lib/trpc/client";

function moneyCompact(n: number): string {
  if (n === 0) return "$0";
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toLocaleString()}`;
}

export default function InventoryPage() {
  const [warehouse, setWarehouse] = useState<Warehouse>("US");
  const { data: rows, isLoading, error } = trpc.inventory.getInventoryRows.useQuery(
    { location: warehouse },
    { refetchOnWindowFocus: false }
  );

  const kpis = useMemo(() => {
    const r = rows ?? [];
    const stockValue = r.reduce((n, x) => n + x.stockValueUsd, 0);
    const atRisk = r.filter((x) => x.flag === "at_risk").length;
    const watch = r.filter((x) => x.flag === "watch").length;
    const overstocked = r.filter((x) => x.flag === "overstocked").length;
    const incoming = r.reduce((n, x) => n + x.incomingUnits, 0);
    return { stockValue, atRisk, watch, overstocked, incoming, skuCount: r.length };
  }, [rows]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-neutral-900">Inventory</h1>
          <p className="text-sm text-neutral-500">
            {isLoading ? "Loading…" : `${kpis.skuCount} SKUs in ${warehouse} warehouse`}
          </p>
        </div>
        <WarehouseToggle value={warehouse} onChange={setWarehouse} />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          label="Stock value"
          value={moneyCompact(kpis.stockValue)}
          hint={`${kpis.skuCount} SKUs`}
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
        <InventoryTable warehouse={warehouse} rows={rows ?? []} />
      )}
    </div>
  );
}
