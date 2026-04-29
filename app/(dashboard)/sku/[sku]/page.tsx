"use client";
import { useParams } from "next/navigation";
import Link from "next/link";
import { FlagPill } from "@/components/inventory/FlagPill";
import { KpiCard } from "@/components/inventory/KpiCard";
import { DailySalesChart } from "@/components/sku/DailySalesChart";
import { trpc } from "@/lib/trpc/client";

type SkuRouteParams = { sku: string };

function fmtNum(n: number | null | undefined, digits = 0): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function fmtMoney(n: number, digits = 0): string {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function fmtUnitCost(n: number | null): string {
  if (n == null || n === 0) return "—";
  return fmtMoney(n, 2);
}

const STATUS_LABEL: Record<string, string> = {
  po: "PO",
  dispatched: "Dispatched",
  in_transit: "In transit",
  arrived: "Arrived",
};

export default function SkuDetailPage() {
  const params = useParams<SkuRouteParams>();
  // useParams returns the URL-encoded form; slashes in a SKU would be
  // unusual but decoding keeps things safe regardless.
  const sku = decodeURIComponent(params?.sku ?? "");

  const { data, isLoading, error } = trpc.inventory.getSkuDetail.useQuery(
    { sku },
    { refetchOnWindowFocus: false, enabled: sku.length > 0 },
  );

  if (isLoading) {
    return <div className="text-sm text-neutral-500">Loading {sku}…</div>;
  }
  if (error) {
    return (
      <div className="rounded border border-red-200 bg-red-50 p-4 text-sm text-red-800">
        Failed to load: {error.message}
      </div>
    );
  }
  if (!data) {
    return (
      <div className="space-y-3">
        <BackLink />
        <div className="rounded border border-neutral-200 bg-white p-6 text-sm text-neutral-700">
          SKU <code className="font-mono">{sku}</code> not found in the catalog.
        </div>
      </div>
    );
  }

  const us = data.byLocation.find((l) => l.location === "US")!;
  const cn = data.byLocation.find((l) => l.location === "CN")!;
  const totalStock = us.onHand + cn.onHand;
  const totalValue = us.stockValueUsd + cn.stockValueUsd;
  // Headline status = the most-concerning flag across warehouses.
  // at_risk > watch > overstocked > healthy. null wins only if both
  // are null.
  const headlineFlag = pickHeadlineFlag(us.flag, cn.flag);

  return (
    <div className="space-y-6">
      <BackLink />

      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="font-mono text-2xl font-semibold text-neutral-900">{data.sku}</h1>
          <p className="mt-0.5 text-sm text-neutral-600">
            {data.productName}
            {data.productLine && (
              <>
                {" · "}
                <span className="text-neutral-500">{data.productLine}</span>
              </>
            )}
            {" · "}
            <span className="text-neutral-500">first seen {data.firstSeenAt}</span>
          </p>
        </div>
        {!data.active && (
          <span className="inline-flex items-center rounded-full bg-neutral-200 px-2 py-0.5 text-xs font-medium text-neutral-700">
            Inactive
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
        <KpiCard label="Total stock" value={fmtNum(totalStock)} hint="US + CN" />
        <KpiCard
          label="US stock"
          value={fmtNum(us.onHand)}
          hint={us.snapshotDate ? `as of ${us.snapshotDate}` : "no snapshot"}
        />
        <KpiCard
          label="CN stock"
          value={fmtNum(cn.onHand)}
          hint={cn.snapshotDate ? `as of ${cn.snapshotDate}` : "no snapshot"}
        />
        <KpiCard label="Stock value" value={fmtMoney(totalValue)} hint="US + CN" />
        <div className="rounded-md border border-neutral-200 bg-white p-4">
          <div className="text-xs uppercase tracking-wide text-neutral-500">Status</div>
          <div className="mt-2">
            <FlagPill flag={headlineFlag} />
          </div>
          {(us.flag || cn.flag) && (
            <div className="mt-2 space-y-0.5 text-xs text-neutral-500">
              <div>
                US: <FlagPill flag={us.flag} />
              </div>
              <div>
                CN: <FlagPill flag={cn.flag} />
              </div>
            </div>
          )}
        </div>
      </div>

      <section className="rounded-md border border-neutral-200 bg-white">
        <header className="border-b border-neutral-200 px-4 py-3">
          <h2 className="text-sm font-semibold text-neutral-900">Sales velocity</h2>
          <p className="text-xs text-neutral-500">
            Units/day across each rolling window. `All` aggregates US + INTL channels.
          </p>
        </header>
        <table className="w-full text-sm">
          <thead className="bg-neutral-50 text-xs uppercase tracking-wide text-neutral-500">
            <tr>
              <th className="px-4 py-2 text-left font-medium">Window</th>
              <th className="px-4 py-2 text-right font-medium">All</th>
              <th className="px-4 py-2 text-right font-medium">US (Shopify)</th>
              <th className="px-4 py-2 text-right font-medium">INTL (Shopify)</th>
              <th className="px-4 py-2 text-left font-medium">As-of</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-100">
            {data.velocityByWindow.map((row) => (
              <tr key={row.windowDays}>
                <td className="px-4 py-2 font-medium text-neutral-700">{row.windowDays}-day</td>
                <td className="px-4 py-2 text-right tabular-nums">
                  {fmtNum(row.perChannel.all, 2)}
                </td>
                <td className="px-4 py-2 text-right tabular-nums">
                  {fmtNum(row.perChannel.shopify_us, 2)}
                </td>
                <td className="px-4 py-2 text-right tabular-nums">
                  {fmtNum(row.perChannel.shopify_intl, 2)}
                </td>
                <td className="px-4 py-2 text-neutral-500">{row.asOfDate ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="rounded-md border border-neutral-200 bg-white">
        <header className="border-b border-neutral-200 px-4 py-3">
          <h2 className="text-sm font-semibold text-neutral-900">Daily sales (last 30 days)</h2>
          <p className="text-xs text-neutral-500">
            Stacked by Shopify channel. Hover a column for the per-day breakdown.
          </p>
        </header>
        <div className="px-4 py-4">
          <DailySalesChart data={data.daily30d} />
        </div>
      </section>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <WarehouseCard
          loc="US"
          loc_={us}
          unitCost={data.unitCostUsd}
          unitCostLabel="US cost"
        />
        <WarehouseCard
          loc="CN"
          loc_={cn}
          // CN routes to INTL cost when available, falls back to US — matches
          // unitCostForLocation semantics from lib/queries/stock.ts.
          unitCost={data.unitCostIntlUsd ?? data.unitCostUsd}
          unitCostLabel={data.unitCostIntlUsd != null ? "INTL cost" : "INTL cost (falls back to US)"}
        />
      </div>
    </div>
  );
}

function BackLink() {
  return (
    <Link href="/inventory" className="text-sm text-neutral-500 hover:text-neutral-900">
      ← Inventory
    </Link>
  );
}

const FLAG_RANK: Record<string, number> = {
  at_risk: 0,
  watch: 1,
  overstocked: 2,
  healthy: 3,
};

function pickHeadlineFlag(
  a: "healthy" | "watch" | "at_risk" | "overstocked" | null,
  b: "healthy" | "watch" | "at_risk" | "overstocked" | null,
): "healthy" | "watch" | "at_risk" | "overstocked" | null {
  if (!a) return b;
  if (!b) return a;
  return (FLAG_RANK[a] ?? 99) <= (FLAG_RANK[b] ?? 99) ? a : b;
}

type WarehouseEntry = {
  location: "US" | "CN";
  onHand: number;
  snapshotDate: string | null;
  stockValueUsd: number;
  flag: "healthy" | "watch" | "at_risk" | "overstocked" | null;
  runOutDate: string | null;
  reasoning: string | null;
  daysOfStock7d: number | null;
  incoming: Array<{
    shipmentName: string;
    quantity: number;
    expectedArrival: string;
    status: "po" | "dispatched" | "in_transit" | "arrived";
  }>;
};

function WarehouseCard({
  loc,
  loc_,
  unitCost,
  unitCostLabel,
}: {
  loc: "US" | "CN";
  loc_: WarehouseEntry;
  unitCost: number | null;
  unitCostLabel: string;
}) {
  const totalIncoming = loc_.incoming.reduce((n, p) => n + p.quantity, 0);
  return (
    <section className="rounded-md border border-neutral-200 bg-white">
      <header className="flex items-center justify-between border-b border-neutral-200 px-4 py-3">
        <h2 className="text-sm font-semibold text-neutral-900">{loc} warehouse</h2>
        <FlagPill flag={loc_.flag} />
      </header>
      <dl className="divide-y divide-neutral-100 text-sm">
        <Row label="On hand" value={`${fmtNum(loc_.onHand)} units`} />
        <Row label="Days of stock (7d velocity)" value={fmtNum(loc_.daysOfStock7d, 1)} />
        <Row label="Run-out date" value={loc_.runOutDate ?? "—"} />
        <Row label="Stock value" value={fmtMoney(loc_.stockValueUsd)} />
        <Row label={unitCostLabel} value={fmtUnitCost(unitCost)} />
        {loc_.reasoning && (
          <div className="px-4 py-2.5">
            <dt className="text-xs uppercase tracking-wide text-neutral-500">Reasoning</dt>
            <dd className="mt-1 text-neutral-700">{loc_.reasoning}</dd>
          </div>
        )}
      </dl>

      <div className="border-t border-neutral-200 px-4 py-3">
        <div className="mb-1.5 flex items-baseline justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
            Incoming
          </h3>
          <div className="text-xs text-neutral-500">
            {loc_.incoming.length === 0
              ? "no pending POs"
              : `${fmtNum(totalIncoming)} units across ${loc_.incoming.length} PO${loc_.incoming.length === 1 ? "" : "s"}`}
          </div>
        </div>
        {loc_.incoming.length === 0 ? (
          <p className="text-sm text-neutral-400">—</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {loc_.incoming.map((p, i) => (
              <li
                key={`${p.expectedArrival}|${p.shipmentName}|${i}`}
                className="flex items-center justify-between gap-3"
              >
                <div className="min-w-0">
                  <span className="text-neutral-700">{p.expectedArrival}</span>
                  <span className="ml-2 text-xs uppercase tracking-wide text-neutral-500">
                    {STATUS_LABEL[p.status] ?? p.status}
                  </span>
                  {p.shipmentName && (
                    <span className="ml-2 truncate text-xs text-neutral-500">{p.shipmentName}</span>
                  )}
                </div>
                <span className="whitespace-nowrap tabular-nums font-medium text-neutral-800">
                  {fmtNum(p.quantity)} units
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between px-4 py-2">
      <dt className="text-neutral-600">{label}</dt>
      <dd className="tabular-nums font-medium text-neutral-900">{value}</dd>
    </div>
  );
}
