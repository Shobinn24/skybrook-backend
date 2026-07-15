"use client";
import { useMemo, useState } from "react";
import { trpc } from "@/lib/trpc/client";

// Loox reviews tool v2 (Scott 2026-07-13): every review from both stores,
// deduped, grouped Std vs Heavy. The KPI table (count / average / stacked
// 5→1 distribution) is pure SQL and always current; clicking a product
// opens the full review feed plus an on-demand Claude chat with every
// matching review in context (Marketing or Product mode). No scheduled
// analysis — Claude only runs, and only costs, when a question is asked.

type Range = { from?: string; to?: string };
type StatusFilter = "published" | "pending" | "all";
type BuyersFilter = "all" | "verified";

const PRESETS: { label: string; days: number | null }[] = [
  { label: "All time", days: null },
  { label: "30d", days: 30 },
  { label: "90d", days: 90 },
  { label: "12m", days: 365 },
];

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

function avgColor(avg: number): string {
  if (avg >= 4.6) return "bg-emerald-100 text-emerald-800";
  if (avg >= 4.3) return "bg-lime-100 text-lime-800";
  if (avg >= 4.0) return "bg-amber-100 text-amber-800";
  return "bg-red-100 text-red-800";
}

const DIST_COLORS = ["bg-emerald-500", "bg-lime-400", "bg-yellow-400", "bg-orange-400", "bg-red-500"];

function DistBar({ dist, n }: { dist: [number, number, number, number, number]; n: number }) {
  if (n === 0) return <div className="h-2.5 w-full rounded bg-neutral-100" />;
  const title = dist.map((c, i) => `${5 - i}★ ${c} (${Math.round((c / n) * 100)}%)`).join("  ");
  return (
    <div className="flex h-2.5 w-full overflow-hidden rounded" title={title}>
      {dist.map((c, i) =>
        c > 0 ? (
          <div key={i} className={DIST_COLORS[i]} style={{ width: `${(c / n) * 100}%` }} />
        ) : null,
      )}
    </div>
  );
}

type OverviewProduct = {
  displayName: string;
  line: string;
  n: number;
  avgRating: string | null;
  r5: number;
  r4: number;
  r3: number;
  r2: number;
  r1: number;
  latestReviewAt: Date | string | null;
};

type Selection = { displayName: string; line: "std" | "heavy" };

function KpiRows({
  products,
  selected,
  onSelect,
}: {
  products: OverviewProduct[];
  selected: Selection | null;
  onSelect: (sel: Selection) => void;
}) {
  return (
    <>
      {products.map((p) => {
        const avg = p.avgRating ? Number(p.avgRating) : null;
        const isSel = selected?.displayName === p.displayName && selected?.line === p.line;
        return (
          <tr
            key={`${p.displayName}|${p.line}`}
            onClick={() => onSelect({ displayName: p.displayName, line: p.line as "std" | "heavy" })}
            className={
              "cursor-pointer border-t border-neutral-100 hover:bg-neutral-50 " +
              (isSel ? "bg-neutral-100" : "")
            }
          >
            <td className="max-w-[16rem] truncate px-3 py-2 font-medium text-neutral-800">
              {p.displayName}
            </td>
            <td className="px-3 py-2 text-right tabular-nums">{p.n.toLocaleString()}</td>
            <td className="px-3 py-2 text-right">
              {avg !== null ? (
                <span className={`inline-block rounded px-1.5 py-0.5 text-xs font-semibold tabular-nums ${avgColor(avg)}`}>
                  {p.avgRating}
                </span>
              ) : (
                "—"
              )}
            </td>
            <td className="w-[30%] px-3 py-2">
              <DistBar dist={[p.r5, p.r4, p.r3, p.r2, p.r1]} n={p.n} />
            </td>
            <td className="whitespace-nowrap px-3 py-2 text-right text-xs text-neutral-500">
              {p.latestReviewAt ? fmtDate(p.latestReviewAt) : "—"}
            </td>
          </tr>
        );
      })}
    </>
  );
}

function TotalRow({ label, products }: { label: string; products: OverviewProduct[] }) {
  const n = products.reduce((a, p) => a + p.n, 0);
  if (n === 0) return null;
  const weighted =
    products.reduce((a, p) => a + (p.avgRating ? Number(p.avgRating) * p.n : 0), 0) / n;
  const dist = ([5, 4, 3, 2, 1] as const).map((s) =>
    products.reduce((a, p) => a + p[`r${s}` as "r5"], 0),
  ) as [number, number, number, number, number];
  return (
    <tr className="border-t border-neutral-200 bg-neutral-50 font-semibold">
      <td className="px-3 py-2 text-neutral-700">{label}</td>
      <td className="px-3 py-2 text-right tabular-nums">{n.toLocaleString()}</td>
      <td className="px-3 py-2 text-right">
        <span className={`inline-block rounded px-1.5 py-0.5 text-xs font-semibold tabular-nums ${avgColor(weighted)}`}>
          {weighted.toFixed(2)}
        </span>
      </td>
      <td className="px-3 py-2">
        <DistBar dist={dist} n={n} />
      </td>
      <td className="px-3 py-2" />
    </tr>
  );
}

