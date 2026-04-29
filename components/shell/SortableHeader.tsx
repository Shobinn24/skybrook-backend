"use client";

import type { ReactNode } from "react";

export type SortDirection = "asc" | "desc";
export type SortConfig<K extends string> = { key: K; direction: SortDirection };

// Click toggles direction when already on this column; otherwise jumps to
// this column with a sensible default direction (desc for right-aligned
// numeric columns, asc for left-aligned text — matches what an operator
// usually wants on first click).
export function SortableHeader<K extends string>({
  label,
  sortKey,
  config,
  onChange,
  align = "left",
  className = "",
  paddingClass = "px-4 py-2",
  rowSpan,
  title,
}: {
  label: ReactNode;
  sortKey: K;
  config: SortConfig<K>;
  onChange: (next: SortConfig<K>) => void;
  align?: "left" | "right";
  className?: string;
  // Sustainability uses a tighter px-3 grid; default matches the
  // inventory/incoming/overstock tables.
  paddingClass?: string;
  // For tables with a stacked two-row header (e.g. sustainability),
  // sortable headers in the first tier need rowSpan={2} to span
  // through the per-shipment sub-header row.
  rowSpan?: number;
  title?: string;
}) {
  const isActive = config.key === sortKey;
  const dir = isActive ? config.direction : null;
  const arrow = dir === "asc" ? "↑" : dir === "desc" ? "↓" : "";

  const handleClick = () => {
    if (isActive) {
      onChange({ key: sortKey, direction: dir === "asc" ? "desc" : "asc" });
    } else {
      onChange({ key: sortKey, direction: align === "right" ? "desc" : "asc" });
    }
  };

  const alignCls = align === "right" ? "text-right" : "text-left";
  const flexCls = align === "right" ? "justify-end" : "justify-start";

  return (
    <th rowSpan={rowSpan} className={`${paddingClass} font-medium ${alignCls} ${className}`}>
      <button
        type="button"
        onClick={handleClick}
        title={title}
        className={`inline-flex w-full items-center gap-1 uppercase tracking-wide transition-colors hover:text-neutral-900 ${flexCls} ${isActive ? "text-neutral-900" : ""}`}
      >
        <span>{label}</span>
        <span aria-hidden className="w-2 text-[10px] tabular-nums text-neutral-500">{arrow}</span>
      </button>
    </th>
  );
}
