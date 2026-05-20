"use client";
import { useState } from "react";
import { trpc } from "@/lib/trpc/client";
import {
  BONUS_MARKETERS,
  BONUS_TIER_1_USD,
  BONUS_TIER_2_USD,
  bonusCategory,
  type BonusMarketer,
} from "@/lib/domain/bonus-tiers";

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

export default function BonusTrackerPage() {
  const tracker = trpc.inventory.getBonusTracker.useQuery(undefined, {
    refetchOnWindowFocus: false,
  });
  const pending = trpc.inventory.getPendingBonusApprovals.useQuery(undefined, {
    refetchOnWindowFocus: false,
  });
  const preview = trpc.inventory.previewBonusNotification.useQuery(undefined, {
    refetchOnWindowFocus: false,
  });
  const history = trpc.inventory.getBonusNotificationHistory.useQuery(
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

  const [openMarketer, setOpenMarketer] = useState<BonusMarketer | null>(
    BONUS_MARKETERS[0] ?? null,
  );
  const [showPreviewModal, setShowPreviewModal] = useState(false);

  const sectionsByMarketer = new Map(
    (tracker.data?.sections ?? []).map((s) => [s.marketer, s]),
  );

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
        {previewData && previewData.awardIds.length > 0 && (
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

      {/* Pending approvals queue */}
      {pendingItems.length > 0 && (
        <div className="overflow-hidden rounded-md border border-amber-300 bg-amber-50">
          <div className="flex items-center justify-between border-b border-amber-300 bg-amber-100 px-4 py-2">
            <div className="text-sm font-semibold text-amber-900">
              Pending approvals · {pendingItems.length}
            </div>
            {pendingItems.length >= 5 && (
              <button
                type="button"
                disabled={bulkApprove.isPending}
                onClick={() => {
                  if (
                    confirm(
                      `Bulk-approve all ${pendingItems.length} pending bonuses at full amount? Use this for historical backlog; per-ad triage is preferred for ongoing crossings.`,
                    )
                  ) {
                    bulkApprove.mutate();
                  }
                }}
                className="rounded-md border border-amber-400 bg-white px-3 py-1.5 text-xs font-medium text-amber-900 hover:bg-amber-100 disabled:opacity-50"
              >
                {bulkApprove.isPending ? "Approving…" : "Bulk-approve all at full"}
              </button>
            )}
          </div>
          <div className="divide-y divide-amber-200">
            {pendingItems.map((p) => (
              <div
                key={p.awardId}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm"
              >
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-neutral-900">
                    {p.marketer}
                    <span className="ml-3 text-neutral-500">·</span>
                    <span className="ml-3 text-neutral-700">Ad {p.adNumber}</span>
                    <span className="ml-3 text-neutral-500">·</span>
                    <span className="ml-3">
                      {p.tier === "tier1" ? "T1 ($13k)" : "T2 ($65k)"}
                    </span>
                  </div>
                  <div className="mt-0.5 text-xs text-neutral-600 truncate">
                    {p.adName} · crossed {fmtDate(p.crossedAt)} · lifetime{" "}
                    {fmtMoney(p.lifetimeSpendUsd)}
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
                    title="Approve full"
                  >
                    Approve full
                  </button>
                  {bonusCategory(p.marketer) === "main" && (
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

      {tracker.isLoading ? (
        <div className="text-sm text-neutral-500">Loading…</div>
      ) : (
        <div className="space-y-4">
          {/* Marketer tab strip */}
          <div className="flex flex-wrap gap-2">
            {BONUS_MARKETERS.map((marketer) => {
              const section = sectionsByMarketer.get(marketer);
              const count = section?.rows.length ?? 0;
              const isActive = openMarketer === marketer;
              return (
                <button
                  key={marketer}
                  type="button"
                  onClick={() => setOpenMarketer(marketer)}
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
          {(() => {
            const marketer = openMarketer;
            if (!marketer) return null;
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

            return (
              <div className="space-y-4">
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
                <div className="overflow-hidden rounded-md border border-neutral-200 bg-white">
                  {rows.length === 0 ? (
                    <div className="px-4 py-6 text-sm text-neutral-500">
                      No ads attributed to {marketer} yet.
                    </div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-neutral-200 bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500">
                            <th className="w-24 px-3 py-2 font-medium">Ad #</th>
                            <th className="px-3 py-2 font-medium">Ad name</th>
                            <th className="w-24 px-3 py-2 font-medium">Link</th>
                            <th className="w-40 px-3 py-2 font-medium">Status</th>
                            <th className="w-40 px-3 py-2 text-right font-medium">
                              Lifetime spend
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((r) => (
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
                              <td className="px-3 py-2">
                                <div className="flex flex-wrap gap-1">
                                  {tierBadge(r.awards.tier1?.status, "T1")}
                                  {tierBadge(r.awards.tier2?.status, "T2")}
                                  {!r.awards.tier1 && !r.awards.tier2 && (
                                    <span className="text-xs text-neutral-400">—</span>
                                  )}
                                </div>
                              </td>
                              <td className="px-3 py-2 text-right font-semibold tabular-nums text-neutral-900">
                                {fmtMoney(r.lifetimeSpendUsd)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </div>
            );
          })()}
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

      {/* Generate-notification preview modal */}
      {showPreviewModal && previewData && (
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
        spend → it appears in <em>Pending approvals</em>. Jasper picks Full /
        Half / Reject per ad (Half is main-marketer only — rehook or collab).
        Approved bonuses queue for the next notification. Click{" "}
        <em>Generate notification</em> to render the WhatsApp message and lock
        the batch.
      </div>
    </div>
  );
}
