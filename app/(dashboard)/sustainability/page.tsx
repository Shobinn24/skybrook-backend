"use client";
import { useState } from "react";
import { WarehouseToggle, type Warehouse } from "@/components/inventory/WarehouseToggle";
import { trpc } from "@/lib/trpc/client";

const WINDOW_OPTIONS = [7, 14, 30] as const;
type WindowDays = (typeof WINDOW_OPTIONS)[number];

function formatYmd(ymd: string): string {
  // "2026-05-03" → "3 May 26" (matches Scott's sheet's tight format)
  const [y, m, d] = ymd.split("-").map(Number);
  const monthNames = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  return `${d} ${monthNames[m - 1]} ${String(y).slice(2)}`;
}

function fmtNum(n: number, digits = 0): string {
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export default function SustainabilityPage() {
  const [warehouse, setWarehouse] = useState<Warehouse>("US");
  const [windowDays, setWindowDays] = useState<WindowDays>(14);
  const { data, isLoading, error } = trpc.inventory.getSustainabilityTimeline.useQuery(
    { location: warehouse, windowDays },
    { refetchOnWindowFocus: false }
  );

  const rows = data?.rows ?? [];
  const shipmentCols = data?.shipmentColumns ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-neutral-900">
            Sustainability check {warehouse}
          </h1>
          <p className="text-sm text-neutral-500">
            {data
              ? `Sales window: ${formatYmd(data.windowStart)} – ${formatYmd(data.windowEnd)} (${data.windowDays}d) · Today: ${formatYmd(data.today)} · ${rows.length} SKUs · ${shipmentCols.length} upcoming shipment${shipmentCols.length === 1 ? "" : "s"}`
              : isLoading
              ? "Loading…"
              : ""}
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
          <WarehouseToggle value={warehouse} onChange={setWarehouse} />
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          Failed to load: {error.message}
        </div>
      )}

      <div className="rounded-md border border-neutral-200 bg-white">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-xs">
            {/* HEADER — two-row stacked: shipment column blocks span 5 cols each */}
            <thead className="bg-neutral-50 text-left text-[11px] uppercase tracking-wide text-neutral-600">
              <tr>
                <th
                  rowSpan={2}
                  className="sticky left-0 z-10 border-r border-neutral-200 bg-neutral-50 px-3 py-2 font-medium"
                >
                  SKU
                </th>
                <th rowSpan={2} className="px-3 py-2 font-medium">Product</th>
                <th rowSpan={2} className="px-3 py-2 text-right font-medium">Sales</th>
                <th rowSpan={2} className="px-3 py-2 text-right font-medium">Prorated 30D</th>
                <th
                  rowSpan={2}
                  className="border-r border-neutral-200 px-3 py-2 text-right font-medium"
                >
                  Stock
                </th>
                {shipmentCols.map((col, i) => (
                  <th
                    key={`${col.eta}|${col.shipmentName}`}
                    colSpan={5}
                    className={
                      "border-l-2 px-3 py-1 text-center font-medium " +
                      (i % 2 === 0 ? "bg-neutral-50 border-neutral-300" : "bg-blue-50/40 border-neutral-300")
                    }
                  >
                    <div className="text-neutral-900 normal-case">
                      {col.shipmentName}
                    </div>
                    <div className="font-normal lowercase tracking-normal text-neutral-500">
                      {formatYmd(col.eta)} · {col.daysFromToday}d
                    </div>
                  </th>
                ))}
              </tr>
              <tr>
                {shipmentCols.map((col, i) => {
                  const cls =
                    "border-l px-2 py-1 text-right font-medium " +
                    (i % 2 === 0 ? "bg-neutral-50 border-neutral-300" : "bg-blue-50/40 border-neutral-300");
                  return (
                    <>
                      <th
                        key={`${col.eta}|${col.shipmentName}|sales`}
                        className={"border-l-2 " + cls.replace("border-l ", "")}
                      >
                        Sales
                      </th>
                      <th key={`${col.eta}|${col.shipmentName}|left`} className={cls}>
                        Stock Left
                      </th>
                      <th key={`${col.eta}|${col.shipmentName}|run`} className={cls + " whitespace-nowrap"}>
                        Run Out
                      </th>
                      <th key={`${col.eta}|${col.shipmentName}|qty`} className={cls}>
                        Qty
                      </th>
                      <th key={`${col.eta}|${col.shipmentName}|after`} className={cls}>
                        After
                      </th>
                    </>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.sku} className="border-t border-neutral-100 hover:bg-neutral-50/50">
                  <td className="sticky left-0 z-10 border-r border-neutral-200 bg-white px-3 py-1.5 font-mono text-[11px] hover:bg-neutral-50/50">
                    {r.sku}
                  </td>
                  <td className="px-3 py-1.5 text-neutral-700">{r.productName}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{fmtNum(r.salesInWindow)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{fmtNum(r.proratedThirtyD)}</td>
                  <td className="border-r border-neutral-200 px-3 py-1.5 text-right tabular-nums">
                    {fmtNum(r.currentStock)}
                  </td>
                  {r.projections.map((p, i) => {
                    const colCls =
                      "border-l px-2 py-1.5 text-right tabular-nums " +
                      (i % 2 === 0 ? "" : "bg-blue-50/30");
                    const stockNeg = p.stockLeftAtEta < 0;
                    return (
                      <>
                        <td
                          key={`${r.sku}|${p.eta}|${p.shipmentName}|sales`}
                          className={"border-l-2 border-neutral-300 " + colCls.replace("border-l ", "")}
                        >
                          {fmtNum(p.salesInWindow)}
                        </td>
                        <td
                          key={`${r.sku}|${p.eta}|${p.shipmentName}|left`}
                          className={colCls + (stockNeg ? " text-red-600 font-medium" : "")}
                        >
                          {fmtNum(p.stockLeftAtEta)}
                        </td>
                        <td
                          key={`${r.sku}|${p.eta}|${p.shipmentName}|run`}
                          className={colCls + " text-neutral-500 whitespace-nowrap"}
                        >
                          {p.runOutDate ? formatYmd(p.runOutDate) : "—"}
                        </td>
                        <td
                          key={`${r.sku}|${p.eta}|${p.shipmentName}|qty`}
                          className={colCls}
                        >
                          {p.shipmentQty > 0 ? fmtNum(p.shipmentQty) : "—"}
                        </td>
                        <td
                          key={`${r.sku}|${p.eta}|${p.shipmentName}|after`}
                          className={colCls + " font-medium"}
                        >
                          {fmtNum(p.afterReceiptStock)}
                        </td>
                      </>
                    );
                  })}
                </tr>
              ))}
              {!isLoading && rows.length === 0 && (
                <tr>
                  <td colSpan={5 + shipmentCols.length * 5} className="px-4 py-8 text-center text-sm text-neutral-500">
                    No SKUs with stock or upcoming shipments in {warehouse}.
                  </td>
                </tr>
              )}
              {isLoading && (
                <tr>
                  <td colSpan={5 + shipmentCols.length * 5} className="px-4 py-8 text-center text-sm text-neutral-500">
                    Loading…
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
