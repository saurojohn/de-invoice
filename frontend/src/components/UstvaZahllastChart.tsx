"use client"
import { L } from "@/components/useI18n"

interface UstvaZahllastChartProps {
  // Each entry: { periodLabel: "2026-08", zahllast: 57.00 }
  // Sorted by the caller (the dashboard passes
  // ASC so the chart reads left=oldest, right=
  // newest — the natural trend reading order).
  // The chart auto-handles negative values (a
  // refund flips the bar below the 0 line).
  data: Array<{ periodLabel: string; zahllast: number }>
  height?: number
  /** Locale for the month-name label. Defaults to de-DE. */
  locale?: string
}

/**
 * Tier 162: Diverging bar chart for the 12-month
 * UStVorauszahlung trend on the dashboard.
 *
 * Why diverging: UStVA-Zahllast can be positive
 * (Vorauszahlung ans Finanzamt = "we owe them")
 * OR negative (Erstattung = "they owe us"). A
 * regular bar chart hides the sign — a refund
 * looks like a small positive bar. The diverging
 * layout puts the 0 line in the middle and bars
 * extend up (red, payable) or down (green,
 * refund).
 *
 * Visual design:
 *   - Red bars above 0 = Vorauszahlung
 *   - Green bars below 0 = Erstattung
 *   - Muted bars at 0 = month with no VAT movement
 *   - Y-axis shows absolute EUR value
 *   - Hover tooltip shows the exact figure
 *   - YTD sum displayed at the top right
 *     (Σ of all 12 months)
 *
 * Why inline SVG (same as RevenueChart / CashflowChart):
 *   - No external chart lib (Recharts adds ~150KB)
 *   - Tailwind classes for axis labels don't work
 *     inside SVG, so a few inline styles
 *   - Diverging layout is just two y-ranges
 *     stitched at the 0 line — trivial in SVG
 */
export function UstvaZahllastChart({ data, height = 200, locale = "de-DE" }: UstvaZahllastChartProps) {
  if (!data || data.length === 0) {
    return (
      <div className="flex items-center justify-center text-gray-400 text-sm" style={{ height }}>
        {L("Keine Daten verfügbar")}
      </div>
    )
  }

  // Normalize: ensure chronological (ASC) order
  // so the chart reads left=oldest, right=newest.
  // The backend returns DESC; the caller is
  // expected to reverse. Defensive sort here in
  // case the caller forgets.
  const rows = [...data].sort((a, b) => a.periodLabel.localeCompare(b.periodLabel))

  // YTD sum (all 12 months)
  const ytd = rows.reduce((sum, r) => sum + r.zahllast, 0)

  // Max abs value for symmetric y-axis
  const maxAbs = Math.max(...rows.map((r) => Math.abs(r.zahllast)), 1)
  const ticks = [-1, -0.5, 0, 0.5, 1].map((p) => maxAbs * p)
  const chartHeight = height - 30
  const chartTop = 10
  // 0-line in the middle
  const zeroY = chartTop + (chartHeight / 2)

  const formatMonth = (label: string) => {
    const [year, month] = label.split("-")
    const d = new Date(parseInt(year, 10), parseInt(month, 10) - 1, 1)
    return d.toLocaleDateString(locale, { month: "short", year: "2-digit" })
  }

  const formatCurrency = (n: number) =>
    new Intl.NumberFormat(locale, { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(n)

  return (
    <div className="w-full" style={{ height }}>
      {/* Legend */}
      <div className="flex gap-4 text-xs text-gray-600 mb-2">
        <div className="flex items-center gap-1">
          <div className="w-3 h-3 bg-red-500 rounded-sm" />
          <span>Vorauszahlung</span>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-3 h-3 bg-emerald-500 rounded-sm" />
          <span>Erstattung</span>
        </div>
        <div className="ml-auto font-mono font-semibold text-gray-700 dark:text-gray-300">
          Σ YTD:{" "}
          <span
            className={
              ytd === 0
                ? "text-gray-500"
                : ytd > 0
                  ? "text-red-600"
                  : "text-emerald-600"
            }
            data-testid="ustva-trend-ytd"
          >
            {formatCurrency(ytd)}
          </span>
        </div>
      </div>

      {/* Tier 710: the axis labels in HTML over the chart — SVG text in a viewBox
          stretched with preserveAspectRatio="none" was squashed to a grey line */}
      <div className="relative w-full" style={{ height: chartHeight }}>
        {ticks.map((tick, i) => (
          <div
            key={i}
            className="absolute left-0 -translate-y-1/2 text-[10px] leading-none text-gray-500 dark:text-gray-400 bg-white/70 dark:bg-gray-900/70 pr-1"
            style={{ top: `${((zeroY - (tick / maxAbs) * (chartHeight / 2)) / height) * 100}%` }}
            data-testid="ustva-trend-tick"
          >
            {formatCurrency(tick)}
          </div>
        ))}
      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        className="w-full"
        style={{ height: chartHeight }}
      >
        {/* Horizontal grid lines */}
        {ticks.map((tick, i) => {
          // tick is in [-maxAbs, +maxAbs]
          // y = zeroY - (tick / maxAbs) * (chartHeight/2)
          // Tier 710: in percent of the height, as the bars are — it was the
          // pixel value read as a percentage (the zero line at 105 %, below the
          // chart, and a refund month's bar drawn under a line that wasn't there)
          const yPct = ((zeroY - (tick / maxAbs) * (chartHeight / 2)) / height) * 100
          const isZero = Math.abs(tick) < 0.01
          return (
            <g key={i}>
              <line
                x1="0"
                x2="100"
                y1={`${yPct}%`}
                y2={`${yPct}%`}
                stroke={isZero ? "#9ca3af" : "#e5e7eb"}
                strokeWidth={isZero ? "0.3" : "0.2"}
                strokeDasharray={isZero ? "" : "0.5,0.5"}
              />
            </g>
          )
        })}

        {/* Bars */}
        {rows.map((d, i) => {
          const colWidth = 100 / rows.length
          const barW = colWidth * 0.6
          const xCenter = colWidth * i + colWidth / 2
          const xBar = xCenter - barW / 2
          const barH = (Math.abs(d.zahllast) / maxAbs) * (chartHeight / 2)
          // positive bars go UP from zeroY, negative
          // bars go DOWN from zeroY
          const yBar = d.zahllast >= 0 ? zeroY - barH : zeroY
          const fill = d.zahllast === 0 ? "#d1d5db" : d.zahllast > 0 ? "#ef4444" : "#10b981"
          return (
            <rect
              key={d.periodLabel}
              x={`${xBar}%`}
              y={`${(yBar / height) * 100}%`}
              width={`${barW}%`}
              height={`${(barH / height) * 100}%`}
              fill={fill}
              opacity={d.zahllast === 0 ? 0.5 : 0.92}
              rx="0.5"
              data-testid={`ustva-trend-bar-${d.periodLabel}`}
              data-zahllast={d.zahllast}
            >
              <title>
                {formatMonth(d.periodLabel)}: {formatCurrency(d.zahllast)}
              </title>
            </rect>
          )
        })}
      </svg>
      </div>

      <div className="flex justify-between text-[10px] text-gray-500 mt-1 px-1">
        {rows.map((d) => (
          <div key={d.periodLabel} className="flex-1 text-center">
            {formatMonth(d.periodLabel)}
          </div>
        ))}
      </div>
    </div>
  )
}
