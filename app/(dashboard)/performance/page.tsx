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
// platform (FB / AppLovin) and by region (US / INTL funnel, across both platforms).
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
        {" "}· US {fmtMoney(us)} · INTL {fmtMoney(nonUs)}
      </span>
    </div>
  );
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
  // Focus areas (4 hand-picked lines) vs All products (every line). Both are
  // views of the SAME per-product-line computation (net revenue; URL-first FB
  // + AppLovin spend) — a focus card and its All-products row always agree.
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

  // Landing URLs carrying FB spend that aren't in the product-map sheet yet
  // (snapshot-scoped). Shown as a section under the All-products table so new
  // funnels get added to the sheet. Only fetched on the All-products view.
  const unmappedQ = trpc.inventory.getUnmappedFbUrls.useQuery(undefined, {
    refetchOnWindowFocus: false,
    enabled: view === "all",
  });

  const rows = data?.rows ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-neutral-900">Performance</h1>
          <p className="text-sm text-neutral-500">
            {data
              ? `Net revenue from Shopify · spend from FB (link-based) + AppLovin · ${fmtDate(data.rangeStart)} – ${fmtDate(data.rangeEnd)}`
              : "Net revenue from Shopify · spend from FB (link-based) + AppLovin"}
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
                  {/* Per-source silent-staleness badges only: the loud-error
                      banner went away with the Supermetrics name-tabs; loud
                      failures on the FB/AppLovin feeds are covered by the
                      freshness cron's Slack alerts. */}
                  <div className="mt-4 border-t border-neutral-100 pt-2 space-y-0.5 text-[11px]">
                    <div className="text-neutral-500">Spend breakdown:</div>
                    {r.spendBySource.map((b) => {
                      const rowColor = b.staleness
                        ? "text-amber-700"
                        : "text-neutral-600";
                      return (
                        <div key={b.source} className={"flex justify-between " + rowColor}>
                          <span className="inline-flex items-center gap-1">
                            {b.source === "AL" ? "AppLovin" : "FB"}
                            {b.staleness && (
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
                </div>
              ))}
              {/* Owner request 2026-07-03: spend-only box for ads with
                  "infotainment" in the name, appended after the product
                  cards. These ads carry no attributable revenue, so Revenue
                  and ROAS are intentionally absent (rollup exposes spend
                  only). */}
              {data?.infotainment && (
                <div className="rounded-lg border border-neutral-200 bg-white p-5">
                  <div className="text-xs uppercase tracking-wide text-neutral-500">
                    Infotainment
                  </div>
                  <div className="mt-3">
                    <div className="text-[10px] uppercase tracking-wide text-neutral-400">
                      Spend
                    </div>
                    <div className="text-lg font-semibold text-neutral-900 tabular-nums">
                      {fmtMoney(data.infotainment.spendUsd)}
                    </div>
                  </div>
                  <div className="mt-4 border-t border-neutral-100 pt-3 text-[11px] text-neutral-500">
                    All ads with &ldquo;infotainment&rdquo; in the name. Spend
                    only: revenue is not attributable to these ads, so no
                    ROAS.
                  </div>
                </div>
              )}
            </div>

            {/* Aggregate men's rollup (owner request 2026-07-20): all men's
                lines combined + US / INTL cuts. Per-product men's numbers
                are distorted by cross-product traffic (e.g. Mens ads landing
                on the Brief with Fly page intl); the aggregate cancels that
                out. */}
            {data?.mens && (
              <>
                <div className="mt-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">
                  Men&apos;s rollup — all men&apos;s products combined
                </div>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                  {data.mens.rows.map((r) => (
                    <div
                      key={r.key}
                      className="rounded-lg border border-neutral-300 bg-white p-5"
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
                      {r.spendBySource && (
                        <div className="mt-4 border-t border-neutral-100 pt-2 space-y-0.5 text-[11px]">
                          <div className="text-neutral-500">Spend breakdown:</div>
                          {r.spendBySource.map((b) => (
                            <div
                              key={b.source}
                              className={
                                "flex justify-between " +
                                (b.staleness ? "text-amber-700" : "text-neutral-600")
                              }
                            >
                              <span>{b.source === "AL" ? "AppLovin" : "FB"}</span>
                              <span className="tabular-nums">{fmtMoney(b.spendUsd)}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
                <div className="rounded-md border border-neutral-200 bg-neutral-50 px-4 py-3 text-xs text-neutral-600">
                  <strong>Men&apos;s rollup notes:</strong> Combines the{" "}
                  {data.mens.lines.length > 0
                    ? data.mens.lines.join(", ")
                    : "men's"}{" "}
                  lines. US / INTL <em>revenue</em> is split by which Shopify
                  store sold; US / INTL <em>spend</em> is split by the ad&apos;s
                  funnel region from the product-map sheet (audience-geo
                  fraction when a URL isn&apos;t mapped). Because some men&apos;s
                  ads currently send traffic to a different men&apos;s product
                  page, per-product men&apos;s cards can misattribute between
                  the men&apos;s lines — these rollup cards are immune to that.
                </div>
              </>
            )}

            <div className="rounded-md border border-neutral-200 bg-neutral-50 px-4 py-3 text-xs text-neutral-600">
              <strong>Notes:</strong> Each card shows the same product line
              (identical revenue / spend / ROAS) as the All products table.
              Revenue is net, summed from <code>daily_sales</code> across all
              Shopify channels — product sales plus each product&apos;s
              pro-rated shipping &amp; tax share. Spend combines link-based
              Facebook attribution (each ad&apos;s destination URL via the
              product-map sheet, ad-name fallback) + AppLovin into one
              combined ROAS. Cards map to the lines <em>Mens</em>,{" "}
              <em>Shapewear</em>, <em>Super High-Waist</em> and{" "}
              <em>High Rise Short</em>.
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
              {showSpendSplit ? "Hide spend breakdown" : "Show spend breakdown (FB/AppLovin · US/INTL)"}
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
            <strong>All products:</strong> revenue is net, summed from{" "}
            <code>daily_sales</code> — each product&apos;s sales plus its
            pro-rated shipping &amp; tax share (no separate shipping &amp; tax
            line); ad spend is Facebook + AppLovin combined
            (use &ldquo;Show spend breakdown&rdquo; for the FB/AppLovin and
            US/INTL splits). FB product &amp; US/INTL come from the product-map
            sheet, matched on each ad&apos;s <strong>destination URL</strong>,
            falling back to the ad name when a URL is not in the sheet. The
            Focus areas cards show these same numbers for their four lines.{" "}
            <em>Brand / Homepage</em> and <em>Clearance / Mixed</em> are spend
            not tied to one product; <em>Unmapped</em> / <em>Other (NA)</em> =
            ads with no recognized product page or name tag.
          </div>

          {/* Links carrying FB spend that aren't in the product-map sheet yet. */}
          {unmappedQ.data && unmappedQ.data.length > 0 && (
            <div className="overflow-x-auto rounded-lg border border-amber-200 bg-amber-50">
              <div className="px-4 py-3 text-sm">
                <strong className="text-amber-900">
                  Ad links not in the product sheet ({unmappedQ.data.length})
                </strong>
                <p className="mt-1 text-xs text-amber-800">
                  These landing URLs carry Facebook spend but have no row in the
                  product-map sheet, so their product &amp; US/INTL fell back to
                  the ad name. Add each one to the sheet to attribute it
                  correctly.
                </p>
              </div>
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="border-y border-amber-200 text-left text-[11px] uppercase tracking-wide text-amber-700">
                    <th className="px-4 py-2 font-medium">URL</th>
                    <th className="px-4 py-2 text-right font-medium">FB spend</th>
                  </tr>
                </thead>
                <tbody>
                  {unmappedQ.data.map((u) => (
                    <tr key={u.url} className="border-b border-amber-100">
                      <td className="px-4 py-2 font-mono text-xs text-amber-900">{u.url}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-amber-900">
                        {fmtMoney(u.spendUsd)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
