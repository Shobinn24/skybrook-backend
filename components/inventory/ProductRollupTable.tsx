"use client";
import { Fragment, useMemo, useState } from "react";
import Link from "next/link";
import { FlagPill } from "./FlagPill";
import { SortableHeader, type SortConfig } from "@/components/shell/SortableHeader";
import type { WarehouseSelection } from "./WarehouseToggle";
import type { InventoryRow } from "@/lib/queries/inventory";

type SortKey =
  | "flag"
  | "productName"
  | "onHand"
  | "incoming"
  | "futureStock"
  | "velocity"
  | "weeksOfStock"
  | "futureWeeksOfStock"
  | "stockValue"
  | "skuCount";

// Worst-flag sort puts the most-urgent product on top.
const FLAG_RANK: Record<string, number> = {
  at_risk: 0,
  watch: 1,
  healthy: 2,
  overstocked: 3,
};

type Group = {
  productName: string;
  productLine: string | null;
  skus: InventoryRow[];
  onHand: number;
  incomingUnits: number;
  futureStock: number;
  stockValueUsd: number;
  velocityPerDay7d: number; // sum across SKUs — drives WoS math
  velocityDisplay: number; // velocity shown in the cell + used for sort
  weeksOfStock: number | null; // computed: onHand / (7d velocity × 7); null if 0
  futureWeeksOfStock: number | null; // computed: futureStock / (7d velocity × 7); null if 0
  worstFlag: "healthy" | "watch" | "at_risk" | "overstocked" | null;
  earliestRunOutDate: string | null;
};

