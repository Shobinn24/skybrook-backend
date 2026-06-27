"use client";
import { useEffect, useState } from "react";
import { trpc } from "@/lib/trpc/client";

const RANGE_OPTIONS = [
  { days: 1, label: "Yesterday" },
  { days: 7, label: "7d" },
  { days: 14, label: "14d" },
  { days: 30, label: "30d" },
] as const;

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

// Expandable spend breakdown: two independent cuts of the same spend — by
// platform (FB / AppLovin) and by region (US / non-US, across both platforms).
function SpendSplit({
  fb,
  al,
  us,
  nonUs,
}: {
  fb: number;
  al: number;
  us: number;
  nonUs: number;
}) {
  return (
    <div className="text-[10px] font-normal text-neutral-400">
      FB {fmtMoney(fb)}
      {al > 0 && <> · AL {fmtMoney(al)}</>}
      <span className="text-neutral-300">
        {" "}· US {fmtMoney(us)} · non-US {fmtMoney(nonUs)}
      </span>
    </div>
  );
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

// Add `days` to a YYYY-MM-DD date (UTC math, stays calendar-correct).
function addDaysYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

// Inclusive day count between two YYYY-MM-DD dates (start..end).
function spanDaysInclusive(start: string, end: string): number {
  const [sy, sm, sd] = start.split("-").map(Number);
  const [ey, em, ed] = end.split("-").map(Number);
  return Math.round((Date.UTC(ey, em - 1, ed) - Date.UTC(sy, sm - 1, sd)) / 86_400_000) + 1;
}

export default function PerformancePage() {
  // Custom date range (Jasper 2026-06-01, mirroring FB Ads Tracker). The
  // preset buttons (Yesterday / 7d / 14d / 30d) now set start+end relative
  // to the chosen end date; the From/To inputs allow any explicit window.
  const [rangeStart, setRangeStart] = useState<string>("");
  const [rangeEnd, setRangeEnd] = useState<string>("");
  // Focus areas (4 hand-configured products) vs All products (every product,
  // revenue from product_sales_usd + FB spend attributed by ad-name prefix).
  const [view, setView] = useState<"focus" | "all">("focus");
  // All-products spend column: combined (FB + AppLovin) by default; toggle
  // reveals the per-row FB / AppLovin split (Scott 2026-06-26).
  const [showSpendSplit, setShowSpendSplit] = useState(false);
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

  // Default to a single day (matches the old "Yesterday" default) on the
  // most recent date where both revenue + spend exist.
  useEffect(() => {
    if (rangeEnd) return;
    if (safeDefault) {
      setRangeEnd(safeDefault);
      setRangeStart(safeDefault);
    }
  }, [rangeEnd, safeDefault]);

  const adSpendMaxDate = freshness.data?.adSpendMaxDate ?? null;
  const spendStaleForEndDate =
    !!adSpendMaxDate && !!rangeEnd && rangeEnd > adSpendMaxDate;

  // Preset = last N days ending on rangeEnd. Anchor on the current end
  // (or the safe default) so presets compose with a hand-picked end date.
  function applyPreset(days: number) {
    const end = rangeEnd || safeDefault || yesterday;
    setRangeEnd(end);
    setRangeStart(addDaysYmd(end, -(days - 1)));
  }
  const activeSpanDays =
    rangeStart && rangeEnd ? spanDaysInclusive(rangeStart, rangeEnd) : null;

  const { data, isLoading, error } = trpc.inventory.getPerformance.useQuery(
    { rangeStart, rangeEnd },
    { refetchOnWindowFocus: false, enabled: !!rangeStart && !!rangeEnd },
  );

  // All-products rollup — only fetched when the toggle is on "All products".
  const allQ = trpc.inventory.getAllProducts.useQuery(
    { rangeStart, rangeEnd },
    {
      refetchOnWindowFocus: false,
      enabled: view === "all" && !!rangeStart && !!rangeEnd,
    },
  );

  const rows = data?.rows ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-neutral-900">Performance</h1>
          <p className="text-sm text-neutral-500">
            {data
              ? `Revenue from Shopify · spend from Supermetrics FB · ${fmtDate(data.rangeStart)} – ${fmtDate(data.rangeEnd)}`
              : "Revenue from Shopify · spend from Supermetrics FB"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="inline-flex overflow-hidden rounded-md border border-neutral-300 bg-white">
            {(
              [
                ["focus", "Focus areas"],
                ["all", "All products"],
              ] as const
            ).map(([v, label]) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={
                  "px-3 py-1.5 text-sm font-medium " +
                  (view === v
                    ? "bg-neutral-900 text-white"
                    : "text-neutral-700 hover:bg-neutral-100")
                }
              >
                {label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 text-sm">
            <label htmlFor="perf-start-date" className="text-neutral-600">
              From
            </label>
            <input
              id="perf-start-date"
              type="date"
              value={rangeStart}
              max={rangeEnd || yesterday}
              onChange={(e) => setRangeStart(e.target.value || rangeStart)}
              className="rounded-md border border-neutral-300 bg-white px-2 py-1 text-sm text-neutral-700 focus:outline-none focus:ring-1 focus:ring-neutral-400"
            />
            <label htmlFor="perf-end-date" className="text-neutral-600">
              To
            </label>
            <input
              id="perf-end-date"
              type="date"
              value={rangeEnd}
              min={rangeStart}
              max={yesterday}
              onChange={(e) => {
                const v = e.target.value || rangeEnd;
                setRangeEnd(v);
                if (rangeStart && v < rangeStart) setRangeStart(v);
              }}
              className="rounded-md border border-neutral-300 bg-white px-2 py-1 text-sm text-neutral-700 focus:outline-none focus:ring-1 focus:ring-neutral-400"
            />
            {safeDefault &&
              (rangeEnd !== safeDefault || rangeStart !== safeDefault) && (
                <button
                  onClick={() => {
                    setRangeEnd(safeDefault);
                    setRangeStart(safeDefault);
                  }}
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
                onClick={() => applyPreset(opt.days)}
                className={
                  "px-3 py-1.5 text-sm font-medium " +
                  (activeSpanDays === opt.days
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

      {view === "focus" ? (
        error ? (
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
                  Ad spend not yet ingested for {fmtDate(rangeEnd)}.
                </strong>{" "}
                Latest available is {fmtDate(adSpendMaxDate)}. Revenue is
                accurate but spend / ROAS will show $0 / — for any day past
                that. Supermetrics refreshes at 3am EDT; the Skybrook
                ingest cron picks it up at 5am EDT.{" "}
                <button
                  onClick={() => {
                    setRangeEnd(adSpendMaxDate);
                    if (rangeStart && adSpendMaxDate < rangeStart)
                      setRangeStart(adSpendMaxDate);
                  }}
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
            {data && data.sourceErrors.length > 0 && (
              <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">
                <div className="flex items-start gap-2">
                  <span aria-hidden="true">⚠</span>
                  <div>
                    <div className="font-semibold">
                      Upstream ad-spend feed broken — ROAS values below may be
                      understated for affected products.
                    </div>
                    <div className="mt-1 text-red-800">
                      Latest Supermetrics pull returned an error for:{" "}
                      {data.sourceErrors.map((e, i) => (
                        <span key={e.tab}>
                          {i > 0 && ", "}
                          <code className="rounded bg-red-100 px-1">{e.tab}</code>
                        </span>
                      ))}
                      . Reason:{" "}
                      {data.sourceErrors[0].reason === "license"
                        ? "Supermetrics license / trial issue — check hub.supermetrics.com → Data sources."
                        : data.sourceErrors[0].reason === "quota"
                        ? "Daily API quota exceeded — wait for reset or upgrade tier."
                        : data.sourceErrors[0].reason === "auth"
                        ? "Connector auth expired — re-authorize the data source."
                        : "Unknown upstream error — see Slack alert details."}
                    </div>
                    <div className="mt-1 text-[11px] text-red-700">
                      Full error: {data.sourceErrors[0].signature}
                    </div>
                  </div>
                </div>
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
                      {r.spendByTab.map((b) => {
                        const rowColor = b.sourceError
                          ? "text-red-700"
                          : b.staleness
                          ? "text-amber-700"
                          : "text-neutral-600";
                        return (
                          <div key={b.tab} className={"flex justify-between " + rowColor}>
                            <span className="inline-flex items-center gap-1">
                              {shortTabLabel(b.tab)}
                              {b.sourceError && (
                                <span
                                  aria-hidden="true"
                                  title={b.sourceError.signature}
                                  className="cursor-help"
                                >
                                  ⚠
                                </span>
                              )}
                              {!b.sourceError && b.staleness && (
                                <span
                                  aria-hidden="true"
                                  title={
                                    b.staleness.latestDate
                                      ? `Last data ${b.staleness.latestDate} (${b.staleness.daysBehind} days behind)`
                                      : "Never received any data"
                                  }
                                  className="cursor-help"
                                >
                                  ⏰
                                </span>
                              )}
                            </span>
                            <span className="tabular-nums">{fmtMoney(b.spendUsd)}</span>
                          </div>
                        );
                      })}
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
        )
      ) : allQ.error ? (
        <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          Failed to load: {allQ.error.message}
        </div>
      ) : allQ.isLoading || !allQ.data ? (
        <div className="text-sm text-neutral-500">Loading…</div>
      ) : (
        <>
          <div className="flex justify-end">
            <button
              onClick={() => setShowSpendSplit((s) => !s)}
              className="text-xs text-neutral-600 underline hover:text-neutral-900"
            >
              {showSpendSplit ? "Hide spend breakdown" : "Show spend breakdown (FB/AppLovin · US/non-US)"}
            </button>
          </div>
          <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="border-b border-neutral-200 text-left text-[11px] uppercase tracking-wide text-neutral-500">
                  <th className="px-4 py-2 font-medium">Product</th>
                  <th className="px-4 py-2 text-right font-medium">Revenue</th>
                  <th className="px-4 py-2 text-right font-medium">Ad spend</th>
                  <th className="px-4 py-2 text-right font-medium">ROAS</th>
                </tr>
              </thead>
              <tbody>
                {allQ.data.rows
                  .filter((r) => r.kind === "product")
                  .map((r) => (
                    <tr key={r.product} className="border-b border-neutral-100">
                      <td className="px-4 py-2 text-neutral-800">{r.product}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-neutral-900">
                        {fmtMoney(r.revenueUsd)}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-neutral-900">
                        {fmtMoney(r.spendUsd)}
                        {showSpendSplit && (
                          <SpendSplit
                            fb={r.fbSpendUsd}
                            al={r.appLovinSpendUsd}
                            us={r.usSpendUsd}
                            nonUs={r.nonUsSpendUsd}
                          />
                        )}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums font-medium text-neutral-900">
                        {fmtRoas(r.roas)}
                      </td>
                    </tr>
                  ))}
                {/* Shipping & tax — revenue not attributed to any product */}
                <tr className="border-b border-neutral-100 bg-neutral-50 text-neutral-600">
                  <td className="px-4 py-2 italic">Shipping &amp; tax</td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {fmtMoney(allQ.data.ancillaryUsd)}
                  </td>
                  <td className="px-4 py-2 text-right text-neutral-400">—</td>
                  <td className="px-4 py-2 text-right text-neutral-400">—</td>
                </tr>
                {/* Non-product spend buckets (brand / clearance / unmapped) */}
                {allQ.data.rows
                  .filter((r) => r.kind !== "product")
                  .map((r) => (
                    <tr
                      key={r.product}
                      className="border-b border-neutral-100 bg-neutral-50 text-neutral-600"
                    >
                      <td className="px-4 py-2 italic">{r.product}</td>
                      <td className="px-4 py-2 text-right text-neutral-400">—</td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        {fmtMoney(r.spendUsd)}
                        {showSpendSplit && (
                          <SpendSplit
                            fb={r.fbSpendUsd}
                            al={r.appLovinSpendUsd}
                            us={r.usSpendUsd}
                            nonUs={r.nonUsSpendUsd}
                          />
                        )}
                      </td>
                      <td className="px-4 py-2 text-right text-neutral-400">—</td>
                    </tr>
                  ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-neutral-300 font-semibold text-neutral-900">
                  <td className="px-4 py-2">Total</td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {fmtMoney(allQ.data.totalRevenueUsd)}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {fmtMoney(allQ.data.totalSpendUsd)}
                    {showSpendSplit && (
                      <SpendSplit
                        fb={allQ.data.totalFbSpendUsd}
                        al={allQ.data.totalAppLovinSpendUsd}
                        us={allQ.data.totalUsSpendUsd}
                        nonUs={allQ.data.totalNonUsSpendUsd}
                      />
                    )}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums font-medium">
                    {allQ.data.totalSpendUsd > 0
                      ? fmtRoas(allQ.data.totalRevenueUsd / allQ.data.totalSpendUsd)
                      : "—"}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
          <div className="rounded-md border border-neutral-200 bg-neutral-50 px-4 py-3 text-xs text-neutral-600">
            <strong>All products:</strong> revenue is exact product sales
            (shipping &amp; tax broken out as its own line) summed from{" "}
            <code>daily_sales</code>; ad spend is Facebook + AppLovin combined
            (use &ldquo;Show spend breakdown&rdquo; for the FB/AppLovin and
            US/non-US splits). FB spend is attributed by each ad&apos;s{" "}
            <strong>destination URL</strong> (the page it sends to), falling back
            to the ad name when no URL is available. The US/non-US split now
            covers both Facebook and AppLovin. <em>Brand / Homepage</em> and{" "}
            <em>Clearance / Mixed</em> are spend not tied to one product;{" "}
            <em>Unmapped</em> = ads with no recognized product page or name tag.
          </div>
        </>
      )}
    </div>
  );
}
