"use client";

import { Fragment, useMemo, useState } from "react";
import Link from "next/link";
import { SortableHeader, type SortConfig } from "@/components/shell/SortableHeader";
import { TracedNumber } from "@/components/trace/TracedNumber";
import type { NumberTrace } from "@/lib/queries/inventory";
import type { SustainabilityTimelineResult } from "@/lib/queries/sustainability-timeline";

type SustainSortKey = "sku" | "product" | "sales" | "salesDollars" | "prorated" | "stock";

function fmtMoney(n: number): string {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

function formatYmd(ymd: string): string {
  // "2026-05-03" → "3 May 26" — matches Scott's sheet's tight format.
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

/**
 * The full per-delivery sustainability timeline table. Self-contained
 * with its own sort state so two instances (US + CN) on the same page
 * can be sorted independently. The page handles warehouse / window
 * selection and which instances to render.
 *
 * Sorting only applies to the 5 sticky-left columns. Per-shipment
 * column blocks stay aligned to row order — sorting by per-shipment
 * cells would shuffle rows in 5-cell-wide column blocks and read as
 * noise rather than signal.
 *
 * Filters (`searchQuery` + `productLineFilter`) come from the page so
 * the same filter state applies to both US and CN tables — operators
 * typically scan the same SKU/family across both warehouses.
 */
export function SustainabilityTimelineTable({
  data,
  isLoading,
  location,
  searchQuery = "",
  productLineFilter = "",
}: {
  data: SustainabilityTimelineResult | undefined;
  isLoading: boolean;
  location: "US" | "CN";
  searchQuery?: string;
  productLineFilter?: string;
}) {
  const [sort, setSort] = useState<SortConfig<SustainSortKey>>({
    key: "sku",
    direction: "asc",
  });

  const rawRows = data?.rows ?? [];
  const shipmentCols = data?.shipmentColumns ?? [];

  const rows = useMemo(() => {
    const dir = sort.direction === "asc" ? 1 : -1;
    const cmp = (a: typeof rawRows[number], b: typeof rawRows[number]): number => {
      switch (sort.key) {
        case "sku":
          return a.sku.localeCompare(b.sku) * dir;
        case "product":
          return a.productName.localeCompare(b.productName) * dir;
        case "sales":
          return (a.salesInWindow - b.salesInWindow) * dir;
        case "salesDollars":
          return (a.salesDollarsInWindow - b.salesDollarsInWindow) * dir;
        case "prorated":
          return (a.proratedThirtyD - b.proratedThirtyD) * dir;
        case "stock":
          return (a.currentStock - b.currentStock) * dir;
      }
    };
    const q = searchQuery.trim().toLowerCase();
    const filtered = rawRows.filter((r) => {
      if (productLineFilter && r.productLine !== productLineFilter) return false;
      if (q && !r.sku.toLowerCase().includes(q) && !r.productName.toLowerCase().includes(q)) return false;
      return true;
    });
    return [...filtered].sort(cmp);
  }, [rawRows, sort, searchQuery, productLineFilter]);

  return (
    <section className="space-y-2">
      <header className="flex items-baseline justify-between gap-3">
        <h2 className="text-base font-semibold text-neutral-900">
          {location} warehouse
        </h2>
        <p className="text-xs text-neutral-500">
          {data
            ? `${formatYmd(data.windowStart)} – ${formatYmd(data.windowEnd)} (${data.windowDays}d) · ${rows.length} SKUs · ${shipmentCols.length} upcoming shipment${shipmentCols.length === 1 ? "" : "s"}`
            : isLoading
              ? "Loading…"
              : ""}
        </p>
      </header>

      <div className="rounded-md border border-neutral-200 bg-white">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-xs">
            {/* HEADER — two-row stacked: shipment column blocks span 5 cols each.
                Sticky so the date/shipment labels stay visible while scrolling
                vertically through long SKU lists. */}
            <thead className="sticky top-0 z-20 bg-neutral-50 text-left text-[11px] uppercase tracking-wide text-neutral-600 shadow-[0_1px_0_0_rgba(0,0,0,0.05)]">
              <tr>
                <SortableHeader<SustainSortKey>
                  label="SKU"
                  sortKey="sku"
                  config={sort}
                  onChange={setSort}
                  rowSpan={2}
                  paddingClass="px-3 py-2"
                  className="sticky left-0 z-10 border-r border-neutral-200 bg-neutral-50"
                />
                <SortableHeader<SustainSortKey>
                  label="Product"
                  sortKey="product"
                  config={sort}
                  onChange={setSort}
                  rowSpan={2}
                  paddingClass="px-3 py-2"
                />
                <SortableHeader<SustainSortKey>
                  label="Sales"
                  sortKey="sales"
                  config={sort}
                  onChange={setSort}
                  align="right"
                  rowSpan={2}
                  paddingClass="px-3 py-2"
                />
                <SortableHeader<SustainSortKey>
                  label="Sales $"
                  sortKey="salesDollars"
                  config={sort}
                  onChange={setSort}
                  align="right"
                  rowSpan={2}
                  paddingClass="px-3 py-2"
                />
                <SortableHeader<SustainSortKey>
                  label="Prorated 30D"
                  sortKey="prorated"
                  config={sort}
                  onChange={setSort}
                  align="right"
                  rowSpan={2}
                  paddingClass="px-3 py-2"
                />
                <SortableHeader<SustainSortKey>
                  label="Stock"
                  sortKey="stock"
                  config={sort}
                  onChange={setSort}
                  align="right"
                  rowSpan={2}
                  paddingClass="px-3 py-2"
                  className="border-r border-neutral-200"
                />
                {shipmentCols.map((col, i) => {
                  const isTerminal = col.kind === "terminal";
                  const baseBg = isTerminal
                    ? "bg-amber-50 border-amber-300"
                    : i % 2 === 0
                      ? "bg-neutral-50 border-neutral-300"
                      : "bg-blue-50/40 border-neutral-300";
                  return (
                    <th
                      key={`${col.eta}|${col.shipmentName}`}
                      colSpan={5}
                      className={"border-l-2 px-3 py-1 text-center font-medium " + baseBg}
                    >
                      <div className="text-neutral-900 normal-case">
                        {isTerminal ? "+30d outlook" : col.shipmentName}
                      </div>
                      <div className="font-normal lowercase tracking-normal text-neutral-500">
                        {formatYmd(col.eta)} · {col.daysFromToday}d
                      </div>
                    </th>
                  );
                })}
              </tr>
              <tr>
                {shipmentCols.map((col, i) => {
                  const isTerminal = col.kind === "terminal";
                  const baseBg = isTerminal
                    ? "bg-amber-50 border-amber-300"
                    : i % 2 === 0
                      ? "bg-neutral-50 border-neutral-300"
                      : "bg-blue-50/40 border-neutral-300";
                  const cls = "border-l px-2 py-1 text-right font-medium " + baseBg;
                  // Fragment with a key so React can identify each
                  // 5-column block. `<>` shorthand can't take a key,
                  // which is what the original page warned about.
                  return (
                    <Fragment key={`${col.eta}|${col.shipmentName}`}>
                      <th
                        className={"border-l-2 " + cls.replace("border-l ", "")}
                      >
                        Sales
                      </th>
                      <th className={cls}>
                        Stock Left
                      </th>
                      <th className={cls + " whitespace-nowrap"}>
                        Run Out
                      </th>
                      <th className={cls}>
                        Qty
                      </th>
                      <th className={cls}>
                        After
                      </th>
                    </Fragment>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.sku} className="border-t border-neutral-100 hover:bg-neutral-50/50">
                  <td className="sticky left-0 z-10 border-r border-neutral-200 bg-white px-3 py-1.5 font-mono text-[11px] hover:bg-neutral-50/50">
                    <Link
                      href={`/sku/${encodeURIComponent(r.sku)}`}
                      className="hover:text-neutral-600 hover:underline"
                    >
                      {r.sku}
                    </Link>
                  </td>
                  <td className="px-3 py-1.5 text-neutral-700">{r.productName}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">
                    <TracedNumber trace={salesTrace(r, data, location)}>
                      {fmtNum(r.salesInWindow)}
                    </TracedNumber>
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-neutral-700">
                    {r.salesDollarsInWindow > 0 ? fmtMoney(r.salesDollarsInWindow) : "—"}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums">
                    <TracedNumber trace={proratedTrace(r, data, location)}>
                      {fmtNum(r.proratedThirtyD)}
                    </TracedNumber>
                  </td>
                  <td className="border-r border-neutral-200 px-3 py-1.5 text-right tabular-nums">
                    <TracedNumber trace={stockTrace(r, location)}>
                      {fmtNum(r.currentStock)}
                    </TracedNumber>
                  </td>
                  {r.projections.map((p, i) => {
                    // Stockout = projected on-hand at the next ETA goes negative
                    // OR a run-out date falls inside this projection window.
                    // Both signal "we'll be out of stock before the next PO
                    // lands" — Scott wants those cells obviously red.
                    const stockOut = p.stockLeftAtEta < 0 || p.runOutDate !== null;
                    const isTerminal = shipmentCols[i]?.kind === "terminal";
                    // Striped column background. Terminal "+30d outlook"
                    // column gets amber. Stockout overrides with red so
                    // the warning isn't muted by the stripe / outlook tint.
                    const stripeBg = isTerminal
                      ? "bg-amber-50/60"
                      : i % 2 === 0
                        ? ""
                        : "bg-blue-50/30";
                    const stockoutBg = stockOut ? "bg-red-50" : stripeBg;
                    const colCls =
                      "border-l px-2 py-1.5 text-right tabular-nums " + stockoutBg;
                    return (
                      <Fragment key={`${r.sku}|${p.eta}|${p.shipmentName}`}>
                        <td
                          className={"border-l-2 border-neutral-300 " + colCls.replace("border-l ", "")}
                        >
                          {fmtNum(p.salesInWindow)}
                        </td>
                        <td className={colCls + (stockOut ? " text-red-700 font-semibold" : "")}>
                          {fmtNum(p.stockLeftAtEta)}
                        </td>
                        <td className={colCls + " whitespace-nowrap " + (p.runOutDate ? "text-red-700 font-medium" : "text-neutral-500")}>
                          {p.runOutDate ? formatYmd(p.runOutDate) : "—"}
                        </td>
                        <td className={colCls}>
                          {p.shipmentQty > 0 ? fmtNum(p.shipmentQty) : "—"}
                        </td>
                        <td className={colCls + " font-medium" + (stockOut && p.afterReceiptStock < 0 ? " text-red-700" : "")}>
                          {fmtNum(p.afterReceiptStock)}
                        </td>
                      </Fragment>
                    );
                  })}
                </tr>
              ))}
              {!isLoading && rows.length === 0 && (
                <tr>
                  <td
                    colSpan={6 + shipmentCols.length * 5}
                    className="px-4 py-8 text-center text-sm text-neutral-500"
                  >
                    No SKUs with stock or upcoming shipments in {location}.
                  </td>
                </tr>
              )}
              {isLoading && (
                <tr>
                  <td
                    colSpan={6 + shipmentCols.length * 5}
                    className="px-4 py-8 text-center text-sm text-neutral-500"
                  >
                    Loading…
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

// Trace builders — synthesize NumberTrace payloads inline from row +
// data context. Cheap to compute per-row and keeps the JSX terse.

type RowT = SustainabilityTimelineResult["rows"][number];

function salesTrace(
  r: RowT,
  data: SustainabilityTimelineResult | undefined,
  location: "US" | "CN",
): NumberTrace | null {
  if (!data) return null;
  const channel = location === "US" ? "shopify_us" : "shopify_intl";
  return {
    label: `Sales in window — ${r.sku} @ ${location}`,
    formula: `Σ daily_sales.units_sold for ${data.windowStart} → ${data.windowEnd} (${data.windowDays}d)`,
    inputs: [
      { label: "Window", value: `${data.windowDays}d` },
      { label: "From", value: data.windowStart },
      { label: "To", value: data.windowEnd },
      { label: "Channel", value: channel },
      { label: "Units in window", value: r.salesInWindow.toLocaleString() },
    ],
    sources: [
      { label: "Source", ref: `daily_sales (channel='${channel}')` },
      {
        label: "Routing",
        ref: "shopify_us → US warehouse, shopify_intl → CN warehouse",
      },
    ],
  };
}

function proratedTrace(
  r: RowT,
  data: SustainabilityTimelineResult | undefined,
  location: "US" | "CN",
): NumberTrace | null {
  if (!data || data.windowDays <= 0) return null;
  const factor = 30 / data.windowDays;
  return {
    label: `Prorated 30D — ${r.sku} @ ${location}`,
    formula: "salesInWindow × (30 / windowDays)",
    inputs: [
      { label: "Sales in window", value: r.salesInWindow.toLocaleString() },
      { label: "Window", value: `${data.windowDays}d` },
      { label: "Multiplier", value: factor.toFixed(3) },
      { label: "Prorated 30D", value: r.proratedThirtyD.toLocaleString() },
    ],
    sources: [
      { label: "Computed in", ref: "lib/queries/sustainability-timeline.ts" },
      {
        label: "Why",
        ref: "Lets operators compare any window length on a common 30-day basis.",
      },
    ],
  };
}

function stockTrace(r: RowT, location: "US" | "CN"): NumberTrace | null {
  return {
    label: `Current stock — ${r.sku} @ ${location}`,
    formula: "Latest snapshot from the inventory sheet at this warehouse.",
    inputs: [
      { label: "On hand", value: `${r.currentStock.toLocaleString()} units` },
    ],
    sources: [
      { label: "Source", ref: "stock_snapshots (latest per sku, location)" },
    ],
  };
}