function ChatPanel({
  sel,
  range,
  status,
  buyers,
}: {
  sel: Selection;
  range: Range;
  status: StatusFilter;
  buyers: BuyersFilter;
}) {
  const [mode, setMode] = useState<"marketing" | "product">("marketing");
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<{ role: "user" | "assistant"; content: string }[]>([]);
  const [attachments, setAttachments] = useState<
    Record<number, { reviewedAt: Date | string | null; rating: number | null; reviewerName: string | null; reviewText: string | null }[]>
  >({});
  const chat = trpc.reviews.chat.useMutation({
    onSuccess: (r, vars) => {
      setMessages([...vars.messages, { role: "assistant", content: r.answer }]);
      if (r.verbatim.length > 0) {
        setAttachments((a) => ({ ...a, [vars.messages.length]: r.verbatim }));
      }
    },
  });

  const reset = (m: "marketing" | "product") => {
    setMode(m);
    setMessages([]);
    setAttachments({});
  };

  const send = () => {
    const q = input.trim();
    if (!q || chat.isPending) return;
    const next = [...messages, { role: "user" as const, content: q }];
    setMessages(next);
    setInput("");
    chat.mutate({
      displayName: sel.displayName,
      line: sel.line,
      mode,
      status,
      buyers,
      messages: next,
      from: range.from,
      to: range.to,
    });
  };

  return (
    <div className="rounded-md border border-neutral-200 bg-white">
      <div className="flex items-center justify-between border-b border-neutral-100 px-3 py-2">
        <h3 className="text-sm font-semibold text-neutral-800">Ask Claude about these reviews</h3>
        <div className="flex overflow-hidden rounded-md border border-neutral-300 text-xs">
          {(["marketing", "product"] as const).map((m) => (
            <button
              key={m}
              onClick={() => reset(m)}
              className={
                "px-2.5 py-1 capitalize " +
                (mode === m ? "bg-neutral-800 text-white" : "bg-white text-neutral-600 hover:bg-neutral-50")
              }
            >
              {m}
            </button>
          ))}
        </div>
      </div>

      <div className="max-h-[26rem] space-y-3 overflow-y-auto px-3 py-3 text-sm">
        {messages.length === 0 && (
          <p className="text-neutral-500">
            Every {mode === "marketing" ? "marketing" : "product development"} question runs with the
            full set of matching reviews in context. Try “what do customers love most?”, “build me a
            persona”, or “show all reviews mentioning sizing in full”.
          </p>
        )}
        {messages.map((m, i) => (
          <div key={i}>
            <div
              className={
                m.role === "user"
                  ? "ml-8 rounded-md bg-neutral-100 px-3 py-2 text-neutral-800"
                  : "mr-4 whitespace-pre-wrap rounded-md border border-neutral-200 px-3 py-2 text-neutral-700"
              }
            >
              {m.content}
            </div>
            {attachments[i] && (
              <div className="mr-4 mt-1 max-h-64 space-y-2 overflow-y-auto rounded-md border border-dashed border-neutral-300 bg-neutral-50 px-3 py-2">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
                  {attachments[i].length} reviews, verbatim
                </p>
                {attachments[i].map((r, j) => (
                  <div key={j} className="text-xs text-neutral-700">
                    <Stars rating={r.rating} />{" "}
                    <span className="font-medium">{r.reviewerName ?? "anonymous"}</span>{" "}
                    <span className="text-neutral-400">
                      {r.reviewedAt ? fmtDate(r.reviewedAt) : ""}
                    </span>
                    <p>{r.reviewText ?? "(no text)"}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
        {chat.isPending && <p className="animate-pulse text-neutral-400">Claude is reading the reviews…</p>}
        {chat.error && (
          <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            {chat.error.message}
          </p>
        )}
      </div>

      <div className="border-t border-neutral-100 p-3">
        <div className="flex gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            rows={2}
            placeholder={`Ask a ${mode} question…`}
            className="w-full resize-none rounded-md border border-neutral-300 px-3 py-2 text-sm focus:border-neutral-400 focus:outline-none"
          />
          <button
            onClick={send}
            disabled={chat.isPending || !input.trim()}
            className="self-end rounded-md bg-neutral-800 px-3 py-2 text-sm text-white hover:bg-neutral-700 disabled:opacity-50"
          >
            Send
          </button>
        </div>
        <p className="mt-1 text-[11px] text-neutral-400">
          Each question sends the matching reviews to Claude; cost scales with review count
          (roughly a couple of dollars on the biggest products, follow-ups much less).
        </p>
      </div>
    </div>
  );
}

export default function ReviewsPage() {
  const [selected, setSelected] = useState<Selection | null>(null);
  const [preset, setPreset] = useState<number | null>(null);
  const [custom, setCustom] = useState<Range>({});
  // Per Scott 2026-07-15: no status filter — always every review.
  const status: StatusFilter = "all";
  const [buyers, setBuyers] = useState<BuyersFilter>("all");
  const [page, setPage] = useState(1);

  const range = useMemo<Range>(() => {
    if (custom.from || custom.to) return custom;
    if (preset === null) return {};
    const from = new Date(Date.now() - preset * 24 * 3600 * 1000).toISOString().slice(0, 10);
    return { from };
  }, [preset, custom]);

  const utils = trpc.useUtils();
  const overview = trpc.reviews.overview.useQuery(
    { ...range, status, buyers },
    { refetchOnWindowFocus: false },
  );
  const product = trpc.reviews.product.useQuery(
    { displayName: selected?.displayName ?? "", line: selected?.line ?? "std", page, status, buyers, ...range },
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
  const std = (data?.products ?? []).filter((p) => p.line !== "heavy");
  const heavy = (data?.products ?? []).filter((p) => p.line === "heavy");

  const pick = (sel: Selection) => {
    setSelected(sel);
    setPage(1);
  };

  return (
    <main className="space-y-4 p-6">
      <header className="flex items-baseline justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-neutral-900">Reviews</h1>
          <p className="mt-1 max-w-2xl text-sm text-neutral-500">
            All Loox reviews across both stores, deduplicated. Ratings and
            distributions are computed straight from the database; click a
            product to read its reviews or ask Claude about them.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {data?.lastSyncAt && (
            <span className="text-xs text-neutral-400">synced {fmtDate(data.lastSyncAt)}</span>
          )}
          <button
            onClick={() => refresh.mutate()}
            disabled={refresh.isPending || !(configured?.api || configured?.imap)}
            className="whitespace-nowrap rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm hover:border-neutral-400 disabled:opacity-50"
          >
            {refresh.isPending ? "Syncing…" : "Sync now"}
          </button>
        </div>
      </header>

      {configured && !configured.api && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <span className="font-medium">Loox API not connected.</span> Set LOOX_MAIN_STORE_ID /
          LOOX_MAIN_SECRET (and the LOOX_INTL_* pair) to sync reviews directly from Loox.
        </div>
      )}

      {data && data.unparsedCount > 0 && (
        <div className="rounded-md border border-orange-300 bg-orange-50 px-3 py-2 text-xs text-orange-900">
          {data.unparsedCount} forwarded email{data.unparsedCount === 1 ? "" : "s"} could not be
          parsed into a review — the raw text is kept so the parser can be extended.
        </div>
      )}

      {/* date range */}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <div className="flex overflow-hidden rounded-md border border-neutral-300">
          {PRESETS.map((p) => (
            <button
              key={p.label}
              onClick={() => {
                setPreset(p.days);
                setCustom({});
                setPage(1);
              }}
              className={
                "px-2.5 py-1 text-xs " +
                (preset === p.days && !custom.from && !custom.to
                  ? "bg-neutral-800 text-white"
                  : "bg-white text-neutral-600 hover:bg-neutral-50")
              }
            >
              {p.label}
            </button>
          ))}
        </div>
        <span className="text-xs text-neutral-400">or</span>
        <input
          type="date"
          value={custom.from ?? ""}
          onChange={(e) => {
            setCustom((c) => ({ ...c, from: e.target.value || undefined }));
            setPage(1);
          }}
          className="rounded-md border border-neutral-300 px-2 py-1 text-xs"
        />
        <span className="text-xs text-neutral-400">to</span>
        <input
          type="date"
          value={custom.to ?? ""}
          onChange={(e) => {
            setCustom((c) => ({ ...c, to: e.target.value || undefined }));
            setPage(1);
          }}
          className="rounded-md border border-neutral-300 px-2 py-1 text-xs"
        />
        <span className="ml-2 h-4 w-px bg-neutral-200" />
        <div className="flex overflow-hidden rounded-md border border-neutral-300">
          {(
            [
              { value: "all", label: "All reviewers" },
              { value: "verified", label: "Verified buyers" },
            ] as const
          ).map((b) => (
            <button
              key={b.value}
              onClick={() => {
                setBuyers(b.value);
                setPage(1);
              }}
              className={
                "px-2.5 py-1 text-xs " +
                (buyers === b.value
                  ? b.value === "verified"
                    ? "bg-emerald-600 text-white"
                    : "bg-neutral-800 text-white"
                  : "bg-white text-neutral-600 hover:bg-neutral-50")
              }
            >
              {b.label}
            </button>
          ))}
        </div>
        {buyers === "verified" && (
          <span className="text-[11px] text-emerald-700">
            only reviewers whose email actually ordered this product (full order history)
          </span>
        )}
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(420px,5fr)_4fr]">
        {/* KPI table */}
        <section className="self-start rounded-md border border-neutral-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-neutral-50 text-left text-[11px] uppercase tracking-wide text-neutral-600">
              <tr>
                <th className="px-3 py-2">Product</th>
                <th className="px-3 py-2 text-right">Reviews</th>
                <th className="px-3 py-2 text-right">Avg</th>
                <th className="px-3 py-2">5★ → 1★</th>
                <th className="px-3 py-2 text-right">Latest</th>
              </tr>
            </thead>
            <tbody>
              {std.length > 0 && (
                <tr className="border-t border-neutral-200 bg-neutral-50/50">
                  <td colSpan={5} className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
                    Standard
                  </td>
                </tr>
              )}
              <KpiRows products={std} selected={selected} onSelect={pick} />
              <TotalRow label="Standard total" products={std} />
              {heavy.length > 0 && (
                <tr className="border-t border-neutral-200 bg-neutral-50/50">
                  <td colSpan={5} className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
                    Heavy
                  </td>
                </tr>
              )}
              <KpiRows products={heavy} selected={selected} onSelect={pick} />
              <TotalRow label="Heavy total" products={heavy} />
              <TotalRow label="All products" products={data?.products ?? []} />
              {data && data.products.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-sm text-neutral-500">
                    No reviews in this range yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </section>

        {/* detail: chat + feed */}
        <section className="space-y-3">
          {!selected && (
            <p className="rounded-md border border-neutral-200 bg-white px-4 py-8 text-center text-sm text-neutral-500">
              Pick a product to read its reviews or ask Claude about them.
            </p>
          )}
          {selected && (
            <>
              <div className="flex items-baseline justify-between">
                <h2 className="text-sm font-semibold text-neutral-900">
                  {selected.displayName}
                  {selected.line === "heavy" && (
                    <span className="ml-2 rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] font-medium text-indigo-700">
                      Heavy
                    </span>
                  )}
                </h2>
                {product.data && (
                  <span className="text-xs text-neutral-500">
                    {product.data.total.toLocaleString()} reviews · avg {product.data.avgRating ?? "—"}
                  </span>
                )}
              </div>

              <ChatPanel
                key={`${selected.displayName}|${selected.line}|${range.from}|${range.to}|${status}|${buyers}`}
                sel={selected}
                range={range}
                status={status}
                buyers={buyers}
              />

              <div className="rounded-md border border-neutral-200 bg-white">
                {(product.data?.reviews ?? []).map((r) => (
                  <div key={r.id} className="border-t border-neutral-100 px-4 py-3 first:border-t-0">
                    <div className="flex items-baseline justify-between text-xs text-neutral-500">
                      <span>
                        <Stars rating={r.rating} />
                        <span className="ml-2 font-medium text-neutral-700">
                          {r.reviewerName ?? "anonymous"}
                        </span>
                        {r.purchaseVerified === "verified" && (
                          <span className="ml-2 rounded bg-emerald-50 px-1 py-0.5 text-[10px] text-emerald-700">
                            ✓ bought it
                          </span>
                        )}
                        {r.purchaseVerified === "unverified" && (
                          <span className="ml-2 rounded bg-red-50 px-1 py-0.5 text-[10px] text-red-700">
                            no matching order
                          </span>
                        )}
                      </span>
                      <span>{fmtDate(r.reviewedAt)}</span>
                    </div>
                    <p className="mt-1 text-sm text-neutral-700">{r.reviewText ?? "(no text)"}</p>
                  </div>
                ))}
                {product.data && product.data.total > product.data.pageSize && (
                  <div className="flex items-center justify-between border-t border-neutral-100 px-4 py-2 text-xs text-neutral-600">
                    <button
                      onClick={() => setPage((p) => Math.max(1, p - 1))}
                      disabled={page <= 1}
                      className="rounded border border-neutral-300 px-2 py-1 disabled:opacity-40"
                    >
                      Newer
                    </button>
                    <span className="tabular-nums">
                      page {page} of {Math.ceil(product.data.total / product.data.pageSize)}
                    </span>
                    <button
                      onClick={() => setPage((p) => p + 1)}
                      disabled={page >= Math.ceil(product.data.total / product.data.pageSize)}
                      className="rounded border border-neutral-300 px-2 py-1 disabled:opacity-40"
                    >
                      Older
                    </button>
                  </div>
                )}
              </div>
            </>
          )}
        </section>
      </div>
    </main>
  );
}
