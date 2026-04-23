import { clsx } from "clsx";

type Kind = "green" | "yellow" | "red" | "gray";

const DOT_COLOR: Record<Kind, string> = {
  green: "bg-green-500",
  yellow: "bg-yellow-500",
  red: "bg-red-500",
  gray: "bg-neutral-400",
};

const PILL_COLOR: Record<Kind, string> = {
  green: "bg-green-100 text-green-800",
  yellow: "bg-yellow-100 text-yellow-800",
  red: "bg-red-100 text-red-800",
  gray: "bg-neutral-200 text-neutral-700",
};

export function StatusPill({ kind, label }: { kind: Kind; label: string }) {
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium",
        PILL_COLOR[kind]
      )}
    >
      <span className={clsx("h-1.5 w-1.5 rounded-full", DOT_COLOR[kind])} />
      {label}
    </span>
  );
}