function moneyDisplay(n: number): string {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

function weeksDisplay(w: number | null): string {
  if (w === null) return "—";
  if (!Number.isFinite(w)) return "∞";
  return w.toFixed(1);
}

export function ProductRollupTable({
  warehouse,
  rows,
  velocityLabel,
  velocityOverride,
}: {
  warehouse: WarehouseSelection;
  rows: InventoryRow[];
  velocityLabel?: string;
  /** Per-`${location}:${sku}` override for the displayed velocity. WoS
   * math intentionally still uses the row's 7d-based velocity so the
   * picker only changes the velocity column. */
  velocityOverride?: Map<string, number> | null;
}) {
  function rowVelocityDisplay(r: InventoryRow): number {
    if (velocityOverride) {
      return velocityOverride.get(`${r.location}:${r.sku}`) ?? 0;
    }
    return r.velocityPerDay7d ?? 0;
  }
  const [sort, setSort] = useState<SortConfig<SortKey>>({ key: "velocity", direction: "desc" });
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const groups = useMemo(() => {
    const needle = filter.trim().toLowerCase();

    // Group by productName. In "All" mode, the same product can have rows
    // at both warehouses — the rollup intentionally collapses across
    // warehouses so the per-product line gives a cross-warehouse view.
    // The expanded SKU sub-rows still call out each location.
    const matched = !needle
      ? rows
      : rows.filter(
          (r) =>
            r.sku.toLowerCase().includes(needle) ||
            r.productName.toLowerCase().includes(needle),
        );

    const byProduct = new Map<string, Group>();
    for (const r of matched) {
      const existing = byProduct.get(r.productName);
      if (existing) {
        existing.skus.push(r);
        existing.onHand += r.onHand;
        existing.incomingUnits += r.incomingUnits;
        existing.futureStock += r.futureStock;
        existing.stockValueUsd += r.stockValueUsd;
        existing.velocityPerDay7d += r.velocityPerDay7d ?? 0;
        existing.velocityDisplay += rowVelocityDisplay(r);
        if (
          r.flag &&
          (existing.worstFlag === null ||
            (FLAG_RANK[r.flag] ?? 99) < (FLAG_RANK[existing.worstFlag] ?? 99))
        ) {
          existing.worstFlag = r.flag;
        }
        if (
          r.runOutDate &&
          (!existing.earliestRunOutDate || r.runOutDate < existing.earliestRunOutDate)
        ) {
          existing.earliestRunOutDate = r.runOutDate;
        }
        continue;
      }
      byProduct.set(r.productName, {
        productName: r.productName,
        productLine: r.productLine,
        skus: [r],
        onHand: r.onHand,
        incomingUnits: r.incomingUnits,
        futureStock: r.futureStock,
        stockValueUsd: r.stockValueUsd,
        velocityPerDay7d: r.velocityPerDay7d ?? 0,
        velocityDisplay: rowVelocityDisplay(r),
        weeksOfStock: null, // computed below
        futureWeeksOfStock: null, // computed below
        worstFlag: r.flag,
        earliestRunOutDate: r.runOutDate,
      });
    }

    // Compute weeks-of-stock per group from totals so it stays
    // consistent with the rolled-up onHand + velocity numbers.
    for (const g of byProduct.values()) {
      g.weeksOfStock = g.velocityPerDay7d > 0
        ? g.onHand / g.velocityPerDay7d / 7
        : null;
      g.futureWeeksOfStock = g.velocityPerDay7d > 0
        ? g.futureStock / g.velocityPerDay7d / 7
        : null;
      // Stable SKU order in the expanded view — alphabetical so size
      // lists at least cluster by family.
      g.skus.sort((a, b) => a.sku.localeCompare(b.sku) || a.location.localeCompare(b.location));
    }

    const dir = sort.direction === "asc" ? 1 : -1;
    const nullish = (n: number | null) => (n === null ? Infinity : n);
    const arr = Array.from(byProduct.values());
    arr.sort((a, b) => {
      switch (sort.key) {
        case "productName":
          return a.productName.localeCompare(b.productName) * dir;
        case "skuCount":
          return (a.skus.length - b.skus.length) * dir;
        case "onHand":
          return (a.onHand - b.onHand) * dir;
        case "incoming":
          return (a.incomingUnits - b.incomingUnits) * dir;
        case "futureStock":
          return (a.futureStock - b.futureStock) * dir;
        case "velocity":
          return (a.velocityDisplay - b.velocityDisplay) * dir;
        case "weeksOfStock":
          return (nullish(a.weeksOfStock) - nullish(b.weeksOfStock)) * dir;
        case "futureWeeksOfStock":
          return (nullish(a.futureWeeksOfStock) - nullish(b.futureWeeksOfStock)) * dir;
        case "stockValue":
          return (a.stockValueUsd - b.stockValueUsd) * dir;
        case "flag":
        default: {
          const fa = a.worstFlag ? FLAG_RANK[a.worstFlag] ?? 99 : 99;
          const fb = b.worstFlag ? FLAG_RANK[b.worstFlag] ?? 99 : 99;
          if (fa !== fb) return (fa - fb) * dir;
          return nullish(a.weeksOfStock) - nullish(b.weeksOfStock);
        }
      }
    });
    return arr;
  }, [rows, sort, filter, velocityOverride]);

  const isOpen = (name: string) => expanded.has(name);
  const toggle = (name: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  const allOpen = groups.length > 0 && groups.every((g) => isOpen(g.productName));
  const expandAll = () =>
    setExpanded(allOpen ? new Set() : new Set(groups.map((g) => g.productName)));

  return (
    <div className="rounded-md border border-neutral-200 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-neutral-200 px-4 py-2">
        <div className="text-sm font-medium">Inventory by product — {warehouse}</div>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter SKU or product…"
          className="rounded border border-neutral-300 px-2 py-1 text-sm"
        />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 z-20 bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-600 shadow-[0_1px_0_0_rgba(0,0,0,0.05)]">
            <tr>
              <th className="w-8 px-2 py-2">
                <button
                  onClick={expandAll}
                  title={allOpen ? "Collapse all" : "Expand all"}
                  className="text-neutral-400 hover:text-neutral-700"
                >
                  {allOpen ? "−" : "+"}
                </button>
              </th>
              <SortableHeader label="Product" sortKey="productName" config={sort} onChange={setSort} />
              <SortableHeader label="SKUs" sortKey="skuCount" config={sort} onChange={setSort} align="right" />
              <SortableHeader label="Stock" sortKey="onHand" config={sort} onChange={setSort} align="right" />
              <SortableHeader label="Incoming" sortKey="incoming" config={sort} onChange={setSort} align="right" />
              <SortableHeader label="Future stock" sortKey="futureStock" config={sort} onChange={setSort} align="right" />
              <SortableHeader label={`Velocity/day${velocityLabel ? ` (${velocityLabel})` : ""}`} sortKey="velocity" config={sort} onChange={setSort} align="right" />
              <SortableHeader label="WOS" sortKey="weeksOfStock" config={sort} onChange={setSort} align="right" />
              <SortableHeader label="FUT WOS" sortKey="futureWeeksOfStock" config={sort} onChange={setSort} align="right" />
              <th className="px-4 py-2 text-left text-xs uppercase tracking-wide text-neutral-600">Runs out</th>
              <SortableHeader label="Status" sortKey="flag" config={sort} onChange={setSort} />
              <SortableHeader label="Stock value" sortKey="stockValue" config={sort} onChange={setSort} align="right" />
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => {
              const open = isOpen(g.productName);
              return (
                <Fragment key={g.productName}>
                  <tr
                    className="cursor-pointer border-t border-neutral-100 hover:bg-neutral-50"
                    onClick={() => toggle(g.productName)}
                  >
                    <td className="px-2 py-2 text-center text-neutral-500">
                      <span aria-hidden>{open ? "▾" : "▸"}</span>
                    </td>
                    <td className="px-4 py-2 text-neutral-900">
                      <span className="font-medium">{g.productName}</span>
                      {g.productLine ? (
                        <span className="ml-2 text-xs text-neutral-400">{g.productLine}</span>
                      ) : null}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-right tabular-nums text-neutral-600">
                      {g.skus.length}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-right tabular-nums">
                      {g.onHand.toLocaleString()}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-right tabular-nums text-neutral-600">
                      {g.incomingUnits.toLocaleString()}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-right tabular-nums font-medium text-neutral-900">
                      {g.futureStock.toLocaleString()}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-right tabular-nums">
                      {g.velocityDisplay > 0 ? g.velocityDisplay.toFixed(2) : "—"}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-right tabular-nums">
                      {weeksDisplay(g.weeksOfStock)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-right tabular-nums text-neutral-700">
                      {weeksDisplay(g.futureWeeksOfStock)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-xs text-neutral-600">
                      {g.earliestRunOutDate ?? "—"}
                    </td>
                    <td className="px-4 py-2">
                      <FlagPill flag={g.worstFlag} />
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-right tabular-nums">
                      {moneyDisplay(g.stockValueUsd)}
                    </td>
                  </tr>
                  {open &&
                    g.skus.map((s) => (
                      <tr
                        key={`${g.productName}|${s.sku}|${s.location}`}
                        className="border-t border-neutral-100 bg-neutral-50/40"
                      >
                        <td className="px-2 py-1.5"></td>
                        <td className="px-4 py-1.5 pl-10 font-mono text-[11px] text-neutral-700">
                          <Link
                            href={`/sku/${encodeURIComponent(s.sku)}`}
                            className="hover:text-neutral-900 hover:underline"
                          >
                            {s.sku}
                          </Link>
                          <span className="ml-2 text-[10px] uppercase tracking-wide text-neutral-400">
                            {s.location}
                          </span>
                        </td>
                        <td />
                        <td className="whitespace-nowrap px-4 py-1.5 text-right tabular-nums text-neutral-600">
                          {s.onHand.toLocaleString()}
                        </td>
                        <td className="whitespace-nowrap px-4 py-1.5 text-right tabular-nums text-neutral-500">
                          {s.incomingUnits.toLocaleString()}
                        </td>
                        <td className="whitespace-nowrap px-4 py-1.5 text-right tabular-nums text-neutral-700">
                          {s.futureStock.toLocaleString()}
                        </td>
                        <td className="whitespace-nowrap px-4 py-1.5 text-right tabular-nums text-neutral-500">
                          {s.velocityPerDay7d !== null ? s.velocityPerDay7d.toFixed(2) : "—"}
                        </td>
                        <td className="whitespace-nowrap px-4 py-1.5 text-right tabular-nums text-neutral-500">
                          {weeksDisplay(s.weeksOfStock)}
                        </td>
                        <td className="whitespace-nowrap px-4 py-1.5 text-right tabular-nums text-neutral-500">
                          {weeksDisplay(s.futureWeeksOfStock)}
                        </td>
                        <td className="whitespace-nowrap px-4 py-1.5 text-xs text-neutral-500">
                          {s.runOutDate ?? "—"}
                        </td>
                        <td className="px-4 py-1.5">
                          <FlagPill flag={s.flag} />
                        </td>
                        <td className="whitespace-nowrap px-4 py-1.5 text-right tabular-nums text-neutral-600">
                          {moneyDisplay(s.stockValueUsd)}
                        </td>
                      </tr>
                    ))}
                </Fragment>
              );
            })}
            {groups.length === 0 && (
              <tr>
                <td colSpan={12} className="px-4 py-6 text-center text-sm text-neutral-500">
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
