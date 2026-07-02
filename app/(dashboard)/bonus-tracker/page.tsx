"use client";
import { useState } from "react";
import { trpc } from "@/lib/trpc/client";
import {
  BONUS_MARKETERS,
  BONUS_TIER_1_USD,
  BONUS_TIER_2_USD,
  bonusCategory,
  isBonusMarketer,
  type BonusMarketer,
} from "@/lib/domain/bonus-tiers";
import { VIDEO_EDITORS, type VideoEditor } from "@/lib/domain/video-editors";
// Type-only import — erased at compile time, so the client bundle never
// pulls in the query module (which imports the db client).
import type { BonusAdRow } from "@/lib/queries/bonus-tracker";

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
  });
}

// Row coloring is now gated by APPROVAL status, not threshold crossing.
// A row only turns orange/green after Jasper approves the bonus.
// (Jasper 2026-05-13: "only turn colour after the bonus amount is
// recorded somewhere".)
function rowClass(opts: {
  tier1Status: string | undefined;
  tier2Status: string | undefined;
}): string {
  const t2Approved =
    opts.tier2Status === "approved_full" || opts.tier2Status === "approved_half";
  const t1Approved =
    opts.tier1Status === "approved_full" || opts.tier1Status === "approved_half";
  if (t2Approved) return "bg-green-50 hover:bg-green-100";
  if (t1Approved) return "bg-orange-50 hover:bg-orange-100";
  return "bg-white hover:bg-neutral-50";
}

function tierBadge(status: string | undefined, tier: "T1" | "T2") {
  if (!status) return null;
  if (status === "rejected") {
    return (
      <span className="inline-flex items-center rounded-full bg-neutral-200 px-2 py-0.5 text-xs font-medium text-neutral-600">
        {tier} rejected
      </span>
    );
  }
  if (status === "pending") {
    return (
      <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900">
        {tier} pending
      </span>
    );
  }
  if (status === "approved_full") {
    const cls = tier === "T2" ? "bg-green-200 text-green-900" : "bg-orange-200 text-orange-900";
    return (
      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>
        {tier}
      </span>
    );
  }
  if (status === "approved_half") {
    const cls = tier === "T2" ? "bg-green-200 text-green-900" : "bg-orange-200 text-orange-900";
    return (
      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>
        {tier} ½
      </span>
    );
  }
  return null;
}

// The count-scoreboard table (month × type rows, one column per
// recipient) — extracted verbatim from the marketer Summary tab so the
// Marketers and Video Editors modes render the exact same DOM for
// their summaries, parameterized only by data, column labels and the
// two text strings.
type CountSummaryData = {
  marketers: ReadonlyArray<string>;
  rows: ReadonlyArray<{
    month: string;
    type: string;
    counts: Partial<Record<string, number>>;
    total: number;
  }>;
  grandTotal: number;
};

