"use client";
import { useState } from "react";
import { trpc } from "@/lib/trpc/client";

// Loox review monitor (Scott 2026-07-13): incoming reviews per product with
// Claude's analysis and the KPIs he was computing by hand. Data arrives via
// the forwarding-inbox pipeline; until that's configured the page explains
// exactly what's missing instead of sitting empty.

function Stars({ rating }: { rating: number | null }) {
  if (rating === null) return <span className="text-neutral-400">—</span>;
  return (
    <span className="tabular-nums text-amber-600" title={`${rating}/5`}>
      {"★".repeat(rating)}
      <span className="text-neutral-300">{"★".repeat(Math.max(0, 5 - rating))}</span>
    </span>
  );
}

function fmtDate(d: string | Date): string {
  return new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

export default function ReviewsPage() {
  const [selected, setSelected] = useState<string | null>(null);
  const utils = trpc.useUtils();
  const overview = trpc.reviews.overview.useQuery(undefined, { refetchOnWindowFocus: false });
  const product = trpc.reviews.product.useQuery(
    { productTitle: selected ?? "" },
    { enabled: !!selected, refetchOnWindowFocus: false },
  );
  const refresh = trpc.reviews.refresh.useMutation({
    onSettled: () => {
      void utils.reviews.overview.invalidate();
      void utils.reviews.product.invalidate();
    },
  });

  const data = overview.data;
  const configured = data?.configured;

  return (
    <main className="space-y-4 p-6">
      <header className="flex items-baseline justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-neutral-900">Reviews</h1>
          <p className="mt-1 max-w-2xl text-sm text-neutral-500">
            Incoming Loox reviews per product, with the running rating and an
            automatic read of themes, complaints and improvement ideas. Reviews
            arrive via the forwarding inbox; analysis refreshes whenever new
            reviews land.
          </p>
        </div>
        <button
          onClick={() => refresh.mutate()}
          disabled={refresh.isPending || !configured?.imap}
          className="whitespace-nowrap rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm hover:border-neutral-400 disabled:opacity-50"
        >
          {refresh.isPending ? "Checking inbox…" : "Check now"}
        </button>
      </header>

      {configured && (!configured.imap || !configured.anthropic) && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {!configured.imap && (
            <p>
              <span className="font-medium">Inbox not connected yet.</span> Set
              LOOX_IMAP_USER and LOOX_IMAP_PASSWORD once the dedicated Gmail
              exists and Loox notifications forward to it.
            </p>
          )}
          {!configured.anthropic && (
            <p>
              <span className="font-medium">Analysis not configured.</span> Set
              ANTHROPIC_API_KEY to enable the automatic review analysis.
            </p>
          )}
        </div>
      )}

      {data && data.unparsedCount > 0 && (
        <div className="rounded-md border border-orange-300 bg-orange-50 px-3 py-2 text-xs text-orange-900">
          {data.unparsedCount} forwarded email{data.unparsedCount === 1 ? "" : "s"} could not be
          parsed into a review — the raw text is kept so the parser can be extended.
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(300px,2fr)_3fr]">
        {/* product list */}
        <section className="rounded-md border border-neutral-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-neutral-50 text-left text-[11px] uppercase tracking-wide text-neutral-600">
              <tr>
                <th className="px-3 py-2">Product</th>
                <th className="px-3 py-2 text-right">Reviews</th>
                <th className="px-3 py-2 text-right">Avg</th>
                <th className="px-3 py-2 text-right">Last 14d</th>
              </tr>
            </thead>
            <tbody>
              {(data?.products ?? []).map((p) => (
                <tr
                  key={p.productTitle}
                  onClick={() => setSelected(p.productTitle)}
                  className={
                    "cursor-pointer border-t border-neutral-100 hover:bg-neutral-50 " +
                    (selected === p.productTitle ? "bg-neutral-100" : "")
                  }
                >
                  <td className="px-3 py-2 font-medium text-neutral-800">{p.productTitle}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{p.reviewCount}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {p.avgRating ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{p.recentCount}</td>
                </tr>
              ))}
              {data && data.products.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center text-sm text-neutral-500">
                    No reviews yet — they appear here as soon as the first
                    forwarded Loox email lands.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </section>

        {/* detail: analysis + feed */}
        <section className="space-y-3">
          {!selected && (
            <p className="rounded-md border border-neutral-200 bg-white px-4 py-8 text-center text-sm text-neutral-500">
              Pick a product to see its analysis and review feed.
            </p>
          )}
          {selected && product.data && (
            <>
              {product.data.analysis ? (
                <div className="rounded-md border border-neutral-200 bg-white p-4 text-sm">
                  <div className="flex items-baseline justify-between">
                    <h2 className="font-semibold text-neutral-900">{selected}</h2>
                    <span className="text-xs text-neutral-500">
                      analyzed {fmtDate(product.data.analysis.generatedAt)} ·{" "}
                      {product.data.analysis.reviewCount} reviews · avg{" "}
                      {product.data.analysis.avgRating ?? "—"}
                    </span>
                  </div>
                  {(() => {
                    const a = product.data.analysis.analysis as {
                      summary: string; themes: string[]; complaints: string[];
                      improvement_ideas: string[]; standout_quotes: string[];
                    };
                    return (
                      <div className="mt-2 space-y-3">
                        <p className="text-neutral-700">{a.summary}</p>
                        <div className="grid gap-3 sm:grid-cols-2">
                          <div>
                            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">Themes</h3>
                            <ul className="mt-1 list-inside list-disc text-neutral-700">
                              {a.themes.map((t) => <li key={t}>{t}</li>)}
                            </ul>
                          </div>
                          <div>
                            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-red-600">Complaints</h3>
                            {a.complaints.length ? (
                              <ul className="mt-1 list-inside list-disc text-neutral-700">
                                {a.complaints.map((t) => <li key={t}>{t}</li>)}
                              </ul>
                            ) : (
                              <p className="mt-1 text-neutral-400">none recurring</p>
                            )}
                          </div>
                          <div>
                            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-emerald-700">Improvement ideas</h3>
                            {a.improvement_ideas.length ? (
                              <ul className="mt-1 list-inside list-disc text-neutral-700">
                                {a.improvement_ideas.map((t) => <li key={t}>{t}</li>)}
                              </ul>
                            ) : (
                              <p className="mt-1 text-neutral-400">—</p>
                            )}
                          </div>
                          <div>
                            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">Standout quotes</h3>
                            {a.standout_quotes.length ? (
                              <ul className="mt-1 space-y-1 text-neutral-600">
                                {a.standout_quotes.map((q) => (
                                  <li key={q} className="italic">“{q}”</li>
                                ))}
                              </ul>
                            ) : (
                              <p className="mt-1 text-neutral-400">—</p>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })()}
                </div>
              ) : (
                <p className="rounded-md border border-neutral-200 bg-white px-4 py-4 text-sm text-neutral-500">
                  No analysis yet for {selected} — it generates on the next cron
                  pass (or Check now) once ANTHROPIC_API_KEY is set.
                </p>
              )}

              <div className="rounded-md border border-neutral-200 bg-white">
                {product.data.reviews.map((r) => (
                  <div key={r.id} className="border-t border-neutral-100 px-4 py-3 first:border-t-0">
                    <div className="flex items-baseline justify-between text-xs text-neutral-500">
                      <span>
                        <Stars rating={r.rating} />
                        <span className="ml-2 font-medium text-neutral-700">
                          {r.reviewerName ?? "anonymous"}
                        </span>
                      </span>
                      <span>{fmtDate(r.receivedAt)}</span>
                    </div>
                    <p className="mt-1 text-sm text-neutral-700">{r.reviewText ?? "(no text)"}</p>
                  </div>
                ))}
              </div>
            </>
          )}
        </section>
      </div>
    </main>
  );
}
