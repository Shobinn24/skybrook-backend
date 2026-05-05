"use client";
import { useState } from "react";
import { trpc } from "@/lib/trpc/client";

const RANGE_OPTIONS = [
  { days: 1, label: "Yesterday" },
  { days: 7, label: "7d" },
  { days: 14, label: "14d" },
  { days: 30, label: "30d" },
] as const;

type RangeDays = (typeof RANGE_OPTIONS)[number]["days"];

function fmtMoney(n: number): string {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

function fmtRoas(n: number | null): string {
  if (n === null) return "—";
  return n.toFixed(2);
}

function fmtDate(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  if (!y || !m || !d) return ymd;
  return new Date(y, m - 1, d).toLocaleDateString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default function PerformancePage() {
  const [rangeDays, setRangeDays] = useState<RangeDays>(1);
  const { data, isLoading, error } = trpc.inventory.getPerformance.useQuery(
    { rangeDays },
    { refetchOnWindowFocus: false },
  );

  const rows = data?.rows ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-neutral-900">Performance</h1>
          <p className="text-sm text-neutral-500">
            {data
              ? `Revenue from Shopify · spend from Supermetrics FB · ${fmtDate(data.rangeStart)} – ${fmtDate(data.rangeEnd)}`
              : "Revenue from Shopify · spend from Supermetrics FB"}
          </p>
        </div>
        <div className="inline-flex overflow-hidden rounded-md border border-neutral-300 bg-white">
          {RANGE_OPTIONS.map((opt) => (
            <button
              key={opt.days}
              onClick={() => setRangeDays(opt.days)}
              className={
                "px-3 py-1.5 text-sm font-medium " +
                (rangeDays === opt.days
                  ? "bg-neutral-900 text-white"
                  : "text-neutral-700 hover:bg-neutral-100")
              }
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {error ? (
        <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          Failed to load: {error.message}
        </div>
      ) : isLoading ? (
        <div className="text-sm text-neutral-500">Loading…</div>
      ) : (
        <>
          {data?.warnEmpty && (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              Most products have $0 spend or revenue in this range. Either the
              ad spend sheet hasn&apos;t refreshed yet today (it runs at 4am LA
              time) or the product mapping needs review. The 14:00 UTC ingest
              cron picks up new spend daily.
            </div>
          )}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            {rows.map((r) => (
              <div
                key={r.key}
                className="rounded-lg border border-neutral-200 bg-white p-5"
              >
                <div className="text-xs uppercase tracking-wide text-neutral-500">
                  {r.label}
                </div>
                <div className="mt-3 grid grid-cols-2 gap-3">
                  <div>
                    <div className="text-[10px] uppercase tracking-wide text-neutral-400">
                      Revenue
                    </div>
                    <div className="text-lg font-semibold text-neutral-900 tabular-nums">
                      {fmtMoney(r.revenueUsd)}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-wide text-neutral-400">
                      Spend
                    </div>
                    <div className="text-lg font-semibold text-neutral-900 tabular-nums">
                      {fmtMoney(r.spendUsd)}
                    </div>
                  </div>
                </div>
                <div className="mt-4 border-t border-neutral-100 pt-3">
                  <div className="text-[10px] uppercase tracking-wide text-neutral-400">
                    ROAS
                  </div>
                  <div className="text-2xl font-bold tabular-nums text-neutral-900">
                    {fmtRoas(r.roas)}
                  </div>
                </div>
                {r.spendByTab.length > 1 && (
                  <div className="mt-4 border-t border-neutral-100 pt-2 space-y-0.5 text-[11px]">
                    <div className="text-neutral-500">Spend breakdown:</div>
                    {r.spendByTab.map((b) => (
                      <div key={b.tab} className="flex justify-between text-neutral-600">
                        <span>{b.tab}</span>
                        <span className="tabular-nums">{fmtMoney(b.spendUsd)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>

          <div className="rounded-md border border-neutral-200 bg-neutral-50 px-4 py-3 text-xs text-neutral-600">
            <strong>Notes:</strong> Spend ingested daily from the
            Supermetrics FB sheet (refreshes 4am LA, our cron pulls at
            14:00 UTC). Revenue summed from <code>daily_sales</code>
            across all Shopify channels. Product mapping: <code>Mens%</code>{" "}
            → Men&apos;s, <code>Shapewear%</code> → Shapewear,{" "}
            <code>Super High-Waist%</code> → SupHW (rolls FB + AppLovin spend
            into one ROAS).
          </div>
        </>
      )}
    </div>
  );
}
