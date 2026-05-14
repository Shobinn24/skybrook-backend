"use client";
import { useMemo, useState } from "react";
import { InventoryTable } from "@/components/inventory/InventoryTable";
import { ProductRollupTable } from "@/components/inventory/ProductRollupTable";
import { KpiCard } from "@/components/inventory/KpiCard";
import {
  WarehouseToggle,
  type WarehouseSelection,
} from "@/components/inventory/WarehouseToggle";
import { trpc } from "@/lib/trpc/client";
import type { NumberTrace } from "@/lib/queries/inventory";
import {
  applyAtRiskWindow,
  AT_RISK_HORIZON_DAYS,
} from "@/lib/domain/at-risk-window";
import { isMainColor } from "@/lib/domain/sku-naming";

// Velocity window picker — defaults to the pre-computed 7d rollup.
// Switching to any other state triggers an on-demand query against
// daily_sales so operators can cross-check velocity against external
// spreadsheets. DOS / weeks-of-stock / sustainability flags continue
// to use the 7d-based pre-computation either way (out of scope for
// this picker).
const VELOCITY_PRESETS = [
  { days: 7, label: "7d (default)" },
  { days: 14, label: "14d" },
  { days: 30, label: "30d" },
  { days: 60, label: "60d" },
  { days: 90, label: "90d" },
] as const;

type VelocityPreset = (typeof VELOCITY_PRESETS)[number]["days"];

type VelocitySelection =
  | { kind: "default" }
  | { kind: "preset"; days: Exclude<VelocityPreset, 7> }
  | { kind: "custom"; rangeStart: string; rangeEnd: string };

// Yesterday in EST as YYYY-MM-DD — matches the cron's data convention
// (today's data is still accumulating). Same logic as /fb-ads.
function yesterdayEstYmd(): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const todayEst = fmt.format(new Date());
  const [y, m, d] = todayEst.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

function addDaysYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function fmtDate(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  if (!y || !m || !d) return ymd;
  return new Date(y, m - 1, d).toLocaleDateString([], {
    month: "short",
    day: "numeric",
  });
}

