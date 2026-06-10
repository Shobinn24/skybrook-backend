"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { clsx } from "clsx";

import { trpc } from "@/lib/trpc/client";
import type { FactoryOrderInputs } from "@/lib/queries/factory-order";
import type {
  CalculationResult,
  GroupSummary,
  SkuDetail,
} from "@/lib/domain/factory-order-calc";
import {
  ALL_GROUPS,
  type ProductGroup,
} from "@/config/factory-order-groups";

// ---------------------------------------------------------------------
// Small fmt helpers
// ---------------------------------------------------------------------

function fmtMoney(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}
function fmtMoney2(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
function fmtNum(n: number | null | undefined, digits = 0): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}
function fmtMos(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toFixed(2);
}

function currentMonthKey(): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}-01`;
}

function shiftMonthKey(key: string, delta: number): string {
  const [y, m] = key.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  const ny = d.getUTCFullYear();
  const nm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${ny}-${nm}-01`;
}

function monthLabel(key: string): string {
  const [y, m] = key.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1, 1));
  return d.toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

// ---------------------------------------------------------------------
// Number-input helpers — keep user typing experience intact while
// auto-saving on blur.
// ---------------------------------------------------------------------

function NumericCell({
  value,
  onChange,
  digits = 0,
  width = "w-24",
  prefix,
  step,
}: {
  value: number | null;
  onChange: (n: number | null) => void;
  digits?: number;
  width?: string;
  prefix?: string;
  step?: string;
}) {
  const [raw, setRaw] = useState<string>(
    value === null ? "" : value.toFixed(digits),
  );
  useEffect(() => {
    setRaw(value === null ? "" : value.toFixed(digits));
  }, [value, digits]);

  return (
    <div className={clsx("inline-flex items-center", prefix && "rounded border border-neutral-300")}>
      {prefix && (
        <span className="px-2 text-xs text-neutral-500">{prefix}</span>
      )}
      <input
        type="number"
        step={step ?? "any"}
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        onBlur={() => {
          const trimmed = raw.trim();
          if (trimmed === "") onChange(null);
          else {
            const n = Number(trimmed);
            onChange(Number.isFinite(n) ? n : null);
          }
        }}
        className={clsx(
          width,
          "px-2 py-1 text-right text-sm tabular-nums",
          prefix ? "border-0 focus:outline-none" : "rounded border border-neutral-300",
        )}
      />
    </div>
  );
}

// ---------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------

