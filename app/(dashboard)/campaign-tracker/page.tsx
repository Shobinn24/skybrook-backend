"use client";
import { useState } from "react";
import { trpc } from "@/lib/trpc/client";
import { CAMPAIGN_BUCKETS } from "@/lib/domain/campaign-buckets";
// Type-only imports — erased at compile time so the client bundle never
// pulls in the query module (which imports the db client).
import type {
  CampaignTrackerCell,
  CampaignTrackerWeek,
} from "@/lib/queries/campaign-tracker";

// Column layout mirrors the ops team's hand-built sheet: the four US/INTL
// buckets with their derived totals inline, then the standalone buckets.
const COLUMNS: Array<{ key: string; label: string; derived?: "us" | "intl" }> = [
  { key: "us_cc", label: "US CC" },
  { key: "us_bau", label: "US BAU" },
  { key: "us_total", label: "US Total", derived: "us" },
  { key: "intl_cc", label: "INTL CC" },
  { key: "intl_bau", label: "INTL BAU" },
  { key: "intl_total", label: "INTL Total", derived: "intl" },
  { key: "cc_cbo", label: "CC CBO" },
  { key: "partnership", label: "Partnership" },
  { key: "zombie", label: "Zombie" },
];

function fmtMoney(n: number): string {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

function fmtDay(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function cellFor(
  col: (typeof COLUMNS)[number],
  buckets: Record<string, CampaignTrackerCell>,
  usTotal: CampaignTrackerCell,
  intlTotal: CampaignTrackerCell,
): CampaignTrackerCell {
  if (col.derived === "us") return usTotal;
  if (col.derived === "intl") return intlTotal;
  return buckets[col.key] ?? { spendUsd: 0, purchaseValueUsd: 0, roas: null };
}

function Cell({ cell, bold }: { cell: CampaignTrackerCell; bold?: boolean }) {
  if (cell.spendUsd === 0 && cell.roas === null) {
    return <td className="px-3 py-1.5 text-right text-neutral-300">—</td>;
  }
  return (
    <td className={`px-3 py-1.5 text-right tabular-nums ${bold ? "font-semibold" : ""}`}>
      <div>{fmtMoney(cell.spendUsd)}</div>
      <div className={cell.roas !== null && cell.roas < 2 ? "text-amber-600" : "text-neutral-500"}>
        {cell.roas !== null ? `${cell.roas.toFixed(2)}x` : "–"}
      </div>
    </td>
  );
}

function WeekNotes({ week, canEdit }: { week: CampaignTrackerWeek; canEdit: boolean }) {
  const utils = trpc.useUtils();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(week.note ?? "");
  const save = trpc.inventory.upsertCampaignTrackerNote.useMutation({
    onSuccess: () => {
      setEditing(false);
      void utils.inventory.getCampaignTracker.invalidate();
    },
  });
  if (!editing) {
    return (
      <div className="flex items-start gap-3 px-3 py-2">
        <div className="min-w-0 flex-1 whitespace-pre-wrap text-sm text-neutral-700">
          {week.note ?? <span className="text-neutral-400">No notes for this week yet.</span>}
        </div>
        {canEdit && (
          <button
            onClick={() => {
              setDraft(week.note ?? "");
              setEditing(true);
            }}
            className="shrink-0 text-xs text-neutral-500 hover:text-neutral-800"
          >
            {week.note ? "Edit" : "Add note"}
          </button>
        )}
      </div>
    );
  }
  return (
    <div className="space-y-2 px-3 py-2">
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={Math.min(12, Math.max(3, draft.split("\n").length + 1))}
        className="block w-full rounded border border-neutral-300 bg-white px-2 py-1 text-sm"
        placeholder="Weekly notes…"
      />
      <div className="flex items-center gap-2">
        <button
          onClick={() => save.mutate({ weekStart: week.weekStart, note: draft })}
          disabled={save.isPending}
          className="rounded bg-neutral-900 px-3 py-1 text-xs font-medium text-white hover:bg-neutral-700 disabled:opacity-50"
        >
          {save.isPending ? "Saving…" : "Save"}
        </button>
        <button onClick={() => setEditing(false)} className="text-xs text-neutral-500 hover:text-neutral-800">
          Cancel
        </button>
        {save.error ? <span className="text-xs text-red-700">{save.error.message}</span> : null}
      </div>
    </div>
  );
}

function WeekBlock({ week, isCurrent, canEdit }: { week: CampaignTrackerWeek; isCurrent: boolean; canEdit: boolean }) {
  const weekEnd = week.days[week.days.length - 1]?.date ?? week.weekStart;
  return (
    <div className="rounded-md border border-neutral-200 bg-white">
      <div className="flex items-baseline justify-between border-b border-neutral-100 px-3 py-2">
        <h2 className="text-sm font-semibold text-neutral-900">
          Week of {fmtDay(week.weekStart)} – {fmtDay(weekEnd)}
          {isCurrent ? (
            <span className="ml-2 rounded bg-blue-50 px-1.5 py-0.5 text-xs font-medium text-blue-700">
              week to date
            </span>
          ) : null}
        </h2>
        <span className="text-xs text-neutral-400">spend / ROAS per day; 7D row is Mon–Sun</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500">
            <tr>
              <th className="px-3 py-2">Date</th>
              {COLUMNS.map((c) => (
                <th key={c.key} className={`px-3 py-2 text-right ${c.derived ? "border-r border-neutral-200" : ""}`}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-100">
            {week.days.map((day) => (
              <tr key={day.date}>
                <td className="whitespace-nowrap px-3 py-1.5 text-neutral-700">{fmtDay(day.date)}</td>
                {COLUMNS.map((c) => (
                  <Cell key={c.key} cell={cellFor(c, day.buckets, day.usTotal, day.intlTotal)} />
                ))}
              </tr>
            ))}
            <tr className="bg-neutral-50">
              <td className="whitespace-nowrap px-3 py-1.5 font-semibold text-neutral-900">
                7D{isCurrent ? " (partial)" : ""}
              </td>
              {COLUMNS.map((c) => (
                <Cell
                  key={c.key}
                  bold
                  cell={cellFor(c, week.weekly.buckets, week.weekly.usTotal, week.weekly.intlTotal)}
                />
              ))}
            </tr>
          </tbody>
        </table>
      </div>
      <div className="border-t border-neutral-100 bg-neutral-50/50">
        <WeekNotes week={week} canEdit={canEdit} />
      </div>
    </div>
  );
}

export default function CampaignTrackerPage() {
  const query = trpc.inventory.getCampaignTracker.useQuery();
  // viewer tier is read-only: server rejects its mutations; hide the controls (2026-07-22)
  const me = trpc.inventory.getMyAccessTier.useQuery(undefined, {
    refetchOnWindowFocus: false,
  });
  const canEdit = me.data?.tier !== undefined && me.data.tier !== "viewer";

  if (query.isLoading) {
    return <div className="p-6 text-sm text-neutral-500">Loading campaign tracker…</div>;
  }
  if (query.error) {
    return <div className="p-6 text-sm text-red-700">Failed to load: {query.error.message}</div>;
  }
  const data = query.data!;
  // Newest week first for day-to-day use; days ascend inside each week
  // (the source sheet's convention).
  const weeks = [...data.weeks].reverse();

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-neutral-900">Campaign Tracker</h1>
          <p className="text-sm text-neutral-500">
            Daily spend and ROAS per campaign, from FB campaign-level data (refreshes with the
            morning ingest). ROAS = FB-attributed purchase value ÷ spend; totals are US/INTL CC+BAU
            with spend-weighted ROAS.
            {data.asOfDate ? ` Data through ${fmtDay(data.asOfDate)}.` : ""}
          </p>
        </div>
      </div>
      {weeks.length === 0 ? (
        <div className="rounded-md border border-neutral-200 bg-white p-6 text-sm text-neutral-500">
          No campaign data ingested yet.
        </div>
      ) : (
        weeks.map((w, i) => <WeekBlock key={w.weekStart} week={w} isCurrent={i === 0 && w.days.length < 7} canEdit={canEdit} />)
      )}
    </div>
  );
}
