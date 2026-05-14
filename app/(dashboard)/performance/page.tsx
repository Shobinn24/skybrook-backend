"use client";
import { useEffect, useState } from "react";
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

// Shorten Supermetrics tab names for the spend breakdown — operators just
// want to see "FB" vs "AL", not the full per-product tab title.
function shortTabLabel(tab: string): string {
  return / AL$/i.test(tab) ? "AL" : "FB";
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

// Pick the lower of two YYYY-MM-DD strings (lexicographic compare on
// ISO date strings = correct chronological order). Returns the first
// non-null when one side is null, or null when both are null.
function minDate(a: string | null, b: string | null): string | null {
  if (a && b) return a < b ? a : b;
  return a ?? b;
}

// Yesterday in EST as YYYY-MM-DD. Today's data is still accumulating,
// so the picker max + initial value is yesterday.
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

export default function PerformancePage() {
  const [rangeDays, setRangeDays] = useState<RangeDays>(1);
  const [endDate, setEndDate] = useState<string>("");
  const yesterday = yesterdayEstYmd();

  // Fetch the latest revenue + spend dates so we can default the
  // end-date picker to a day where BOTH have data. Previously the
  // page defaulted to "yesterday" and silently showed $X revenue
  // with $0 spend on mornings before the Supermetrics ingest had
  // run for that day — confusing operators into thinking the page
  // was broken. Jasper 2026-05-14.
  const freshness = trpc.inventory.getPerformanceDataFreshness.useQuery(
    undefined,
    { refetchOnWindowFocus: false },
  );
  const safeDefault = freshness.data
    ? minDate(
        freshness.data.revenueMaxDate,
        freshness.data.adSpendMaxDate,
      ) ?? yesterday
    : null;

  useEffect(() => {
    if (endDate) return;
    if (safeDefault) setEndDate(safeDefault);
  }, [endDate, safeDefault]);

  const adSpendMaxDate = freshness.data?.adSpendMaxDate ?? null;
  const spendStaleForEndDate =
    !!adSpendMaxDate && !!endDate && endDate > adSpendMaxDate;

  const { data, isLoading, error } = trpc.inventory.getPerformance.useQuery(
    { rangeDays, endDate },
    { refetchOnWindowFocus: false, enabled: !!endDate },
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
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 text-sm">
            <label htmlFor="perf-end-date" className="text-neutral-600">
              Ending
            </label>
            <input
              id="perf-end-date"
              type="date"
              value={endDate}
              max={yesterday}
              onChange={(e) => setEndDate(e.target.value || yesterday)}
              className="rounded-md border border-neutral-300 bg-white px-2 py-1 text-sm text-neutral-700 focus:outline-none focus:ring-1 focus:ring-neutral-400"
            />
            {safeDefault && endDate !== safeDefault && (
              <button
                onClick={() => setEndDate(safeDefault)}
                className="text-xs text-neutral-500 hover:text-neutral-900 underline"
              >
                Reset
              </button>
            )}
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
      </div>

      {error ? (
        <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          Failed to load: {error.message}
        </div>
      ) : isLoading ? (
        <div className="text-sm text-neutral-500">Loading…</div>
      ) : (
        <>
          {spendStaleForEndDate && adSpendMaxDate && (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              <strong>
                Ad spend not yet ingested for {fmtDate(endDate)}.
              </strong>{" "}
              Latest available is {fmtDate(adSpendMaxDate)}. Revenue is
              accurate but spend / ROAS will show $0 / — for any day past
              that. Supermetrics refreshes at 3am EDT; the Skybrook
              ingest cron picks it up at 5am EDT.{" "}
              <button
                onClick={() => setEndDate(adSpendMaxDate)}
                className="underline hover:no-underline"
              >
                Switch to {fmtDate(adSpendMaxDate)}
              </button>
              .
            </div>
          )}
          {data?.warnEmpty && (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              Most products have $0 spend or revenue in this range. Either the
              ad spend sheet hasn&apos;t refreshed yet today (it runs at 3am
              EDT) or the product mapping needs review. The 09:00 UTC ingest
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
                        <span>{shortTabLabel(b.tab)}</span>
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
            Supermetrics sheet (refreshes 4am Asuncion = 3am EDT, our
            cron pulls at 09:00 UTC). Each product rolls Facebook +
            AppLovin spend
            into one combined ROAS. Revenue summed from{" "}
            <code>daily_sales</code> across all Shopify channels.
            Product mapping: <code>Mens%</code> → Men&apos;s,{" "}
            <code>Shapewear%</code> → Shapewear,{" "}
            <code>Super High-Waist%</code> → SupHW.
          </div>
        </>
      )}
    </div>
  );
}
