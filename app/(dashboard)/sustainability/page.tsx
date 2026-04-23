"use client";
import { useMemo, useState } from "react";
import { FlagPill } from "@/components/inventory/FlagPill";
import { KpiCard } from "@/components/inventory/KpiCard";
import { trpc } from "@/lib/trpc/client";

type Filter = "all" | "at_risk" | "watch" | "healthy" | "overstocked";

const FLAG_ORDER: Record<string, number> = {
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

export default function SustainabilityPage() {
  const us = trpc.inventory.getInventoryRows.useQuery({ location: "US" });
  const cn = trpc.inventory.getInventoryRows.useQuery({ location: "CN" });
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");

  const rows = useMemo(() => {
    const all = [...(us.data ?? []), ...(cn.data ?? [])];
    const filtered = all.filter((r) => {
      if (filter !== "all" && r.flag !== filter) return false;
      if (
        search.trim() &&
        !r.sku.toLowerCase().includes(search.toLowerCase()) &&
        !r.productName.toLowerCase().includes(search.toLowerCase())
      ) {
        return false;
      }
      return true;
    });
    return filtered.sort((a, b) => {
      const fa = a.flag ? FLAG_ORDER[a.flag] ?? 99 : 99;
      const fb = b.flag ? FLAG_ORDER[b.flag] ?? 99 : 99;
      if (fa !== fb) return fa - fb;
      const toNum = (x: number | null) => (x === null ? Infinity : x);
      return toNum(a.weeksOfStock) - toNum(b.weeksOfStock);
    });
  }, [us.data, cn.data, filter, search]);

  const counts = useMemo(() => {
    const all = [...(us.data ?? []), ...(cn.data ?? [])];
    return {
      at_risk: all.filter((r) => r.flag === "at_risk").length,
      watch: all.filter((r) => r.flag === "watch").length,
      healthy: all.filter((r) => r.flag === "healthy").length,
      overstocked: all.filter((r) => r.flag === "overstocked").length,
    };
  }, [us.data, cn.data]);

  const loading = us.isLoading || cn.isLoading;
  const error = us.error ?? cn.error;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-neutral-900">Sustainability report</h1>
        <p className="text-sm text-neutral-500">
          Projected run-out dates walk forward through upcoming POs. At-risk = stocks out before next PO.
          Watch = stocks out between this PO and the next.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <KpiCard
          label="At risk"
          value={counts.at_risk}
          tone={counts.at_risk > 0 ? "danger" : "neutral"}
        />
        <KpiCard
          label="Watch"
          value={counts.watch}
          tone={counts.watch > 0 ? "warn" : "neutral"}
        />
        <KpiCard label="Healthy" value={counts.healthy} />
        <KpiCard label="Overstocked" value={counts.overstocked} />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-2">
          {(["all", "at_risk", "watch", "healthy", "overstocked"] as Filter[]).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={
                "rounded-full border px-3 py-1 text-xs font-medium " +
                (filter === f
                  ? "border-neutral-900 bg-neutral-900 text-white"
                  : "border-neutral-300 bg-white text-neutral-700 hover:bg-neutral-100")
              }
            >
              {f === "all" ? "All" : f.replace("_", " ")}
            </button>
          ))}
        </div>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter SKU or product…"
          className="rounded border border-neutral-300 px-2 py-1 text-sm"
        />
      </div>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          Failed to load: {error.message}
        </div>
      )}

      <div className="rounded-md border border-neutral-200 bg-white">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-600">
              <tr>
                <th className="px-4 py-2 font-medium">SKU</th>
                <th className="px-4 py-2 font-medium">Product</th>
                <th className="px-4 py-2 font-medium">Location</th>
                <th className="px-4 py-2 font-medium text-right">Stock</th>
                <th className="px-4 py-2 font-medium text-right">Velocity/day</th>
                <th className="px-4 py-2 font-medium text-right">Weeks of stock</th>
                <th className="px-4 py-2 font-medium">Run-out date</th>
                <th className="px-4 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.sku}-${r.location}`} className="border-t border-neutral-100">
                  <td className="whitespace-nowrap px-4 py-2 font-mono text-xs">{r.sku}</td>
                  <td className="px-4 py-2">{r.productName}</td>
                  <td className="px-4 py-2">{r.location}</td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {r.onHand.toLocaleString()}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {r.velocityPerDay7d !== null ? r.velocityPerDay7d.toFixed(2) : "—"}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {weeksDisplay(r.weeksOfStock)}
                  </td>
                  <td className="px-4 py-2 text-neutral-600">{r.runOutDate ?? "—"}</td>
                  <td className="px-4 py-2">
                    <FlagPill flag={r.flag} />
                  </td>
                </tr>
              ))}
              {!loading && rows.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-6 text-center text-sm text-neutral-500">
                    {filter === "all"
                      ? "No sustainability data yet. Run the daily ingest to populate."
                      : `No SKUs in ${filter.replace("_", " ")} category.`}
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
