import { clsx } from "clsx";

const LABEL: Record<string, string> = {
  healthy: "Healthy",
  watch: "Watch",
  at_risk: "At risk",
  overstocked: "Overstocked",
};

const COLOR: Record<string, string> = {
  healthy: "bg-green-100 text-green-800",
  watch: "bg-yellow-100 text-yellow-800",
  at_risk: "bg-red-100 text-red-800",
  overstocked: "bg-slate-200 text-slate-700",
};

export function FlagPill({ flag }: { flag: string | null }) {
  if (!flag) return <span className="text-xs text-neutral-400">—</span>;
  return (
    <span
      className={clsx(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
        COLOR[flag] ?? "bg-neutral-200 text-neutral-700"
      )}
    >
      {LABEL[flag] ?? flag}
    </span>
  );
}