function CountSummaryTable({
  data,
  isLoading,
  emptyText,
  columnLabel,
  footerText,
}: {
  data: CountSummaryData | undefined;
  isLoading: boolean;
  emptyText: string;
  columnLabel: (name: string) => string;
  footerText: string;
}) {
  if (isLoading) {
    return <div className="text-sm text-neutral-500">Loading summary…</div>;
  }
  if (!data || data.rows.length === 0) {
    return (
      <div className="rounded-md border border-neutral-200 bg-white px-4 py-6 text-sm text-neutral-500">
        {emptyText}
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-md border border-neutral-200 bg-white">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-neutral-200 bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500">
              <th className="px-3 py-2 font-medium">Month</th>
              <th className="px-3 py-2 font-medium">Type</th>
              {data.marketers.map((m) => (
                <th
                  key={m}
                  className="px-3 py-2 text-right font-medium tabular-nums"
                >
                  {columnLabel(m)}
                </th>
              ))}
              <th className="px-3 py-2 text-right font-medium">Total</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r, i) => {
              // Render a thicker top border on the FIRST row
              // of each new month, so the 4-row monthly
              // sections read visually. Also blank the Month
              // cell on rows 2-4 of a section.
              const isFirstOfMonth =
                i === 0 || data.rows[i - 1].month !== r.month;
              return (
                <tr
                  key={`${r.month}-${r.type}`}
                  className={
                    "hover:bg-neutral-50 " +
                    (isFirstOfMonth
                      ? "border-t-2 border-neutral-200"
                      : "border-t border-neutral-100")
                  }
                >
                  <td className="px-3 py-2 font-medium text-neutral-900">
                    {isFirstOfMonth ? r.month : ""}
                  </td>
                  <td className="px-3 py-2 text-neutral-700">
                    {r.type}
                  </td>
                  {data.marketers.map((m) => {
                    const n = r.counts[m] ?? 0;
                    return (
                      <td
                        key={m}
                        className="px-3 py-2 text-right tabular-nums text-neutral-800"
                      >
                        {n > 0 ? (
                          n
                        ) : (
                          <span className="text-neutral-300">—</span>
                        )}
                      </td>
                    );
                  })}
                  <td className="px-3 py-2 text-right font-semibold tabular-nums text-neutral-900">
                    {r.total > 0 ? (
                      r.total
                    ) : (
                      <span className="text-neutral-300">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-neutral-200 bg-neutral-50 text-sm font-semibold">
              <td className="px-3 py-2 text-neutral-700" colSpan={2}>
                All months — total awards
              </td>
              <td
                className="px-3 py-2 text-right tabular-nums text-neutral-900"
                colSpan={data.marketers.length}
              />
              <td className="px-3 py-2 text-right tabular-nums text-neutral-900">
                {data.grandTotal}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
      <div className="border-t border-neutral-100 bg-white px-3 py-2 text-xs text-neutral-500">
        {footerText}
      </div>
    </div>
  );
}

// The lifetime-spend ad table with per-tier progress bars — extracted
// verbatim from the per-marketer view so the Marketers and Video
// Editors modes render the exact same DOM for their tables (quality
// review 2026-07-02: single source for the duplicated markup).
function BonusAdTable({
  rows,
  emptyText,
  past7dWindow,
}: {
  rows: BonusAdRow[];
  emptyText: string;
  past7dWindow: { start: string; end: string } | undefined;
}) {
  return (
    <div className="overflow-hidden rounded-md border border-neutral-200 bg-white">
      {rows.length === 0 ? (
        <div className="px-4 py-6 text-sm text-neutral-500">{emptyText}</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-neutral-200 bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500">
                <th className="w-20 px-3 py-2 font-medium">Ad #</th>
                <th className="px-3 py-2 font-medium">Ad name</th>
                <th className="w-20 px-3 py-2 font-medium">Link</th>
                <th className="w-32 px-3 py-2 text-right font-medium">
                  Lifetime spend
                </th>
                <th className="w-28 px-3 py-2 text-right font-medium">
                  Past 7D spend
                  {past7dWindow && (
                    <span className="block text-[10px] font-normal text-neutral-400">
                      {fmtDate(past7dWindow.start)} –{" "}
                      {fmtDate(past7dWindow.end)}
                    </span>
                  )}
                </th>
                <th className="w-56 px-3 py-2 font-medium">
                  Progress to tiers
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const t1Pct = Math.min(
                  100,
                  Math.round(
                    (r.lifetimeSpendUsd / BONUS_TIER_1_USD) * 100,
                  ),
                );
                const t2Pct = Math.min(
                  100,
                  Math.round(
                    (r.lifetimeSpendUsd / BONUS_TIER_2_USD) * 100,
                  ),
                );
                return (
                  <tr
                    key={r.adNumber}
                    className={`border-b border-neutral-100 last:border-b-0 ${rowClass({
                      tier1Status: r.awards.tier1?.status,
                      tier2Status: r.awards.tier2?.status,
                    })}`}
                  >
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
                      {fmtMoney(r.lifetimeSpendUsd)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-neutral-700">
                      {r.past7dSpendUsd > 0 ? (
                        fmtMoney(r.past7dSpendUsd)
                      ) : (
                        <span className="text-neutral-300">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <div className="space-y-1.5">
                        <div className="flex items-center gap-2 text-[11px]">
                          <span className="w-9 text-right text-neutral-500 tabular-nums">
                            $13k
                          </span>
                          <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-neutral-100">
                            <div
                              className="absolute inset-y-0 left-0 bg-orange-500"
                              style={{ width: `${t1Pct}%` }}
                            />
                          </div>
                          <span className="w-10 text-right text-neutral-500 tabular-nums">
                            {t1Pct}%
                          </span>
                        </div>
                        <div className="flex items-center gap-2 text-[11px]">
                          <span className="w-9 text-right text-neutral-500 tabular-nums">
                            $65k
                          </span>
                          <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-neutral-100">
                            <div
                              className="absolute inset-y-0 left-0 bg-green-500"
                              style={{ width: `${t2Pct}%` }}
                            />
                          </div>
                          <span className="w-10 text-right text-neutral-500 tabular-nums">
                            {t2Pct}%
                          </span>
                        </div>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function BonusTrackerPage() {
  // The caller's access tier drives which controls render: fb_ads_only
  // gets a read-only view (client 2026-07-02) — approve/reject/bulk/
  // preview/send are hidden, and their marketing-tier queries are not
  // even fired (they would FORBIDDEN).
  const me = trpc.inventory.getMyAccessTier.useQuery(undefined, {
    refetchOnWindowFocus: false,
  });
  const tier = me.data?.tier;
  const isAdmin = tier === "ops" || tier === "marketing";

  const tracker = trpc.inventory.getBonusTracker.useQuery(undefined, {
    refetchOnWindowFocus: false,
  });
  const pending = trpc.inventory.getPendingBonusApprovals.useQuery(undefined, {
    refetchOnWindowFocus: false,
    enabled: isAdmin,
  });
  const preview = trpc.inventory.previewBonusNotification.useQuery(undefined, {
    refetchOnWindowFocus: false,
    enabled: isAdmin,
  });
  const history = trpc.inventory.getBonusNotificationHistory.useQuery(
    undefined,
    { refetchOnWindowFocus: false },
  );
  // Summary tab — count-only redesign (Jasper 2026-05-28). Old
  // getBonusSummary route is still alive for compatibility but no
  // longer wired into the UI.
  const summary = trpc.inventory.getBonusCountSummary.useQuery(undefined, {
    refetchOnWindowFocus: false,
  });
  // Editor Summary — the video-editor mirror of the marketer scoreboard
  // (client 2026-07-02). Same read tier, so fb_ads_only can load it.
  const editorSummary = trpc.inventory.getVideoEditorBonusCountSummary.useQuery(
    undefined,
    { refetchOnWindowFocus: false },
  );
  const utils = trpc.useUtils();

  const refreshAll = async () => {
    await Promise.all([
      utils.inventory.getBonusTracker.invalidate(),
      utils.inventory.getPendingBonusApprovals.invalidate(),
      utils.inventory.previewBonusNotification.invalidate(),
      utils.inventory.getBonusNotificationHistory.invalidate(),
      utils.inventory.getBonusSummary.invalidate(),
      utils.inventory.getBonusCountSummary.invalidate(),
      utils.inventory.getVideoEditorBonusCountSummary.invalidate(),
    ]);
  };

  const approve = trpc.inventory.approveBonus.useMutation({
    onSuccess: refreshAll,
  });
  const reject = trpc.inventory.rejectBonus.useMutation({
    onSuccess: refreshAll,
  });
  const bulkApprove = trpc.inventory.bulkApprovePending.useMutation({
    onSuccess: refreshAll,
  });
  const send = trpc.inventory.sendBonusNotification.useMutation({
    onSuccess: refreshAll,
  });

  // Program toggle (operator design 2026-07-02): the page hosts two
  // bonus programs. "Marketers" renders the original page unchanged;
  // "Video Editors" mirrors that UX per-editor. Each program keeps its
  // own active-tab state so flipping between them doesn't lose position.
  type Program = "marketers" | "videoEditors";
  const [program, setProgram] = useState<Program>("marketers");

  type ActiveView = BonusMarketer | "summary";
  // Summary is the default landing view and the leftmost tab (Jasper 2026-05-26).
  const [activeView, setActiveView] = useState<ActiveView>("summary");
  // Video Editors mode mirrors the marketer strip: Summary leftmost and
  // the default landing view for the mode.
  const [activeEditor, setActiveEditor] = useState<VideoEditor | "summary">(
    "summary",
  );
  const [showPreviewModal, setShowPreviewModal] = useState(false);

  const sectionsByMarketer = new Map(
    (tracker.data?.sections ?? []).map((s) => [s.marketer, s]),
  );
  const sectionsByEditor = new Map(
    (tracker.data?.videoEditors ?? []).map((s) => [s.editor, s]),
  );
  const unknownInitials = tracker.data?.unknownInitials ?? [];

  const pendingItems = pending.data ?? [];
  const previewData = preview.data;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-neutral-900">
            Bonus Tracker
          </h1>
          <p className="text-sm text-neutral-500">
            Lifetime FB ad spend per marketer · color appears after approval ·
            T1 = {fmtMoney(BONUS_TIER_1_USD)} crossed, T2 = {fmtMoney(BONUS_TIER_2_USD)} crossed
          </p>
        </div>
        {isAdmin && previewData && previewData.awardIds.length > 0 && (
          <button
            type="button"
            onClick={() => setShowPreviewModal(true)}
            className="inline-flex items-center gap-2 rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-500"
          >
            Generate notification · {previewData.awardIds.length} pending payouts
          </button>
        )}
      </div>

      {(tracker.error || pending.error) && (
        <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          Failed to load: {(tracker.error ?? pending.error)?.message}
        </div>
      )}

      {tracker.isLoading ? (
        <div className="text-sm text-neutral-500">Loading…</div>
      ) : (
        <div className="space-y-4">
          {/* Program toggle — Marketers (the original page, unchanged) vs
              Video Editors (client 2026-07-02). One notification batch
              covers both programs, so the header controls stay global. */}
          <div className="inline-flex rounded-md border border-neutral-200 bg-white p-0.5">
            {(
              [
                ["marketers", "Marketers"],
                ["videoEditors", "Video Editors"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setProgram(value)}
                aria-pressed={program === value}
                className={`rounded px-3 py-1.5 text-sm font-medium transition ${
                  program === value
                    ? "bg-neutral-900 text-white"
                    : "text-neutral-700 hover:bg-neutral-50"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {program === "marketers" ? (
            <>
              {/* Summary + marketer tab strip — Summary first (Jasper 2026-05-26). */}
              <div className="flex flex-wrap gap-2">
                {/* Summary tab — bonus paid per month per marketer (Jasper 2026-05-20). */}
                <button
                  type="button"
                  onClick={() => setActiveView("summary")}
                  aria-pressed={activeView === "summary"}
                  className={`inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition ${
                    activeView === "summary"
                      ? "bg-neutral-900 text-white"
                      : "border border-neutral-200 bg-white text-neutral-700 hover:bg-neutral-50"
                  }`}
                >
                  Summary
                </button>
                {BONUS_MARKETERS.map((marketer) => {
                  const section = sectionsByMarketer.get(marketer);
                  const count = section?.rows.length ?? 0;
                  const isActive = activeView === marketer;
                  return (
                    <button
                      key={marketer}
                      type="button"
                      onClick={() => setActiveView(marketer)}
                      aria-pressed={isActive}
                      className={`inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition ${
                        isActive
                          ? "bg-neutral-900 text-white"
                          : "border border-neutral-200 bg-white text-neutral-700 hover:bg-neutral-50"
                      }`}
                    >
                      {marketer}
                      <span
                        className={`inline-flex min-w-[1.5rem] items-center justify-center rounded px-1.5 py-0.5 text-xs font-medium tabular-nums ${
                          isActive
                            ? "bg-white/20 text-white"
                            : "bg-neutral-100 text-neutral-600"
                        }`}
                      >
                        {count}
                      </span>
                    </button>
                  );
                })}
              </div>

              {/* Active tab content */}
              {activeView === "summary" ? (
                // Count-only Summary (Jasper 2026-05-28 redesign) — mirrors
                // the Ads Bonus Tracking 3 Summary tab. Rows are (month ×
                // type) tuples, columns are marketers in Jasper's order
                // ("JW" → "J Weston" per his sheet labels; the data layer
                // keeps the short code). 4-row sections per month.
                <CountSummaryTable
                  data={summary.data}
                  isLoading={summary.isLoading}
                  emptyText="No notifications sent yet for May 2026 onwards — the scoreboard fills in as monthly batches go out."
                  columnLabel={(m) => (m === "JW" ? "J Weston" : m)}
                  footerText="Counts of approved bonuses sent in monthly batches. May 2026 onwards. Mirrors the Summary tab on Ads Bonus Tracking 3."
                />
              ) : (
              (() => {
                const marketer = activeView;
                const section = sectionsByMarketer.get(marketer);
                const rows = section?.rows ?? [];
                const totalAds = rows.length;
                const hitT1 = rows.filter(
                  (r) => r.lifetimeSpendUsd >= BONUS_TIER_1_USD,
                ).length;
                const hitT2 = rows.filter(
                  (r) => r.lifetimeSpendUsd >= BONUS_TIER_2_USD,
                ).length;
                const totalLifetime = rows.reduce(
                  (sum, r) => sum + r.lifetimeSpendUsd,
                  0,
                );
                // Per-marketer pending — Jasper 2026-05-20: each tab shows
                // only that marketer's pending queue.
                const marketerPending = pendingItems.filter(
                  (p) => p.marketer === marketer,
                );

                return (
                  <div className="space-y-4">
                    {/* Per-marketer pending approvals (marketing/ops only —
                        fb_ads_only is read-only per client 2026-07-02) */}
                    {isAdmin && marketerPending.length > 0 && (
                      <div className="overflow-hidden rounded-md border border-amber-300 bg-amber-50">
                        <div className="flex items-center justify-between border-b border-amber-300 bg-amber-100 px-4 py-2">
                          <div className="text-sm font-semibold text-amber-900">
                            {marketer} pending approvals · {marketerPending.length}
                          </div>
                          {marketerPending.length >= 5 && (
                            <button
                              type="button"
                              disabled={bulkApprove.isPending}
                              onClick={() => {
                                if (
                                  confirm(
                                    `Bulk-approve ALL ${pendingItems.length} pending bonuses (across all marketers) at full amount? Use this for historical backlog only.`,
                                  )
                                ) {
                                  bulkApprove.mutate();
                                }
                              }}
                              className="rounded-md border border-amber-400 bg-white px-3 py-1.5 text-xs font-medium text-amber-900 hover:bg-amber-100 disabled:opacity-50"
                            >
                              {bulkApprove.isPending ? "Approving…" : "Bulk-approve all (every marketer) at full"}
                            </button>
                          )}
                        </div>
                        <div className="divide-y divide-amber-200">
                          {marketerPending.map((p) => (
                            <div
                              key={p.awardId}
                              className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm"
                            >
                              <div className="min-w-0 flex-1">
                                <div className="font-medium text-neutral-900">
                                  <span>Ad {p.adNumber}</span>
                                  <span className="ml-3 text-neutral-500">·</span>
                                  <span className="ml-3">
                                    {p.tier === "tier1"
                                      ? "T1 ($13k)"
                                      : "T2 ($65k)"}
                                  </span>
                                </div>
                                <div className="mt-0.5 text-xs text-neutral-600 truncate">
                                  {p.adName} · crossed {fmtDate(p.crossedAt)} · lifetime {fmtMoney(p.lifetimeSpendUsd)}
                                </div>
                              </div>
                              <div className="flex items-center gap-2">
                                {p.adLink && (
                                  <a
                                    href={p.adLink}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-xs text-blue-600 hover:underline"
                                  >
                                    View ad ↗
                                  </a>
                                )}
                                <button
                                  type="button"
                                  disabled={approve.isPending}
                                  onClick={() =>
                                    approve.mutate({
                                      awardId: p.awardId,
                                      approval: "approved_full",
                                    })
                                  }
                                  className="rounded-md bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-500 disabled:opacity-50"
                                  title="Approve"
                                >
                                  Approve
                                </button>
                                {isBonusMarketer(p.marketer) &&
                                  bonusCategory(p.marketer) === "main" && (
                                  <button
                                    type="button"
                                    disabled={approve.isPending}
                                    onClick={() =>
                                      approve.mutate({
                                        awardId: p.awardId,
                                        approval: "approved_half",
                                      })
                                    }
                                    className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50"
                                    title="Approve half (rehook / collab)"
                                  >
                                    Approve half
                                  </button>
                                )}
                                <button
                                  type="button"
                                  disabled={reject.isPending}
                                  onClick={() => reject.mutate({ awardId: p.awardId })}
                                  className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-100 disabled:opacity-50"
                                >
                                  Reject
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Summary cards */}
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                      <div className="rounded-md border border-neutral-200 bg-white p-4">
                        <div className="text-xs font-medium uppercase tracking-wide text-neutral-500">
                          Total ads
                        </div>
                        <div className="mt-1 text-2xl font-semibold text-neutral-900 tabular-nums">
                          {totalAds}
                        </div>
                      </div>
                      <div className="rounded-md border border-orange-200 bg-orange-50 p-4">
                        <div className="text-xs font-medium uppercase tracking-wide text-neutral-500">
                          Hit $13k tier
                        </div>
                        <div className="mt-1 text-2xl font-semibold text-neutral-900 tabular-nums">
                          {hitT1}
                        </div>
                      </div>
                      <div className="rounded-md border border-green-200 bg-green-50 p-4">
                        <div className="text-xs font-medium uppercase tracking-wide text-neutral-500">
                          Hit $65k tier
                        </div>
                        <div className="mt-1 text-2xl font-semibold text-neutral-900 tabular-nums">
                          {hitT2}
                        </div>
                      </div>
                      <div className="rounded-md border border-neutral-200 bg-white p-4">
                        <div className="text-xs font-medium uppercase tracking-wide text-neutral-500">
                          Total lifetime spend
                        </div>
                        <div className="mt-1 text-2xl font-semibold text-neutral-900 tabular-nums">
                          {fmtMoney(totalLifetime)}
                        </div>
                      </div>
                    </div>

                    {/* Ad table */}
                    <BonusAdTable
                      rows={rows}
                      emptyText={`No ads attributed to ${marketer} yet.`}
                      past7dWindow={tracker.data?.past7dWindow}
                    />
                  </div>
                );
              })()
              )}
            </>
          ) : (
            (() => {
              // Video Editors program (client 2026-07-02) — mirrors the
              // marketer UX: a Summary scoreboard leftmost (and the
              // mode's default view), then per-editor tabs with that
              // editor's pending queue, summary cards and the shared ad
              // table. fb_ads_only sees the tables only (admin controls
              // hidden, as on the marketer side).
              return (
                <div className="space-y-4">
                  {/* Unknown initials — needs a ruling (marketing/ops only) */}
                  {isAdmin && unknownInitials.length > 0 && (
                    <div className="overflow-hidden rounded-md border border-purple-300 bg-purple-50">
                      <div className="border-b border-purple-300 bg-purple-100 px-4 py-2 text-sm font-semibold text-purple-900">
                        Unknown initials — needs a ruling ·{" "}
                        {unknownInitials.length}
                      </div>
                      <div className="divide-y divide-purple-200">
                        {unknownInitials.map((u) => (
                          <div
                            key={u.initials}
                            className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 text-sm"
                          >
                            <div className="min-w-0 flex-1">
                              <span className="font-semibold text-purple-900">
                                {u.initials}
                              </span>
                              <span className="ml-3 text-xs text-neutral-600">
                                e.g. {u.exampleAdName}
                              </span>
                            </div>
                            <div className="text-xs tabular-nums text-neutral-600">
                              {u.adCount} ad{u.adCount === 1 ? "" : "s"} ·
                              lifetime {fmtMoney(u.totalLifetimeSpendUsd)}
                            </div>
                          </div>
                        ))}
                      </div>
                      <div className="border-t border-purple-200 bg-purple-50 px-4 py-2 text-xs text-purple-800">
                        AIAD ads whose initials aren't a known video editor.
                        No bonus accrues until the client rules on them.
                      </div>
                    </div>
                  )}

                  {/* Summary + per-editor tab strip — mirrors the marketer
                      strip (Summary leftmost, the mode's default view). */}
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => setActiveEditor("summary")}
                      aria-pressed={activeEditor === "summary"}
                      className={`inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition ${
                        activeEditor === "summary"
                          ? "bg-neutral-900 text-white"
                          : "border border-neutral-200 bg-white text-neutral-700 hover:bg-neutral-50"
                      }`}
                    >
                      Summary
                    </button>
                    {VIDEO_EDITORS.map((editor) => {
                      const section = sectionsByEditor.get(editor);
                      const count = section?.rows.length ?? 0;
                      const isActive = activeEditor === editor;
                      return (
                        <button
                          key={editor}
                          type="button"
                          onClick={() => setActiveEditor(editor)}
                          aria-pressed={isActive}
                          className={`inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition ${
                            isActive
                              ? "bg-neutral-900 text-white"
                              : "border border-neutral-200 bg-white text-neutral-700 hover:bg-neutral-50"
                          }`}
                        >
                          {editor}
                          <span
                            className={`inline-flex min-w-[1.5rem] items-center justify-center rounded px-1.5 py-0.5 text-xs font-medium tabular-nums ${
                              isActive
                                ? "bg-white/20 text-white"
                                : "bg-neutral-100 text-neutral-600"
                            }`}
                          >
                            {count}
                          </span>
                        </button>
                      );
                    })}
                  </div>

                  {activeEditor === "summary" ? (
                    // Editor Summary — same scoreboard layout as the
                    // marketer Summary tab, columns per editor.
                    <CountSummaryTable
                      data={editorSummary.data}
                      isLoading={editorSummary.isLoading}
                      emptyText="No editor bonuses sent yet for May 2026 onwards — the scoreboard fills in as monthly batches go out."
                      columnLabel={(e) => e}
                      footerText="Counts of approved video-editor bonuses sent in monthly batches. May 2026 onwards."
                    />
                  ) : (
                    (() => {
                      const editor = activeEditor;
                      const rows = sectionsByEditor.get(editor)?.rows ?? [];
                      const totalAds = rows.length;
                      const hitT1 = rows.filter(
                        (r) => r.lifetimeSpendUsd >= BONUS_TIER_1_USD,
                      ).length;
                      const hitT2 = rows.filter(
                        (r) => r.lifetimeSpendUsd >= BONUS_TIER_2_USD,
                      ).length;
                      const totalLifetime = rows.reduce(
                        (sum, r) => sum + r.lifetimeSpendUsd,
                        0,
                      );
                      // Each editor tab shows only that editor's pending
                      // queue — same convention as the marketer tabs.
                      const editorPending = pendingItems.filter(
                        (p) => p.marketer === editor,
                      );
                      return (
                        <>
                  {/* Per-editor pending approvals (marketing/ops only) */}
                  {isAdmin && editorPending.length > 0 && (
                    <div className="overflow-hidden rounded-md border border-amber-300 bg-amber-50">
                      <div className="border-b border-amber-300 bg-amber-100 px-4 py-2 text-sm font-semibold text-amber-900">
                        {activeEditor} pending approvals · {editorPending.length}
                      </div>
                      <div className="divide-y divide-amber-200">
                        {editorPending.map((p) => (
                          <div
                            key={p.awardId}
                            className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm"
                          >
                            <div className="min-w-0 flex-1">
                              <div className="font-medium text-neutral-900">
                                <span>Ad {p.adNumber}</span>
                                <span className="ml-3 text-neutral-500">·</span>
                                <span className="ml-3">
                                  {p.tier === "tier1"
                                    ? "T1 ($13k)"
                                    : "T2 ($65k)"}
                                </span>
                              </div>
                              <div className="mt-0.5 text-xs text-neutral-600 truncate">
                                {p.adName} · crossed {fmtDate(p.crossedAt)} · lifetime {fmtMoney(p.lifetimeSpendUsd)}
                              </div>
                            </div>
                            <div className="flex items-center gap-2">
                              {p.adLink && (
                                <a
                                  href={p.adLink}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-xs text-blue-600 hover:underline"
                                >
                                  View ad ↗
                                </a>
                              )}
                              <button
                                type="button"
                                disabled={approve.isPending}
                                onClick={() =>
                                  approve.mutate({
                                    awardId: p.awardId,
                                    approval: "approved_full",
                                  })
                                }
                                className="rounded-md bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-500 disabled:opacity-50"
                                title="Approve"
                              >
                                Approve
                              </button>
                              <button
                                type="button"
                                disabled={approve.isPending}
                                onClick={() =>
                                  approve.mutate({
                                    awardId: p.awardId,
                                    approval: "approved_half",
                                  })
                                }
                                className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50"
                                title="Approve half"
                              >
                                Approve half
                              </button>
                              <button
                                type="button"
                                disabled={reject.isPending}
                                onClick={() =>
                                  reject.mutate({ awardId: p.awardId })
                                }
                                className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-100 disabled:opacity-50"
                              >
                                Reject
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Summary cards — same layout as the marketer tabs. */}
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <div className="rounded-md border border-neutral-200 bg-white p-4">
                      <div className="text-xs font-medium uppercase tracking-wide text-neutral-500">
                        Total ads
                      </div>
                      <div className="mt-1 text-2xl font-semibold text-neutral-900 tabular-nums">
                        {totalAds}
                      </div>
                    </div>
                    <div className="rounded-md border border-orange-200 bg-orange-50 p-4">
                      <div className="text-xs font-medium uppercase tracking-wide text-neutral-500">
                        Hit $13k tier
                      </div>
                      <div className="mt-1 text-2xl font-semibold text-neutral-900 tabular-nums">
                        {hitT1}
                      </div>
                    </div>
                    <div className="rounded-md border border-green-200 bg-green-50 p-4">
                      <div className="text-xs font-medium uppercase tracking-wide text-neutral-500">
                        Hit $65k tier
                      </div>
                      <div className="mt-1 text-2xl font-semibold text-neutral-900 tabular-nums">
                        {hitT2}
                      </div>
                    </div>
                    <div className="rounded-md border border-neutral-200 bg-white p-4">
                      <div className="text-xs font-medium uppercase tracking-wide text-neutral-500">
                        Total lifetime spend
                      </div>
                      <div className="mt-1 text-2xl font-semibold text-neutral-900 tabular-nums">
                        {fmtMoney(totalLifetime)}
                      </div>
                    </div>
                  </div>

                  {/* Ad table — shared component with the marketer view. */}
                  <BonusAdTable
                    rows={rows}
                    emptyText={`No AIAD ads attributed to ${editor} yet.`}
                    past7dWindow={tracker.data?.past7dWindow}
                  />

                  <div className="rounded-md border border-neutral-200 bg-neutral-50 px-4 py-3 text-xs text-neutral-600">
                    Video editor bonuses apply to AI video ads only (names
                    tagged “AIad”). Same $13k / $65k lifetime-spend tiers;
                    flat editor rates. The same ad can also earn its
                    marketer's bonus.
                  </div>
                        </>
                      );
                    })()
                  )}
                </div>
              );
            })()
          )}
        </div>
      )}

      {/* Notification history */}
      {(history.data?.length ?? 0) > 0 && (
        <div className="overflow-hidden rounded-md border border-neutral-200 bg-white">
          <div className="border-b border-neutral-200 bg-neutral-50 px-4 py-2 text-sm font-medium text-neutral-700">
            Notification history
          </div>
          <div className="divide-y divide-neutral-200">
            {(history.data ?? []).map((h) => (
              <div key={h.id} className="px-4 py-3 text-sm">
                <div className="flex items-center justify-between">
                  <div>
                    <span className="font-medium">{h.periodLabel}</span>
                    <span className="ml-2 text-xs text-neutral-500">
                      sent {fmtDate(h.sentAt.slice(0, 10))} by {h.sentBy}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    {h.whatsappStatus === "sent" ? (
                      <span className="text-xs text-green-700">✓ WhatsApp sent</span>
                    ) : (
                      <span className="text-xs text-amber-700">
                        {h.whatsappStatus ?? "—"}
                      </span>
                    )}
                  </div>
                </div>
                <details className="mt-1">
                  <summary className="cursor-pointer text-xs text-neutral-500 hover:text-neutral-700">
                    View message
                  </summary>
                  <pre className="mt-2 whitespace-pre-wrap rounded border border-neutral-200 bg-neutral-50 p-2 text-xs text-neutral-700">
                    {h.messageBody}
                  </pre>
                </details>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Generate-notification preview modal (marketing/ops only) */}
      {isAdmin && showPreviewModal && previewData && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-900/60 p-4">
          <div className="max-h-[90vh] w-full max-w-2xl overflow-hidden rounded-md bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-neutral-200 px-4 py-3">
              <div className="font-semibold text-neutral-900">
                Notification preview — {previewData.periodLabel}
              </div>
              <button
                type="button"
                onClick={() => setShowPreviewModal(false)}
                className="text-neutral-400 hover:text-neutral-700"
              >
                ✕
              </button>
            </div>
            <div className="max-h-[60vh] space-y-4 overflow-y-auto px-4 py-3">
              <div>
                <div className="mb-1 text-xs uppercase tracking-wide text-neutral-500">
                  Message body
                </div>
                <pre className="whitespace-pre-wrap rounded border border-neutral-200 bg-neutral-50 p-3 text-sm text-neutral-800">
                  {previewData.messageBody}
                </pre>
              </div>
              <div className="text-sm text-neutral-500">
                {previewData.awardIds.length} bonus
                {previewData.awardIds.length === 1 ? "" : "es"} in this batch
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-neutral-200 px-4 py-3">
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard?.writeText(previewData.messageBody);
                }}
                className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-100"
              >
                Copy
              </button>
              <button
                type="button"
                onClick={() => setShowPreviewModal(false)}
                className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-100"
              >
                Close
              </button>
              <button
                type="button"
                disabled={send.isPending}
                onClick={() => {
                  send.mutate(undefined, {
                    onSuccess: () => setShowPreviewModal(false),
                  });
                }}
                className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
              >
                {send.isPending ? "Sending…" : "Send + lock batch"}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="rounded-md border border-neutral-200 bg-neutral-50 px-4 py-3 text-xs text-neutral-600">
        <strong>How this works:</strong> An ad crosses $13k or $65k lifetime
        spend → it appears in <em>Pending approvals</em>. Jasper picks Approve /
        Approve half / Reject per ad (for marketers, Approve half is
        main-marketer only — rehook or collab; video-editor awards can also be
        approved at half).
        Approved bonuses queue for the next notification. Click{" "}
        <em>Generate notification</em> to render the WhatsApp message and lock
        the batch.
      </div>
    </div>
  );
}