export default function FactoryOrdersPage() {
  const [orderMonth, setOrderMonth] = useState<string>(currentMonthKey());

  // Load draft for the selected month. Idempotent — creates if missing.
  const draft = trpc.factoryOrder.getDraft.useQuery({ orderMonth });
  const calc = trpc.factoryOrder.calculate.useQuery(
    draft.data ? { orderId: draft.data.header.id } : ({} as { orderId: string }),
    { enabled: !!draft.data, staleTime: 5_000 },
  );
  const utils = trpc.useUtils();
  const saveInputs = trpc.factoryOrder.saveInputs.useMutation({
    onSuccess: () => {
      // Cheap: refetch the calc to pick up new numbers.
      void calc.refetch();
    },
  });
  const approve = trpc.factoryOrder.approve.useMutation();

  // Local mirror of the draft inputs so the inputs stay responsive
  // while save round-trips. Server-sourced values are merged in by
  // useEffect when the draft (re)loads.
  const [local, setLocal] = useState<FactoryOrderInputs | null>(null);
  useEffect(() => {
    if (draft.data) setLocal(draft.data.inputs);
  }, [draft.data]);

  const isApproved = draft.data?.header.status === "approved";

  const saveAndCommit = useCallback(
    (next: FactoryOrderInputs) => {
      if (!draft.data) return;
      setLocal(next);
      saveInputs.mutate({ orderId: draft.data.header.id, inputs: next });
    },
    [draft.data, saveInputs],
  );

  // Convenience setters that derive `next` from `local`.
  const patch = useCallback(
    (mut: (curr: FactoryOrderInputs) => FactoryOrderInputs) => {
      setLocal((curr) => {
        if (!curr) return curr;
        const next = mut(curr);
        if (draft.data) {
          saveInputs.mutate({ orderId: draft.data.header.id, inputs: next });
        }
        return next;
      });
    },
    [draft.data, saveInputs],
  );

  // Build per-group summary lookup by name+side for the table render.
  const summaryByKey = useMemo(() => {
    const m = new Map<string, GroupSummary>();
    const result = calc.data as CalculationResult | undefined;
    for (const s of result?.summaries ?? []) {
      m.set(`${s.groupName}|${s.side}`, s);
    }
    return m;
  }, [calc.data]);

  if (draft.isLoading) {
    return <div className="text-sm text-neutral-500">Loading…</div>;
  }
  if (!draft.data || !local) {
    return (
      <div className="rounded border border-red-200 bg-red-50 p-4 text-sm text-red-800">
        Could not load draft for {orderMonth}.
      </div>
    );
  }

  const totalRevenue =
    (local.revenueUs ?? 0) +
    (local.revenueIntl ?? 0) +
    (local.revenueAmazon ?? 0);
  const usForecastSum = local.forecast.us.reduce((s, n) => s + n, 0);
  const intlForecastSum = local.forecast.intl.reduce((s, n) => s + n, 0);

  return (
    <div className="space-y-6">
      {/* Heading + month picker */}
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-neutral-900">
            Factory Orders
          </h1>
          <p className="mt-1 text-sm text-neutral-600">
            Replaces the monthly secondary-order Excel workbook. Edit any
            input to recalc the whole table live. Approve to freeze and
            generate the SB / MV factory sheets (Phase 4).
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setOrderMonth(shiftMonthKey(orderMonth, -1))}
            className="rounded border border-neutral-300 bg-white px-2 py-1 text-sm hover:bg-neutral-100"
          >
            ←
          </button>
          <span className="min-w-[8rem] text-center text-sm font-medium">
            {monthLabel(orderMonth)}
          </span>
          <button
            onClick={() => setOrderMonth(shiftMonthKey(orderMonth, 1))}
            className="rounded border border-neutral-300 bg-white px-2 py-1 text-sm hover:bg-neutral-100"
          >
            →
          </button>
          <span
            className={clsx(
              "ml-2 rounded px-2 py-0.5 text-xs",
              isApproved
                ? "bg-green-50 text-green-800"
                : "bg-neutral-100 text-neutral-700",
            )}
          >
            {isApproved ? "Approved" : "Draft"}
          </span>
        </div>
      </div>

      {/* Revenue + forecast cards */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="rounded-md border border-neutral-200 bg-white p-4">
          <div className="text-xs uppercase tracking-wide text-neutral-500">
            30-day revenue actuals
          </div>
          <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <label className="text-neutral-700">US Store</label>
            <NumericCell
              value={local.revenueUs}
              onChange={(n) => patch((c) => ({ ...c, revenueUs: n }))}
              digits={2}
              prefix="$"
              width="w-32"
            />
            <label className="text-neutral-700">INTL Store</label>
            <NumericCell
              value={local.revenueIntl}
              onChange={(n) => patch((c) => ({ ...c, revenueIntl: n }))}
              digits={2}
              prefix="$"
              width="w-32"
            />
            <label className="text-neutral-700">Amazon Store</label>
            <NumericCell
              value={local.revenueAmazon}
              onChange={(n) => patch((c) => ({ ...c, revenueAmazon: n }))}
              digits={2}
              prefix="$"
              width="w-32"
            />
            <div className="border-t border-neutral-200 pt-2 font-medium text-neutral-900">
              Total
            </div>
            <div className="border-t border-neutral-200 pt-2 text-right font-medium tabular-nums">
              {fmtMoney2(totalRevenue)}
            </div>
          </div>
        </div>

        <div className="rounded-md border border-neutral-200 bg-white p-4">
          <div className="text-xs uppercase tracking-wide text-neutral-500">
            Revenue forecast
          </div>
          <div className="mt-2 grid grid-cols-5 gap-x-2 gap-y-2 text-sm">
            <div className="col-span-5 text-xs text-neutral-500">
              US — next 4 months
            </div>
            {local.forecast.us.map((m, i) => (
              <NumericCell
                key={`us-${i}`}
                value={m}
                onChange={(n) =>
                  patch((c) => ({
                    ...c,
                    forecast: {
                      ...c.forecast,
                      us: c.forecast.us.map((v, j) => (j === i ? n ?? 0 : v)),
                    },
                  }))
                }
                prefix="$"
                width="w-24"
              />
            ))}
            <div className="col-span-1 text-right text-xs font-medium tabular-nums">
              = {fmtMoney(usForecastSum)}
            </div>
            <div className="col-span-5 mt-2 text-xs text-neutral-500">
              INTL — next 3 months
            </div>
            {local.forecast.intl.map((m, i) => (
              <NumericCell
                key={`intl-${i}`}
                value={m}
                onChange={(n) =>
                  patch((c) => ({
                    ...c,
                    forecast: {
                      ...c.forecast,
                      intl: c.forecast.intl.map((v, j) => (j === i ? n ?? 0 : v)),
                    },
                  }))
                }
                prefix="$"
                width="w-24"
              />
            ))}
            <div className="col-span-2 text-right text-xs font-medium tabular-nums">
              = {fmtMoney(intlForecastSum)}
            </div>
          </div>
        </div>
      </div>

      {/* Order notes */}
      <div className="rounded-md border border-neutral-200 bg-white p-4">
        <label className="text-xs uppercase tracking-wide text-neutral-500">
          Order notes
        </label>
        <textarea
          value={local.orderNotes ?? ""}
          onChange={(e) => setLocal((c) => (c ? { ...c, orderNotes: e.target.value || null } : c))}
          onBlur={() => local && saveAndCommit(local)}
          rows={2}
          className="mt-1 w-full rounded border border-neutral-300 px-2 py-1 text-sm"
          placeholder="e.g., This needs to last until 4 Aug — when KAI May arrives"
        />
      </div>

      {/* Product group table */}
      <div>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-neutral-900">
            Product groups{" "}
            <span className="text-neutral-500">({ALL_GROUPS.length})</span>
          </h2>
          {calc.isFetching && (
            <span className="text-xs text-neutral-500">Recalculating…</span>
          )}
        </div>
        <ProductGroupsTable
          groups={ALL_GROUPS}
          inputs={local}
          patch={patch}
          summaryByKey={summaryByKey}
          currentSplits={
            (calc.data as CalculationResult | undefined)?.currentSplits ?? {
              us: {},
              intl: {},
            }
          }
          isApproved={isApproved}
          details={
            (calc.data as CalculationResult | undefined)?.details ?? []
          }
        />
      </div>

      {/* Bottom totals + actions */}
      <div className="flex items-center justify-between rounded-md border border-neutral-200 bg-white p-4">
        <div className="grid grid-cols-3 gap-x-8 text-sm">
          <div>
            <div className="text-xs uppercase tracking-wide text-neutral-500">
              US Order
            </div>
            <div className="mt-1 text-xl font-semibold tabular-nums">
              {fmtMoney(
                (calc.data as CalculationResult | undefined)?.totals.usAmount ??
                  0,
              )}
            </div>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wide text-neutral-500">
              INTL Order
            </div>
            <div className="mt-1 text-xl font-semibold tabular-nums">
              {fmtMoney(
                (calc.data as CalculationResult | undefined)?.totals
                  .intlAmount ?? 0,
              )}
            </div>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wide text-neutral-500">
              Combined Total
            </div>
            <div className="mt-1 text-xl font-semibold tabular-nums">
              {fmtMoney(
                (calc.data as CalculationResult | undefined)?.totals
                  .combinedAmount ?? 0,
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {!isApproved && (
            <button
              onClick={() => {
                // Approver identity comes from the session server-side.
                if (
                  !window.confirm(
                    "Approve and freeze this order? The inputs will become read-only.",
                  )
                ) {
                  return;
                }
                approve.mutate(
                  { orderId: draft.data!.header.id },
                  {
                    onSuccess: () => {
                      void utils.factoryOrder.getDraft.invalidate({ orderMonth });
                    },
                  },
                );
              }}
              disabled={approve.isPending}
              className="rounded border border-neutral-900 bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-800 disabled:opacity-50"
            >
              {approve.isPending ? "Approving…" : "Approve order"}
            </button>
          )}
          {isApproved && (
            <>
              <a
                href={`/api/factory-orders/${draft.data!.header.id}/sheet/US`}
                className="rounded border border-neutral-300 bg-white px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-100"
                download
              >
                Download SB (US)
              </a>
              <a
                href={`/api/factory-orders/${draft.data!.header.id}/sheet/INTL`}
                className="rounded border border-neutral-300 bg-white px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-100"
                download
              >
                Download MV (INTL)
              </a>
            </>
          )}
        </div>
      </div>

      <div className="text-xs text-neutral-400">
        Calc as of {new Date().toLocaleString()} — auto-saves every input.{" "}
        {saveInputs.isPending && <span>Saving…</span>}
        {saveInputs.isError && (
          <span className="text-red-600">
            Save failed: {saveInputs.error.message}
          </span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// Big table component
// ---------------------------------------------------------------------

type SummaryRow = GroupSummary;
type DetailRow = SkuDetail;

function ProductGroupsTable({
  groups,
  inputs,
  patch,
  summaryByKey,
  currentSplits,
  isApproved,
  details,
}: {
  groups: ReadonlyArray<ProductGroup>;
  inputs: FactoryOrderInputs;
  patch: (mut: (curr: FactoryOrderInputs) => FactoryOrderInputs) => void;
  summaryByKey: Map<string, SummaryRow>;
  currentSplits: { us: Record<string, number>; intl: Record<string, number> };
  isApproved: boolean;
  details: DetailRow[];
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (name: string) =>
    setExpanded((p) => {
      const n = new Set(p);
      if (n.has(name)) n.delete(name);
      else n.add(name);
      return n;
    });

  const detailsByGroup = useMemo(() => {
    const m = new Map<string, DetailRow[]>();
    for (const d of details) {
      const arr = m.get(d.groupName) ?? [];
      arr.push(d);
      m.set(d.groupName, arr);
    }
    return m;
  }, [details]);

  return (
    <div className="overflow-x-auto rounded-md border border-neutral-200 bg-white">
      <table className="w-full text-sm">
        <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500">
          <tr>
            <th className="w-6 px-2 py-2" />
            <th className="px-3 py-2">Product</th>
            <th className="px-3 py-2">Type</th>
            <th className="px-3 py-2 text-right">Scaling</th>
            <th className="px-3 py-2 text-right">Change Split / Custom Qty</th>
            <th className="px-3 py-2 text-right">FUT MOS (US / INTL)</th>
            <th className="px-3 py-2 text-right">Order Qty (US / INTL)</th>
            <th className="px-3 py-2 text-right">Order $</th>
            <th className="px-3 py-2">Comment</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-100">
          {groups.map((g) => {
            const us = summaryByKey.get(`${g.name}|US`);
            const intl = summaryByKey.get(`${g.name}|INTL`);
            const orderUsd = (us?.orderAmount ?? 0) + (intl?.orderAmount ?? 0);
            const isOpen = expanded.has(g.name);
            const scaling = inputs.scaling[g.name] ?? 1.0;
            return (
              <>
                <tr key={`${g.name}-row`} className="hover:bg-neutral-50">
                  <td className="px-2 py-2 align-top">
                    <button
                      onClick={() => toggle(g.name)}
                      className="text-neutral-400 hover:text-neutral-700"
                    >
                      {isOpen ? "▾" : "▸"}
                    </button>
                  </td>
                  <td className="px-3 py-2 align-top font-medium text-neutral-900">
                    {g.name}
                    {g.kind === "calculated" && g.isMainLine && (
                      <span className="ml-2 rounded bg-blue-50 px-1.5 py-0.5 text-[10px] uppercase text-blue-700">
                        Main Line
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 align-top text-xs text-neutral-600">
                    {g.kind === "calculated" ? "Calculated" : "Custom"}
                  </td>
                  <td className="px-3 py-2 align-top text-right">
                    <NumericCell
                      value={scaling}
                      onChange={(n) =>
                        patch((c) => ({
                          ...c,
                          scaling: { ...c.scaling, [g.name]: n ?? 1.0 },
                        }))
                      }
                      digits={2}
                      step="0.01"
                      width="w-20"
                    />
                  </td>
                  <td className="px-3 py-2 align-top text-right">
                    {g.kind === "calculated" && g.isMainLine ? (
                      <MainLineSplitControls
                        groupName={g.name}
                        usCurrent={currentSplits.us[g.name] ?? 0}
                        intlCurrent={currentSplits.intl[g.name] ?? 0}
                        usOverride={inputs.splits.us[g.name]}
                        intlOverride={inputs.splits.intl[g.name]}
                        onChangeUs={(n) =>
                          patch((c) => ({
                            ...c,
                            splits: {
                              ...c.splits,
                              us: { ...c.splits.us, [g.name]: n ?? 0 },
                            },
                          }))
                        }
                        onChangeIntl={(n) =>
                          patch((c) => ({
                            ...c,
                            splits: {
                              ...c.splits,
                              intl: { ...c.splits.intl, [g.name]: n ?? 0 },
                            },
                          }))
                        }
                      />
                    ) : g.kind === "custom" ? (
                      <CustomQtyControls
                        groupName={g.name}
                        total={inputs.customQtys[g.name] ?? 0}
                        usShare={inputs.customUsShare[g.name] ?? 1.0}
                        onChangeTotal={(n) =>
                          patch((c) => ({
                            ...c,
                            customQtys: {
                              ...c.customQtys,
                              [g.name]: n ?? 0,
                            },
                          }))
                        }
                        onChangeShare={(n) =>
                          patch((c) => ({
                            ...c,
                            customUsShare: {
                              ...c.customUsShare,
                              [g.name]: n,
                            },
                          }))
                        }
                      />
                    ) : (
                      <span className="text-xs text-neutral-400">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 align-top text-right tabular-nums text-neutral-700">
                    {fmtMos(us?.futureMos ?? null)} /{" "}
                    {fmtMos(intl?.futureMos ?? null)}
                  </td>
                  <td className="px-3 py-2 align-top text-right tabular-nums text-neutral-700">
                    {fmtNum(us?.qtyToOrder ?? 0)} /{" "}
                    {fmtNum(intl?.qtyToOrder ?? 0)}
                  </td>
                  <td className="px-3 py-2 align-top text-right tabular-nums font-medium text-neutral-900">
                    {fmtMoney(orderUsd)}
                  </td>
                  <td className="px-3 py-2 align-top">
                    <input
                      value={inputs.comments[g.name] ?? ""}
                      onChange={(e) =>
                        patch((c) => ({
                          ...c,
                          comments: {
                            ...c.comments,
                            [g.name]: e.target.value,
                          },
                        }))
                      }
                      className="w-full rounded border border-neutral-200 px-2 py-1 text-xs"
                      placeholder="…"
                      disabled={isApproved}
                    />
                  </td>
                </tr>
                {isOpen && (
                  <tr key={`${g.name}-detail`} className="bg-neutral-50">
                    <td />
                    <td colSpan={8} className="px-3 py-3">
                      <SkuDetailTable
                        details={detailsByGroup.get(g.name) ?? []}
                      />
                    </td>
                  </tr>
                )}
              </>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function MainLineSplitControls({
  groupName,
  usCurrent,
  intlCurrent,
  usOverride,
  intlOverride,
  onChangeUs,
  onChangeIntl,
}: {
  groupName: string;
  usCurrent: number;
  intlCurrent: number;
  usOverride: number | undefined;
  intlOverride: number | undefined;
  onChangeUs: (n: number | null) => void;
  onChangeIntl: (n: number | null) => void;
}) {
  return (
    <div className="flex flex-col items-end gap-1 text-xs text-neutral-600">
      <div className="flex items-center gap-1">
        <span className="text-neutral-400">
          curr {usCurrent.toFixed(2)} →
        </span>
        <NumericCell
          value={usOverride ?? usCurrent}
          onChange={onChangeUs}
          digits={2}
          step="0.01"
          width="w-16"
        />
        <span className="text-neutral-400">US</span>
      </div>
      <div className="flex items-center gap-1">
        <span className="text-neutral-400">
          curr {intlCurrent.toFixed(2)} →
        </span>
        <NumericCell
          value={intlOverride ?? intlCurrent}
          onChange={onChangeIntl}
          digits={2}
          step="0.01"
          width="w-16"
        />
        <span className="text-neutral-400">INTL</span>
      </div>
      <span className="sr-only">{groupName}</span>
    </div>
  );
}

function CustomQtyControls({
  groupName,
  total,
  usShare,
  onChangeTotal,
  onChangeShare,
}: {
  groupName: string;
  total: number;
  usShare: number;
  onChangeTotal: (n: number | null) => void;
  onChangeShare: (n: number) => void;
}) {
  const sharePct = Math.round(usShare * 100);
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        <NumericCell
          value={total}
          onChange={onChangeTotal}
          digits={0}
          width="w-20"
        />
        <span className="text-xs text-neutral-500">units</span>
      </div>
      <div className="flex items-center gap-2 text-xs text-neutral-600">
        <input
          type="range"
          min={0}
          max={100}
          step={5}
          value={sharePct}
          onChange={(e) => onChangeShare(Number(e.target.value) / 100)}
          className="w-24"
        />
        <span className="tabular-nums">
          US {sharePct}% / INTL {100 - sharePct}%
        </span>
      </div>
      <span className="sr-only">{groupName}</span>
    </div>
  );
}

function SkuDetailTable({ details }: { details: DetailRow[] }) {
  if (details.length === 0) {
    return (
      <div className="text-xs text-neutral-500">
        No SKU detail (group has no enriched SKUs yet — check skus catalog).
      </div>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead className="text-left text-[10px] uppercase tracking-wide text-neutral-500">
          <tr>
            <th className="px-2 py-1">SKU</th>
            <th className="px-2 py-1">Side</th>
            <th className="px-2 py-1 text-right">Shopify 30D</th>
            <th className="px-2 py-1 text-right">Amazon 30D</th>
            <th className="px-2 py-1 text-right">Adj sales</th>
            <th className="px-2 py-1 text-right">Stock (PD/Amz/Hold)</th>
            <th className="px-2 py-1 text-right">Incoming</th>
            <th className="px-2 py-1 text-right">Current MOS</th>
            <th className="px-2 py-1 text-right">FUT MOS</th>
            <th className="px-2 py-1 text-right">Qty</th>
            <th className="px-2 py-1 text-right">Unit cost</th>
            <th className="px-2 py-1 text-right">Amount</th>
          </tr>
        </thead>
        <tbody>
          {details.map((d) => (
            <tr
              key={`${d.sku}-${d.side}`}
              className={clsx(
                "border-t border-neutral-200",
                d.side === "INTL" && "bg-neutral-50/40",
              )}
            >
              <td className="px-2 py-1 font-mono">{d.sku}</td>
              <td className="px-2 py-1">{d.side}</td>
              <td className="px-2 py-1 text-right tabular-nums">
                {fmtNum(d.shopify30d)}
              </td>
              <td className="px-2 py-1 text-right tabular-nums">
                {fmtNum(d.amazon30d)}
              </td>
              <td className="px-2 py-1 text-right tabular-nums">
                {fmtNum(d.adjustedSales)}
              </td>
              <td className="px-2 py-1 text-right tabular-nums text-neutral-600">
                {fmtNum(d.pdStock)}/{fmtNum(d.amazonStock)}/{fmtNum(d.amazonHold)}
              </td>
              <td className="px-2 py-1 text-right tabular-nums">
                {fmtNum(d.incoming)}
              </td>
              <td className="px-2 py-1 text-right tabular-nums">
                {fmtMos(d.currentMos)}
              </td>
              <td className="px-2 py-1 text-right tabular-nums">
                {fmtMos(d.futureMos)}
              </td>
              <td className="px-2 py-1 text-right tabular-nums font-medium">
                {fmtNum(d.qtyToOrder)}
              </td>
              <td className="px-2 py-1 text-right tabular-nums">
                {fmtMoney2(d.unitCost)}
              </td>
              <td className="px-2 py-1 text-right tabular-nums font-medium">
                {fmtMoney(d.amount)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
