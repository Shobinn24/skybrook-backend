"use client";

import { Fragment, useMemo, useState } from "react";
import Link from "next/link";
import { KpiCard } from "@/components/inventory/KpiCard";
import { StatusPill } from "@/components/shell/StatusPill";
import { SortableHeader, type SortConfig } from "@/components/shell/SortableHeader";
import { trpc } from "@/lib/trpc/client";

type LocationFilter = "all" | "US" | "CN";
type DisplayStatus = "pending" | "overdue" | "received";

// Group-level sort keys. SKU isn't here because groups roll up multiple
// SKUs and sorting by a single SKU would be ambiguous.
type GroupSortKey =
  | "productName"
  | "destination"
  | "shipmentName"
  | "status"
  | "quantity"
  | "expectedArrival";

const STATUS_LABEL: Record<DisplayStatus, string> = {
  pending: "Pending",
  overdue: "Overdue",
  received: "Received",
};

const STATUS_PILL_KIND: Record<DisplayStatus, "gray" | "yellow" | "green" | "red"> = {
  pending: "gray",
  overdue: "red",
  received: "green",
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

type Group = {
  key: string;
  destination: "US" | "CN";
  shipmentName: string;
  productName: string;
  productLine: string | null;
  displayStatus: DisplayStatus;
  expectedArrival: string;
  totalQuantity: number;
  // Sub-rows: one per SKU contributing to the group total.
  skuRows: Array<{
    id: number | string;
    sku: string;
    quantity: number;
  }>;
};

export default function IncomingShipmentsPage() {
  const [location, setLocation] = useState<LocationFilter>("all");
  const [includeReceived, setIncludeReceived] = useState(false);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortConfig<GroupSortKey>>({
    key: "expectedArrival",
    direction: "asc",
  });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const utils = trpc.useUtils();
  const { data, isLoading, error } = trpc.inventory.getIncomingShipmentsView.useQuery({
    destination: location === "all" ? undefined : location,
    includeReceived,
  });

  const markReceived = trpc.inventory.markIncomingReceived.useMutation({
    onSuccess: () => utils.inventory.getIncomingShipmentsView.invalidate(),
  });
  const unmarkReceived = trpc.inventory.unmarkIncomingReceived.useMutation({
    onSuccess: () => utils.inventory.getIncomingShipmentsView.invalidate(),
  });

  // Pipeline: filter underlying rows → group by (shipment + product +
  // warehouse + status + ETA) → sort groups. Search auto-expands any
  // group containing a matched SKU so the SKU is visible by default.
  const { groups, autoExpandKeys } = useMemo(() => {
    const rows = data?.rows ?? [];
    const needle = search.trim().toLowerCase();

    // Each row may match the search via the GROUP fields (product /
    // shipment) or via the SKU itself. SKU-level matches drive
    // auto-expansion.
    const matchedRows = !needle
      ? rows
      : rows.filter((r) => {
          return (
            r.sku.toLowerCase().includes(needle) ||
            (r.productName ?? "").toLowerCase().includes(needle) ||
            r.shipmentName.toLowerCase().includes(needle)
          );
        });

    const skuMatchKeys = new Set<string>();
    if (needle) {
      for (const r of matchedRows) {
        if (r.sku.toLowerCase().includes(needle)) {
          skuMatchKeys.add(`${r.shipmentName}|${r.destination}|${r.productName ?? r.sku}|${r.displayStatus}|${r.expectedArrival}`);
        }
      }
    }

    const byKey = new Map<string, Group>();
    for (const r of matchedRows) {
      const productName = r.productName ?? r.sku;
      const key = `${r.shipmentName}|${r.destination}|${productName}|${r.displayStatus}|${r.expectedArrival}`;
      const existing = byKey.get(key);
      if (existing) {
        existing.totalQuantity += r.quantity;
        existing.skuRows.push({ id: r.id, sku: r.sku, quantity: r.quantity });
        continue;
      }
      byKey.set(key, {
        key,
        destination: r.destination,
        shipmentName: r.shipmentName,
        productName,
        productLine: r.productLine,
        displayStatus: r.displayStatus,
        expectedArrival: r.expectedArrival,
        totalQuantity: r.quantity,
        skuRows: [{ id: r.id, sku: r.sku, quantity: r.quantity }],
      });
    }

    // Stable SKU order within each group — alphabetical so size lists
    // (s, m, l, xl) at least cluster by family.
    for (const g of byKey.values()) {
      g.skuRows.sort((a, b) => a.sku.localeCompare(b.sku));
    }

    const dir = sort.direction === "asc" ? 1 : -1;
    const sorted = Array.from(byKey.values()).sort((a, b) => {
      switch (sort.key) {
        case "productName": return a.productName.localeCompare(b.productName) * dir;
        case "destination": return a.destination.localeCompare(b.destination) * dir;
        case "shipmentName": return a.shipmentName.localeCompare(b.shipmentName) * dir;
        case "status": return a.displayStatus.localeCompare(b.displayStatus) * dir;
        case "quantity": return (a.totalQuantity - b.totalQuantity) * dir;
        case "expectedArrival":
        default:
          return a.expectedArrival.localeCompare(b.expectedArrival) * dir;
      }
    });

    return { groups: sorted, autoExpandKeys: skuMatchKeys };
  }, [data?.rows, search, sort]);

  const isExpanded = (key: string) => expanded.has(key) || autoExpandKeys.has(key);
  const toggleExpand = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const allExpanded = groups.length > 0 && groups.every((g) => isExpanded(g.key));
  const expandAll = () =>
    setExpanded(allExpanded ? new Set() : new Set(groups.map((g) => g.key)));

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
    overdueCount: 0,
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-neutral-900">Incoming shipments</h1>
        <p className="mt-1 text-sm text-neutral-600">
          POs arriving at US and CN warehouses, sorted by expected arrival — soonest first.
          Shipments past their ETA without a receipt confirmation surface as <span className="font-medium text-red-700">Overdue</span> so
          delayed or delivered-but-not-counted POs stay visible. Click <span className="font-medium">Mark received</span> once
          stock is in inventory; received shipments hide unless you toggle past shipments on.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
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
          label="Overdue"
          value={summary.overdueCount}
          hint={summary.overdueCount > 0 ? "Confirm or chase" : undefined}
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
              checked={includeReceived}
              onChange={(e) => setIncludeReceived(e.target.checked)}
              className="h-3.5 w-3.5"
            />
            Show past shipments
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
        {groups.length === 0 ? (
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
                  <th className="w-8 px-2 py-2">
                    <button
                      onClick={expandAll}
                      title={allExpanded ? "Collapse all" : "Expand all"}
                      className="text-neutral-400 hover:text-neutral-700"
                    >
                      {allExpanded ? "−" : "+"}
                    </button>
                  </th>
                  <SortableHeader label="Product" sortKey="productName" config={sort} onChange={setSort} />
                  <SortableHeader label="Destination" sortKey="destination" config={sort} onChange={setSort} />
                  <SortableHeader label="Shipment" sortKey="shipmentName" config={sort} onChange={setSort} />
                  <SortableHeader label="Status" sortKey="status" config={sort} onChange={setSort} />
                  <SortableHeader label="Quantity" sortKey="quantity" config={sort} onChange={setSort} align="right" />
                  <SortableHeader label="Expected arrival" sortKey="expectedArrival" config={sort} onChange={setSort} />
                  <th className="px-4 py-2 text-right text-xs uppercase tracking-wide text-neutral-500">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {groups.map((g) => {
                  const rel = relativeArrival(g.expectedArrival);
                  const open = isExpanded(g.key);
                  const skuCount = g.skuRows.length;
                  const isReceived = g.displayStatus === "received";
                  const canMark = g.displayStatus === "overdue" || g.displayStatus === "pending";
                  const mutationKey = { shipmentName: g.shipmentName, destination: g.destination, expectedArrival: g.expectedArrival };
                  const isPending =
                    (markReceived.isPending &&
                      markReceived.variables?.shipmentName === g.shipmentName &&
                      markReceived.variables?.destination === g.destination &&
                      markReceived.variables?.expectedArrival === g.expectedArrival) ||
                    (unmarkReceived.isPending &&
                      unmarkReceived.variables?.shipmentName === g.shipmentName &&
                      unmarkReceived.variables?.destination === g.destination &&
                      unmarkReceived.variables?.expectedArrival === g.expectedArrival);
                  return (
                    <Fragment key={g.key}>
                      <tr className="cursor-pointer hover:bg-neutral-50" onClick={() => toggleExpand(g.key)}>
                        <td className="px-2 py-2 text-center text-neutral-500">
                          <span aria-hidden>{open ? "▾" : "▸"}</span>
                        </td>
                        <td className="px-4 py-2 text-neutral-700">
                          <span className="font-medium text-neutral-900">{g.productName}</span>
                          <span className="ml-2 text-xs text-neutral-400">
                            {skuCount} SKU{skuCount === 1 ? "" : "s"}
                          </span>
                          {g.productLine ? (
                            <span className="ml-2 text-xs text-neutral-400">
                              {g.productLine}
                            </span>
                          ) : null}
                        </td>
                        <td className="whitespace-nowrap px-4 py-2 text-neutral-700">
                          {g.destination}
                        </td>
                        <td className="px-4 py-2 text-neutral-700">{g.shipmentName}</td>
                        <td className="px-4 py-2">
                          <StatusPill
                            kind={STATUS_PILL_KIND[g.displayStatus]}
                            label={STATUS_LABEL[g.displayStatus]}
                          />
                        </td>
                        <td className="whitespace-nowrap px-4 py-2 text-right tabular-nums font-medium text-neutral-900">
                          {fmtNumber(g.totalQuantity)}
                        </td>
                        <td className="whitespace-nowrap px-4 py-2">
                          <div className="text-neutral-700">{fmtDate(g.expectedArrival)}</div>
                          <div className={"text-xs " + TONE_CLASS[rel.tone]}>{rel.label}</div>
                        </td>
                        <td className="whitespace-nowrap px-4 py-2 text-right">
                          {isReceived ? (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                unmarkReceived.mutate(mutationKey);
                              }}
                              disabled={isPending}
                              className="rounded border border-neutral-300 px-2 py-1 text-xs text-neutral-600 hover:bg-neutral-100 disabled:opacity-50"
                            >
                              {isPending ? "…" : "Undo"}
                            </button>
                          ) : canMark ? (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                markReceived.mutate(mutationKey);
                              }}
                              disabled={isPending}
                              className="rounded border border-green-300 bg-green-50 px-2 py-1 text-xs font-medium text-green-800 hover:bg-green-100 disabled:opacity-50"
                            >
                              {isPending ? "…" : "Mark received"}
                            </button>
                          ) : null}
                        </td>
                      </tr>
                      {open &&
                        g.skuRows.map((sr) => (
                          <tr key={`${g.key}|${sr.id}`} className="bg-neutral-50/40">
                            <td className="px-2 py-1.5"></td>
                            <td className="px-4 py-1.5 pl-10 font-mono text-[11px] text-neutral-700">
                              <Link
                                href={`/sku/${encodeURIComponent(sr.sku)}`}
                                className="hover:text-neutral-900 hover:underline"
                              >
                                {sr.sku}
                              </Link>
                            </td>
                            <td colSpan={3} />
                            <td className="whitespace-nowrap px-4 py-1.5 text-right tabular-nums text-neutral-600">
                              {fmtNumber(sr.quantity)}
                            </td>
                            <td colSpan={2} />
                          </tr>
                        ))}
                    </Fragment>
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
