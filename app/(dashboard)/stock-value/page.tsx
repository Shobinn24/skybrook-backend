"use client";
import { useMemo, useState } from "react";
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

export default function StockValuePage() {
  const [warehouse, setWarehouse] = useState<Warehouse>("US");
  const { data: rows, isLoading, error } = trpc.inventory.getStockValueByProduct.useQuery(
    { location: warehouse },
    { refetchOnWindowFocus: false }
  );

  const productRows = rows ?? [];
  const totals = useMemo(() => {
    const totalUsd = productRows.reduce((n, r) => n + r.totalUsd, 0);
    const unitCount = productRows.reduce((n, r) => n + r.unitCount, 0);
    const skuCount = productRows.reduce((n, r) => n + r.skuCount, 0);
    return { totalUsd, unitCount, skuCount, productCount: productRows.length };
  }, [productRows]);

  const max = productRows.length > 0 ? productRows[0].totalUsd : 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-neutral-900">Stock value</h1>
          <p className="text-sm text-neutral-500">
            {isLoading
              ? "Loading…"
              : `${totals.productCount} products · ${totals.skuCount} SKUs in ${warehouse} warehouse`}
          </p>
        </div>
        <WarehouseToggle value={warehouse} onChange={setWarehouse} />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <KpiCard
          label="Total value"
          value={moneyCompact(totals.totalUsd)}
          hint={`${warehouse} warehouse`}
        />
        <KpiCard label="Total units" value={totals.unitCount.toLocaleString()} />
        <KpiCard
          label="Products"
          value={totals.productCount}
          hint={`${totals.skuCount} SKUs`}
        />
      </div>

      <section className="rounded-md border border-neutral-200 bg-white">
        <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-neutral-200 px-4 py-3">
          <h2 className="text-sm font-semibold text-neutral-900">By product</h2>
          <div className="text-xs text-neutral-500">
            Sorted by value · {warehouse} warehouse
          </div>
        </header>
        {error ? (
          <div className="px-4 py-6 text-sm text-red-700">
            Failed to load: {error.message}
          </div>
        ) : isLoading ? (
          <div className="px-4 py-6 text-sm text-neutral-500">Loading…</div>
        ) : productRows.length === 0 ? (
          <div className="px-4 py-6 text-sm text-neutral-500">
            No SKUs with stock in {warehouse}.
          </div>
        ) : (
          <ul className="divide-y divide-neutral-100">
            {productRows.map((row) => {
              const pct = max > 0 ? (row.totalUsd / max) * 100 : 0;
              return (
                <li
                  key={row.productName}
                  className="grid grid-cols-[1fr_auto] items-center gap-4 px-4 py-2.5"
                >
                  <div className="min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <div className="truncate text-sm font-medium text-neutral-800">
                        {row.productName}
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
    </div>
  );
}
