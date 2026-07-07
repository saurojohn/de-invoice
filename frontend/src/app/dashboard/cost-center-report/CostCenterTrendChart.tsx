"use client"

// Tier 47: CostCenterTrendChart — 12-month line chart
// for the cost-center report.
//
// Renders one polyline per cost-center showing the net
// amount (revenue − expense) per month across the
// selected year. The yearly report endpoint already
// returns `rows[].monthly: number[12]` — we just plot
// them.
//
// Visual conventions:
//   - X axis: 12 month labels (i18n monthShort)
//   - Y axis: net (EUR). Auto-scales to the largest
//     absolute value across all visible series.
//   - One polyline per cost-center. Colour from the
//     same COST_CENTER_PALETTE as the dashboard-v2
//     pie so the cost-center identity is stable across
//     pages.
//   - Zero-line drawn across the middle so positive
//     and negative months are easy to tell apart.
//   - Hovering a data point shows a tooltip with the
//     cost-center name, month label, and signed EUR
//     amount.
//
// This is a pure-function component — same pattern as
// CostCenterPie from dashboard-v2. No state, no
// effects; React reconciliation handles re-renders on
// report changes.

import { useState } from "react"
import { useI18n } from "@/components/useI18n"

interface TrendRow {
  costCenter: string
  monthly: number[] // length 12, idx 0 = Jan, ..., 11 = Dec
}

// Same palette as the dashboard-v2 pie chart so a
// cost-center that reads "blue" in the pie chart also
// reads "blue" in the trend chart. Stable cross-page
// identity.
const PALETTE = [
  "#2563eb", // blue-600
  "#059669", // emerald-600
  "#d97706", // amber-600
  "#7c3aed", // violet-600
  "#dc2626", // red-600
  "#0891b2", // cyan-600
  "#db2777", // pink-600
  "#65a30d", // lime-600
  "#9333ea", // purple-600
  "#ea580c", // orange-600
]

// Number formatter — German locale, no currency symbol
// (we render the symbol once in the axis label).
const fmt = (n: number): string =>
  new Intl.NumberFormat("de-DE", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(n)

const eur = (n: number): string =>
  new Intl.NumberFormat("de-DE", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 0,
  }).format(n)

const signedEur = (n: number): string => {
  if (n === 0) return eur(0)
  return `${n > 0 ? "+" : "−"}${eur(Math.abs(n))}`
}

interface Props {
  rows: TrendRow[]
  year: number
}

