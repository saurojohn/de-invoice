"use client"

interface RevenueChartProps {
  // Each entry: { month: "2026-01", totalAmount: 1234.56 }
  // or with expenses: { month, revenue, expenses }
  // (the new dashboard endpoint returns the latter).
  data: Array<{ month: string; totalAmount?: number; revenue?: number; expenses?: number; invoiceCount?: number }>
  height?: number
  /** Label for the y-axis (currency). Defaults to "EUR". */
  currency?: string
}

/**
 * Lightweight inline-SVG bar chart — no external chart library.
 * Shows monthly revenue (and optionally expenses as a
 * contrasting color) with axis labels and a hover tooltip.
 *
 * Visual design:
 *   - Revenue bars in blue, expense bars in red,
 *     side-by-side per month (grouped bar)
 *   - Max value (across both series) determines y-scale
 *     (with 5% headroom)
 *   - Inactive months (count = 0) are dimmed
 *   - Fallback to old single-series shape (totalAmount
 *     only) for the legacy /reports/sales endpoint
 */
export function RevenueChart({ data, height = 200, currency = "EUR" }: RevenueChartProps) {
  if (!data || data.length === 0) {
    return (
      <div className="flex items-center justify-center text-gray-400 text-sm" style={{ height }}>
        Keine Daten verfügbar
      </div>
    )
  }

  // Normalize to a unified { revenue, expenses } shape.
  // The old endpoint returns totalAmount; the new
  // dashboard endpoint returns revenue + expenses.
  const rows = data.map((d) => ({
    month: d.month,
    revenue: d.revenue ?? d.totalAmount ?? 0,
    expenses: d.expenses ?? 0,
  }))
  const max = Math.max(...rows.flatMap((r) => [r.revenue, r.expenses]), 1)
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((p) => max * p)
  const chartHeight = height - 30
  const chartTop = 10
  const hasExpenses = rows.some((r) => r.expenses > 0)

  const formatMonth = (m: string) => {
    const [year, month] = m.split("-")
    const monthNames = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"]
    return `${monthNames[parseInt(month, 10) - 1]} ${year.slice(2)}`
  }

  const formatCurrency = (n: number) =>
    new Intl.NumberFormat("de-DE", { style: "currency", currency, maximumFractionDigits: 0 }).format(n)

  const barWidthPct = hasExpenses ? 28 : 60

  return (
    <div className="w-full" style={{ height }}>
      {hasExpenses && (
        // Legend — only show when there are actually
        // expenses to draw. Saves vertical space and
        // avoids confusion for sales-only companies.
        <div className="flex gap-4 text-xs text-gray-600 mb-2">
          <div className="flex items-center gap-1">
            <div className="w-3 h-3 bg-blue-500 rounded-sm" />
            <span>Umsatz</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-3 h-3 bg-red-400 rounded-sm" />
            <span>Aufwand</span>
          </div>
        </div>
      )}
      <svg
        viewBox={`0 0 100 100`}
        preserveAspectRatio="none"
        className="w-full"
        style={{ height: chartHeight }}
      >
        {/* Horizontal grid lines + y-axis labels */}
        {ticks.map((tick, i) => {
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
              >
                {formatCurrency(tick)}
              </text>
            </g>
          )
        })}

        {/* Bars: revenue (blue) + optional expense (red) */}
        {rows.map((d, i) => {
          const colWidth = 100 / rows.length
          const barW = colWidth * (barWidthPct / 100)
          const xCenter = colWidth * i + colWidth / 2
          const xRevenue = hasExpenses
            ? xCenter - barW - 0.5
            : xCenter - barW / 2
          const xExpense = xCenter + 0.5
          const barHRev = (d.revenue / max) * chartHeight
          const barHExp = (d.expenses / max) * chartHeight
          const yRev = chartTop + chartHeight - barHRev
          const yExp = chartTop + chartHeight - barHExp
          const isEmpty = d.revenue === 0 && d.expenses === 0
          return (
            <g key={d.month}>
              <rect
                x={`${xRevenue}%`}
                y={`${(yRev / height) * 100}%`}
                width={`${barW}%`}
                height={`${(barHRev / height) * 100}%`}
                fill="#3b82f6"
                opacity={isEmpty ? 0.4 : 0.95}
                rx="0.5"
              >
                <title>
                  {formatMonth(d.month)}: Umsatz {formatCurrency(d.revenue)}
                  {hasExpenses
                    ? `, Aufwand ${formatCurrency(d.expenses)}`
                    : ""}
                </title>
              </rect>
              {hasExpenses && d.expenses > 0 && (
                <rect
                  x={`${xExpense}%`}
                  y={`${(yExp / height) * 100}%`}
                  width={`${barW}%`}
                  height={`${(barHExp / height) * 100}%`}
                  fill="#f87171"
                  opacity={0.9}
                  rx="0.5"
                >
                  <title>
                    {formatMonth(d.month)}: Aufwand {formatCurrency(d.expenses)}
                  </title>
                </rect>
              )}
            </g>
          )
        })}
      </svg>

      <div className="flex justify-between text-[10px] text-gray-500 mt-1 px-1">
        {rows.map((d) => (
          <div key={d.month} className="flex-1 text-center">
            {formatMonth(d.month)}
          </div>
        ))}
      </div>
    </div>
  )
}
