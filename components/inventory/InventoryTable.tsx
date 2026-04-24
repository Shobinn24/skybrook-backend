"use client";
import { useMemo, useState } from "react";
import { FlagPill } from "./FlagPill";
import { TracedNumber } from "@/components/trace/TracedNumber";
import type { Warehouse } from "./WarehouseToggle";
import type { InventoryRow } from "@/lib/queries/inventory";

type SortKey = "flag" | "sku" | "onHand" | "weeksOfStock" | "stockValue";

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

export function InventoryTable({
  warehouse,
  rows,
}: {
  warehouse: Warehouse;
  rows: InventoryRow[];
}) {
  const [sort, setSort] = useState<SortKey>("flag");
  const [filter, setFilter] = useState("");

  const sorted = useMemo(() => {
    const filtered = filter.trim()
      ? rows.filter((r) =>
          r.sku.toLowerCase().includes(filter.toLowerCase()) ||
          r.productName.toLowerCase().includes(filter.toLowerCase())
        )
      : rows;
    const copy = [...filtered];
    switch (sort) {
      case "sku":
        return copy.sort((a, b) => a.sku.localeCompare(b.sku));
      case "onHand":
        return copy.sort((a, b) => a.onHand - b.onHand);
      case "weeksOfStock": {
        const toNum = (x: number | null) => (x === null ? Infinity : x);
        return copy.sort((a, b) => toNum(a.weeksOfStock) - toNum(b.weeksOfStock));
      }
      case "stockValue":
        return copy.sort((a, b) => b.stockValueUsd - a.stockValueUsd);
      case "flag":
      default:
        return copy.sort((a, b) => {
          const fa = a.flag ? FLAG_RANK[a.flag] ?? 99 : 99;
          const fb = b.flag ? FLAG_RANK[b.flag] ?? 99 : 99;
          if (fa !== fb) return fa - fb;
          const toNum = (x: number | null) => (x === null ? Infinity : x);
          return toNum(a.weeksOfStock) - toNum(b.weeksOfStock);
        });
    }
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
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            className="rounded border border-neutral-300 px-2 py-1 text-sm"
          >
            <option value="flag">Sort: Status (worst first)</option>
            <option value="weeksOfStock">Sort: Weeks of stock ↑</option>
            <option value="onHand">Sort: Stock ↑</option>
            <option value="sku">Sort: SKU</option>
            <option value="stockValue">Sort: Value ↓</option>
          </select>
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
              <th className="px-4 py-2 font-medium">SKU</th>
              <th className="px-4 py-2 font-medium">Product</th>
              <th className="px-4 py-2 font-medium text-right">Stock</th>
              <th className="px-4 py-2 font-medium text-right">Incoming</th>
              <th className="px-4 py-2 font-medium text-right">Velocity/day</th>
              <th className="px-4 py-2 font-medium text-right">Weeks of stock</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2 font-medium text-right">Stock value</th>
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
                <td className="px-4 py-2 text-right tabular-nums">
                  <TracedNumber trace={r.trace.stockValue}>
                    {moneyDisplay(r.stockValueUsd)}
                  </TracedNumber>
                </td>
              </tr>
            ))}
            {sorted.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-6 text-center text-sm text-neutral-500">
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
