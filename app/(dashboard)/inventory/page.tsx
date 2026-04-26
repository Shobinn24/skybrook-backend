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

function moneyExact(n: number): string {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

export default function InventoryPage() {
  const [warehouse, setWarehouse] = useState<Warehouse>("US");
  const { data: rows, isLoading, error } = trpc.inventory.getInventoryRows.useQuery(
    { location: warehouse },
    { refetchOnWindowFocus: false }
  );
  const lineBreakdown = trpc.inventory.getStockValueByProductLine.useQuery(
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

  const lineRows = lineBreakdown.data ?? [];
  const lineMax = lineRows.length > 0 ? lineRows[0].totalUsd : 0;

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

      <section className="rounded-md border border-neutral-200 bg-white">
        <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-neutral-200 px-4 py-3">
          <h2 className="text-sm font-semibold text-neutral-900">
            Stock value by product line
          </h2>
          <div className="text-xs text-neutral-500">{warehouse} warehouse</div>
        </header>
        {lineBreakdown.isLoading ? (
          <div className="px-4 py-6 text-sm text-neutral-500">Loading…</div>
        ) : lineRows.length === 0 ? (
          <div className="px-4 py-6 text-sm text-neutral-500">
            No SKUs with stock in {warehouse}.
          </div>
        ) : (
          <ul className="divide-y divide-neutral-100">
            {lineRows.map((row) => {
              const pct = lineMax > 0 ? (row.totalUsd / lineMax) * 100 : 0;
              const label = row.productLine ?? "Uncategorized";
              return (
                <li
                  key={label}
                  className="grid grid-cols-[1fr_auto] items-center gap-4 px-4 py-2.5"
                >
                  <div className="min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <div className="truncate text-sm font-medium text-neutral-800">
                        {label}
                      </div>
                      <div className="text-xs text-neutral-500">
                        {row.skuCount} SKU{row.skuCount === 1 ? "" : "s"} ·{" "}
                        {row.unitCount.toLocaleString()} units
                      </div>
                    </div>
                    <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-neutral-100">
                      <div
                        className="h-full rounded-full bg-neutral-700"
                        style={{ width: `${Math.max(pct, 1)}%` }}
                      />
                    </div>
                  </div>
                  <div className="whitespace-nowrap text-right tabular-nums text-sm font-semibold text-neutral-900">
                    {moneyExact(row.totalUsd)}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

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
