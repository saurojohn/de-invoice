"use client"

// Tier 36: Dashboard v2 — chart-heavy redesign.
//
// The legacy /dashboard page renders KPI tiles + a
// trend chart + recent invoices all in 3 separate
// round-trips (`/reports/dashboard`, `/reports/sales`,
// `/invoices`). v2 collapses that into ONE call to
// /reports/dashboard-v2 (which bundles KPIs +
// arAging + topCustomers + recentActivity) and adds
// dedicated widgets for each:
//
//   - 4 KPI strip (YTD revenue / expenses / USt /
//     open receivables) — same data as legacy
//   - Revenue-vs-expenses line chart (12 months)
//   - A/R aging donut (5 buckets from arAging.totals)
//   - Top 5 customers bar chart
//   - Recent activity list
//
// The page keeps the legacy page as /dashboard for
// users who prefer the simpler view; /dashboard/v2 is
// reachable from a button in the header.

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import LanguageSwitcher from "@/components/LanguageSwitcher"
import { ThemeToggle } from "@/components/ThemeToggle"
import { useI18n } from "@/components/useI18n"
import { apiGet } from "@/lib/api"

interface MonthlyRow {
  month: string
  revenue: number
  expenses: number
}

interface DashboardKpis {
  ytd: { revenue: number; expenses: number; vorsteuer: number; ust: number; countInvoices: number; countExpenses: number; net: number }
  thisMonth: { revenue: number; expenses: number; ust: number; countInvoices: number }
  lastMonth: { revenue: number; expenses: number; ust: number }
  changes: { revenue: number; expenses: number; ust: number; vorsteuer: number }
  openReceivables: number
  openPayables: number
  byMonth: MonthlyRow[]
  generatedAt?: string
}

interface ArAging {
  current: number
  "1-30": number
  "31-60": number
  "61-90": number
  "90+": number
}

interface TopCustomer {
  customerId: string
  name: string
  customerNumber: string | null
  revenue: number
  invoiceCount: number
}

interface RecentActivity {
  invoiceId: string
  invoiceNumber: string
  total: number
  currency: string
  customerName: string
  customerNumber: string | null
  issueDate: string
  dueDate: string | null
  status: string
}

/**
 * Tier 38: one row per cost center (the user-stamped
 * string from Invoice.costCenter / Expense.costCenter;
 * NULL → "Nicht zugewiesen"). The backend already merges
 * both sides into one bucket per center + sorts by
 * |revenue - expense| desc.
 */
interface CostCenterBucket {
  costCenter: string
  revenue: number
  expense: number
  ust: number   // SUM(invoice.totalVat) YTD
  vorsteuer: number  // SUM(expense.vatAmount) YTD
  invoiceCount: number
  expenseCount: number
}

interface DashboardV2 {
  kpis: DashboardKpis
  arAging: ArAging
  topCustomers: TopCustomer[]
  recentActivity: RecentActivity[]
  costCenterBreakdown: CostCenterBucket[]
  generatedAt: string
}

function fmtMoney(n: number) {
  return new Intl.NumberFormat("de-DE", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n || 0)
}

function fmtPct(p: number) {
  const v = Number(p) || 0
  const sign = v > 0 ? "+" : ""
  return `${sign}${v.toFixed(1)}%`
}

function fmtMonth(m: string) {
  const [year, month] = m.split("-")
  const monthNames = [
    "Jan", "Feb", "Mär", "Apr", "Mai", "Jun",
    "Jul", "Aug", "Sep", "Okt", "Nov", "Dez",
  ]
  return `${monthNames[parseInt(month, 10) - 1]} ${year.slice(2)}`
}

/**
 * Donut chart for the A/R aging buckets. Pure SVG,
 * no chart library — keeps the bundle small. Shows
 * each bucket as a percentage arc + a legend table.
 */
