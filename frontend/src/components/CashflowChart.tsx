"use client"

interface CashflowChartProps {
  data: Array<{
    month: string
    label: string
    net: number
    cumulative: number
    isDry: boolean
  }>
  height?: number
  currency?: string
}

/**
 * Lightweight inline-SVG bar chart for the cash flow
 * forecast. Shows monthly NET (incoming − outgoing) as
 * bars (positive green / negative red) and the
 * cumulative balance as a thin line over the bars.
 *
 * Why inline SVG: matches the RevenueChart pattern
 * (no external chart library, easy to drop on a
 * dashboard, easy to add data-testid attributes
 * for Playwright).
 *
 * Cumulative line uses stroke-dasharray so it
 * reads as a "balance trend" not a value bar.
 */
export function CashflowChart({ data, height = 220, currency = "EUR" }: CashflowChartProps) {
  if (!data || data.length === 0) {
    return (
      <div className="flex items-center justify-center text-gray-400 text-sm" style={{ height }}>
        Keine Daten
      </div>
    )
  }
  const maxAbsNet = Math.max(...data.map((d) => Math.abs(d.net)), 1)
  const maxCum = Math.max(...data.map((d) => d.cumulative), 1)
  const minCum = Math.min(...data.map((d) => d.cumulative), 0)
  const cumRange = maxCum - minCum || 1
  const chartHeight = height - 50
  const chartTop = 20
  const barWidth = 100 / data.length
  const innerBarW = Math.max(8, Math.min(36, barWidth * 0.6))
  const zeroY = chartTop + (chartHeight / 2)

  const fmt = (n: number) =>
    new Intl.NumberFormat("de-DE", { style: "currency", currency, maximumFractionDigits: 0 }).format(n)

  return (
    <svg
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      style={{ width: "100%", height }}
      className="overflow-visible"
      data-testid="cashflow-chart"
    >
      {/* Zero line */}
      <line
        x1={0}
        y1={zeroY}
        x2={100}
        y2={zeroY}
        stroke="#9ca3af"
        strokeWidth={0.3}
        strokeDasharray="0.5 0.5"
      />
      {/* Bars: positive up, negative down */}
      {data.map((d, i) => {
        const h = (Math.abs(d.net) / maxAbsNet) * (chartHeight / 2)
        const x = i * barWidth + (barWidth - innerBarW) / 2
        const y = d.net >= 0 ? zeroY - h : zeroY
        return (
          <rect
            key={d.month}
            x={x}
            y={y}
            width={innerBarW}
            height={h}
            fill={d.net >= 0 ? "#10b981" : "#ef4444"}
            opacity={d.isDry ? 0.7 : 1}
            data-testid={`cashflow-bar-${d.month}`}
          />
        )
      })}
      {/* Cumulative line: scaled to its own range
          (cumulative uses a different scale than net
          because cumulative can be 10× larger). The
          line's position tells the trend story; the
          exact value is in the table below. */}
      <polyline
        fill="none"
        stroke="#2563eb"
        strokeWidth={0.6}
        strokeDasharray="1.5 1.5"
        points={data
          .map((d, i) => {
            const x = i * barWidth + barWidth / 2
            // Map cumulative from [minCum, maxCum] to
            // [chartTop+chartHeight, chartTop] (top of
            // chart = highest cumulative).
            const y =
              chartTop + chartHeight - ((d.cumulative - minCum) / cumRange) * chartHeight
            return `${x},${y}`
          })
          .join(" ")}
        data-testid="cashflow-cumulative-line"
      />
      {/* Month labels (rotated for compactness) */}
      {data.map((d, i) => {
        const x = i * barWidth + barWidth / 2
        return (
          <text
            key={`lbl-${d.month}`}
            x={x}
            y={99}
            fontSize={3}
            textAnchor="middle"
            fill="#6b7280"
          >
            {d.label.split(" ")[0].slice(0, 3)}
          </text>
        )
      })}
    </svg>
  )
}
