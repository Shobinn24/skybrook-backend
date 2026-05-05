"use client";
import { useState } from "react";
import { trpc } from "@/lib/trpc/client";

function fmtDate(ymd: string | null): string {
  if (!ymd) return "—";
  const [y, m, d] = ymd.split("-").map(Number);
  if (!y || !m || !d) return ymd;
  return new Date(y, m - 1, d).toLocaleDateString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

type ManualField =
  | "intlSiteLive"
  | "intlLaunchDate"
  | "usSiteLive"
  | "usLaunchDate";

export default function LaunchesPage() {
  const utils = trpc.useUtils();
  const launches = trpc.inventory.getLaunches.useQuery(undefined, {
    refetchOnWindowFocus: false,
  });
  const formOptions = trpc.inventory.getLaunchFormOptions.useQuery(undefined, {
    refetchOnWindowFocus: false,
  });

  const addMutation = trpc.inventory.addLaunch.useMutation({
    onSuccess: () => {
      void utils.inventory.getLaunches.invalidate();
      setProductName("");
      setShipmentName("");
      setAdding(false);
    },
  });
  const updateMutation = trpc.inventory.updateLaunchDates.useMutation({
    onSuccess: () => utils.inventory.getLaunches.invalidate(),
  });
  const removeMutation = trpc.inventory.removeLaunch.useMutation({
    onSuccess: () => utils.inventory.getLaunches.invalidate(),
  });

  const [adding, setAdding] = useState(false);
  const [productName, setProductName] = useState("");
  const [shipmentName, setShipmentName] = useState("");

  const handleAdd = () => {
    if (!productName || !shipmentName) return;
    addMutation.mutate({ productName, shipmentName });
  };

  const handleDateChange = (id: string, field: ManualField, value: string) => {
    updateMutation.mutate({
      id,
      [field]: value || null,
    });
  };

  const rows = launches.data ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-neutral-900">Product launches</h1>
          <p className="text-sm text-neutral-500">
            ETAs auto-derive from incoming shipments. Site Live and Launch
            dates are manual — enter as you commit them. New colorway = new
            launch row.
          </p>
        </div>
        {!adding && (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="rounded bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700"
          >
            + Add launch
          </button>
        )}
      </div>

      {adding && (
        <div className="rounded border border-neutral-200 bg-neutral-50 p-3 space-y-2">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label className="text-xs text-neutral-700">
              Product
              <select
                value={productName}
                onChange={(e) => setProductName(e.target.value)}
                className="mt-0.5 block w-full rounded border border-neutral-300 bg-white px-2 py-1 text-sm"
              >
                <option value="">— pick a product —</option>
                {(formOptions.data?.productNames ?? []).map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
            </label>
            <label className="text-xs text-neutral-700">
              Order (shipment name)
              <select
                value={shipmentName}
                onChange={(e) => setShipmentName(e.target.value)}
                className="mt-0.5 block w-full rounded border border-neutral-300 bg-white px-2 py-1 text-sm"
              >
                <option value="">— pick a shipment —</option>
                {(formOptions.data?.shipmentNames ?? []).map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </label>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleAdd}
              disabled={!productName || !shipmentName || addMutation.isPending}
              className="rounded bg-neutral-900 px-3 py-1 text-xs font-medium text-white hover:bg-neutral-700 disabled:opacity-50"
            >
              {addMutation.isPending ? "Saving…" : "Save launch"}
            </button>
            <button
              type="button"
              onClick={() => setAdding(false)}
              className="text-xs text-neutral-500 hover:text-neutral-800"
            >
              Cancel
            </button>
            {addMutation.error && (
              <span className="text-xs text-red-700">{addMutation.error.message}</span>
            )}
          </div>
        </div>
      )}

      <div className="rounded-md border border-neutral-200 bg-white">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500">
              <tr>
                <th className="px-3 py-2">Product</th>
                <th className="px-3 py-2">Order</th>
                <th className="px-3 py-2 border-l-2 border-neutral-300">ETA Ant</th>
                <th className="px-3 py-2">Site Live</th>
                <th className="px-3 py-2">INTL Launch</th>
                <th className="px-3 py-2 border-l-2 border-neutral-300">ETA PD</th>
                <th className="px-3 py-2">Site Live</th>
                <th className="px-3 py-2">US Launch</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {launches.isLoading ? (
                <tr>
                  <td colSpan={9} className="px-4 py-6 text-center text-sm text-neutral-500">
                    Loading…
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-4 py-6 text-center text-sm text-neutral-500">
                    No launches yet. Click <strong>Add launch</strong> to log one.
                  </td>
                </tr>
              ) : (
                rows.map((r) => (
                  <tr key={r.id} className="hover:bg-neutral-50/50">
                    <td className="whitespace-nowrap px-3 py-1.5 font-medium text-neutral-900">
                      {r.productName}
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-neutral-700">
                      {r.shipmentName}
                    </td>
                    <td className="whitespace-nowrap border-l-2 border-neutral-300 bg-neutral-50/40 px-3 py-1.5 tabular-nums text-neutral-700">
                      {fmtDate(r.etaAnt)}
                    </td>
                    <td className="px-3 py-1.5">
                      <DateCell
                        value={r.intlSiteLive}
                        onChange={(v) => handleDateChange(r.id, "intlSiteLive", v)}
                      />
                    </td>
                    <td className="px-3 py-1.5">
                      <DateCell
                        value={r.intlLaunchDate}
                        onChange={(v) => handleDateChange(r.id, "intlLaunchDate", v)}
                      />
                    </td>
                    <td className="whitespace-nowrap border-l-2 border-neutral-300 bg-neutral-50/40 px-3 py-1.5 tabular-nums text-neutral-700">
                      {fmtDate(r.etaPd)}
                    </td>
                    <td className="px-3 py-1.5">
                      <DateCell
                        value={r.usSiteLive}
                        onChange={(v) => handleDateChange(r.id, "usSiteLive", v)}
                      />
                    </td>
                    <td className="px-3 py-1.5">
                      <DateCell
                        value={r.usLaunchDate}
                        onChange={(v) => handleDateChange(r.id, "usLaunchDate", v)}
                      />
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-right">
                      <button
                        type="button"
                        onClick={() => {
                          if (confirm(`Remove launch ${r.productName} / ${r.shipmentName}?`)) {
                            removeMutation.mutate({ id: r.id });
                          }
                        }}
                        className="text-xs text-red-700 hover:text-red-900 underline underline-offset-2"
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function DateCell({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (next: string) => void;
}) {
  // Track local edit state so the input doesn't reset on every keystroke
  // when the parent re-renders from the mutation invalidation.
  const [draft, setDraft] = useState<string | null>(null);
  const display = draft ?? value ?? "";
  return (
    <input
      type="date"
      value={display}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== null && draft !== (value ?? "")) {
          onChange(draft);
        }
        setDraft(null);
      }}
      className="rounded border border-neutral-200 bg-white px-1.5 py-0.5 text-xs tabular-nums hover:border-neutral-400 focus:border-neutral-500 focus:outline-none"
    />
  );
}
