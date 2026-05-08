"use client";
import { useMemo, useState } from "react";
import { KpiCard } from "@/components/inventory/KpiCard";
import {
  WarehouseToggle,
  type WarehouseSelection,
} from "@/components/inventory/WarehouseToggle";
import { SortableHeader, type SortConfig } from "@/components/shell/SortableHeader";
import { trpc } from "@/lib/trpc/client";

type StockValueSortKey =
  | "productName"
  | "skuCount"
  | "unitCount"
  | "totalUsd"
  | "futureUnitCount"
  | "futureValueUsd"
  | "combinedUnits"
  | "combinedValue";

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
  const [warehouse, setWarehouse] = useState<WarehouseSelection>("US");
  const isAll = warehouse === "All";
  // Default to value-desc — Scott's primary lens for "which bucket is
  // tying up the most capital". Operators can flip to other columns.
  const [sort, setSort] = useState<SortConfig<StockValueSortKey>>({
    key: "totalUsd",
    direction: "desc",
  });
  const { data: rows, isLoading, error } = trpc.inventory.getStockValueByProduct.useQuery(
    { location: isAll ? undefined : warehouse },
    { refetchOnWindowFocus: false }
  );

  const productRows = rows ?? [];
  const totals = useMemo(() => {
    const totalUsd = productRows.reduce((n, r) => n + r.totalUsd, 0);
    const unitCount = productRows.reduce((n, r) => n + r.unitCount, 0);
    const skuCount = productRows.reduce((n, r) => n + r.skuCount, 0);
    const futureUnitCount = productRows.reduce((n, r) => n + r.futureUnitCount, 0);
    const futureValueUsd = productRows.reduce((n, r) => n + r.futureValueUsd, 0);
    return {
      totalUsd,
      unitCount,
      skuCount,
      productCount: productRows.length,
      futureUnitCount,
      futureValueUsd,
    };
  }, [productRows]);

  // The bar denominator is always the max value, NOT the max of the
  // currently-sorted column — that way the bars keep meaning ("share
  // of biggest bucket by $") regardless of how the table is sorted.
  const maxValue = useMemo(
    () => productRows.reduce((m, r) => (r.totalUsd > m ? r.totalUsd : m), 0),
    [productRows],
  );

  const sortedRows = useMemo(() => {
    const dir = sort.direction === "asc" ? 1 : -1;
    const cmp = (a: typeof productRows[number], b: typeof productRows[number]) => {
      switch (sort.key) {
        case "productName":
          return a.productName.localeCompare(b.productName) * dir;
        case "skuCount":
          return (a.skuCount - b.skuCount) * dir;
        case "unitCount":
          return (a.unitCount - b.unitCount) * dir;
        case "totalUsd":
          return (a.totalUsd - b.totalUsd) * dir;
        case "futureUnitCount":
          return (a.futureUnitCount - b.futureUnitCount) * dir;
        case "futureValueUsd":
          return (a.futureValueUsd - b.futureValueUsd) * dir;
        case "combinedUnits":
          return (
            (a.unitCount + a.futureUnitCount) - (b.unitCount + b.futureUnitCount)
          ) * dir;
        case "combinedValue":
          return (
            (a.totalUsd + a.futureValueUsd) - (b.totalUsd + b.futureValueUsd)
          ) * dir;
      }
    };
    return [...productRows].sort(cmp);
  }, [productRows, sort]);

  const scopeLabel = isAll ? "all warehouses" : `${warehouse} warehouse`;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-neutral-900">Stock value</h1>
          <p className="text-sm text-neutral-500">
            {isLoading
              ? "Loading…"
              : `${totals.productCount} products · ${totals.skuCount} SKUs in ${scopeLabel}`}
          </p>
        </div>
        <WarehouseToggle value={warehouse} onChange={setWarehouse} showAll />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          label="Current value"
          value={moneyCompact(totals.totalUsd)}
          hint={`${totals.unitCount.toLocaleString()} units on hand`}
        />
        <KpiCard
          label="Future value"
          value={moneyCompact(totals.futureValueUsd)}
          hint={
            totals.futureUnitCount > 0
              ? `${totals.futureUnitCount.toLocaleString()} units inbound`
              : "No incoming"
          }
        />
        <KpiCard
          label="Combined (current + future)"
          value={moneyCompact(totals.totalUsd + totals.futureValueUsd)}
          hint={scopeLabel}
        />
        <KpiCard
          label="Products"
          value={totals.productCount}
          hint={`${totals.skuCount} SKUs`}
        />
      </div>

      <section className="rounded-md border border-neutral-200 bg-white">
        <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-neutral-200 px-4 py-3">
          <h2 className="text-sm font-semibold text-neutral-900">By product</h2>
          <div className="text-xs text-neutral-500">{scopeLabel}</div>
        </header>
        {error ? (
          <div className="px-4 py-6 text-sm text-red-700">
            Failed to load: {error.message}
          </div>
        ) : isLoading ? (
          <div className="px-4 py-6 text-sm text-neutral-500">Loading…</div>
        ) : sortedRows.length === 0 ? (
          <div className="px-4 py-6 text-sm text-neutral-500">
            No SKUs with stock in {scopeLabel}.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-neutral-50 text-xs uppercase tracking-wide text-neutral-500">
                <tr>
                  <SortableHeader<StockValueSortKey>
                    label="Product"
                    sortKey="productName"
                    config={sort}
                    onChange={setSort}
                  />
                  <SortableHeader<StockValueSortKey>
                    label="SKUs"
                    sortKey="skuCount"
                    config={sort}
                    onChange={setSort}
                    align="right"
                  />
                  <SortableHeader<StockValueSortKey>
                    label="Units"
                    sortKey="unitCount"
                    config={sort}
                    onChange={setSort}
                    align="right"
                  />
                  <SortableHeader<StockValueSortKey>
                    label="Value"
                    sortKey="totalUsd"
                    config={sort}
                    onChange={setSort}
                    align="right"
                  />
                  <SortableHeader<StockValueSortKey>
                    label="Future units"
                    sortKey="futureUnitCount"
                    config={sort}
                    onChange={setSort}
                    align="right"
                  />
                  <SortableHeader<StockValueSortKey>
                    label="Future value"
                    sortKey="futureValueUsd"
                    config={sort}
                    onChange={setSort}
                    align="right"
                  />
                  <SortableHeader<StockValueSortKey>
                    label="Combined units"
                    sortKey="combinedUnits"
                    config={sort}
                    onChange={setSort}
                    align="right"
                  />
                  <SortableHeader<StockValueSortKey>
                    label="Combined value"
                    sortKey="combinedValue"
                    config={sort}
                    onChange={setSort}
                    align="right"
                  />
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {sortedRows.map((row) => {
                  const pct = maxValue > 0 ? (row.totalUsd / maxValue) * 100 : 0;
                  return (
                    <tr key={row.productName} className="hover:bg-neutral-50/50">
                      <td className="px-4 py-2 text-neutral-800">
                        <div className="truncate font-medium">{row.productName}</div>
                      </td>
                      <td className="whitespace-nowrap px-4 py-2 text-right tabular-nums text-neutral-600">
                        {row.skuCount.toLocaleString()}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2 text-right tabular-nums text-neutral-600">
                        {row.unitCount.toLocaleString()}
                      </td>
                      <td className="px-4 py-2 text-right">
                        <div className="whitespace-nowrap tabular-nums font-semibold text-neutral-900">
                          {moneyExact(row.totalUsd)}
                        </div>
                        <div className="ml-auto mt-1 h-1 w-32 overflow-hidden rounded-full bg-neutral-100">
                          <div
                            className="h-full rounded-full bg-neutral-700"
                            style={{ width: `${Math.max(pct, 1)}%` }}
                          />
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-4 py-2 text-right tabular-nums text-neutral-600">
                        {row.futureUnitCount > 0 ? row.futureUnitCount.toLocaleString() : "—"}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2 text-right tabular-nums text-neutral-700">
                        {row.futureValueUsd > 0 ? moneyExact(row.futureValueUsd) : "—"}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2 text-right tabular-nums font-medium text-neutral-800">
                        {(row.unitCount + row.futureUnitCount).toLocaleString()}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2 text-right tabular-nums font-semibold text-neutral-900">
                        {moneyExact(row.totalUsd + row.futureValueUsd)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
