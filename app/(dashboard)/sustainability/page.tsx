"use client";
import { useState } from "react";
import {
  WarehouseToggle,
  type WarehouseSelection,
} from "@/components/inventory/WarehouseToggle";
import { SustainabilityTimelineTable } from "@/components/sustainability/SustainabilityTimelineTable";
import { trpc } from "@/lib/trpc/client";

const WINDOW_OPTIONS = [7, 14, 30] as const;
type WindowDays = (typeof WINDOW_OPTIONS)[number];

export default function SustainabilityPage() {
  const [selection, setSelection] = useState<WarehouseSelection>("US");
  const [windowDays, setWindowDays] = useState<WindowDays>(14);
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

      {/* Single-warehouse: render only the selected one. All: render
          both stacked, US first then CN. Each table has its own sort
          state so operators can sort the two independently. */}
      {(isAll || selection === "US") && (
        <SustainabilityTimelineTable
          data={usQuery.data}
          isLoading={usQuery.isLoading}
          location="US"
        />
      )}
      {(isAll || selection === "CN") && (
        <SustainabilityTimelineTable
          data={cnQuery.data}
          isLoading={cnQuery.isLoading}
          location="CN"
        />
      )}
    </div>
  );
}
