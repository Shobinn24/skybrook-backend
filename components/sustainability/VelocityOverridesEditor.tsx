"use client";
import { useState } from "react";
import { trpc } from "@/lib/trpc/client";

type Override = {
  id: string;
  startDate: string;
  endDate: string;
  multiplier: number;
  note: string | null;
};

type Location = "US" | "CN";

function fmtPct(multiplier: number): string {
  const pct = (multiplier - 1) * 100;
  if (pct === 0) return "no change";
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(0)}%`;
}

export function VelocityOverridesEditor({
  location,
  overrides,
}: {
  location: Location;
  overrides: Override[];
}) {
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  // Stored as percent change (0 = no change, 20 = +20%) for ergonomics.
  const [pctChange, setPctChange] = useState<string>("0");
  const [note, setNote] = useState("");

  const utils = trpc.useUtils();
  const addMutation = trpc.inventory.addVelocityOverride.useMutation({
    onSuccess: () => {
      void utils.inventory.getSustainabilityTimeline.invalidate();
      setAdding(false);
      setStartDate("");
      setEndDate("");
      setPctChange("0");
      setNote("");
    },
  });
  const removeMutation = trpc.inventory.removeVelocityOverride.useMutation({
    onSuccess: () => {
      void utils.inventory.getSustainabilityTimeline.invalidate();
    },
  });

  const validNumber = (s: string): number | null => {
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  };

  const handleAdd = () => {
    const pct = validNumber(pctChange);
    if (pct === null) return;
    const multiplier = 1 + pct / 100;
    if (multiplier <= 0) return;
    if (!startDate || !endDate) return;
    addMutation.mutate({
      location,
      startDate,
      endDate,
      multiplier,
      note: note.trim() || undefined,
    });
  };

  return (
    <div className="rounded-md border border-neutral-200 bg-white">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between px-4 py-2 text-left text-sm hover:bg-neutral-50"
      >
        <div>
          <span className="font-medium text-neutral-900">
            Velocity scaling
          </span>
          <span className="ml-2 text-xs text-neutral-500">
            {overrides.length === 0
              ? "no overrides — projecting at current sales rate"
              : `${overrides.length} override${overrides.length === 1 ? "" : "s"} active for ${location}`}
          </span>
        </div>
        <span aria-hidden className="text-neutral-400">
          {open ? "▾" : "▸"}
        </span>
      </button>

      {open && (
        <div className="border-t border-neutral-200 px-4 py-3 space-y-3">
          <p className="text-xs text-neutral-600">
            Scale projected sales velocity inside a date range. <span className="font-medium">+20%</span> means
            sales are expected to be 20% higher than the trailing window suggests; <span className="font-medium">−20%</span> means
            20% lower. Overrides apply to all SKUs in the {location} warehouse.
          </p>

          {overrides.length > 0 && (
            <div className="overflow-hidden rounded border border-neutral-200">
              <table className="w-full text-sm">
                <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500">
                  <tr>
                    <th className="px-3 py-1.5">From</th>
                    <th className="px-3 py-1.5">To</th>
                    <th className="px-3 py-1.5 text-right">Scaling</th>
                    <th className="px-3 py-1.5">Note</th>
                    <th className="px-3 py-1.5"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-100">
                  {overrides.map((o) => (
                    <tr key={o.id}>
                      <td className="whitespace-nowrap px-3 py-1.5 text-neutral-700">{o.startDate}</td>
                      <td className="whitespace-nowrap px-3 py-1.5 text-neutral-700">{o.endDate}</td>
                      <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums font-medium text-neutral-900">
                        ×{o.multiplier.toFixed(2)}
                        <span className="ml-2 text-xs text-neutral-500">({fmtPct(o.multiplier)})</span>
                      </td>
                      <td className="px-3 py-1.5 text-neutral-600">{o.note ?? "—"}</td>
                      <td className="px-3 py-1.5 text-right">
                        <button
                          type="button"
                          onClick={() => removeMutation.mutate({ id: o.id })}
                          disabled={removeMutation.isPending}
                          className="text-xs text-red-700 hover:text-red-900 underline underline-offset-2 disabled:opacity-50"
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {adding ? (
            <div className="space-y-2 rounded border border-neutral-200 bg-neutral-50 p-3">
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-4">
                <label className="text-xs text-neutral-700">
                  From
                  <input
                    type="date"
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                    className="mt-0.5 block w-full rounded border border-neutral-300 px-2 py-1 text-sm"
                  />
                </label>
                <label className="text-xs text-neutral-700">
                  To
                  <input
                    type="date"
                    value={endDate}
                    onChange={(e) => setEndDate(e.target.value)}
                    className="mt-0.5 block w-full rounded border border-neutral-300 px-2 py-1 text-sm"
                  />
                </label>
                <label className="text-xs text-neutral-700">
                  % change
                  <input
                    type="number"
                    step="1"
                    value={pctChange}
                    onChange={(e) => setPctChange(e.target.value)}
                    className="mt-0.5 block w-full rounded border border-neutral-300 px-2 py-1 text-sm tabular-nums"
                    placeholder="20"
                  />
                </label>
                <label className="text-xs text-neutral-700">
                  Note (optional)
                  <input
                    type="text"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    className="mt-0.5 block w-full rounded border border-neutral-300 px-2 py-1 text-sm"
                    placeholder="Mens launch ramp"
                  />
                </label>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleAdd}
                  disabled={addMutation.isPending || !startDate || !endDate}
                  className="rounded bg-neutral-900 px-3 py-1 text-xs font-medium text-white hover:bg-neutral-700 disabled:opacity-50"
                >
                  {addMutation.isPending ? "Saving…" : "Add override"}
                </button>
                <button
                  type="button"
                  onClick={() => setAdding(false)}
                  className="text-xs text-neutral-500 hover:text-neutral-800"
                >
                  Cancel
                </button>
                {addMutation.error && (
                  <span className="text-xs text-red-700">
                    {addMutation.error.message}
                  </span>
                )}
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="rounded border border-neutral-300 px-3 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-100"
            >
              + Add override
            </button>
          )}
        </div>
      )}
    </div>
  );
}
