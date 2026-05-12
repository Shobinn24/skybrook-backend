"use client";
import { useMemo, useRef, useEffect, useState } from "react";
import { trpc } from "@/lib/trpc/client";
import {
  FB_MARKETERS,
  FB_MARKETER_UNASSIGNED,
} from "@/lib/domain/fb-marketers";

const PRESETS = [
  { days: 7, label: "7d" },
  { days: 14, label: "14d" },
  { days: 30, label: "30d" },
] as const;

const MARKETER_FILTER_OPTIONS = [...FB_MARKETERS, FB_MARKETER_UNASSIGNED] as const;
type MarketerFilterOption = (typeof MARKETER_FILTER_OPTIONS)[number];

function fmtMoney(n: number): string {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
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

// Yesterday in EST as YYYY-MM-DD. Today's data is still accumulating,
// so the picker default + max is yesterday — same convention as
// /performance.
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
  const t = Date.UTC(y, m - 1, d + days);
  return new Date(t).toISOString().slice(0, 10);
}

export default function FbAdsPage() {
  const yesterday = useMemo(() => yesterdayEstYmd(), []);
  const [rangeEnd, setRangeEnd] = useState<string>(yesterday);
  const [rangeStart, setRangeStart] = useState<string>(() =>
    addDaysYmd(yesterday, -29),
  );
  const [selectedMarketers, setSelectedMarketers] = useState<
    ReadonlySet<MarketerFilterOption>
  >(() => new Set());
  const [marketerMenuOpen, setMarketerMenuOpen] = useState(false);
  const marketerMenuRef = useRef<HTMLDivElement>(null);

  // Close the marketer dropdown on outside click.
  useEffect(() => {
    if (!marketerMenuOpen) return;
    function onClickAway(e: MouseEvent) {
      if (
        marketerMenuRef.current &&
        !marketerMenuRef.current.contains(e.target as Node)
      ) {
        setMarketerMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", onClickAway);
    return () => document.removeEventListener("mousedown", onClickAway);
  }, [marketerMenuOpen]);

  const marketerFilterArray = useMemo(
    () => Array.from(selectedMarketers),
    [selectedMarketers],
  );

  const { data, isLoading, error } = trpc.inventory.getFbAdsRollup.useQuery(
    {
      rangeStart,
      rangeEnd,
      marketers: marketerFilterArray.length > 0 ? marketerFilterArray : undefined,
    },
    { refetchOnWindowFocus: false },
  );

  const rows = data?.rows ?? [];

  function applyPreset(days: number) {
    setRangeEnd(yesterday);
    setRangeStart(addDaysYmd(yesterday, -(days - 1)));
  }

  function toggleMarketer(name: MarketerFilterOption) {
    setSelectedMarketers((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  function clearMarketers() {
    setSelectedMarketers(new Set());
  }

  const marketerButtonLabel =
    selectedMarketers.size === 0
      ? "All marketers"
      : selectedMarketers.size === 1
        ? Array.from(selectedMarketers)[0]
        : `${selectedMarketers.size} marketers`;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-neutral-900">
            FB Ads Tracker
          </h1>
          <p className="text-sm text-neutral-500">
            Top-spending Facebook ads pivoted by ad number ·{" "}
            {fmtDate(rangeStart)} – {fmtDate(rangeEnd)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2 text-sm">
            <label htmlFor="fb-start-date" className="text-neutral-600">
              From
            </label>
            <input
              id="fb-start-date"
              type="date"
              value={rangeStart}
              max={rangeEnd}
              onChange={(e) => setRangeStart(e.target.value || rangeStart)}
              className="rounded-md border border-neutral-300 bg-white px-2 py-1 text-sm text-neutral-700 focus:outline-none focus:ring-1 focus:ring-neutral-400"
            />
            <label htmlFor="fb-end-date" className="text-neutral-600">
              To
            </label>
            <input
              id="fb-end-date"
              type="date"
              value={rangeEnd}
              max={yesterday}
              min={rangeStart}
              onChange={(e) => setRangeEnd(e.target.value || rangeEnd)}
              className="rounded-md border border-neutral-300 bg-white px-2 py-1 text-sm text-neutral-700 focus:outline-none focus:ring-1 focus:ring-neutral-400"
            />
          </div>
          <div className="inline-flex overflow-hidden rounded-md border border-neutral-300 bg-white">
            {PRESETS.map((opt) => (
              <button
                key={opt.days}
                onClick={() => applyPreset(opt.days)}
                className="px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-100"
              >
                {opt.label}
              </button>
            ))}
          </div>
          <div className="relative" ref={marketerMenuRef}>
            <button
              type="button"
              onClick={() => setMarketerMenuOpen((v) => !v)}
              className="inline-flex items-center gap-1.5 rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-100"
            >
              {marketerButtonLabel}
              <span aria-hidden className="text-neutral-400">
                ▾
              </span>
            </button>
            {marketerMenuOpen && (
              <div className="absolute right-0 z-10 mt-1 w-52 rounded-md border border-neutral-200 bg-white py-1 text-sm shadow-lg">
                <div className="flex items-center justify-between border-b border-neutral-100 px-3 py-1.5 text-xs uppercase tracking-wide text-neutral-500">
                  <span>Filter by marketer</span>
                  {selectedMarketers.size > 0 && (
                    <button
                      type="button"
                      onClick={clearMarketers}
                      className="text-blue-600 hover:underline"
                    >
                      Clear
                    </button>
                  )}
                </div>
                {MARKETER_FILTER_OPTIONS.map((name) => (
                  <label
                    key={name}
                    className="flex cursor-pointer items-center gap-2 px-3 py-1.5 hover:bg-neutral-50"
                  >
                    <input
                      type="checkbox"
                      checked={selectedMarketers.has(name)}
                      onChange={() => toggleMarketer(name)}
                      className="rounded border-neutral-300"
                    />
                    <span
                      className={
                        name === FB_MARKETER_UNASSIGNED
                          ? "italic text-neutral-500"
                          : "text-neutral-700"
                      }
                    >
                      {name}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {error ? (
        <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          Failed to load: {error.message}
        </div>
      ) : isLoading ? (
        <div className="text-sm text-neutral-500">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="rounded-md border border-neutral-200 bg-white p-6 text-sm text-neutral-600">
          No FB ad spend in this range yet. If the page is brand-new, the
          ingest job may not have run — it pulls from the FB Ads Tracker
          sheet on the same 14:00 UTC schedule as the other Supermetrics
          tabs.
        </div>
      ) : (
        <>
          <div className="rounded-md border border-neutral-200 bg-white p-4 text-sm text-neutral-700">
            <span className="text-neutral-500">Total spend</span>{" "}
            <span className="font-semibold tabular-nums">
              {fmtMoney(data?.totalSpendUsd ?? 0)}
            </span>{" "}
            <span className="text-neutral-500">across {rows.length} ads</span>
          </div>
          <div className="overflow-x-auto rounded-md border border-neutral-200 bg-white">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-neutral-200 bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500">
                  <th className="w-16 px-3 py-2 font-medium">#</th>
                  <th className="w-24 px-3 py-2 font-medium">Ad #</th>
                  <th className="px-3 py-2 font-medium">Ad name</th>
                  <th className="w-40 px-3 py-2 font-medium">Marketer</th>
                  <th className="w-24 px-3 py-2 font-medium">Link</th>
                  <th className="w-32 px-3 py-2 text-right font-medium">
                    Spend
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.adNumber}
                    className="border-b border-neutral-100 last:border-b-0 hover:bg-neutral-50"
                  >
                    <td className="px-3 py-2 text-neutral-500 tabular-nums">
                      {r.rank}
                    </td>
                    <td className="px-3 py-2 font-medium text-neutral-900 tabular-nums">
                      {r.adNumber}
                    </td>
                    <td className="px-3 py-2 text-neutral-800">
                      <div title={r.adNameRaw}>{r.adName}</div>
                      <div
                        className="text-[11px] text-neutral-400 truncate max-w-md"
                        title={r.adNameRaw}
                      >
                        {r.adNameRaw}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-xs text-neutral-700">
                      {r.marketers.length === 0 ? (
                        <span className="italic text-neutral-400">Unassigned</span>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {r.marketers.map((m) => (
                            <span
                              key={m}
                              className="inline-flex items-center rounded-full bg-neutral-100 px-2 py-0.5 font-medium text-neutral-700"
                            >
                              {m}
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {r.adLink ? (
                        <a
                          href={r.adLink}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-600 hover:underline"
                        >
                          Open ↗
                        </a>
                      ) : (
                        <span className="text-neutral-400">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right font-semibold tabular-nums text-neutral-900">
                      {fmtMoney(r.spendUsd)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="rounded-md border border-neutral-200 bg-neutral-50 px-4 py-3 text-xs text-neutral-600">
            <strong>Notes:</strong> Source is the FB Ads Tracker sheet
            (Sheet7). Ad number is parsed from column A — the integer
            after &ldquo;Ad &rdquo; or &ldquo;DCA &rdquo;. The same ad
            number can run in multiple campaigns; spend is summed across
            all of them. Ad name + link shown are taken from the
            highest-spending variant. Ingest runs daily at 14:00 UTC.
          </div>
        </>
      )}
    </div>
  );
}
