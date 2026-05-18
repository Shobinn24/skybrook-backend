"use client";

import { useMemo, useState } from "react";
import { clsx } from "clsx";
import { KpiCard } from "@/components/inventory/KpiCard";
import { trpc } from "@/lib/trpc/client";

// Mirror the histogram bin order from `computeStatsWindow`. Keys are
// "0".."20" plus ">20" overflow.
const BIN_KEYS: ReadonlyArray<string> = [
  ...Array.from({ length: 21 }, (_, i) => String(i)),
  ">20",
];

// Soft cap on rendered flag rows. Production currently surfaces ~3,700
// carrier flags because many DHL eCommerce shipments never receive a
// terminal DELIVERED event (Spec §4.5 calls this out as a known v1
// limitation). Rendering all rows tanks DOM perf; cap at this count
// and surface a "+ N more" footer.
const MAX_RENDERED_FLAGS = 100;

function fmtHours(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  if (n >= 48) return `${(n / 24).toFixed(1)}d`;
  return `${n.toFixed(0)}h`;
}
function fmtDays(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  return `${n.toFixed(1)}d`;
}
function fmtDeltaPct(pct: number | null): {
  text: string;
  tone: "neutral" | "positive" | "negative";
} {
  if (pct === null) return { text: "—", tone: "neutral" };
  const abs = Math.abs(pct);
  if (abs < 5) return { text: `${pct >= 0 ? "+" : ""}${pct.toFixed(0)}%`, tone: "neutral" };
  // For shipping time, smaller-is-better — positive delta (slower) is bad.
  return {
    text: `${pct >= 0 ? "↑" : "↓"}${abs.toFixed(0)}%`,
    tone: pct >= 0 ? "negative" : "positive",
  };
}
function fmtAgo(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.round(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function DeltaBadge({ pct }: { pct: number | null }) {
  const { text, tone } = fmtDeltaPct(pct);
  return (
    <span
      className={clsx(
        "ml-2 text-xs tabular-nums",
        tone === "positive" && "text-green-700",
        tone === "negative" && "text-red-700",
        tone === "neutral" && "text-neutral-500",
      )}
    >
      {text}
    </span>
  );
}

function HistogramCard({
  current,
  prior,
}: {
  current: Record<string, number>;
  prior: Record<string, number> | null;
}) {
  const maxCount = Math.max(
    1,
    ...BIN_KEYS.map((k) =>
      Math.max(current[k] ?? 0, prior?.[k] ?? 0),
    ),
  );
  return (
    <div className="rounded-md border border-neutral-200 bg-white p-4">
      <div className="text-xs uppercase tracking-wide text-neutral-500">
        Carrier transit distribution (days)
      </div>
      <div className="mt-3 flex h-32 items-end gap-1">
        {BIN_KEYS.map((bin) => {
          const c = current[bin] ?? 0;
          const p = prior?.[bin] ?? 0;
          const cHeight = (c / maxCount) * 100;
          const pHeight = (p / maxCount) * 100;
          return (
            <div
              key={bin}
              className="relative flex-1 min-w-0"
              title={`${bin}d: ${c} (prior ${p})`}
            >
              {/* prior 30d outline (taller of the two stays visible) */}
              {prior !== null && pHeight > 0 && (
                <div
                  className="absolute bottom-0 left-0 w-full border-l border-r border-t border-neutral-400"
                  style={{ height: `${pHeight}%` }}
                />
              )}
              {/* current 30d filled */}
              {cHeight > 0 && (
                <div
                  className="absolute bottom-0 left-0 w-full bg-blue-500"
                  style={{ height: `${cHeight}%` }}
                />
              )}
            </div>
          );
        })}
      </div>
      <div className="mt-1 flex items-center justify-between text-[10px] text-neutral-400">
        <span>0d</span>
        <span>10d</span>
        <span>20d+</span>
      </div>
      <div className="mt-2 flex items-center gap-3 text-[10px] text-neutral-500">
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-2 w-3 bg-blue-500" /> Last 30d
        </span>
        {prior !== null && (
          <span className="inline-flex items-center gap-1">
            <span className="inline-block h-2 w-3 border border-neutral-400" />{" "}
            Prior 30d
          </span>
        )}
      </div>
    </div>
  );
}

function FulfilmentFlagsTable({
  flags,
}: {
  flags: ReadonlyArray<{
    orderId: string;
    orderName: string;
    orderCreatedAt: string;
    expectedShipDate: string;
    daysPastDue: number;
    customerName: string | null;
    shippingState: string | null;
    lineItems: Array<{ sku: string | null; name: string | null; quantity: number }>;
    currentStatus: string;
    shopifyAdminLink: string;
  }>;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (flags.length === 0) {
    return (
      <div className="rounded-md border border-neutral-200 bg-white px-4 py-8 text-center text-sm text-neutral-500">
        All orders shipping on time. Nothing to action.
      </div>
    );
  }

  const shown = flags.slice(0, MAX_RENDERED_FLAGS);
  const hidden = flags.length - shown.length;

  return (
    <div className="overflow-x-auto rounded-md border border-neutral-200 bg-white">
      <table className="w-full text-sm">
        <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500">
          <tr>
            <th className="w-6 px-2 py-2" />
            <th className="px-4 py-2">Order</th>
            <th className="px-4 py-2 text-right">Days past due</th>
            <th className="px-4 py-2">Customer</th>
            <th className="px-4 py-2">State</th>
            <th className="px-4 py-2">Status</th>
            <th className="px-4 py-2">Expected ship</th>
            <th className="px-4 py-2" />
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-100">
          {shown.map((f) => {
            const isOpen = expanded.has(f.orderId);
            return (
              <>
                <tr key={f.orderId} className="hover:bg-neutral-50">
                  <td className="px-2 py-2">
                    <button
                      onClick={() => toggle(f.orderId)}
                      className="text-neutral-400 hover:text-neutral-700"
                      aria-label={isOpen ? "Collapse" : "Expand line items"}
                    >
                      {isOpen ? "▾" : "▸"}
                    </button>
                  </td>
                  <td className="px-4 py-2 font-medium">{f.orderName}</td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {f.daysPastDue}
                  </td>
                  <td className="px-4 py-2 text-neutral-700">
                    {f.customerName ?? "—"}
                  </td>
                  <td className="px-4 py-2 text-neutral-700">
                    {f.shippingState ?? "—"}
                  </td>
                  <td className="px-4 py-2 text-neutral-700">
                    {f.currentStatus}
                  </td>
                  <td className="px-4 py-2 text-neutral-700 tabular-nums">
                    {f.expectedShipDate}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <a
                      href={f.shopifyAdminLink}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs text-blue-700 hover:underline"
                    >
                      Open in Shopify ↗
                    </a>
                  </td>
                </tr>
                {isOpen && (
                  <tr key={`${f.orderId}-detail`} className="bg-neutral-50">
                    <td />
                    <td colSpan={7} className="px-4 py-2 text-xs text-neutral-700">
                      <div className="mb-1 font-medium text-neutral-600">
                        Pending line items:
                      </div>
                      <ul className="ml-2 space-y-0.5">
                        {f.lineItems.map((li, i) => (
                          <li key={`${f.orderId}-li-${i}`}>
                            {li.quantity}× {li.name ?? "(unnamed)"}{" "}
                            {li.sku ? (
                              <span className="text-neutral-400">[{li.sku}]</span>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    </td>
                  </tr>
                )}
              </>
            );
          })}
          {hidden > 0 && (
            <tr className="bg-neutral-50">
              <td />
              <td colSpan={7} className="px-4 py-2 text-xs text-neutral-500 italic">
                +{hidden} more flags (sorted by days-past-due desc; only the
                worst {MAX_RENDERED_FLAGS} shown).
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function CarrierFlagsTable({
  flags,
}: {
  flags: ReadonlyArray<{
    orderId: string;
    orderName: string;
    fulfilledAt: string;
    daysSinceShip: number;
    deliveredAt: string | null;
    carrier: string | null;
    trackingNumber: string | null;
    trackingUrl: string | null;
    shippingState: string | null;
    status: "in_transit_over_10_days" | "delivered_late";
    shopifyAdminLink: string;
  }>;
}) {
  if (flags.length === 0) {
    return (
      <div className="rounded-md border border-neutral-200 bg-white px-4 py-8 text-center text-sm text-neutral-500">
        No packages over 10 days in transit.
      </div>
    );
  }
  const shown = flags.slice(0, MAX_RENDERED_FLAGS);
  const hidden = flags.length - shown.length;
  return (
    <div className="overflow-x-auto rounded-md border border-neutral-200 bg-white">
      <table className="w-full text-sm">
        <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500">
          <tr>
            <th className="px-4 py-2">Order</th>
            <th className="px-4 py-2 text-right">Days since ship</th>
            <th className="px-4 py-2">Status</th>
            <th className="px-4 py-2">Carrier</th>
            <th className="px-4 py-2">Tracking</th>
            <th className="px-4 py-2">State</th>
            <th className="px-4 py-2" />
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-100">
          {shown.map((f) => (
            <tr key={`${f.orderId}-${f.fulfilledAt}`} className="hover:bg-neutral-50">
              <td className="px-4 py-2 font-medium">{f.orderName}</td>
              <td className="px-4 py-2 text-right tabular-nums">
                {f.daysSinceShip}
              </td>
              <td className="px-4 py-2 text-neutral-700">
                <span
                  className={clsx(
                    "rounded px-1.5 py-0.5 text-xs",
                    f.status === "in_transit_over_10_days"
                      ? "bg-yellow-50 text-yellow-800"
                      : "bg-red-50 text-red-800",
                  )}
                >
                  {f.status === "in_transit_over_10_days"
                    ? "In transit >10d"
                    : "Delivered late"}
                </span>
              </td>
              <td className="px-4 py-2 text-neutral-700">{f.carrier ?? "—"}</td>
              <td className="px-4 py-2 text-neutral-700 tabular-nums">
                {f.trackingUrl && f.trackingNumber ? (
                  <a
                    href={f.trackingUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-blue-700 hover:underline"
                  >
                    {f.trackingNumber}
                  </a>
                ) : (
                  f.trackingNumber ?? "—"
                )}
              </td>
              <td className="px-4 py-2 text-neutral-700">
                {f.shippingState ?? "—"}
              </td>
              <td className="px-4 py-2 text-right">
                <a
                  href={f.shopifyAdminLink}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs text-blue-700 hover:underline"
                >
                  Open in Shopify ↗
                </a>
              </td>
            </tr>
          ))}
          {hidden > 0 && (
            <tr className="bg-neutral-50">
              <td colSpan={7} className="px-4 py-2 text-xs text-neutral-500 italic">
                +{hidden} more flags (sorted by days-since-ship desc; only the
                worst {MAX_RENDERED_FLAGS} shown). Per spec §4.5, many of these
                are likely carriers that don&apos;t push a DELIVERED event back
                to Shopify rather than truly stuck packages.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export default function ShippingPerformancePage() {
  const { data, isLoading, error } =
    trpc.shippingAudit.getView.useQuery(undefined, {
      // Live Shopify fetch + ~30d of orders → not super cheap. Cache for
      // ~5min on the client so flipping between pages doesn't refetch.
      staleTime: 5 * 60_000,
    });

  const current = data?.stats.current;
  const prior = data?.stats.prior ?? null;
  const deltas = data?.stats.deltaPct;

  const lastUpdated = useMemo(
    () => fmtAgo(data?.computedAt ?? null),
    [data?.computedAt],
  );

  if (isLoading) {
    return (
      <div className="text-sm text-neutral-500">Loading shipping data…</div>
    );
  }
  if (error) {
    return (
      <div className="rounded border border-red-200 bg-red-50 p-4 text-sm text-red-800">
        Failed to load shipping data: {error.message}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold text-neutral-900">
            Shipping Performance
          </h1>
          <div className="text-xs text-neutral-500">
            Last updated: {lastUpdated}
          </div>
        </div>
        <p className="mt-1 text-sm text-neutral-600">
          US-store orders only. Two daily checks (Mon–Fri): fulfilment SLA
          (3PL ship-by) and carrier transit (&gt;10 days). Stats compare the
          last 30 days against the prior 30.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <KpiCard
            label="Avg fulfilment"
            value={
              <>
                <span>{fmtHours(current?.avgFulfilmentHours ?? null)}</span>
                <DeltaBadge pct={deltas?.fulfilmentHours ?? null} />
              </>
            }
            hint="Order placed → label generated"
          />
          <KpiCard
            label="Avg carrier transit"
            value={
              <>
                <span>{fmtDays(current?.avgTransitDays ?? null)}</span>
                <DeltaBadge pct={deltas?.transitDays ?? null} />
              </>
            }
            hint="Ship → delivered"
          />
          <KpiCard
            label="Avg total delivery"
            value={
              <>
                <span>{fmtDays(current?.avgTotalDays ?? null)}</span>
                <DeltaBadge pct={deltas?.totalDays ?? null} />
              </>
            }
            hint="Order → delivered"
          />
        </div>
        <HistogramCard
          current={current?.transitHistogram ?? {}}
          prior={prior?.transitHistogram ?? null}
        />
      </div>

      <div>
        <h2 className="mb-2 text-sm font-semibold text-neutral-900">
          Flagged orders — Fulfilment SLA{" "}
          <span className="text-neutral-500">
            ({data?.fulfilmentFlags.length ?? 0})
          </span>
        </h2>
        <FulfilmentFlagsTable flags={data?.fulfilmentFlags ?? []} />
      </div>

      <div>
        <h2 className="mb-2 text-sm font-semibold text-neutral-900">
          Flagged orders — Carrier transit{" "}
          <span className="text-neutral-500">
            ({data?.carrierFlags.length ?? 0})
          </span>
        </h2>
        <CarrierFlagsTable flags={data?.carrierFlags ?? []} />
      </div>

      <div className="text-xs text-neutral-400">
        Stats window:{" "}
        {current
          ? `${current.windowStart} → ${current.windowEnd}, n=${current.deliveredCount}`
          : "—"}
        {prior
          ? ` · Prior: ${prior.windowStart} → ${prior.windowEnd}, n=${prior.deliveredCount}`
          : ""}
      </div>
    </div>
  );
}
