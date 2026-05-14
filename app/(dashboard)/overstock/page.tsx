"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { KpiCard } from "@/components/inventory/KpiCard";
import { ProductRollupTable } from "@/components/inventory/ProductRollupTable";
import { SortableHeader, type SortConfig } from "@/components/shell/SortableHeader";
import { trpc } from "@/lib/trpc/client";

type LocationFilter = "all" | "US" | "CN";

type SortKey =
  | "sku"
  | "productName"
  | "location"
  | "onHand"
  | "velocity"
  | "daysOfStock"
  | "stockValue";

function fmtMoney(n: number): string {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

function fmtNumber(n: number, digits = 0): string {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function fmtDays(days: number | null): string {
  if (days === null) return "—";
  if (!Number.isFinite(days)) return "∞";
  return Math.round(days).toLocaleString();
}

export default function OverstockPage() {
  const { data, isLoading, error } = trpc.inventory.getOverstockView.useQuery();
  const [search, setSearch] = useState("");
  const [location, setLocation] = useState<LocationFilter>("all");
  // Mirrors /inventory's default — Scott 2026-05-05: "make the default
  // view 1 row per product (not per sku)". Flat per-SKU view stays one
  // toggle away. Aggregation semantics for products with mixed flags
  // are pending Scott input (Phase 2).
  const [groupByProduct, setGroupByProduct] = useState(true);
  const [sort, setSort] = useState<SortConfig<SortKey>>({
    key: "velocity",
    direction: "desc",
  });

  // Rows after only the location filter. Feeds the rollup view, which
  // owns its own search + sort internally. Computing it separately
  // from `filteredRows` lets the rollup ignore the page-level search
  // (hidden in grouped mode anyway).
  const locationFilteredRows = useMemo(() => {
    const rows = data?.rows ?? [];
    if (location === "all") return rows;
    return rows.filter((r) => r.location === location);
  }, [data?.rows, location]);

  const filteredRows = useMemo(() => {
    const matched = locationFilteredRows.filter((r) => {
      if (
        search.trim() &&
        !r.sku.toLowerCase().includes(search.toLowerCase()) &&
        !r.productName.toLowerCase().includes(search.toLowerCase())
      ) {
        return false;
      }
      return true;
    });
    const dir = sort.direction === "asc" ? 1 : -1;
    const nullish = (x: number | null) => (x === null ? Infinity : x);
    return [...matched].sort((a, b) => {
      switch (sort.key) {
        case "sku": return a.sku.localeCompare(b.sku) * dir;
        case "productName": return a.productName.localeCompare(b.productName) * dir;
        case "location": return a.location.localeCompare(b.location) * dir;
        case "onHand": return (a.onHand - b.onHand) * dir;
        case "velocity": return (nullish(a.velocityPerDay7d) - nullish(b.velocityPerDay7d)) * dir;
        case "daysOfStock": return (nullish(a.daysOfStock) - nullish(b.daysOfStock)) * dir;
        case "stockValue":
        default:
          return (a.stockValueUsd - b.stockValueUsd) * dir;
      }
    });
  }, [locationFilteredRows, search, sort]);

  if (isLoading) {
    return <div className="text-sm text-neutral-500">Loading overstock view…</div>;
  }
  if (error) {
    return (
      <div className="rounded border border-red-200 bg-red-50 p-4 text-sm text-red-800">
        Failed to load overstock view: {error.message}
      </div>
    );
  }

  const summary = data?.summary ?? {
    count: 0,
    totalStockValueUsd: 0,
    medianDaysOfStock: null as number | null,
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-neutral-900">Overstock</h1>
        <p className="mt-1 text-sm text-neutral-600">
          SKUs whose current stock significantly exceeds projected demand. Use
          this view to decide which products to push in marketing emails and
          ad campaigns. Sorted by stock value — highest dollar-leverage first.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <KpiCard
          label="Overstocked SKUs"
          value={summary.count}
          tone={summary.count > 0 ? "warn" : "neutral"}
        />
        <KpiCard
          label="Capital tied up"
          value={fmtMoney(summary.totalStockValueUsd)}
          hint="Stock value across all overstocked SKU × location rows."
        />
        <KpiCard
          label="Median days of stock"
          value={
            summary.medianDaysOfStock === null
              ? "—"
              : fmtDays(summary.medianDaysOfStock)
          }
          hint="Half of overstocked rows are sitting on more days of stock than this."
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-2">
          {(["all", "US", "CN"] as LocationFilter[]).map((l) => (
            <button
              key={l}
              onClick={() => setLocation(l)}
              className={
                "rounded-full border px-3 py-1 text-xs font-medium " +
                (location === l
                  ? "border-neutral-900 bg-neutral-900 text-white"
                  : "border-neutral-300 bg-white text-neutral-700 hover:bg-neutral-100")
              }
            >
              {l === "all" ? "All warehouses" : l}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <label className="inline-flex items-center gap-2 text-xs text-neutral-700">
            <input
              type="checkbox"
              checked={groupByProduct}
              onChange={(e) => setGroupByProduct(e.target.checked)}
              className="h-3.5 w-3.5"
            />
            Group by product
          </label>
          {!groupByProduct && (
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter SKU or product…"
              className="rounded border border-neutral-300 px-2 py-1 text-sm"
            />
          )}
        </div>
      </div>

      {groupByProduct ? (
        locationFilteredRows.length === 0 ? (
          <div className="rounded border border-neutral-200 bg-white px-4 py-8 text-center text-sm text-neutral-500">
            {summary.count === 0
              ? "No SKUs are currently flagged as overstocked. The dashboard recomputes flags daily at 10am EST."
              : "No overstocked SKUs in the selected warehouse."}
          </div>
        ) : (
          <ProductRollupTable
            warehouse={location === "all" ? "All" : location}
            rows={locationFilteredRows}
          />
        )
      ) : (
      <div className="rounded border border-neutral-200 bg-white">
        {filteredRows.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-neutral-500">
            {summary.count === 0
              ? "No SKUs are currently flagged as overstocked. The dashboard recomputes flags daily at 10am EST."
              : "No SKUs match the current filter."}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 z-20 bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500 shadow-[0_1px_0_0_rgba(0,0,0,0.05)]">
                <tr>
                  <SortableHeader label="SKU" sortKey="sku" config={sort} onChange={setSort} />
                  <SortableHeader label="Product" sortKey="productName" config={sort} onChange={setSort} />
                  <SortableHeader label="Location" sortKey="location" config={sort} onChange={setSort} />
                  <SortableHeader label="On hand" sortKey="onHand" config={sort} onChange={setSort} align="right" />
                  <SortableHeader
                    label="Velocity 7d"
                    sortKey="velocity"
                    config={sort}
                    onChange={setSort}
                    align="right"
                    title="Velocity (units/day, 7-day window)"
                  />
                  <SortableHeader label="Days of stock" sortKey="daysOfStock" config={sort} onChange={setSort} align="right" />
                  <SortableHeader label="Stock value" sortKey="stockValue" config={sort} onChange={setSort} align="right" />
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {filteredRows.map((r) => (
                  <tr key={`${r.sku}:${r.location}`} className="hover:bg-neutral-50">
                    <td className="whitespace-nowrap px-4 py-2 font-medium text-neutral-900">
                      <Link
                        href={`/sku/${encodeURIComponent(r.sku)}`}
                        className="hover:text-neutral-600 hover:underline"
                      >
                        {r.sku}
                      </Link>
                    </td>
                    <td className="px-4 py-2 text-neutral-700">
                      {r.productName}
                      {r.productLine ? (
                        <span className="ml-2 text-xs text-neutral-400">
                          {r.productLine}
                        </span>
                      ) : null}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-neutral-700">
                      {r.location}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-right tabular-nums text-neutral-700">
                      {fmtNumber(r.onHand)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-right tabular-nums text-neutral-700">
                      {r.velocityPerDay7d === null
                        ? "—"
                        : r.velocityPerDay7d.toFixed(2)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-right tabular-nums text-neutral-700">
                      {fmtDays(r.daysOfStock)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-right tabular-nums font-medium text-neutral-900">
                      {fmtMoney(r.stockValueUsd)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      )}
    </div>
  );
}
