"use client"

interface RevenueChartProps {
  // Each entry: { month: "2026-01", totalAmount: 1234.56 }
  data: Array<{ month: string; totalAmount: number; invoiceCount?: number }>
  height?: number
  /** Label for the y-axis (currency). Defaults to "EUR". */
  currency?: string
}

/**
 * Lightweight inline-SVG bar chart — no external chart library.
 * Shows monthly revenue with axis labels and a hover tooltip.
 *
 * Visual design:
 *   - Bars are 60% of the column width, centered
 *   - Max value determines y-scale (with 5% headroom)
 *   - Inactive months (count = 0) are dimmed
 */
export function RevenueChart({ data, height = 200, currency = "EUR" }: RevenueChartProps) {
  if (!data || data.length === 0) {
    return (
      <div className="flex items-center justify-center text-gray-400 text-sm" style={{ height }}>
        Keine Daten verfügbar
      </div>
    )
  }

  const max = Math.max(...data.map((d) => d.totalAmount), 1)
  // Y-axis: 4 ticks at 0/25/50/75/100%
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((p) => max * p)
  const chartHeight = height - 30 // leave room for x-labels
  const chartTop = 10

  const formatMonth = (m: string) => {
    // "2026-01" → "Jan 26"
    const [year, month] = m.split("-")
    const monthNames = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"]
    return `${monthNames[parseInt(month, 10) - 1]} ${year.slice(2)}`
  }

  const formatCurrency = (n: number) =>
    new Intl.NumberFormat("de-DE", { style: "currency", currency, maximumFractionDigits: 0 }).format(n)

  const barWidthPct = 60 // % of column width

  return (
    <div className="w-full" style={{ height }}>
      <svg
        viewBox={`0 0 100 100`}
        preserveAspectRatio="none"
        className="w-full"
        style={{ height: chartHeight }}
      >
        {/* Horizontal grid lines + y-axis labels */}
        {ticks.map((tick, i) => {
          const y = chartTop + (chartHeight - (tick / max) * chartHeight) * (chartHeight / chartHeight)
          // Simpler: use percentage of chartHeight
          const yPct = chartTop + ((1 - tick / max) * chartHeight) / height * 100
          return (
            <g key={i}>
              <line
                x1="0"
                x2="100"
                y1={`${yPct}%`}
                y2={`${yPct}%`}
                stroke="#e5e7eb"
                strokeWidth="0.2"
                strokeDasharray="0.5,0.5"
              />
              <text
                x="0"
                y={`${yPct}%`}
                fontSize="2.5"
                fill="#6b7280"
                dominantBaseline="middle"
                transform="translate(0, 0)"
              >
                {formatCurrency(tick)}
              </text>
            </g>
          )
        })}

        {/* Bars */}
        {data.map((d, i) => {
          const colWidth = 100 / data.length
          const barW = colWidth * (barWidthPct / 100)
          const x = colWidth * i + (colWidth - barW) / 2
          const barH = (d.totalAmount / max) * chartHeight
          const y = chartTop + chartHeight - barH
          const isEmpty = d.invoiceCount === 0
          return (
            <g key={d.month}>
              <rect
                x={`${x}%`}
                y={`${(y / height) * 100}%`}
                width={`${barW}%`}
                height={`${(barH / height) * 100}%`}
                fill={isEmpty ? "#e5e7eb" : "#3b82f6"}
                opacity={isEmpty ? 0.5 : 1}
                rx="0.5"
              >
                <title>
                  {formatMonth(d.month)}: {formatCurrency(d.totalAmount)} ({d.invoiceCount || 0} Rechnungen)
                </title>
              </rect>
            </g>
          )
        })}
      </svg>

      {/* X-axis labels */}
      <div className="flex justify-between text-[10px] text-gray-500 mt-1 px-1">
        {data.map((d) => (
          <div key={d.month} className="flex-1 text-center">
            {formatMonth(d.month)}
          </div>
        ))}
      </div>
    </div>
  )
}
