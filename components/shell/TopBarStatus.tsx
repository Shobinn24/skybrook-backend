"use client";
import { trpc } from "@/lib/trpc/client";
import { StatusPill } from "./StatusPill";

const SOURCE_LABEL: Record<string, string> = {
  sheets_inventory: "Inventory sheet",
  sheets_incoming: "Incoming sheet",
  shopify_us: "Shopify US",
  shopify_intl: "Shopify Intl",
};

export function TopBarStatus() {
  const { data, isLoading } = trpc.pipeline.getLatestPullsPerSource.useQuery();

  if (isLoading) {
    return (
      <div className="flex items-center gap-3 border-b border-neutral-200 bg-white px-4 py-2 text-sm text-neutral-500">
        Loading data freshness…
      </div>
    );
  }

  const pulls = data ?? [];

  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-neutral-200 bg-white px-4 py-2">
      <div className="text-sm font-medium text-neutral-700">Data freshness</div>
      {pulls.length === 0 && (
        <StatusPill kind="gray" label="No pulls yet" />
      )}
      {pulls.map((p) => {
        const hours = (Date.now() - new Date(p.startedAt).getTime()) / 3_600_000;
        const kind: "green" | "yellow" | "red" =
          p.status === "failed" || hours > 48 ? "red" : hours > 26 ? "yellow" : "green";
        const when = new Date(p.startedAt).toLocaleString([], {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        });
        return (
          <StatusPill
            key={p.id}
            kind={kind}
            label={`${SOURCE_LABEL[p.source] ?? p.source} · ${when}`}
          />
        );
      })}
    </div>
  );
}
