"use client";
import { useState } from "react";
import { trpc } from "@/lib/trpc/client";
import {
  BONUS_MARKETERS,
  BONUS_TIER_1_USD,
  BONUS_TIER_2_USD,
  bonusTier,
  type BonusMarketer,
} from "@/lib/domain/bonus-tiers";

function fmtMoney(n: number): string {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

// Background + ring color per tier. Bonus $ amounts are intentionally
// NOT surfaced in the UI — only tier progress is visible (spec).
const TIER_ROW_CLASS: Record<"none" | "tier1" | "tier2", string> = {
  none: "bg-white hover:bg-neutral-50",
  tier1: "bg-orange-50 hover:bg-orange-100",
  tier2: "bg-green-50 hover:bg-green-100",
};

const TIER_BADGE_CLASS: Record<"tier1" | "tier2", string> = {
  tier1: "bg-orange-200 text-orange-900",
  tier2: "bg-green-200 text-green-900",
};

export default function BonusTrackerPage() {
  const { data, isLoading, error } =
    trpc.inventory.getBonusTracker.useQuery(undefined, {
      refetchOnWindowFocus: false,
    });

  const [openMarketer, setOpenMarketer] = useState<BonusMarketer | null>(
    BONUS_MARKETERS[0] ?? null,
  );

  const sectionsByMarketer = new Map(
    (data?.sections ?? []).map((s) => [s.marketer, s]),
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-neutral-900">
          Bonus Tracker
        </h1>
        <p className="text-sm text-neutral-500">
          Lifetime FB ad spend per marketer · orange ≥{" "}
          {fmtMoney(BONUS_TIER_1_USD)} · green ≥ {fmtMoney(BONUS_TIER_2_USD)}
        </p>
      </div>

      {error ? (
        <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          Failed to load: {error.message}
        </div>
      ) : isLoading ? (
        <div className="text-sm text-neutral-500">Loading…</div>
      ) : (
        <div className="space-y-3">
          {BONUS_MARKETERS.map((marketer) => {
            const section = sectionsByMarketer.get(marketer);
            const rows = section?.rows ?? [];
            const isOpen = openMarketer === marketer;
            const tier1Count = rows.filter(
              (r) => bonusTier(r.lifetimeSpendUsd) === "tier1",
            ).length;
            const tier2Count = rows.filter(
              (r) => bonusTier(r.lifetimeSpendUsd) === "tier2",
            ).length;

            return (
              <div
                key={marketer}
                className="overflow-hidden rounded-md border border-neutral-200 bg-white"
              >
                <button
                  type="button"
                  onClick={() =>
                    setOpenMarketer(isOpen ? null : marketer)
                  }
                  className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-neutral-50"
                  aria-expanded={isOpen}
                >
                  <div className="flex items-center gap-3">
                    <span
                      aria-hidden
                      className="text-neutral-400 tabular-nums"
                    >
                      {isOpen ? "▾" : "▸"}
                    </span>
                    <span className="font-semibold text-neutral-900">
                      {marketer}
                    </span>
                    <span className="text-xs text-neutral-500">
                      {rows.length} {rows.length === 1 ? "ad" : "ads"}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 text-xs">
                    {tier2Count > 0 && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 font-medium text-green-900">
                        {tier2Count} @ T2
                      </span>
                    )}
                    {tier1Count > 0 && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-orange-100 px-2 py-0.5 font-medium text-orange-900">
                        {tier1Count} @ T1
                      </span>
                    )}
                  </div>
                </button>

                {isOpen && (
                  <div className="border-t border-neutral-200">
                    {rows.length === 0 ? (
                      <div className="px-4 py-6 text-sm text-neutral-500">
                        No ads attributed to {marketer} yet.
                      </div>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="border-b border-neutral-200 bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500">
                              <th className="w-24 px-3 py-2 font-medium">
                                Ad #
                              </th>
                              <th className="px-3 py-2 font-medium">
                                Ad name
                              </th>
                              <th className="w-24 px-3 py-2 font-medium">
                                Link
                              </th>
                              <th className="w-20 px-3 py-2 font-medium">
                                Tier
                              </th>
                              <th className="w-40 px-3 py-2 text-right font-medium">
                                Lifetime spend
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {rows.map((r) => {
                              const tier = bonusTier(r.lifetimeSpendUsd);
                              return (
                                <tr
                                  key={r.adNumber}
                                  className={`border-b border-neutral-100 last:border-b-0 ${TIER_ROW_CLASS[tier]}`}
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
                                      <span className="text-neutral-400">
                                        —
                                      </span>
                                    )}
                                  </td>
                                  <td className="px-3 py-2">
                                    {tier === "none" ? (
                                      <span className="text-xs text-neutral-400">
                                        —
                                      </span>
                                    ) : (
                                      <span
                                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${TIER_BADGE_CLASS[tier]}`}
                                      >
                                        {tier === "tier2" ? "T2" : "T1"}
                                      </span>
                                    )}
                                  </td>
                                  <td className="px-3 py-2 text-right font-semibold tabular-nums text-neutral-900">
                                    {fmtMoney(r.lifetimeSpendUsd)}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="rounded-md border border-neutral-200 bg-neutral-50 px-4 py-3 text-xs text-neutral-600">
        <strong>Notes:</strong> Lifetime spend is summed across the entire
        FB Ads Tracker history. An ad attributed to multiple marketers
        appears in each marketer&rsquo;s section with the full ad spend in
        both (per Jasper 2026-05-11). Nate and Scotty are excluded from
        bonus payouts. Already-paid bonus tracking + monthly notifications
        are pending Jasper&rsquo;s answers on payout amounts and message
        format.
      </div>
    </div>
  );
}
