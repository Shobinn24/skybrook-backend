"use client";

type DailyRow = { date: string; us: number; intl: number; total: number };

const BAR_W = 14;
const GAP = 4;
const CHART_H = 120;
const X_LABEL_H = 16;

const US_COLOR = "rgb(64 64 64)"; // neutral-700
const INTL_COLOR = "rgb(96 165 250)"; // blue-400

/**
 * Stacked-bar SVG chart for the SKU detail page. One bar per day in the
 * trailing 30-day window — US units (bottom, dark) plus INTL units
 * (top, blue). Native SVG `<title>` element provides the per-day
 * tooltip on hover; no JS state, no chart library.
 *
 * Bars scale to the chart's max daily total so a single high-volume
 * day doesn't flatten the rest. When every day is zero (rare — a SKU
 * that has stock but no recent sales) the chart still renders an
 * empty grid so the layout doesn't shift.
 */
export function DailySalesChart({ data }: { data: DailyRow[] }) {
  if (data.length === 0) return null;
  const max = Math.max(1, ...data.map((d) => d.total));
  const w = data.length * (BAR_W + GAP);
  const total = data.reduce((n, d) => n + d.total, 0);
  const peak = data.reduce<DailyRow | null>(
    (acc, d) => (acc === null || d.total > acc.total ? d : acc),
    null,
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-3 text-xs text-neutral-600">
        <div className="flex items-center gap-3">
          <LegendSwatch color={US_COLOR} label="US" />
          <LegendSwatch color={INTL_COLOR} label="INTL" />
        </div>
        <div className="tabular-nums">
          {total.toLocaleString()} units over 30 days
          {peak && peak.total > 0 && (
            <>
              {" · peak "}
              <span className="font-medium text-neutral-800">{peak.total.toLocaleString()}</span>
              {" on "}
              <span className="text-neutral-700">{peak.date}</span>
            </>
          )}
        </div>
      </div>

      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${w} ${CHART_H + X_LABEL_H}`}
          preserveAspectRatio="none"
          className="block h-32 w-full min-w-[480px]"
          role="img"
          aria-label="Daily sales over the last 30 days, stacked by Shopify channel"
        >
          {/* Y-axis gridlines at 25 / 50 / 75 / 100 % of max */}
          {[0.25, 0.5, 0.75, 1].map((p) => (
            <line
              key={p}
              x1={0}
              x2={w}
              y1={CHART_H - CHART_H * p}
              y2={CHART_H - CHART_H * p}
              stroke="currentColor"
              strokeOpacity={0.08}
            />
          ))}

          {data.map((d, i) => {
            const x = i * (BAR_W + GAP);
            const usH = (d.us / max) * CHART_H;
            const intlH = (d.intl / max) * CHART_H;
            return (
              <g key={d.date}>
                {/* Native browser tooltip via SVG <title> — no JS state. */}
                <title>{`${d.date}: ${d.total} units (US ${d.us}, INTL ${d.intl})`}</title>
                {/* Invisible full-height hit-area so hovering anywhere
                    in the column triggers the tooltip, not just on the
                    short bars of low-sales days. */}
                <rect
                  x={x}
                  y={0}
                  width={BAR_W}
                  height={CHART_H}
                  fill="transparent"
                />
                {usH > 0 && (
                  <rect
                    x={x}
                    y={CHART_H - usH}
                    width={BAR_W}
                    height={usH}
                    fill={US_COLOR}
                  />
                )}
                {intlH > 0 && (
                  <rect
                    x={x}
                    y={CHART_H - usH - intlH}
                    width={BAR_W}
                    height={intlH}
                    fill={INTL_COLOR}
                  />
                )}
              </g>
            );
          })}

          {/* X-axis date labels every 7 days — month/day only, since
              every label is in the same year. */}
          {data.map((d, i) =>
            i % 7 === 0 ? (
              <text
                key={`l-${d.date}`}
                x={i * (BAR_W + GAP) + BAR_W / 2}
                y={CHART_H + X_LABEL_H - 4}
                textAnchor="middle"
                fontSize={9}
                fill="currentColor"
                opacity={0.6}
              >
                {d.date.slice(5)}
              </text>
            ) : null,
          )}
        </svg>
      </div>
    </div>
  );
}

function LegendSwatch({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        aria-hidden
        className="inline-block h-2.5 w-2.5 rounded-sm"
        style={{ backgroundColor: color }}
      />
      <span>{label}</span>
    </span>
  );
}
