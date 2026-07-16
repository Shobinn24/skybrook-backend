"use client";
import { useState } from "react";
import { trpc } from "@/lib/trpc/client";

// Sizing exchange analysis (Scott 2026-07-15, spec-faithful). Two views,
// deliberately separate (combining them was tried manually and was harder
// to read):
//   Direction — of exchanges at each size, % up (ran small) vs down (ran
//   big) vs same-size style swap. Denominator = exchanges.
//   Rate — exchanges as % of units sold per size. Denominator = sales.
// XXS is a real size (confirmed 2026-07-16) and counts fully; boundary
// sizes carry a censoring marker and never drive the verdict chip.

type Range = { from?: string; to?: string };

const PRESETS: { label: string; days: number | null }[] = [
  { label: "All data", days: null },
  { label: "90d", days: 90 },
  { label: "180d", days: 180 },
];

const UP = "#D85A30"; // sized up — ran small
const DOWN = "#4A7C9B"; // sized down — ran big
const SAME = "#CCCCCC";
// Boundary sizes can only exchange one way, so their mix carries no
// signal — rendered as a neutral striped bar instead (Scott 2026-07-16).
const NO_SIGNAL_STRIPES =
  "repeating-linear-gradient(45deg, #E2E2E2 0 6px, #F4F4F4 6px 12px)";

export default function SizingPage() {
  const [view, setView] = useState<"direction" | "rate">("direction");
  const [range, setRange] = useState<Range>({});

  return (
    <main className="mx-auto max-w-6xl px-4 py-6">
      <div className="mb-1 flex items-baseline justify-between">
        <h1 className="text-xl font-semibold">Sizing exchanges</h1>
        <span className="text-xs text-neutral-500">
          CS exchange log (EV tab) × Shopify sales · Seamless excluded · 2026 data
        </span>
      </div>
      <p className="mb-4 text-sm text-neutral-600">
        Direction says which way a size misses; Rate says how much it matters. Standard and
        Heavy are never merged — they routinely run in opposite directions.
      </p>

      <div className="mb-4 flex flex-wrap items-center gap-2 text-xs">
        <div className="flex overflow-hidden rounded-md border border-neutral-300">
          {(
            [
              { v: "direction", label: "Direction mix" },
              { v: "rate", label: "Exchange rate vs sales" },
            ] as const
          ).map((t) => (
            <button
              key={t.v}
              onClick={() => setView(t.v)}
              className={
                "px-3 py-1.5 " +
                (view === t.v ? "bg-neutral-800 text-white" : "bg-white text-neutral-600 hover:bg-neutral-50")
              }
            >
              {t.label}
            </button>
          ))}
        </div>
        <span className="h-4 w-px bg-neutral-200" />
        <div className="flex overflow-hidden rounded-md border border-neutral-300">
          {PRESETS.map((p) => {
            const active =
              (p.days === null && !range.from && !range.to) ||
              (p.days !== null &&
                !range.to &&
                range.from === new Date(Date.now() - p.days * 86400000).toISOString().slice(0, 10));
            return (
              <button
                key={p.label}
                onClick={() =>
                  setRange(
                    p.days === null
                      ? {}
                      : { from: new Date(Date.now() - p.days * 86400000).toISOString().slice(0, 10) },
                  )
                }
                className={
                  "px-2.5 py-1.5 " +
                  (active ? "bg-neutral-800 text-white" : "bg-white text-neutral-600 hover:bg-neutral-50")
                }
              >
                {p.label}
              </button>
            );
          })}
        </div>
        <span className="flex items-center gap-1 text-neutral-600">
          <input
            type="date"
            value={range.from ?? ""}
            max={range.to}
            onChange={(e) => setRange({ ...range, from: e.target.value || undefined })}
            className="rounded-md border border-neutral-300 bg-white px-1.5 py-1 text-neutral-700"
          />
          →
          <input
            type="date"
            value={range.to ?? ""}
            min={range.from}
            onChange={(e) => setRange({ ...range, to: e.target.value || undefined })}
            className="rounded-md border border-neutral-300 bg-white px-1.5 py-1 text-neutral-700"
          />
        </span>
        {view === "direction" ? (
          <span className="flex items-center gap-3 text-neutral-600">
            <Chip color={UP} /> sized up (ran small)
            <Chip color={DOWN} /> sized down (ran big)
            <Chip color={SAME} /> same size
            <span className="flex items-center gap-1">
              <span
                className="inline-block h-3 w-3 rounded-sm align-middle"
                style={{ background: NO_SIGNAL_STRIPES }}
              />
              smallest/largest size — no signal
            </span>
          </span>
        ) : (
          <span className="text-neutral-600">
            &lt;5% normal for apparel · 7–10% watch · &gt;10% problem
          </span>
        )}
      </div>

      {view === "direction" ? <DirectionView range={range} /> : <RateView range={range} />}
    </main>
  );
}

function Chip({ color }: { color: string }) {
  return <span className="inline-block h-3 w-3 rounded-sm align-middle" style={{ background: color }} />;
}

