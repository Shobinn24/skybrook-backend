"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { KpiCard } from "@/components/inventory/KpiCard";
import { StatusPill } from "@/components/shell/StatusPill";
import { SortableHeader, type SortConfig } from "@/components/shell/SortableHeader";
import { trpc } from "@/lib/trpc/client";

type LocationFilter = "all" | "US" | "CN";

type SortKey =
  | "sku"
  | "productName"
  | "destination"
  | "shipmentName"
  | "status"
  | "quantity"
  | "expectedArrival";

const STATUS_LABEL: Record<string, string> = {
  po: "PO",
  dispatched: "Dispatched",
  in_transit: "In transit",
  arrived: "Arrived",
};

const STATUS_PILL_KIND: Record<string, "gray" | "yellow" | "green"> = {
  po: "gray",
  dispatched: "yellow",
  in_transit: "yellow",
  arrived: "green",
};

function fmtNumber(n: number): string {
  return n.toLocaleString("en-US");
}

function fmtDate(ymd: string): string {
  // ymd comes back as YYYY-MM-DD; treat as local-day so we don't shift across UTC.
  const [y, m, d] = ymd.split("-").map((s) => Number(s));
  if (!y || !m || !d) return ymd;
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function daysFromToday(ymd: string): number | null {
  const [y, m, d] = ymd.split("-").map((s) => Number(s));
  if (!y || !m || !d) return null;
  const target = new Date(y, m - 1, d);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  target.setHours(0, 0, 0, 0);
  const ms = target.getTime() - today.getTime();
  return Math.round(ms / 86_400_000);
}

function relativeArrival(ymd: string): { label: string; tone: "neutral" | "warn" | "danger" | "good" } {
  const days = daysFromToday(ymd);
  if (days === null) return { label: ymd, tone: "neutral" };
  if (days < 0) return { label: `${-days}d overdue`, tone: "danger" };
  if (days === 0) return { label: "Today", tone: "good" };
  if (days === 1) return { label: "Tomorrow", tone: "warn" };
  if (days <= 7) return { label: `In ${days} days`, tone: "warn" };
  if (days <= 30) return { label: `In ${days} days`, tone: "neutral" };
  const weeks = Math.round(days / 7);
  return { label: `In ${weeks} weeks`, tone: "neutral" };
}

const TONE_CLASS: Record<"neutral" | "warn" | "danger" | "good", string> = {
  neutral: "text-neutral-600",
  warn: "text-yellow-700 font-medium",
  danger: "text-red-700 font-medium",
  good: "text-green-700 font-medium",
};

export default function IncomingShipmentsPage() {
  const [location, setLocation] = useState<LocationFilter>("all");
  const [includeArrived, setIncludeArrived] = useState(false);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortConfig<SortKey>>({
    key: "expectedArrival",
    direction: "asc",
  });

  const { data, isLoading, error } = trpc.inventory.getIncomingShipmentsView.useQuery({
    destination: location === "all" ? undefined : location,
    includeArrived,
  });

  const filteredRows = useMemo(() => {
    const rows = data?.rows ?? [];
    const matched = !search.trim()
      ? rows
      : rows.filter((r) => {
          const needle = search.toLowerCase();
          return (
            r.sku.toLowerCase().includes(needle) ||
            (r.productName ?? "").toLowerCase().includes(needle) ||
            r.shipmentName.toLowerCase().includes(needle)
          );
        });
    const dir = sort.direction === "asc" ? 1 : -1;
    return [...matched].sort((a, b) => {
      switch (sort.key) {
        case "sku": return a.sku.localeCompare(b.sku) * dir;
        case "productName": return (a.productName ?? "").localeCompare(b.productName ?? "") * dir;
        case "destination": return a.destination.localeCompare(b.destination) * dir;
        case "shipmentName": return a.shipmentName.localeCompare(b.shipmentName) * dir;
        case "status": return a.status.localeCompare(b.status) * dir;
        case "quantity": return (a.quantity - b.quantity) * dir;
        case "expectedArrival":
        default:
          return a.expectedArrival.localeCompare(b.expectedArrival) * dir;
      }
    });
  }, [data?.rows, search, sort]);

  if (isLoading) {
    return <div className="text-sm text-neutral-500">Loading incoming shipments…</div>;
  }
  if (error) {
    return (
      <div className="rounded border border-red-200 bg-red-50 p-4 text-sm text-red-800">
        Failed to load incoming shipments: {error.message}
      </div>
    );
  }

  const summary = data?.summary ?? {
    totalUnits: 0,
    shipmentCount: 0,
    skuCount: 0,
    nextArrival: null as string | null,
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-neutral-900">Incoming shipments</h1>
        <p className="mt-1 text-sm text-neutral-600">
          POs, dispatched, and in-transit shipments arriving at US and CN warehouses.
          Sorted by expected arrival — soonest first. Already-arrived shipments
          are hidden by default since those units already count in stock.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <KpiCard
          label="Units inbound"
          value={fmtNumber(summary.totalUnits)}
        />
        <KpiCard
          label="Shipments"
          value={summary.shipmentCount}
        />
        <KpiCard
          label="Distinct SKUs"
          value={summary.skuCount}
        />
        <KpiCard
          label="Next arrival"
          value={summary.nextArrival ? fmtDate(summary.nextArrival) : "—"}
          hint={summary.nextArrival ? relativeArrival(summary.nextArrival).label : undefined}
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
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
          <label className="ml-2 inline-flex items-center gap-2 text-xs text-neutral-700">
            <input
              type="checkbox"
              checked={includeArrived}
              onChange={(e) => setIncludeArrived(e.target.checked)}
              className="h-3.5 w-3.5"
            />
            Show arrived
          </label>
        </div>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter SKU, product, or shipment…"
          className="rounded border border-neutral-300 px-2 py-1 text-sm"
        />
      </div>

      <div className="rounded border border-neutral-200 bg-white">
        {filteredRows.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-neutral-500">
            {summary.shipmentCount === 0
              ? "No incoming shipments are currently tracked. New POs land in the Incoming Google Sheet and refresh daily at 10am EST."
              : "No shipments match the current filter."}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500">
                <tr>
                  <SortableHeader label="SKU" sortKey="sku" config={sort} onChange={setSort} />
                  <SortableHeader label="Product" sortKey="productName" config={sort} onChange={setSort} />
                  <SortableHeader label="Destination" sortKey="destination" config={sort} onChange={setSort} />
                  <SortableHeader label="Shipment" sortKey="shipmentName" config={sort} onChange={setSort} />
                  <SortableHeader label="Status" sortKey="status" config={sort} onChange={setSort} />
                  <SortableHeader label="Quantity" sortKey="quantity" config={sort} onChange={setSort} align="right" />
                  <SortableHeader label="Expected arrival" sortKey="expectedArrival" config={sort} onChange={setSort} />
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {filteredRows.map((r) => {
                  const rel = relativeArrival(r.expectedArrival);
                  return (
                    <tr key={r.id} className="hover:bg-neutral-50">
                      <td className="whitespace-nowrap px-4 py-2 font-medium text-neutral-900">
                        <Link
                          href={`/sku/${encodeURIComponent(r.sku)}`}
                          className="hover:text-neutral-600 hover:underline"
                        >
                          {r.sku}
                        </Link>
                      </td>
                      <td className="px-4 py-2 text-neutral-700">
                        {r.productName ?? <span className="text-neutral-400">—</span>}
                        {r.productLine ? (
                          <span className="ml-2 text-xs text-neutral-400">
                            {r.productLine}
                          </span>
                        ) : null}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2 text-neutral-700">
                        {r.destination}
                      </td>
                      <td className="px-4 py-2 text-neutral-700">{r.shipmentName}</td>
                      <td className="px-4 py-2">
                        <StatusPill
                          kind={STATUS_PILL_KIND[r.status] ?? "gray"}
                          label={STATUS_LABEL[r.status] ?? r.status}
                        />
                      </td>
                      <td className="whitespace-nowrap px-4 py-2 text-right tabular-nums text-neutral-700">
                        {fmtNumber(r.quantity)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2">
                        <div className="text-neutral-700">{fmtDate(r.expectedArrival)}</div>
                        <div className={"text-xs " + TONE_CLASS[rel.tone]}>{rel.label}</div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
