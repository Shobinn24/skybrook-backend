"use client";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
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
 *
 * The popover renders via a portal to document.body using fixed positioning.
 * That sidesteps clipping inside scrollable ancestors — the inventory table
 * and sustainability table both wrap their content in overflow-x-auto, which
 * computes overflow-y to `auto` per CSS spec, clipping any normally-positioned
 * popover.
 */
type PopoverPos = { top: number; left: number; right: number };

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
  const [pos, setPos] = useState<PopoverPos | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const popoverId = useId();

  // Compute portal position from the button's bounding rect on open
  // (and whenever it might change while open — scroll, resize). The
  // popover anchors below the trigger, edge-aligned per `align`.
  useEffect(() => {
    if (!open) return;
    const compute = () => {
      const btn = buttonRef.current;
      if (!btn) return;
      const rect = btn.getBoundingClientRect();
      setPos({
        top: rect.bottom + 4,
        left: rect.left,
        right: window.innerWidth - rect.right,
      });
    };
    compute();
    window.addEventListener("scroll", compute, true);
    window.addEventListener("resize", compute);
    return () => {
      window.removeEventListener("scroll", compute, true);
      window.removeEventListener("resize", compute);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      const t = e.target as Node;
      const inButton = buttonRef.current?.contains(t);
      const inPopover = popoverRef.current?.contains(t);
      if (!inButton && !inPopover) setOpen(false);
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

  // Portal target — guarded so SSR doesn't blow up.
  const portalRoot = typeof document === "undefined" ? null : document.body;

  return (
    <span className={clsx("inline-block", className)}>
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        aria-label="Show source for this number"
        onClick={() => setOpen((v) => !v)}
        className={clsx(
          "tabular-nums underline decoration-dotted decoration-neutral-400 underline-offset-2",
          "hover:decoration-neutral-900 focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-900",
          "cursor-help",
        )}
      >
        {children}
      </button>
      {open && pos && portalRoot &&
        createPortal(
          <div
            ref={popoverRef}
            id={popoverId}
            role="dialog"
            aria-label={trace.label}
            // Fixed positioning + portal escapes any scrollable ancestor's
            // clipping. `align` controls which edge anchors to the trigger:
            // right-anchored is the default for right-aligned numeric cells
            // so the popover stays within the column.
            style={
              align === "right"
                ? { position: "fixed", top: pos.top, right: pos.right }
                : { position: "fixed", top: pos.top, left: pos.left }
            }
            className="z-50 w-80 rounded-md border border-neutral-200 bg-white p-3 text-left shadow-lg"
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
          </div>,
          portalRoot,
        )}
    </span>
  );
}
