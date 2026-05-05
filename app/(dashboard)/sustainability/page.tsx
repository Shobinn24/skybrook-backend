"use client";
import { useMemo, useState } from "react";
import {
  WarehouseToggle,
  type WarehouseSelection,
} from "@/components/inventory/WarehouseToggle";
import { SustainabilityTimelineTable } from "@/components/sustainability/SustainabilityTimelineTable";
import { VelocityOverridesEditor } from "@/components/sustainability/VelocityOverridesEditor";
import { trpc } from "@/lib/trpc/client";

const WINDOW_OPTIONS = [7, 14, 30] as const;
type WindowDays = (typeof WINDOW_OPTIONS)[number];

export default function SustainabilityPage() {
  const [selection, setSelection] = useState<WarehouseSelection>("US");
  const [windowDays, setWindowDays] = useState<WindowDays>(14);
  const [searchQuery, setSearchQuery] = useState("");
  const [productLineFilter, setProductLineFilter] = useState("");
  const isAll = selection === "All";

  // Two parallel queries — `enabled` gates each so single-warehouse
  // mode only fires the matching one. Same pattern as /inventory's
  // All-warehouses view: the underlying procedure stays single-
  // location; the page composes both when needed.
  const usQuery = trpc.inventory.getSustainabilityTimeline.useQuery(
    { location: "US", windowDays },
    {
      refetchOnWindowFocus: false,
      enabled: isAll || selection === "US",
    },
  );
  const cnQuery = trpc.inventory.getSustainabilityTimeline.useQuery(
    { location: "CN", windowDays },
    {
      refetchOnWindowFocus: false,
      enabled: isAll || selection === "CN",
    },
  );

  const headlineError = isAll
    ? usQuery.error ?? cnQuery.error
    : (selection === "US" ? usQuery : cnQuery).error;

  // Build the unique productLine list from whichever queries are
  // currently enabled. Excludes nulls. Sorted alphabetically.
  const productLineOptions = useMemo(() => {
    const set = new Set<string>();
    for (const q of [usQuery, cnQuery]) {
      for (const r of q.data?.rows ?? []) {
        if (r.productLine) set.add(r.productLine);
      }
    }
    return Array.from(set).sort();
  }, [usQuery.data, cnQuery.data]);

  // Distinct productNames at each warehouse — drives the per-product
  // dropdown on the velocity-overrides editor. Pulled from the same
  // timeline rows so we only offer products that actually exist at
  // the location (not every product is stocked at both warehouses).
  const productNamesByLoc = useMemo(() => {
    const collect = (rows: Array<{ productName: string }> | undefined) =>
      Array.from(new Set((rows ?? []).map((r) => r.productName))).sort();
    return {
      US: collect(usQuery.data?.rows),
      CN: collect(cnQuery.data?.rows),
    };
  }, [usQuery.data, cnQuery.data]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-neutral-900">
            Sustainability check {isAll ? "" : selection}
          </h1>
          <p className="text-sm text-neutral-500">
            {isAll
              ? "US + CN warehouses, side-by-side"
              : "Per-delivery projection: stock left at each upcoming ETA + run-out date"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="inline-flex overflow-hidden rounded-md border border-neutral-300 bg-white">
            {WINDOW_OPTIONS.map((opt) => (
              <button
                key={opt}
                onClick={() => setWindowDays(opt)}
                className={
                  "px-3 py-1.5 text-sm font-medium " +
                  (windowDays === opt
                    ? "bg-neutral-900 text-white"
                    : "text-neutral-700 hover:bg-neutral-100")
                }
              >
                {opt}d
              </button>
            ))}
          </div>
          <WarehouseToggle value={selection} onChange={setSelection} showAll />
        </div>
      </div>

      {headlineError && (
        <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          Failed to load: {headlineError.message}
        </div>
      )}

      {/* Filter row — applies to both US and CN tables when in All mode. */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search SKU or product name…"
          className="w-72 rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm placeholder:text-neutral-400 focus:border-neutral-500 focus:outline-none focus:ring-1 focus:ring-neutral-500"
        />
        <select
          value={productLineFilter}
          onChange={(e) => setProductLineFilter(e.target.value)}
          className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm text-neutral-700 focus:border-neutral-500 focus:outline-none focus:ring-1 focus:ring-neutral-500"
        >
          <option value="">All product lines</option>
          {productLineOptions.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
        {(searchQuery || productLineFilter) && (
          <button
            onClick={() => {
              setSearchQuery("");
              setProductLineFilter("");
            }}
            className="text-xs text-neutral-500 hover:text-neutral-800 underline underline-offset-2"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Single-warehouse: render only the selected one. All: render
          both stacked, US first then CN. Each table has its own sort
          state so operators can sort the two independently. */}
      {(isAll || selection === "US") && (
        <div className="space-y-3">
          <VelocityOverridesEditor
            location="US"
            overrides={usQuery.data?.overrides ?? []}
            productOptions={productNamesByLoc.US}
          />
          <SustainabilityTimelineTable
            data={usQuery.data}
            isLoading={usQuery.isLoading}
            location="US"
            searchQuery={searchQuery}
            productLineFilter={productLineFilter}
          />
        </div>
      )}
      {(isAll || selection === "CN") && (
        <div className="space-y-3">
          <VelocityOverridesEditor
            location="CN"
            overrides={cnQuery.data?.overrides ?? []}
            productOptions={productNamesByLoc.CN}
          />
          <SustainabilityTimelineTable
            data={cnQuery.data}
            isLoading={cnQuery.isLoading}
            location="CN"
            searchQuery={searchQuery}
            productLineFilter={productLineFilter}
          />
        </div>
      )}
    </div>
  );
}
