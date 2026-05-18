import { clsx } from "clsx";
import type { ReactNode } from "react";
import { TracedNumber } from "@/components/trace/TracedNumber";
import type { NumberTrace } from "@/lib/queries/inventory";

export function KpiCard({
  label,
  value,
  tone = "neutral",
  hint,
  trace,
}: {
  label: string;
  // ReactNode (not just string/number) so callers can decorate the
  // value with inline delta badges, units, links, etc. without
  // dropping out of the KpiCard component.
  value: ReactNode;
  tone?: "neutral" | "warn" | "danger";
  hint?: string;
  // Optional click-to-inspect trace. When passed, the number becomes
  // a TracedNumber trigger with formula + inputs + sources. SPEC §3.1
  // wants every displayed number to be traceable; this brings KPI
  // cards into parity with the inventory table cells.
  trace?: NumberTrace | null;
}) {
  const valueClass = clsx(
    "mt-1 text-2xl font-semibold tabular-nums",
    tone === "danger" && "text-red-700",
    tone === "warn" && "text-yellow-700",
    tone === "neutral" && "text-neutral-900",
  );
  return (
    <div className="rounded-md border border-neutral-200 bg-white p-4">
      <div className="text-xs uppercase tracking-wide text-neutral-500">{label}</div>
      <div className={valueClass}>
        {trace ? (
          // align="left" so the popover anchors to the card's left
          // edge and stays within the card column at typical grid widths.
          <TracedNumber trace={trace} align="left">
            {value}
          </TracedNumber>
        ) : (
          value
        )}
      </div>
      {hint && <div className="mt-1 text-xs text-neutral-500">{hint}</div>}
    </div>
  );
}
