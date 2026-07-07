"use client";
import { useState } from "react";
import { trpc } from "@/lib/trpc/client";

// "18 Jul 2026" — DD MMM YYYY per Jasper 2026-06-10 ("easier on the
// eyes"). en-GB gives day-first ordering regardless of the viewer's OS
// locale.
function fmtDate(ymd: string | null): string {
  if (!ymd) return "—";
  const [y, m, d] = ymd.split("-").map(Number);
  if (!y || !m || !d) return ymd;
  return new Date(y, m - 1, d).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function fmtMoney(v: string | number | null): string {
  if (v === null || v === "") return "—";
  const n = typeof v === "number" ? v : Number(v);
  if (Number.isNaN(n)) return "—";
  return `$${n.toFixed(2)}`;
}

type ManualField =
  | "intlSiteLive"
  | "intlLaunchDate"
  | "usSiteLive"
  | "usLaunchDate";

type PrepField =
  | "sellingPriceUsd"
  | "externalProductName"
  | "factoryContentUrl"
  | "imageToolContentUrl";

export default function LaunchesPage() {
  const utils = trpc.useUtils();
  // fb_ads_only gets a read-only view (client 2026-07-07 "share that page
  // with all the marketers") — add/remove/edit controls are hidden and
  // their marketing-tier mutations are never fired.
  const me = trpc.inventory.getMyAccessTier.useQuery(undefined, {
    refetchOnWindowFocus: false,
  });
  const isAdmin = me.data?.tier === "ops" || me.data?.tier === "marketing";

  const launches = trpc.inventory.getLaunches.useQuery(undefined, {
    refetchOnWindowFocus: false,
  });
  const formOptions = trpc.inventory.getLaunchFormOptions.useQuery(undefined, {
    refetchOnWindowFocus: false,
    enabled: isAdmin,
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

  const handlePrepChange = (id: string, field: PrepField, value: string) => {
    updateMutation.mutate({
      id,
      [field]: value.trim() || null,
    });
  };

  const rows = launches.data ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-neutral-900">Product launches</h1>
          <p className="text-sm text-neutral-500">
            ETAs auto-derive from incoming shipments; landed COGS from the
            cost sheet. Site Live / Launch dates, price, external name and
            content links are manual — enter as you commit them. New
            colorway = new launch row.
          </p>
        </div>
        {isAdmin && !adding && (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="rounded bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700"
          >
            + Add launch
          </button>
        )}
      </div>

      {isAdmin && adding && (
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
            <thead className="sticky top-0 z-20 bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500 shadow-[0_1px_0_0_rgba(0,0,0,0.05)]">
              <tr>
                <th className="px-3 py-2">Product</th>
                <th className="px-3 py-2">Order</th>
                <th className="px-3 py-2 border-l-2 border-neutral-300">ETA Ant</th>
                <th className="px-3 py-2">Site Live</th>
                <th className="px-3 py-2">INTL Launch</th>
                <th className="px-3 py-2 border-l-2 border-neutral-300">ETA PD</th>
                <th className="px-3 py-2">Site Live</th>
                <th className="px-3 py-2">US Launch</th>
                <th className="px-3 py-2 border-l-2 border-neutral-300">Ext. name</th>
                <th className="px-3 py-2">Price</th>
                <th className="px-3 py-2">Landed COGS</th>
                <th className="px-3 py-2">Factory content</th>
                <th className="px-3 py-2">Image tool content</th>
                {isAdmin && <th className="px-3 py-2"></th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {launches.isLoading ? (
                <tr>
                  <td colSpan={14} className="px-4 py-6 text-center text-sm text-neutral-500">
                    Loading…
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={14} className="px-4 py-6 text-center text-sm text-neutral-500">
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
                        readOnly={!isAdmin}
                        onChange={(v) => handleDateChange(r.id, "intlSiteLive", v)}
                      />
                    </td>
                    <td className="px-3 py-1.5">
                      <DateCell
                        value={r.intlLaunchDate}
                        readOnly={!isAdmin}
                        onChange={(v) => handleDateChange(r.id, "intlLaunchDate", v)}
                      />
                    </td>
                    <td className="whitespace-nowrap border-l-2 border-neutral-300 bg-neutral-50/40 px-3 py-1.5 tabular-nums text-neutral-700">
                      {fmtDate(r.etaPd)}
                    </td>
                    <td className="px-3 py-1.5">
                      <DateCell
                        value={r.usSiteLive}
                        readOnly={!isAdmin}
                        onChange={(v) => handleDateChange(r.id, "usSiteLive", v)}
                      />
                    </td>
                    <td className="px-3 py-1.5">
                      <DateCell
                        value={r.usLaunchDate}
                        readOnly={!isAdmin}
                        onChange={(v) => handleDateChange(r.id, "usLaunchDate", v)}
                      />
                    </td>
                    <td className="border-l-2 border-neutral-300 px-3 py-1.5">
                      <TextCell
                        value={r.externalProductName}
                        placeholder="external name"
                        readOnly={!isAdmin}
                        onChange={(v) => handlePrepChange(r.id, "externalProductName", v)}
                      />
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5">
                      <TextCell
                        value={r.sellingPriceUsd}
                        placeholder="0.00"
                        display={fmtMoney(r.sellingPriceUsd)}
                        readOnly={!isAdmin}
                        onChange={(v) => handlePrepChange(r.id, "sellingPriceUsd", v.replace(/^\$/, ""))}
                      />
                    </td>
                    {/* Landed COGS — read-only, derived from the cost sheet.
                        Title shows bucket size + how many SKUs still lack a
                        cost so a low-looking number is explainable. */}
                    <td
                      className="whitespace-nowrap px-3 py-1.5 tabular-nums text-neutral-700"
                      title={`avg over ${r.cogsSkuCount - r.cogsMissingCount}/${r.cogsSkuCount} costed SKUs (US / INTL)`}
                    >
                      {r.landedCogsUsd === null ? (
                        "—"
                      ) : (
                        <>
                          {fmtMoney(r.landedCogsUsd)}
                          <span className="text-neutral-400"> / {fmtMoney(r.landedCogsIntlUsd)}</span>
                          {r.cogsMissingCount > 0 && (
                            <span className="ml-1 text-[10px] text-amber-600" title={`${r.cogsMissingCount} SKU(s) missing cost on the cost sheet`}>
                              *
                            </span>
                          )}
                        </>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5">
                      <LinkCell
                        value={r.factoryContentUrl}
                        readOnly={!isAdmin}
                        onChange={(v) => handlePrepChange(r.id, "factoryContentUrl", v)}
                      />
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5">
                      <LinkCell
                        value={r.imageToolContentUrl}
                        readOnly={!isAdmin}
                        onChange={(v) => handlePrepChange(r.id, "imageToolContentUrl", v)}
                      />
                    </td>
                    {isAdmin && (
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
                    )}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {updateMutation.error && (
          <div className="border-t border-neutral-200 px-3 py-2 text-xs text-red-700">
            {updateMutation.error.message}
          </div>
        )}
      </div>
    </div>
  );
}

function DateCell({
  value,
  onChange,
  readOnly = false,
}: {
  value: string | null;
  onChange: (next: string) => void;
  readOnly?: boolean;
}) {
  // Display formatted "18 Jul 2026" text; switch to the native date
  // picker only while editing. A bare input[type=date] renders in the
  // browser's locale format (MM/DD/YYYY for most of the team), which is
  // what Jasper asked to change (2026-06-10).
  const [editing, setEditing] = useState(false);
  // Track local edit state so the input doesn't reset on every keystroke
  // when the parent re-renders from the mutation invalidation.
  const [draft, setDraft] = useState<string | null>(null);
  if (readOnly) {
    return <span className="text-xs tabular-nums text-neutral-700">{fmtDate(value)}</span>;
  }
  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="rounded border border-neutral-200 bg-white px-1.5 py-0.5 text-xs tabular-nums hover:border-neutral-400 focus:border-neutral-500 focus:outline-none"
      >
        {fmtDate(value)}
      </button>
    );
  }
  return (
    <input
      type="date"
      autoFocus
      value={draft ?? value ?? ""}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== null && draft !== (value ?? "")) {
          onChange(draft);
        }
        setDraft(null);
        setEditing(false);
      }}
      className="rounded border border-neutral-200 bg-white px-1.5 py-0.5 text-xs tabular-nums hover:border-neutral-400 focus:border-neutral-500 focus:outline-none"
    />
  );
}

// Click-to-edit text cell — same interaction pattern as DateCell.
function TextCell({
  value,
  onChange,
  placeholder,
  display,
  readOnly = false,
}: {
  value: string | null;
  onChange: (next: string) => void;
  placeholder?: string;
  /** Optional formatted display (e.g. "$24.99") shown when not editing. */
  display?: string;
  readOnly?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const shown = display ?? (value || "—");
  if (readOnly) {
    return <span className="text-xs text-neutral-700">{shown}</span>;
  }
  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="max-w-[14rem] truncate rounded border border-neutral-200 bg-white px-1.5 py-0.5 text-left text-xs hover:border-neutral-400 focus:border-neutral-500 focus:outline-none"
        title={value ?? undefined}
      >
        {shown}
      </button>
    );
  }
  return (
    <input
      type="text"
      autoFocus
      placeholder={placeholder}
      value={draft ?? value ?? ""}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
      onBlur={() => {
        if (draft !== null && draft !== (value ?? "")) {
          onChange(draft);
        }
        setDraft(null);
        setEditing(false);
      }}
      className="w-40 rounded border border-neutral-200 bg-white px-1.5 py-0.5 text-xs hover:border-neutral-400 focus:border-neutral-500 focus:outline-none"
    />
  );
}

// Drive-link cell: shows "Open ↗" when a link is set (plus an Edit
// affordance for admins); empty state is the same click-to-edit input.
function LinkCell({
  value,
  onChange,
  readOnly = false,
}: {
  value: string | null;
  onChange: (next: string) => void;
  readOnly?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  if (!editing) {
    return (
      <span className="inline-flex items-center gap-1.5">
        {value ? (
          <a
            href={value}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-blue-700 underline underline-offset-2 hover:text-blue-900"
            title={value}
          >
            Open ↗
          </a>
        ) : (
          <span className="text-xs text-neutral-400">—</span>
        )}
        {!readOnly && (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="rounded border border-neutral-200 bg-white px-1.5 py-0.5 text-[10px] text-neutral-500 hover:border-neutral-400 hover:text-neutral-800 focus:outline-none"
          >
            {value ? "edit" : "add link"}
          </button>
        )}
      </span>
    );
  }
  return (
    <input
      type="url"
      autoFocus
      placeholder="https://drive.google.com/…"
      value={draft ?? value ?? ""}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
      onBlur={() => {
        if (draft !== null && draft !== (value ?? "")) {
          onChange(draft);
        }
        setDraft(null);
        setEditing(false);
      }}
      className="w-56 rounded border border-neutral-200 bg-white px-1.5 py-0.5 text-xs hover:border-neutral-400 focus:border-neutral-500 focus:outline-none"
    />
  );
}