function moneyCompact(n: number): string {
  if (n === 0) return "$0";
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toLocaleString()}`;
}

// Trace popovers want a precise dollar figure even when the KPI card
// shows the compact form ($1.2M). Render whole dollars with commas.
function stockValueDisplay(n: number): string {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

export default function InventoryPage() {
  const [selection, setSelection] = useState<WarehouseSelection>("US");
  const isAll = selection === "All";
  // Default to grouped — Scott 2026-05-05: "make the default view 1 row per
  // product (not per sku) with an option to click expand to see all SKUs."
  // Flat per-SKU view stays one toggle away for engineering / CSV export.
  const [groupByProduct, setGroupByProduct] = useState(true);
  // Scott 2026-05-07: filter out alt-color OG / HW / 9055 SKUs so the
  // at-risk view focuses on currently-advertised colorways. Defaults
  // off so total counts still match other tabs by default.
  const [mainColorOnly, setMainColorOnly] = useState(false);

  // Two parallel queries — `enabled` gates each so single-warehouse
  // mode only fires the matching one. React Query dedupes + caches both
  // so toggling between US/CN/All doesn't re-fetch.
  const usQuery = trpc.inventory.getInventoryRows.useQuery(
    { location: "US" },
    {
      refetchOnWindowFocus: false,
      enabled: isAll || selection === "US",
    },
  );
  const cnQuery = trpc.inventory.getInventoryRows.useQuery(
    { location: "CN" },
    {
      refetchOnWindowFocus: false,
      enabled: isAll || selection === "CN",
    },
  );

  // Velocity window picker state. Default = pre-computed 7d (no extra
  // query). Anything else fires getVelocityForRange below.
  const [velocitySel, setVelocitySel] = useState<VelocitySelection>({
    kind: "default",
  });
  const yesterday = useMemo(() => yesterdayEstYmd(), []);

  // Range used by the on-demand getVelocityForRange query. Null when the
  // default 7d is active so we use the pre-computed velocityPerDay7d on
  // each row instead of refetching.
  const resolvedRange = useMemo(() => {
    if (velocitySel.kind === "default") return null;
    if (velocitySel.kind === "preset") {
      return {
        rangeStart: addDaysYmd(yesterday, -(velocitySel.days - 1)),
        rangeEnd: yesterday,
      };
    }
    return {
      rangeStart: velocitySel.rangeStart,
      rangeEnd: velocitySel.rangeEnd,
    };
  }, [velocitySel, yesterday]);

  // Range shown in the From/To inputs. Always non-null so the inputs
  // reflect the currently-active preset (including default 7d) — the
  // previous behavior of falling back to a 30d window when default was
  // active was a UX bug surfaced by Jasper 2026-05-14.
  const displayRange = useMemo(() => {
    if (resolvedRange) return resolvedRange;
    // default 7d
    return {
      rangeStart: addDaysYmd(yesterday, -6),
      rangeEnd: yesterday,
    };
  }, [resolvedRange, yesterday]);

  const usVelQuery = trpc.inventory.getVelocityForRange.useQuery(
    {
      location: "US",
      rangeStart: resolvedRange?.rangeStart ?? yesterday,
      rangeEnd: resolvedRange?.rangeEnd ?? yesterday,
    },
    {
      refetchOnWindowFocus: false,
      enabled: !!resolvedRange && (isAll || selection === "US"),
    },
  );
  const cnVelQuery = trpc.inventory.getVelocityForRange.useQuery(
    {
      location: "CN",
      rangeStart: resolvedRange?.rangeStart ?? yesterday,
      rangeEnd: resolvedRange?.rangeEnd ?? yesterday,
    },
    {
      refetchOnWindowFocus: false,
      enabled: !!resolvedRange && (isAll || selection === "CN"),
    },
  );

  const velocityOverride = useMemo(() => {
    if (!resolvedRange) return null;
    const m = new Map<string, number>();
    for (const r of usVelQuery.data?.rows ?? []) m.set(`US:${r.sku}`, r.unitsPerDay);
    for (const r of cnVelQuery.data?.rows ?? []) m.set(`CN:${r.sku}`, r.unitsPerDay);
    return m;
  }, [resolvedRange, usVelQuery.data, cnVelQuery.data]);

  const velocityLabel = useMemo(() => {
    if (velocitySel.kind === "default") return "7d";
    if (velocitySel.kind === "preset") return `${velocitySel.days}d`;
    return `${fmtDate(velocitySel.rangeStart)} – ${fmtDate(velocitySel.rangeEnd)}`;
  }, [velocitySel]);

  const rows = useMemo(() => {
    const raw = isAll
      ? [...(usQuery.data ?? []), ...(cnQuery.data ?? [])]
      : (selection === "US" ? usQuery.data : cnQuery.data) ?? [];
    // Scott 2026-05-06: at-risk on /inventory means "running out within
    // 45 days" per the sustainability projection — different rule than
    // the underlying flag (which is preserved on other tabs).
    const today = new Date().toISOString().slice(0, 10);
    const filtered = mainColorOnly ? raw.filter((r) => isMainColor(r.sku)) : raw;
    return applyAtRiskWindow(filtered, today);
  }, [isAll, selection, usQuery.data, cnQuery.data, mainColorOnly]);

  const isLoading = isAll
    ? usQuery.isLoading || cnQuery.isLoading
    : (selection === "US" ? usQuery : cnQuery).isLoading;
  const error = isAll
    ? usQuery.error ?? cnQuery.error
    : (selection === "US" ? usQuery : cnQuery).error;

  const kpis = useMemo(() => {
    const stockValue = rows.reduce((n, x) => n + x.stockValueUsd, 0);
    const atRisk = rows.filter((x) => x.flag === "at_risk").length;
    const watch = rows.filter((x) => x.flag === "watch").length;
    const overstocked = rows.filter((x) => x.flag === "overstocked").length;
    const incoming = rows.reduce((n, x) => n + x.incomingUnits, 0);
    const totalUnits = rows.reduce((n, x) => n + x.onHand, 0);
    const pricedRows = rows.filter((x) => (x.unitCostUsd ?? 0) > 0).length;
    return {
      stockValue,
      atRisk,
      watch,
      overstocked,
      incoming,
      skuCount: rows.length,
      totalUnits,
      pricedRows,
    };
  }, [rows]);

  const scopeRefLabel = isAll ? "All warehouses (US + CN)" : `${selection} warehouse`;

  // Click-to-inspect traces for the KPI strip. Mirrors the per-row
  // traces on the inventory table — formula + inputs + sources.
  // Recomputed off the same `rows` the cards display so the math
  // displayed in the popover always reconciles.
  const stockValueTrace: NumberTrace = {
    label: `Stock value — ${scopeRefLabel}`,
    formula: "Σ on_hand × unit_cost across the displayed rows",
    inputs: [
      { label: "Rows summed", value: kpis.skuCount.toLocaleString() },
      { label: "Total on-hand units", value: kpis.totalUnits.toLocaleString() },
      { label: "Rows with a unit cost", value: kpis.pricedRows.toLocaleString() },
      { label: "Stock value", value: stockValueDisplay(kpis.stockValue) },
    ],
    sources: [
      { label: "Stock", ref: "stock_snapshots (latest per sku, location)" },
      { label: "Cost", ref: "skus.unit_cost_usd / unit_cost_intl_usd" },
    ],
    note:
      kpis.pricedRows < kpis.skuCount
        ? `${kpis.skuCount - kpis.pricedRows} row(s) have no unit cost; their stock value contribution is $0.`
        : undefined,
  };
  const atRiskTrace: NumberTrace = {
    label: `SKUs at risk — ${scopeRefLabel}`,
    formula: `count of (sku, location) rows projected to run out within the next ${AT_RISK_HORIZON_DAYS} days`,
    inputs: [
      { label: "Rows scanned", value: kpis.skuCount.toLocaleString() },
      { label: "At risk", value: kpis.atRisk.toLocaleString() },
      { label: "Watch (out beyond 45d)", value: kpis.watch.toLocaleString() },
      { label: "Horizon", value: `${AT_RISK_HORIZON_DAYS} days` },
    ],
    sources: [
      { label: "Source", ref: "sustainability_flags + runOutDate (latest per sku, location)" },
      {
        label: "Rule",
        ref:
          "at_risk = projected runOutDate ≤ today + 45d. " +
          "Overstocked rows are excluded. " +
          "Rows with no projected run-out date (PO coverage holds through horizon) are NOT at risk.",
      },
      { label: "Scott", ref: "2026-05-07: at risk should mean projected to run out per sustainability check, not raw weeks-of-stock" },
    ],
  };
  const overstockedTrace: NumberTrace = {
    label: `Overstocked SKUs — ${scopeRefLabel}`,
    formula:
      "count of (sku, location) rows where sustainability flag = 'overstocked'",
    inputs: [
      { label: "Rows scanned", value: kpis.skuCount.toLocaleString() },
      { label: "Overstocked", value: kpis.overstocked.toLocaleString() },
    ],
    sources: [
      { label: "Source", ref: "sustainability_flags (latest per sku, location)" },
      {
        label: "Threshold",
        ref: "overstocked = projected days of stock > 90d (per spec §4.3)",
      },
    ],
  };
  const incomingTrace: NumberTrace = {
    label: `Incoming units — ${scopeRefLabel}`,
    formula: "Σ pending PO quantities across the displayed rows",
    inputs: [
      { label: "Rows summed", value: kpis.skuCount.toLocaleString() },
      { label: "Total incoming", value: kpis.incoming.toLocaleString() },
    ],
    sources: [
      { label: "Source", ref: "incoming_shipments where status != 'arrived'" },
      { label: "Filtered to", ref: scopeRefLabel },
    ],
  };

  // Header label: "all warehouses" reads better than "All" inline.
  const scopeLabel = isAll ? "all warehouses" : `${selection} warehouse`;
  // KPI hint distinguishes "X SKUs" from "X (sku × warehouse) rows" in
  // All mode — a SKU stocked in both warehouses contributes 2 rows.
  const skuCountHint = isAll
    ? `${kpis.skuCount} (SKU × warehouse) rows`
    : `${kpis.skuCount} SKUs`;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-neutral-900">Inventory</h1>
          <p className="text-sm text-neutral-500">
            {isLoading ? "Loading…" : `${kpis.skuCount} ${isAll ? "rows" : "SKUs"} in ${scopeLabel}`}
          </p>
        </div>
        <WarehouseToggle value={selection} onChange={setSelection} showAll />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          label="Stock value"
          value={moneyCompact(kpis.stockValue)}
          hint={skuCountHint}
          trace={stockValueTrace}
        />
        <KpiCard
          label={`SKUs at risk (${AT_RISK_HORIZON_DAYS}d)`}
          value={kpis.atRisk}
          tone={kpis.atRisk > 0 ? "danger" : "neutral"}
          hint={kpis.watch > 0 ? `+${kpis.watch} runs out beyond ${AT_RISK_HORIZON_DAYS}d` : undefined}
          trace={atRiskTrace}
        />
        <KpiCard
          label="Overstocked SKUs"
          value={kpis.overstocked}
          trace={overstockedTrace}
        />
        <KpiCard
          label="Incoming units"
          value={kpis.incoming.toLocaleString()}
          trace={incomingTrace}
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-3 text-xs text-neutral-700">
          <span className="font-medium text-neutral-600">Velocity window</span>
          <div className="inline-flex overflow-hidden rounded-md border border-neutral-300 bg-white">
            {VELOCITY_PRESETS.map((p) => {
              const isActive =
                p.days === 7
                  ? velocitySel.kind === "default"
                  : velocitySel.kind === "preset" && velocitySel.days === p.days;
              return (
                <button
                  key={p.days}
                  type="button"
                  onClick={() =>
                    setVelocitySel(
                      p.days === 7
                        ? { kind: "default" }
                        : {
                            kind: "preset",
                            days: p.days as Exclude<VelocityPreset, 7>,
                          },
                    )
                  }
                  className={
                    "px-3 py-1.5 font-medium " +
                    (isActive
                      ? "bg-neutral-900 text-white"
                      : "text-neutral-700 hover:bg-neutral-100")
                  }
                >
                  {p.label}
                </button>
              );
            })}
            <button
              type="button"
              onClick={() =>
                setVelocitySel({
                  kind: "custom",
                  rangeStart: displayRange.rangeStart,
                  rangeEnd: displayRange.rangeEnd,
                })
              }
              className={
                "px-3 py-1.5 font-medium border-l border-neutral-300 " +
                (velocitySel.kind === "custom"
                  ? "bg-neutral-900 text-white"
                  : "text-neutral-700 hover:bg-neutral-100")
              }
            >
              Custom
            </button>
          </div>
          <div className="flex items-center gap-2">
            <label htmlFor="vel-start" className="text-neutral-600">
              From
            </label>
            <input
              id="vel-start"
              type="date"
              value={displayRange.rangeStart}
              max={displayRange.rangeEnd}
              onChange={(e) =>
                setVelocitySel({
                  kind: "custom",
                  rangeStart: e.target.value,
                  rangeEnd: displayRange.rangeEnd,
                })
              }
              className="rounded-md border border-neutral-300 bg-white px-2 py-1 focus:outline-none focus:ring-1 focus:ring-neutral-400"
            />
            <label htmlFor="vel-end" className="text-neutral-600">
              To
            </label>
            <input
              id="vel-end"
              type="date"
              value={displayRange.rangeEnd}
              max={yesterday}
              min={displayRange.rangeStart}
              onChange={(e) =>
                setVelocitySel({
                  kind: "custom",
                  rangeStart: displayRange.rangeStart,
                  rangeEnd: e.target.value,
                })
              }
              className="rounded-md border border-neutral-300 bg-white px-2 py-1 focus:outline-none focus:ring-1 focus:ring-neutral-400"
            />
          </div>
          {velocitySel.kind !== "default" && (
            <button
              type="button"
              onClick={() => setVelocitySel({ kind: "default" })}
              className="text-blue-600 hover:underline"
            >
              Reset to 7d
            </button>
          )}
        </div>
        <div className="flex items-center gap-4">
          <label
            className="inline-flex items-center gap-2 text-xs text-neutral-700"
            title="Hide alt colorways of OG / HW / 9055 (clearance / aging stock). Boyshort + Super HW colors all count as main."
          >
            <input
              type="checkbox"
              checked={mainColorOnly}
              onChange={(e) => setMainColorOnly(e.target.checked)}
              className="h-3.5 w-3.5"
            />
            Main colors only
          </label>
          <label className="inline-flex items-center gap-2 text-xs text-neutral-700">
            <input
              type="checkbox"
              checked={groupByProduct}
              onChange={(e) => setGroupByProduct(e.target.checked)}
              className="h-3.5 w-3.5"
            />
            Group by product
          </label>
        </div>
      </div>

      {velocitySel.kind !== "default" && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <strong>Velocity ({velocityLabel})</strong> reflects the chosen
          window — sum of units sold ÷ days, computed on demand from
          daily_sales. SKUs with no sales in the window display 0.
          Weeks-of-stock and run-out projection still use the 7d-based
          rollup; only the velocity column is affected by this picker.
        </div>
      )}

      {error ? (
        <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          Failed to load inventory: {error.message}
        </div>
      ) : groupByProduct ? (
        <ProductRollupTable
          warehouse={selection}
          rows={rows}
          velocityLabel={velocityLabel}
          velocityOverride={velocityOverride}
        />
      ) : (
        <InventoryTable
          warehouse={selection}
          rows={rows}
          velocityLabel={velocityLabel}
          velocityOverride={velocityOverride}
        />
      )}
    </div>
  );
}
