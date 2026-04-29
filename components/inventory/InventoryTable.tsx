"use client";
import { useMemo, useState } from "react";
import { FlagPill } from "./FlagPill";
import { TracedNumber } from "@/components/trace/TracedNumber";
import { SortableHeader, type SortConfig } from "@/components/shell/SortableHeader";
import type { Warehouse } from "./WarehouseToggle";
import type { InventoryRow } from "@/lib/queries/inventory";

type SortKey =
  | "flag"
  | "sku"
  | "productName"
  | "onHand"
  | "incoming"
  | "velocity"
  | "weeksOfStock"
  | "unitCost"
  | "stockValue";

// Rank flags so sorting by "flag" puts the most-urgent on top.
const FLAG_RANK: Record<string, number> = {
  at_risk: 0,
  watch: 1,
  healthy: 2,
  overstocked: 3,
};

function weeksDisplay(w: number | null): string {
  if (w === null) return "—";
  if (!Number.isFinite(w)) return "∞";
  return w.toFixed(1);
}

function moneyDisplay(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

// Per-unit cost is small ($1–$30 range), so show 2 decimals — operators
// care about the cents when reading this column.
function unitCostDisplay(n: number | null): string {
  if (n === null || n === 0) return "—";
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}

export function InventoryTable({
  warehouse,
  rows,
}: {
  warehouse: Warehouse;
  rows: InventoryRow[];
}) {
  const [sort, setSort] = useState<SortConfig<SortKey>>({ key: "flag", direction: "asc" });
  const [filter, setFilter] = useState("");

  const sorted = useMemo(() => {
    const filtered = filter.trim()
      ? rows.filter((r) =>
          r.sku.toLowerCase().includes(filter.toLowerCase()) ||
          r.productName.toLowerCase().includes(filter.toLowerCase())
        )
      : rows;
    const dir = sort.direction === "asc" ? 1 : -1;
    const nullish = (x: number | null) => (x === null ? Infinity : x);
    const compare = (a: InventoryRow, b: InventoryRow) => {
      switch (sort.key) {
        case "sku":
          return a.sku.localeCompare(b.sku) * dir;
        case "productName":
          return a.productName.localeCompare(b.productName) * dir;
        case "onHand":
          return (a.onHand - b.onHand) * dir;
        case "incoming":
          return (a.incomingUnits - b.incomingUnits) * dir;
        case "velocity":
          return (nullish(a.velocityPerDay7d) - nullish(b.velocityPerDay7d)) * dir;
        case "weeksOfStock":
          return (nullish(a.weeksOfStock) - nullish(b.weeksOfStock)) * dir;
        case "unitCost":
          return (nullish(a.unitCostUsd) - nullish(b.unitCostUsd)) * dir;
        case "stockValue":
          return (a.stockValueUsd - b.stockValueUsd) * dir;
        case "flag":
        default: {
          const fa = a.flag ? FLAG_RANK[a.flag] ?? 99 : 99;
          const fb = b.flag ? FLAG_RANK[b.flag] ?? 99 : 99;
          if (fa !== fb) return (fa - fb) * dir;
          // Within a flag bucket, weeks-of-stock asc gives stable tiebreak.
          return nullish(a.weeksOfStock) - nullish(b.weeksOfStock);
        }
      }
    };
    return [...filtered].sort(compare);
  }, [rows, sort, filter]);

  const exportCsv = () => {
    const header = [
      "sku",
      "product",
      "on_hand",
      "velocity_per_day_7d",
      "days_of_stock",
      "weeks_of_stock",
      "flag",
      "run_out_date",
      "incoming_units",
      "unit_cost_usd",
      "stock_value_usd",
      "snapshot_date",
    ];
    const lines = [header.join(",")].concat(
      sorted.map((r) =>
        [
          r.sku,
          `"${r.productName.replace(/"/g, '""')}"`,
          r.onHand,
          r.velocityPerDay7d?.toFixed(4) ?? "",
          r.daysOfStock !== null && Number.isFinite(r.daysOfStock)
            ? r.daysOfStock.toFixed(2)
            : "",
          r.weeksOfStock !== null && Number.isFinite(r.weeksOfStock)
            ? r.weeksOfStock.toFixed(2)
            : "",
          r.flag ?? "",
          r.runOutDate ?? "",
          r.incomingUnits,
          r.unitCostUsd?.toFixed(4) ?? "",
          r.stockValueUsd.toFixed(2),
          r.snapshotDate,
        ].join(",")
      )
    );
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `skybrook-${warehouse}-stock-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="rounded-md border border-neutral-200 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-neutral-200 px-4 py-2">
        <div className="text-sm font-medium">Inventory — {warehouse}</div>
        <div className="flex items-center gap-2">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter SKU or product…"
            className="rounded border border-neutral-300 px-2 py-1 text-sm"
          />
          <button
            onClick={exportCsv}
            className="rounded bg-neutral-900 px-3 py-1 text-sm font-medium text-white hover:bg-neutral-700"
          >
            Export CSV
          </button>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-600">
            <tr>
              <SortableHeader label="SKU" sortKey="sku" config={sort} onChange={setSort} />
              <SortableHeader label="Product" sortKey="productName" config={sort} onChange={setSort} />
              <SortableHeader label="Stock" sortKey="onHand" config={sort} onChange={setSort} align="right" />
              <SortableHeader label="Incoming" sortKey="incoming" config={sort} onChange={setSort} align="right" />
              <SortableHeader label="Velocity/day" sortKey="velocity" config={sort} onChange={setSort} align="right" />
              <SortableHeader label="Weeks of stock" sortKey="weeksOfStock" config={sort} onChange={setSort} align="right" />
              <SortableHeader label="Status" sortKey="flag" config={sort} onChange={setSort} />
              <SortableHeader label="Unit cost" sortKey="unitCost" config={sort} onChange={setSort} align="right" />
              <SortableHeader label="Stock value" sortKey="stockValue" config={sort} onChange={setSort} align="right" />
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={`${r.sku}-${r.location}`} className="border-t border-neutral-100">
                <td className="whitespace-nowrap px-4 py-2 font-mono text-xs">{r.sku}</td>
                <td className="px-4 py-2">{r.productName}</td>
                <td className="px-4 py-2 text-right tabular-nums">
                  <TracedNumber trace={r.trace.onHand}>{r.onHand.toLocaleString()}</TracedNumber>
                </td>
                <td className="px-4 py-2 text-right tabular-nums text-neutral-600">
                  <TracedNumber trace={r.trace.incoming}>
                    {r.incomingUnits.toLocaleString()}
                  </TracedNumber>
                </td>
                <td className="px-4 py-2 text-right tabular-nums">
                  {r.velocityPerDay7d !== null ? (
                    <TracedNumber trace={r.trace.velocity}>
                      {r.velocityPerDay7d.toFixed(2)}
                    </TracedNumber>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="px-4 py-2 text-right tabular-nums">
                  {r.trace.weeksOfStock ? (
                    <TracedNumber trace={r.trace.weeksOfStock}>
                      {weeksDisplay(r.weeksOfStock)}
                    </TracedNumber>
                  ) : (
                    weeksDisplay(r.weeksOfStock)
                  )}
                </td>
                <td className="px-4 py-2">
                  <FlagPill flag={r.flag} />
                </td>
                <td className="px-4 py-2 text-right tabular-nums text-neutral-600">
                  {unitCostDisplay(r.unitCostUsd)}
                </td>
                <td className="px-4 py-2 text-right tabular-nums">
                  <TracedNumber trace={r.trace.stockValue}>
                    {moneyDisplay(r.stockValueUsd)}
                  </TracedNumber>
                </td>
              </tr>
            ))}
            {sorted.length === 0 && (
              <tr>
                <td colSpan={9} className="px-4 py-6 text-center text-sm text-neutral-500">
                  No stock data for {warehouse} yet. Run the daily ingest to populate.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