function VerdictChip({ verdict }: { verdict: string }) {
  const cls =
    verdict === "runs small"
      ? "bg-orange-100 text-orange-800"
      : verdict === "runs large"
      ? "bg-sky-100 text-sky-800"
      : verdict === "neutral"
      ? "bg-neutral-100 text-neutral-600"
      : "bg-neutral-50 text-neutral-400";
  return <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase ${cls}`}>{verdict}</span>;
}

function DirectionView({ range }: { range: Range }) {
  const q = trpc.sizing.directionMix.useQuery(range);
  if (q.isLoading) return <p className="text-sm text-neutral-500">Loading…</p>;
  if (q.error) return <p className="text-sm text-red-600">{q.error.message}</p>;
  const panels = q.data?.panels ?? [];
  if (!panels.length) return <p className="text-sm text-neutral-500">No exchange data in range.</p>;

  return (
    <div className="grid gap-4 md:grid-cols-2">
      {panels.map((p) => (
        <section key={p.label} className="rounded-md border border-neutral-200 bg-white p-4">
          <div className="mb-2 flex items-baseline justify-between">
            <h2 className="text-sm font-semibold">{p.label}</h2>
            <span className="flex items-center gap-2 text-xs text-neutral-500">
              <VerdictChip verdict={p.verdict} />
              n={p.totalExchanges.toLocaleString()}
            </span>
          </div>
          <div className="grid gap-1">
            {p.cells.map((c) => (
              <div key={c.size} className="flex items-center gap-2 text-xs">
                <span className="w-9 shrink-0 text-right text-neutral-700">{c.size}</span>
                {c.boundary ? (
                  <div
                    className="h-4 flex-1 rounded-sm"
                    style={{ background: NO_SIGNAL_STRIPES }}
                    title={`${c.size} is at the end of this product's size run — exchanges can only go one way, so the mix carries no signal (up ${c.pctUp}% · down ${c.pctDown}% · same ${c.pctSame}%)`}
                  />
                ) : c.lowConfidence ? (
                  <span className="flex-1 text-neutral-400">– (n={c.total}, too few to read)</span>
                ) : (
                  <div
                    className="flex h-4 flex-1 overflow-hidden rounded-sm"
                    title={`up ${c.pctUp}% · down ${c.pctDown}% · same ${c.pctSame}%`}
                  >
                    <div style={{ width: `${c.pctUp}%`, background: UP }} />
                    <div style={{ width: `${c.pctDown}%`, background: DOWN }} />
                    <div style={{ width: `${c.pctSame}%`, background: SAME }} />
                  </div>
                )}
                <span className="w-14 shrink-0 text-right tabular-nums text-neutral-500">
                  n={c.total}
                </span>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

// Overall average per product (Scott 2026-07-16) — same severity
// thresholds as the per-size cells below it.
function OverallRateTable({
  panels,
}: {
  panels: { label: string; units: number; exchanges: number }[];
}) {
  const rows = panels
    .map((p) => ({
      ...p,
      rate: p.units > 0 ? Math.round((p.exchanges / p.units) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.rate - a.rate);
  return (
    <section className="mb-4 rounded-md border border-neutral-200 bg-white">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-neutral-200 text-left text-neutral-500">
            <th className="px-3 py-2 font-medium">Product</th>
            <th className="px-3 py-2 text-right font-medium">Units sold</th>
            <th className="px-3 py-2 text-right font-medium">Sizing exchanges</th>
            <th className="px-3 py-2 text-right font-medium">Overall exchange rate</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const color = r.rate > 10 ? "#DC2626" : r.rate >= 7 ? "#D97706" : "#374151";
            return (
              <tr key={r.label} className="border-b border-neutral-100 last:border-0">
                <td className="px-3 py-1.5 font-medium text-neutral-700">{r.label}</td>
                <td className="px-3 py-1.5 text-right tabular-nums text-neutral-500">
                  {r.units.toLocaleString()}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums text-neutral-500">
                  {r.exchanges.toLocaleString()}
                </td>
                <td className="px-3 py-1.5 text-right font-semibold tabular-nums" style={{ color }}>
                  {r.rate}%
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

function RateView({ range }: { range: Range }) {
  const q = trpc.sizing.salesWeighted.useQuery(range);
  if (q.isLoading) return <p className="text-sm text-neutral-500">Loading…</p>;
  if (q.error) return <p className="text-sm text-red-600">{q.error.message}</p>;
  const panels = q.data?.panels ?? [];
  if (!panels.length) return <p className="text-sm text-neutral-500">No sales data in range yet.</p>;

  return (
    <>
      <p className="mb-3 text-xs text-neutral-500">
        Sales coverage: {q.data?.salesCoverage.from ?? "–"} → {q.data?.salesCoverage.to ?? "–"} ·
        exchange % = sizing exchanges ÷ units sold at that size
      </p>
      <OverallRateTable panels={panels} />
      <div className="grid gap-4 md:grid-cols-2">
        {panels.map((p) => (
          <section key={p.label} className="rounded-md border border-neutral-200 bg-white p-4">
            <div className="mb-2 flex items-baseline justify-between">
              <h2 className="text-sm font-semibold">{p.label}</h2>
              <span className="text-xs text-neutral-500">
                {p.exchanges.toLocaleString()} exch / {p.units.toLocaleString()} units
              </span>
            </div>
            <div className="grid gap-1">
              {p.cells.map((c) => {
                const color =
                  c.severity === "problem" ? "#DC2626" : c.severity === "watch" ? "#D97706" : "#9CA3AF";
                return (
                  <div key={c.size} className="flex items-center gap-2 text-xs">
                    <span className="w-9 shrink-0 text-right text-neutral-700">{c.size}</span>
                    <div className="h-4 flex-1 rounded-sm bg-neutral-100">
                      <div
                        className="h-full rounded-sm"
                        style={{ width: `${Math.min(100, c.pctExch * 5)}%`, background: color }}
                        title={`${c.pctExch}% of ${c.units.toLocaleString()} units exchanged (${c.exchanges})`}
                      />
                    </div>
                    <span className="w-24 shrink-0 text-right tabular-nums" style={{ color }}>
                      {c.pctExch}% <span className="text-neutral-400">({c.units.toLocaleString()}u)</span>
                    </span>
                  </div>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </>
  );
}
