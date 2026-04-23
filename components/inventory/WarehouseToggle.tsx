"use client";
import { clsx } from "clsx";

export type Warehouse = "US" | "CN";
const OPTIONS: Warehouse[] = ["US", "CN"];

export function WarehouseToggle({
  value,
  onChange,
}: {
  value: Warehouse;
  onChange: (w: Warehouse) => void;
}) {
  return (
    <div className="inline-flex overflow-hidden rounded-md border border-neutral-300 bg-white">
      {OPTIONS.map((o) => (
        <button
          key={o}
          onClick={() => onChange(o)}
          className={clsx(
            "px-3 py-1.5 text-sm font-medium",
            value === o
              ? "bg-neutral-900 text-white"
              : "text-neutral-700 hover:bg-neutral-100"
          )}
        >
          {o}
        </button>
      ))}
    </div>
  );
}