export default function CostCenterTrendChart({ rows, year }: Props) {
  const { t } = useI18n()
  const [hover, setHover] = useState<{
    costCenter: string
    monthIdx: number
    amount: number
    x: number
    y: number
  } | null>(null)

  // Chart geometry. Keep this small — it's a horizontal
  // strip with a legend below.
  const W = 720
  const H = 240
  const PAD_LEFT = 56
  const PAD_RIGHT = 12
  const PAD_TOP = 18
  const PAD_BOTTOM = 36
  const plotW = W - PAD_LEFT - PAD_RIGHT
  const plotH = H - PAD_TOP - PAD_BOTTOM

  if (!rows || rows.length === 0) {
    return (
      <div className="text-sm text-gray-400 dark:text-gray-500 py-12 text-center">
        {t("costCenterReport.trendEmpty")}
      </div>
    )
  }

  // X axis: 12 evenly-spaced month positions.
  const monthXs = Array.from({ length: 12 }, (_, i) =>
    PAD_LEFT + (plotW * i) / 11,
  )

  // Y axis: auto-scale. Use max |value| across all
  // series, with a small floor of 1 so a year of all
  // zeros still renders a flat line at zero.
  const maxAbs = Math.max(
    1,
    ...rows.flatMap((r) => r.monthly.map((v) => Math.abs(v))),
  )
  // Round up to a "nice" number for the axis ticks
  // (100, 200, 500, 1000, ...). We use the next
  // magnitude step up so the chart never touches the
  // top edge — leaves 5% headroom.
  const niceMax = niceCeil(maxAbs * 1.05)

  const yFor = (v: number): number => {
    const ratio = v / niceMax
    return PAD_TOP + plotH / 2 - ratio * (plotH / 2)
  }
  const zeroY = yFor(0)

  // Build a polyline string per row.
  const polylines = rows.map((r, idx) => {
    const points = r.monthly
      .map((v, i) => `${monthXs[i]},${yFor(v)}`)
      .join(" ")
    return {
      costCenter: r.costCenter,
      points,
      color: PALETTE[idx % PALETTE.length],
    }
  })

  // Y axis ticks — 5 lines evenly spaced.
  const yTicks = [-1, -0.5, 0, 0.5, 1].map((f) => ({
    f,
    value: f * niceMax,
    y: yFor(f * niceMax),
  }))

  const monthShort = (() => {
    const arr = (t("costCenterReport.monthShort") as unknown) as string[]
    if (Array.isArray(arr) && arr.length === 12) return arr
    return ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"]
  })()

  return (
    <div className="space-y-3" data-testid="cc-trend">
      <div className="text-sm font-medium text-gray-700 dark:text-gray-200">
        {t("costCenterReport.trendTitle").replace("{year}", String(year))}
      </div>
      <div className="relative">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          width="100%"
          height={H}
          role="img"
          aria-label={`Cost-center trend chart for ${year}`}
          className="bg-white dark:bg-gray-800 rounded"
          data-testid="cc-trend-svg"
        >
          {/* Horizontal gridlines + Y axis tick labels */}
          {yTicks.map((tk) => (
            <g key={tk.f}>
              <line
                x1={PAD_LEFT}
                x2={PAD_LEFT + plotW}
                y1={tk.y}
                y2={tk.y}
                stroke="currentColor"
                strokeOpacity={tk.f === 0 ? 0.4 : 0.1}
                strokeWidth={tk.f === 0 ? 1 : 1}
                strokeDasharray={tk.f === 0 ? "" : "2 2"}
                className="text-gray-400 dark:text-gray-600"
              />
              <text
                x={PAD_LEFT - 6}
                y={tk.y + 4}
                fontSize="10"
                textAnchor="end"
                className="fill-gray-500 dark:fill-gray-400 font-mono"
              >
                {fmt(tk.value)}
              </text>
            </g>
          ))}

          {/* Zero-line emphasis (already drawn above but
              this one is on top so the dark/light
              contrast holds) */}
          <line
            x1={PAD_LEFT}
            x2={PAD_LEFT + plotW}
            y1={zeroY}
            y2={zeroY}
            stroke="currentColor"
            strokeOpacity={0.45}
            strokeWidth={1}
            className="text-gray-500 dark:text-gray-400"
          />

          {/* X axis month labels */}
          {monthXs.map((x, i) => (
            <text
              key={i}
              x={x}
              y={H - PAD_BOTTOM + 16}
              fontSize="10"
              textAnchor="middle"
              className="fill-gray-500 dark:fill-gray-400"
            >
              {monthShort[i]}
            </text>
          ))}

          {/* Polylines — one per cost-center. Drawn
              before the data points so the points sit
              on top. */}
          {polylines.map((pl) => (
            <polyline
              key={pl.costCenter}
              points={pl.points}
              fill="none"
              stroke={pl.color}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              data-testid="cc-trend-line"
              data-cost-center={pl.costCenter}
            />
          ))}

          {/* Data points (interactive). Each point is
              a circle + transparent hit area for
              easier hovering. */}
          {rows.map((r, idx) => {
            const color = PALETTE[idx % PALETTE.length]
            return r.monthly.map((v, i) => {
              const cx = monthXs[i]
              const cy = yFor(v)
              return (
                <g key={`${r.costCenter}-${i}`}>
                  {/* Larger hit area */}
                  <circle
                    cx={cx}
                    cy={cy}
                    r={8}
                    fill="transparent"
                    onMouseEnter={() =>
                      setHover({
                        costCenter: r.costCenter,
                        monthIdx: i,
                        amount: v,
                        x: cx,
                        y: cy,
                      })
                    }
                    onMouseLeave={() => setHover(null)}
                    data-testid="cc-trend-dot"
                  />
                  {/* Visible dot */}
                  <circle
                    cx={cx}
                    cy={cy}
                    r={3}
                    fill={color}
                    stroke="white"
                    strokeWidth={1}
                    className="dark:stroke-gray-800"
                    pointerEvents="none"
                  />
                </g>
              )
            })
          })}
        </svg>

        {/* Hover tooltip — absolute positioned over
            the SVG container. Uses simple math
            (the SVG is rendered at full container
            width, so we compute the percent offset). */}
        {hover && (
          <div
            data-testid="cc-trend-tooltip"
            className="absolute pointer-events-none bg-gray-900 text-white text-xs px-2 py-1 rounded shadow-lg"
            style={{
              left: `calc(${(hover.x / W) * 100}% )`,
              top: `${(hover.y / H) * 100}%`,
              transform: "translate(-50%, -120%)",
            }}
          >
            <div className="font-medium">{hover.costCenter}</div>
            <div className="text-gray-300">
              {monthShort[hover.monthIdx]} {year}
            </div>
            <div className="font-mono">{signedEur(hover.amount)}</div>
          </div>
        )}
      </div>

      {/* Legend — small swatches below the chart so
          the user can match colours back to the
          table. */}
      <div
        className="flex flex-wrap gap-x-4 gap-y-1 text-xs"
        data-testid="cc-trend-legend"
      >
        {polylines.map((pl) => (
          <div key={pl.costCenter} className="flex items-center gap-1.5">
            <span
              className="inline-block w-3 h-0.5 rounded-full"
              style={{ backgroundColor: pl.color }}
            />
            <span className="text-gray-700 dark:text-gray-300">
              {pl.costCenter}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

/** Round up to a "nice" magnitude. Used to pick the
 *  Y-axis upper bound so the chart never touches the
 *  top edge. Steps are roughly log-spaced:
 *    [1, 2, 5, 10, 20, 50, 100, 200, 500, ...] × 10^k */
function niceCeil(n: number): number {
  if (n <= 0) return 1
  const exp = Math.floor(Math.log10(n))
  const base = Math.pow(10, exp)
  const m = n / base
  let nice: number
  if (m <= 1) nice = 1
  else if (m <= 2) nice = 2
  else if (m <= 5) nice = 5
  else nice = 10
  return nice * base
}