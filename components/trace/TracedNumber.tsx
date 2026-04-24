"use client";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { clsx } from "clsx";
import type { NumberTrace } from "@/lib/queries/inventory";

/**
 * Wraps a displayed number with a click-to-inspect popover. Spec §3.1 and §8.2
 * require every number on the dashboard to be traceable back to source. This
 * is the shared primitive that enforces that — consumers pass a formatted
 * display string plus a NumberTrace payload.
 *
 * Accessibility: the trigger is a real <button>, so it is keyboard-focusable
 * and operable with Enter/Space. Escape and outside-click dismiss the popover.
 */
export function TracedNumber({
  children,
  trace,
  align = "right",
  className,
}: {
  children: ReactNode;
  trace: NumberTrace | null | undefined;
  align?: "left" | "right";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const popoverId = useId();

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!trace) {
    return <span className={className}>{children}</span>;
  }

  return (
    <span ref={wrapRef} className={clsx("relative inline-block", className)}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        aria-label="Show source for this number"
        onClick={() => setOpen((v) => !v)}
        className={clsx(
          "tabular-nums underline decoration-dotted decoration-neutral-400 underline-offset-2",
          "hover:decoration-neutral-900 focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-900",
          "cursor-help"
        )}
      >
        {children}
      </button>
      {open && (
        <div
          id={popoverId}
          role="dialog"
          aria-label={trace.label}
          className={clsx(
            "absolute z-40 mt-1 w-80 rounded-md border border-neutral-200 bg-white p-3 text-left shadow-lg",
            align === "right" ? "right-0" : "left-0"
          )}
        >
          <div className="mb-1 text-xs font-semibold text-neutral-900">{trace.label}</div>
          {trace.formula && (
            <div className="mb-2 text-xs text-neutral-600">
              <span className="font-medium text-neutral-500">Formula:</span> {trace.formula}
            </div>
          )}
          {trace.inputs && trace.inputs.length > 0 && (
            <dl className="mb-2 space-y-0.5 text-xs">
              {trace.inputs.map((inp) => (
                <div key={inp.label} className="flex justify-between gap-2">
                  <dt className="text-neutral-500">{inp.label}</dt>
                  <dd className="font-mono text-neutral-900">{inp.value}</dd>
                </div>
              ))}
            </dl>
          )}
          {trace.sources.length > 0 && (
            <div className="border-t border-neutral-100 pt-2">
              <div className="mb-1 text-xs font-medium text-neutral-500">Source</div>
              <dl className="space-y-0.5 text-xs">
                {trace.sources.map((s, i) => (
                  <div key={`${s.label}-${i}`} className="flex justify-between gap-2">
                    <dt className="text-neutral-500">{s.label}</dt>
                    <dd className="font-mono text-neutral-700">{s.ref}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
          {trace.note && (
            <div className="mt-2 rounded border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-800">
              {trace.note}
            </div>
          )}
        </div>
      )}
    </span>
  );
}