function AgingDonut({ arAging }: { arAging: ArAging }) {
  const buckets = [
    { key: "current", label: "Aktuell (nicht fällig)", color: "#10b981" },
    { key: "1-30", label: "1-30 Tage überfällig", color: "#f59e0b" },
    { key: "31-60", label: "31-60 Tage", color: "#f97316" },
    { key: "61-90", label: "61-90 Tage", color: "#ef4444" },
    { key: "90+", label: "> 90 Tage", color: "#b91c1c" },
  ] as const
  const total = buckets.reduce(
    (s, b) => s + (arAging[b.key as keyof ArAging] || 0),
    0,
  )
  const size = 180
  const r = 70
  const cx = size / 2
  const cy = size / 2
  let accum = 0
  return (
    <div
      className="flex flex-col md:flex-row items-center gap-6"
      data-testid="dashboard-v2-aging-donut"
    >
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size}>
        <circle
          cx={cx}
          cy={cy}
          r={r}
          fill="none"
          stroke="#e5e7eb"
          strokeWidth={20}
        />
        {total > 0 &&
          buckets.map((b) => {
            const v = arAging[b.key as keyof ArAging] || 0
            if (v <= 0) return null
            const fraction = v / total
            const dash = 2 * Math.PI * r * fraction
            const gap = 2 * Math.PI * r - dash
            const offset = -2 * Math.PI * r * (accum / total)
            accum += v
            return (
              <circle
                key={b.key}
                cx={cx}
                cy={cy}
                r={r}
                fill="none"
                stroke={b.color}
                strokeWidth={20}
                strokeDasharray={`${dash} ${gap}`}
                strokeDashoffset={offset}
                transform={`rotate(-90 ${cx} ${cy})`}
              />
            )
          })}
        <text
          x={cx}
          y={cy - 4}
          textAnchor="middle"
          className="fill-gray-700 dark:fill-gray-200"
          fontSize="13"
          fontWeight="600"
        >
          {fmtMoney(total)} €
        </text>
        <text
          x={cx}
          y={cy + 14}
          textAnchor="middle"
          className="fill-gray-400"
          fontSize="11"
        >
          gesamt
        </text>
      </svg>
      <div className="space-y-1 text-sm">
        {buckets.map((b) => {
          const v = arAging[b.key as keyof ArAging] || 0
          const pct = total > 0 ? (v / total) * 100 : 0
          return (
            <div
              key={b.key}
              className="flex items-center gap-2"
              data-testid="dashboard-v2-aging-bucket"
            >
              <span
                className="inline-block w-3 h-3 rounded-sm"
                style={{ backgroundColor: b.color }}
              />
              <span className="flex-1">{b.label}</span>
              <span className="font-mono">{fmtMoney(v)} €</span>
              <span className="text-gray-400 text-xs">{pct.toFixed(0)}%</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/**
 * Horizontal bar chart for top customers. Pure SVG —
 * scales linearly to width. Each bar's width is
 * proportional to its revenue; the largest customer
 * fills ~80% of the available space.
 */
function TopCustomersBar({ customers }: { customers: TopCustomer[] }) {
  const max = Math.max(...customers.map((c) => c.revenue), 1)
  return (
    <div
      className="space-y-3"
      data-testid="dashboard-v2-top-customers"
    >
      {customers.map((c) => {
        const pct = (c.revenue / max) * 100
        return (
          <div
            key={c.customerId}
            className="space-y-1"
            data-testid="dashboard-v2-top-customer-row"
          >
            <div className="flex justify-between text-sm">
              <div className="font-medium truncate max-w-[60%]">
                {c.name}
                {c.customerNumber && (
                  <span className="ml-2 text-xs text-gray-400 font-mono">
                    {c.customerNumber}
                  </span>
                )}
              </div>
              <div className="font-mono text-gray-700 dark:text-gray-300">
                {fmtMoney(c.revenue)} €
              </div>
            </div>
            <div className="h-2 bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden">
              <div
                className="h-full bg-blue-500 rounded-full transition-all"
                style={{ width: `${pct}%` }}
              />
            </div>
            <div className="text-xs text-gray-400">
              {c.invoiceCount} Rechnungen
            </div>
          </div>
        )
      })}
    </div>
  )
}

/**
 * Revenue-vs-expenses dual line chart for the
 * byMonth series. Pure SVG, no deps. Lines drawn as
 * poly-lines (one path each) with subtle area fill.
 */
function RevenueTrendChart({ byMonth }: { byMonth: MonthlyRow[] }) {
  if (!byMonth || byMonth.length === 0) {
    return (
      <div className="text-gray-400 text-sm text-center py-12">
        Keine Daten verfügbar
      </div>
    )
  }
  const W = 720
  const H = 220
  const PAD_L = 50
  const PAD_R = 16
  const PAD_T = 16
  const PAD_B = 32
  const innerW = W - PAD_L - PAD_R
  const innerH = H - PAD_T - PAD_B
  const max = Math.max(
    ...byMonth.flatMap((m) => [m.revenue, m.expenses]),
    1,
  )
  const xStep = innerW / Math.max(byMonth.length - 1, 1)
  const yScale = (v: number) => PAD_T + innerH - (v / max) * innerH

  const pts = (k: "revenue" | "expenses") =>
    byMonth
      .map(
        (m, i) =>
          `${PAD_L + i * xStep},${yScale(m[k] || 0)}`,
      )
      .join(" ")

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((p) => ({
    y: yScale(max * p),
    label: fmtMoney(max * p),
  }))

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="w-full h-auto"
      preserveAspectRatio="xMidYMid meet"
      data-testid="dashboard-v2-revenue-chart"
    >
      {/* gridlines + y-axis labels */}
      {ticks.map((t, i) => (
        <g key={`tick-${i}`}>
          <line
            x1={PAD_L}
            x2={W - PAD_R}
            y1={t.y}
            y2={t.y}
            stroke="currentColor"
            className="text-gray-200 dark:text-gray-700"
            strokeDasharray="2,2"
            strokeWidth={0.5}
          />
          <text
            x={PAD_L - 6}
            y={t.y + 4}
            textAnchor="end"
            className="fill-gray-400"
            fontSize="10"
          >
            {t.label}
          </text>
        </g>
      ))}
      {/* Revenue polyline (blue) */}
      <polyline
        fill="none"
        stroke="#2563eb"
        strokeWidth={2}
        points={pts("revenue")}
      />
      {/* Expenses polyline (red) */}
      <polyline
        fill="none"
        stroke="#dc2626"
        strokeWidth={2}
        strokeDasharray="4,2"
        points={pts("expenses")}
      />
      {/* X-axis labels — every other month to avoid overlap */}
      {byMonth.map((m, i) => (
        <text
          key={`xl-${i}`}
          x={PAD_L + i * xStep}
          y={H - PAD_B + 16}
          textAnchor="middle"
          className="fill-gray-400"
          fontSize="10"
        >
          {i % 2 === 0 ? fmtMonth(m.month) : ""}
        </text>
      ))}
      {/* Legend */}
      <g transform={`translate(${PAD_L}, ${PAD_T - 8})`}>
        <rect x={0} y={-6} width={10} height={2} fill="#2563eb" />
        <text x={14} y={0} className="fill-gray-600" fontSize="11">
          Umsatz
        </text>
        <rect x={70} y={-6} width={10} height={2} fill="#dc2626" />
        <text x={84} y={0} className="fill-gray-600" fontSize="11">
          Aufwand
        </text>
      </g>
    </svg>
  )
}

/**
 * Tier 38: Cost-Center pie chart.
 *
 * Donut visualization of the breakdown — each slice's
 * arc length = |revenue − expense| (the net economic
 * impact of that cost center). We don't add positive
 * revenue + negative expense on a pie (one slice can't
 * show both signs), so we use the absolute delta as the
 * "weight" of each center and surface the breakdown in
 * the legend rows with the actual signed totals.
 *
 * Same SVG-no-deps approach as AgingDonut above —
 * arrows here are sums of dash + gap offsets around
 * the 360° circumference. The largest bucket fills
 * the full 360 minus a thin grey "no-data" arc at the
 * bottom (kept visually consistent with the arAging
 * donut styling).
 */
const COST_CENTER_PALETTE = [
  "#2563eb", // blue
  "#10b981", // emerald
  "#f59e0b", // amber
  "#ef4444", // red
  "#8b5cf6", // violet
  "#14b8a6", // teal
  "#f97316", // orange
  "#ec4899", // pink
  "#6366f1", // indigo
  "#84cc16", // lime
]

function CostCenterPie({
  buckets,
}: {
  buckets: CostCenterBucket[]
}) {
  // Pure-function UI — degenerate input renders empty
  // state. The "no cost center data" hint says exactly
  // what to do next (stamps a cost center on an
  // invoice) so the user isn't left guessing.
  const size = 200
  const r = 80
  const cx = size / 2
  const cy = size / 2
  if (!buckets || buckets.length === 0) {
    return (
      <div
        className="text-sm text-gray-400 text-center py-12"
        data-testid="cost-center-empty"
      >
        Keine Kostenträger-Daten vorhanden
      </div>
    )
  }
  // Net delta per center → pie slice weight = abs(delta).
  const weights = buckets.map((b) => Math.abs(b.revenue - b.expense))
  const total = weights.reduce((s, w) => s + w, 0)
  if (total === 0) {
    return (
      <div
        className="text-sm text-gray-400 text-center py-12"
        data-testid="cost-center-empty"
      >
        Keine Kostenträger-Bewegungen in diesem Zeitraum
      </div>
    )
  }

  // Build arcs: same dash/gap math as AgingDonut.
  let accum = 0
  const arcs = buckets
    .map((b, i) => {
      const w = weights[i]
      if (w <= 0) return null
      const fraction = w / total
      const dash = 2 * Math.PI * r * fraction
      const gap = 2 * Math.PI * r - dash
      const offset = -2 * Math.PI * r * (accum / total)
      accum += w
      const color = COST_CENTER_PALETTE[i % COST_CENTER_PALETTE.length]
      return { b, color, dash, gap, offset, fraction }
    })
    .filter(Boolean) as Array<{
    b: CostCenterBucket
    color: string
    dash: number
    gap: number
    offset: number
    fraction: number
  }>

  return (
    <div
      className="flex flex-col md:flex-row items-center gap-6"
      data-testid="cost-center-pie"
    >
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size}>
        {/* Soft background ring so 100% single-bucket slices still
            show a hairline outline. Same #e5e7eb as the arAging donut. */}
        <circle
          cx={cx}
          cy={cy}
          r={r}
          fill="none"
          stroke="#e5e7eb"
          strokeWidth={20}
        />
        {arcs.map((a, i) => (
          <circle
            key={`arc-${i}`}
            cx={cx}
            cy={cy}
            r={r}
            fill="none"
            stroke={a.color}
            strokeWidth={20}
            strokeDasharray={`${a.dash} ${a.gap}`}
            strokeDashoffset={a.offset}
            transform={`rotate(-90 ${cx} ${cy})`}
            data-testid="cost-center-arc"
            data-cost-center={a.b.costCenter}
          />
        ))}
        <text
          x={cx}
          y={cy - 4}
          textAnchor="middle"
          className="fill-gray-700 dark:fill-gray-200"
          fontSize="13"
          fontWeight="600"
        >
          {fmtMoney(total)} €
        </text>
        <text
          x={cx}
          y={cy + 14}
          textAnchor="middle"
          className="fill-gray-400"
          fontSize="11"
        >
          Netto-Summe
        </text>
      </svg>
      <div className="space-y-1 text-sm flex-1 min-w-0">
        {arcs.map((a, i) => (
          <div
            key={`legend-${i}`}
            className="flex items-center gap-2"
            data-testid="cost-center-legend-row"
            data-cost-center={a.b.costCenter}
          >
            <span
              className="inline-block w-3 h-3 rounded-sm shrink-0"
              style={{ backgroundColor: a.color }}
            />
            <span className="flex-1 truncate">{a.b.costCenter}</span>
            <span className="font-mono">
              {fmtMoney(a.b.revenue - a.b.expense)} €
            </span>
            <span className="text-gray-400 text-xs">
              {(a.fraction * 100).toFixed(0)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

export default function DashboardV2Page() {
  const router = useRouter()
  const { t } = useI18n()
  const [data, setData] = useState<DashboardV2 | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const companyId = localStorage.getItem("companyId")
    if (!companyId) {
      router.push("/login")
      return
    }
    setLoading(true)
    apiGet<DashboardV2>(
      `/api/v1/reports/dashboard-v2?companyId=${companyId}`,
    )
      .then((d) => {
        setData(d)
        setLoading(false)
      })
      .catch((err: any) => {
        setError(err?.message || "Unbekannter Fehler")
        setLoading(false)
      })
  }, [router])

  return (
    <main className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <header className="bg-white dark:bg-gray-800 border-b shadow-sm">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h1
              className="text-2xl font-bold text-blue-600 dark:text-blue-400"
              data-testid="dashboard-v2-title"
            >
              {t("dashboard.title") || "Dashboard"} v2
            </h1>
            <Button
              variant="outline"
              size="sm"
              onClick={() => router.push("/dashboard")}
            >
              ← v1
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <LanguageSwitcher />
            <ThemeToggle />
            <Button
              variant="outline"
              onClick={() => {
                localStorage.clear()
                router.push("/login")
              }}
            >
              {t("dashboard.logout")}
            </Button>
            <Button
              onClick={() =>
                router.push("/dashboard/invoices/create")
              }
              data-testid="dashboard-v2-new-invoice"
            >
              {t("dashboard.newInvoice")}
            </Button>
          </div>
        </div>
      </header>

      <div className="container mx-auto px-4 py-8">
        {loading && (
          <div
            className="text-center py-12 text-gray-500"
            data-testid="dashboard-v2-loading"
          >
            {t("common.loading") || "Lade Dashboard…"}
          </div>
        )}
        {error && (
          <div
            className="p-4 bg-red-50 border border-red-200 text-red-800 rounded"
            data-testid="dashboard-v2-error"
          >
            ✗ {error}
          </div>
        )}
        {!loading && !error && data && (
          <>
            {/* KPI Strip — 4 headline numbers. The
                month-over-month change indicators compare
                thisMonth to lastMonth (from kpis.changes). */}
            <div
              className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6"
              data-testid="dashboard-v2-kpis"
            >
              <Card>
                <CardContent className="pt-6">
                  <div className="text-xs text-gray-500 uppercase">
                    Umsatz YTD
                  </div>
                  <div
                    className="text-2xl font-bold text-blue-600 mt-1"
                    data-testid="kpi-ytd-revenue"
                  >
                    {fmtMoney(data.kpis.ytd.revenue)} €
                  </div>
                  <div className="text-xs mt-1">
                    <span
                      className={
                        data.kpis.changes.revenue >= 0
                          ? "text-emerald-600"
                          : "text-red-600"
                      }
                    >
                      {fmtPct(data.kpis.changes.revenue)}
                    </span>{" "}
                    <span className="text-gray-400">vs. Vormonat</span>
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-6">
                  <div className="text-xs text-gray-500 uppercase">
                    Aufwand YTD
                  </div>
                  <div
                    className="text-2xl font-bold text-red-600 mt-1"
                    data-testid="kpi-ytd-expenses"
                  >
                    {fmtMoney(data.kpis.ytd.expenses)} €
                  </div>
                  <div className="text-xs mt-1">
                    <span
                      className={
                        data.kpis.changes.expenses <= 0
                          ? "text-emerald-600"
                          : "text-red-600"
                      }
                    >
                      {fmtPct(data.kpis.changes.expenses)}
                    </span>{" "}
                    <span className="text-gray-400">vs. Vormonat</span>
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-6">
                  <div className="text-xs text-gray-500 uppercase">
                    USt YTD
                  </div>
                  <div className="text-2xl font-bold text-emerald-600 mt-1">
                    {fmtMoney(data.kpis.ytd.ust)} €
                  </div>
                  <div className="text-xs text-gray-400 mt-1">
                    {data.kpis.ytd.countInvoices} Rechnungen
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-6">
                  <div className="text-xs text-gray-500 uppercase">
                    Offene Forderungen
                  </div>
                  <div
                    className="text-2xl font-bold text-amber-600 mt-1"
                    data-testid="kpi-open-receivables"
                  >
                    {fmtMoney(data.kpis.openReceivables)} €
                  </div>
                  <div className="text-xs text-gray-400 mt-1">
                    nicht bezahlt
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Top row — revenue trend + A/R aging donut */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
              <Card className="lg:col-span-2">
                <CardHeader>
                  <CardTitle>
                    Umsatz- und Aufwandsentwicklung (12 Monate)
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <RevenueTrendChart byMonth={data.kpis.byMonth} />
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>Forderungs-Alterung</CardTitle>
                </CardHeader>
                <CardContent>
                  <AgingDonut arAging={data.arAging} />
                </CardContent>
              </Card>
            </div>

            {/* Tier 38: third middle row — Cost-Center breakdown
                (pie + legend). Single-column on small viewports. */}
            <div className="grid grid-cols-1 gap-4 mb-6">
              <Card data-testid="cost-center-card">
                <CardHeader>
                  <CardTitle>
                    Umsatz nach Kostenträger (YTD)
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <CostCenterPie
                    buckets={data.costCenterBreakdown || []}
                  />
                </CardContent>
              </Card>
            </div>

            {/* Bottom row — top customers + recent activity */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <Card>
                <CardHeader>
                  <CardTitle>Top 5 Kunden YTD</CardTitle>
                </CardHeader>
                <CardContent>
                  <TopCustomersBar customers={data.topCustomers} />
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>Letzte Aktivität</CardTitle>
                </CardHeader>
                <CardContent>
                  <div
                    className="space-y-2"
                    data-testid="dashboard-v2-recent"
                  >
                    {data.recentActivity.length === 0 && (
                      <div className="text-sm text-gray-400">
                        Keine Aktivität
                      </div>
                    )}
                    {data.recentActivity.map((r) => (
                      <div
                        key={r.invoiceId}
                        className="flex items-center justify-between text-sm border-b border-gray-100 dark:border-gray-800 pb-2 last:border-0"
                        data-testid="dashboard-v2-recent-row"
                      >
                        <div className="min-w-0">
                          <div className="font-mono text-blue-600 truncate">
                            {r.invoiceNumber}
                          </div>
                          <div className="text-gray-500 truncate">
                            {r.customerName}
                          </div>
                        </div>
                        <div className="text-right text-sm">
                          <div className="font-mono">
                            {fmtMoney(r.total)} {r.currency}
                          </div>
                          <div className="text-xs text-gray-400">
                            {r.status}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            </div>

            <div className="mt-6 text-xs text-gray-400 text-center">
              Generiert:{" "}
              {new Date(data.generatedAt).toLocaleString("de-DE")}
            </div>
          </>
        )}
      </div>
    </main>
  )
}