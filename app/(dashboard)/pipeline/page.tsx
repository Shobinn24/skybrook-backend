"use client";

import { trpc } from "@/lib/trpc/client";
import { StatusPill } from "@/components/shell/StatusPill";

const SOURCE_LABEL: Record<string, string> = {
  sheets_inventory: "Inventory sheet",
  sheets_incoming: "Incoming sheet",
  shopify_us: "Shopify US",
  shopify_intl: "Shopify International",
};

const SOURCE_ORDER = [
  "sheets_inventory",
  "sheets_incoming",
  "shopify_us",
  "shopify_intl",
] as const;

const FRESH_HOURS = 26;
const STALE_HOURS = 48;

type Pull = {
  id: string;
  source: string;
  startedAt: string | Date;
  finishedAt: string | Date | null;
  status: "success" | "failed" | "partial";
  rowCount: number;
  errorMessage: string | null;
  fingerprint: string | null;
  schemaDrifted: boolean;
  priorFingerprint: string | null;
};

function freshnessPill(latest: Pull): { kind: "green" | "yellow" | "red" | "gray"; label: string } {
  if (!latest) return { kind: "gray", label: "No pulls yet" };
  const hours = (Date.now() - new Date(latest.startedAt).getTime()) / 3_600_000;
  if (latest.status === "failed" || hours > STALE_HOURS) {
    return { kind: "red", label: `Last pull ${formatTimeShort(latest.startedAt)}` };
  }
  if (hours > FRESH_HOURS) {
    return { kind: "yellow", label: `Last pull ${formatTimeShort(latest.startedAt)}` };
  }
  return { kind: "green", label: `Last pull ${formatTimeShort(latest.startedAt)}` };
}

function statusPill(status: Pull["status"]): { kind: "green" | "yellow" | "red"; label: string } {
  if (status === "success") return { kind: "green", label: "Success" };
  if (status === "partial") return { kind: "yellow", label: "Partial" };
  return { kind: "red", label: "Failed" };
}

function formatTimeFull(t: string | Date): string {
  return new Date(t).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatTimeShort(t: string | Date): string {
  return new Date(t).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatDuration(start: string | Date, end: string | Date | null): string {
  if (!end) return "—";
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (ms < 0) return "—";
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

export default function PipelinePage() {
  const { data, isLoading, error } = trpc.pipeline.getPullHistoryAllSources.useQuery();

  if (isLoading) {
    return <div className="text-sm text-neutral-500">Loading pull history…</div>;
  }
  if (error) {
    return (
      <div className="rounded border border-red-200 bg-red-50 p-4 text-sm text-red-800">
        Failed to load pull history: {error.message}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-neutral-900">Pipeline status</h1>
        <p className="mt-1 text-sm text-neutral-600">
          History of data pulls per source. Daily ingest runs at 10am EST. Most-recent
          {" "}30 pulls per source shown.
        </p>
      </div>

      {SOURCE_ORDER.map((source) => {
        const rows = ((data?.[source] as unknown) as Pull[] | undefined) ?? [];
        const latest = rows[0];
        const f = freshnessPill(latest);
        const fails = rows.filter((r) => r.status === "failed").length;
        const drifts = rows.filter((r) => r.schemaDrifted).length;

        return (
          <section
            key={source}
            className="rounded border border-neutral-200 bg-white"
          >
            <header className="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-200 px-4 py-3">
              <div className="flex flex-wrap items-center gap-3">
                <h2 className="text-base font-semibold text-neutral-900">
                  {SOURCE_LABEL[source] ?? source}
                </h2>
                <StatusPill kind={f.kind} label={f.label} />
                {drifts > 0 && (
                  <StatusPill
                    kind="yellow"
                    label={`${drifts} schema change${drifts === 1 ? "" : "s"}`}
                  />
                )}
              </div>
              <div className="text-xs text-neutral-500">
                {rows.length} pull{rows.length === 1 ? "" : "s"} shown
                {fails > 0 ? ` · ${fails} failed` : ""}
              </div>
            </header>

            {rows.length === 0 ? (
              <div className="px-4 py-6 text-sm text-neutral-500">
                No pulls recorded yet for this source.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500">
                    <tr>
                      <th className="px-4 py-2 font-medium">Started</th>
                      <th className="px-4 py-2 font-medium">Status</th>
                      <th className="px-4 py-2 font-medium">Duration</th>
                      <th className="px-4 py-2 font-medium text-right">Rows</th>
                      <th className="px-4 py-2 font-medium">Notes</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-neutral-100">
                    {rows.map((r) => {
                      const s = statusPill(r.status);
                      return (
                        <tr key={r.id} className="hover:bg-neutral-50">
                          <td className="whitespace-nowrap px-4 py-2 text-neutral-700">
                            {formatTimeFull(r.startedAt)}
                          </td>
                          <td className="px-4 py-2">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <StatusPill kind={s.kind} label={s.label} />
                              {r.schemaDrifted && (
                                <span
                                  className="inline-flex items-center gap-1 rounded-full bg-yellow-100 px-2 py-0.5 text-xs font-medium text-yellow-800"
                                  title={
                                    r.priorFingerprint && r.fingerprint
                                      ? `Schema fingerprint changed from ${r.priorFingerprint} to ${r.fingerprint}`
                                      : "Schema fingerprint changed since the previous successful pull"
                                  }
                                >
                                  Schema changed
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="whitespace-nowrap px-4 py-2 text-neutral-700">
                            {formatDuration(r.startedAt, r.finishedAt)}
                          </td>
                          <td className="whitespace-nowrap px-4 py-2 text-right tabular-nums text-neutral-700">
                            {r.rowCount.toLocaleString()}
                          </td>
                          <td className="px-4 py-2 text-neutral-600">
                            {r.errorMessage ? (
                              <span className="text-red-700" title={r.errorMessage}>
                                {r.errorMessage.length > 80
                                  ? `${r.errorMessage.slice(0, 80)}…`
                                  : r.errorMessage}
                              </span>
                            ) : (
                              <span className="text-neutral-400">—</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
