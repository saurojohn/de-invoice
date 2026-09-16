"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import LanguageSwitcher from "@/components/LanguageSwitcher"
import MandantSwitcher from "@/components/MandantSwitcher"
import { ReadOnlyToggle, ReadOnlyBanner } from "@/components/ReadOnlyBanner"
import { RevenueChart } from "@/components/RevenueChart"
import { UstvaZahllastChart } from "@/components/UstvaZahllastChart"
import { ThemeToggle } from "@/components/ThemeToggle"
import { useI18n } from "@/components/useI18n"
import { apiGet } from "@/lib/api"
import { signOut } from "@/lib/auth"

interface DashboardStats {
  totalInvoices: number
  pendingAmount: number
  overdueAmount: number
  // Tier 236: count of overdue invoices (not just
  // amount). Powers the dashboard's Overdue Counter
  // tile — the most-actionable KPI for the Berater.
  // Derived from the same /invoices fetch that powers
  // overdueAmount; no extra API call.
  overdueCount: number
  paidAmount: number
}

// Tier 63: recurring-invoice stats for the dashboard widget.
// Mirrors the shape of `GET /api/v1/recurring-invoices/stats`.
interface RecurringStats {
  active: number
  paused: number
  dueThisWeek: number
  runsThisMonth: number
  failedLast30Days: number
  dueThisWeekList: Array<{
    id: string
    name: string
    nextRunAt: string
    interval: string
    intervalCount: number
    customer: { id: string; name: string; customerNumber?: string | null }
  }>
}

interface DashboardKpis {
  ytd: {
    revenue: number
    ust: number
    countInvoices: number
    expenses: number
    vorsteuer: number
    countExpenses: number
    net: number
  }
  thisMonth: {
    revenue: number
    ust: number
    countInvoices: number
    expenses: number
    vorsteuer: number
    countExpenses: number
  }
  lastMonth: {
    revenue: number
    ust: number
    countInvoices: number
    expenses: number
    vorsteuer: number
    countExpenses: number
  }
  changes: {
    revenue: number
    expenses: number
    ust: number
    vorsteuer: number
  }
  openReceivables: number
  openPayables: number
  byMonth: Array<{ month: string; revenue: number; expenses: number }>
  generatedAt: string
}

interface RecentInvoice {
  id: string
  invoiceNumber: string
  issueDate: string
  total: string
  status: string
  customer?: { name: string; customerNumber?: string | null } | null
}

// Tier 193: System Health widget. Mirrors the
// backend's GET /api/v1/health/summary response.
// The dashboard polls this every 30s so the Berater
// sees at-a-glance whether the backend is healthy
// (status badge) + how big the data is
// (companies/users/invoices/customers).
interface SystemHealth {
  status: "ok" | "degraded" | "down"
  version: string
  uptimeSec: number
  dbOk: boolean
  storageOk: boolean
  memory: { rssMB: number; heapMB: number }
  business: { companies: number; users: number; invoices: number; customers: number }
  timestamp: string
}

const fmtMoney = (n: number) =>
  n.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const fmtDate = (s: string | null | undefined, locale = "de-DE") =>
  s ? new Date(s).toLocaleDateString(locale, { day: "2-digit", month: "2-digit", year: "numeric" }) : "—"

export default function DashboardPage() {
  const router = useRouter()
  const { t, getDateLocale } = useI18n()
  const dl = getDateLocale()
  const [stats, setStats] = useState<DashboardStats | null>(null)
  const [recurringStats, setRecurringStats] = useState<RecurringStats | null>(null)
  const [kpis, setKpis] = useState<DashboardKpis | null>(null)
  const [monthlyRevenue, setMonthlyRevenue] = useState<Array<{ month: string; totalAmount: number; invoiceCount?: number }>>([])
  const [recentInvoices, setRecentInvoices] = useState<RecentInvoice[]>([])
  // Tier 159: per-customer credit utilization
  // (openBalance / creditLimit). Surface over-limit
  // customers + warning-zone customers at the top of
  // the dashboard so the Berater sees them before
  // the next Mahnung-Lauf.
  const [creditUtilization, setCreditUtilization] = useState<Array<{
    customerId: string
    customerName: string
    customerNumber: string | null
    creditLimit: number
    totalOpen: number
    utilization: number
    status: 'ok' | 'warning' | 'over'
  }>>([])
  // Tier 161: USt-Voranmeldung history for the
  // Monatsvergleich widget. The backend serializes
  // 6 compute() calls — at 1-2s each, the full
  // response is 1-2s. Soft-fail (return []) so a
  // transient backend issue doesn't take the
  // dashboard down. The widget hides itself on
  // empty.
  const [ustvaHistory, setUstvaHistory] = useState<Array<{
    year: number
    month: number
    periodLabel: string
    taxableAmount19: number
    taxableAmount7: number
    vat19: number
    vat7: number
    zahllast: number
    invoiceCount: number
    expenseCount: number
  }>>([])
  const [, setLoading] = useState(true)
  // Tier 193: System Health summary from /api/v1/health/summary
  const [systemHealth, setSystemHealth] = useState<SystemHealth | null>(null)
  const [systemHealthError, setSystemHealthError] = useState(false)

  useEffect(() => {
    const companyId = localStorage.getItem("companyId")
    if (!companyId) {
      router.push("/login")
      return
    }

    // Default date range: last 12 months
    const now = new Date()
    const startDate = new Date(now.getFullYear() - 1, now.getMonth() + 1, 1)
      .toISOString().split("T")[0]
    const endDate = now.toISOString().split("T")[0]

    // Use apiGet for proper x-user-id / x-company-id
    // headers. Raw fetch() would 401 against HeaderAuthGuard
    // — the symptom was "all dashboard numbers are 0" because
    // the failed fetches resolved to undefined and the
    // .reduce() ran over an empty list.
    Promise.all([
      apiGet<{ data: any[]; total: number }>(`/api/v1/invoices?companyId=${companyId}&pageSize=500`),
      apiGet<{ byMonth: any[] }>(`/api/v1/reports/sales?companyId=${companyId}&startDate=${startDate}&endDate=${endDate}`),
      apiGet<DashboardKpis>(`/api/v1/reports/dashboard?companyId=${companyId}`),
      // Tier 63: recurring-invoice aggregate for the
      // dashboard widget. We tolerate failure on this
      // one — the widget falls back to "—/—" rather
      // than breaking the whole dashboard if the
      // endpoint is unreachable (e.g. during a hot
      // reload mid-restart).
      apiGet<RecurringStats>(`/api/v1/recurring-invoices/stats?companyId=${companyId}`)
        .catch(() => null),
      // Tier 159: per-customer credit utilization.
      // Soft-fail — the widget hides itself if the
      // endpoint errors out (no customers with
      // creditLimit, or the endpoint is down).
      apiGet<Array<{
        customerId: string
        customerName: string
        customerNumber: string | null
        creditLimit: number
        totalOpen: number
        utilization: number
        status: 'ok' | 'warning' | 'over'
      }>>(`/api/v1/customers/credit-utilization?companyId=${companyId}`)
        .catch(() => [] as any),
      // Tier 161: USt-Voranmeldung history for the
      // dashboard Monatsvergleich widget. We fetch
      // 12 months (not 6) so the Tier 162 12-month
      // trend chart can use the same payload. The
      // 6-row table shows the top 6; the 12-bar
      // chart shows all 12. One fetch, two
      // consumers. Soft-fail — the widget hides
      // itself on empty/error.
      apiGet<Array<{
        year: number
        month: number
        periodLabel: string
        taxableAmount19: number
        taxableAmount7: number
        vat19: number
        vat7: number
        zahllast: number
        invoiceCount: number
        expenseCount: number
      }>>(`/api/v1/ustva/history?companyId=${companyId}&months=12`)
        .catch(() => [] as any),
      // Tier 193: System Health widget. The
      // /health/summary endpoint is intentionally
      // cheap (no auth, no company filter — it's a
      // global health probe), so we fetch it in
      // parallel with the rest. Soft-fail so a
      // 500 here doesn't take the whole dashboard
      // down. The widget shows a "load error"
      // state in that case.
      apiGet<SystemHealth>(`/api/v1/health/summary`)
        .catch((err) => {
          console.warn("System health summary failed:", err)
          setSystemHealthError(true)
          return null
        }),
    ])
      .then(([invoiceList, salesReport, dashboardKpis, recurring, creditRows, ustvaRows, sysHealth]) => {
        const invoices = invoiceList?.data || []
        const pending = invoices
          .filter((inv: any) => inv.status === "sent" || inv.status === "draft" || inv.status === "overdue")
          .reduce((sum: number, inv: any) => sum + Number(inv.total || 0), 0)
        const overdue = invoices
          .filter((inv: any) => inv.status === "overdue")
          .reduce((sum: number, inv: any) => sum + Number(inv.total || 0), 0)
        const paid = invoices
          .filter((inv: any) => inv.status === "paid")
          .reduce((sum: number, inv: any) => sum + Number(inv.total || 0), 0)

        setStats({
          totalInvoices: invoiceList?.total ?? invoices.length,
          pendingAmount: pending,
          overdueAmount: overdue,
          // Tier 236: count of overdue invoices. Cheap
          // O(N) over the already-fetched list — no
          // second API call. Powers the new Overdue
          // Counter KPI tile on the dashboard.
          overdueCount: invoices.filter(
            (inv: any) => inv.status === "overdue",
          ).length,
          paidAmount: paid,
        })
        setRecurringStats(recurring)
        setMonthlyRevenue(salesReport?.byMonth || [])
        setKpis(dashboardKpis || null)
        setRecentInvoices(invoices.slice(0, 8) as RecentInvoice[])
        setCreditUtilization(creditRows || [])
        setUstvaHistory(ustvaRows || [])
        if (sysHealth) {
          setSystemHealth(sysHealth)
          setSystemHealthError(false)
        }
        setLoading(false)
      })
      .catch((err) => {
        console.error("Dashboard load failed:", err)
        setLoading(false)
      })
  }, [router])

  return (
    <main className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <ReadOnlyBanner />
      <header className="bg-white dark:bg-gray-800 border-b shadow-sm">
        <div className="container mx-auto px-4 py-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-blue-600 dark:text-blue-400">{t("dashboard.title")}</h1>
            <Button variant="outline" size="sm" onClick={() => router.push("/dashboard/v2")}>
              → v2
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-2 sm:gap-4">
            <MandantSwitcher />
            <ReadOnlyToggle />
            <LanguageSwitcher />
            <ThemeToggle />
            <Button variant="outline" onClick={async () => {
              // Tier 401: revoke the session server-side first — clearing
              // localStorage used to leave the credential valid.
              await signOut()
              router.push("/login")
            }}>
              {t("dashboard.logout")}
            </Button>
            <Button onClick={() => router.push("/dashboard/invoices/create")}>
              {t("dashboard.newInvoice")}
            </Button>
          </div>
        </div>
      </header>

      <div className="container mx-auto px-3 sm:px-4 py-4 sm:py-8">
        {/* KPI Tiles — YTD + Month-over-Month change
            indicators. The "change" arrows come from
            the dashboard endpoint's `changes` field
            (thisMonth vs lastMonth). Each tile also
            surfaces the previous-month value in
            muted text so the user has a reference.
            Tier 236: 5-column grid (was 4) to add the
            Overdue Counter tile — the most-actionable
            KPI for the Berater. */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4 mb-8">
          {/* YTD Revenue */}
          <Card>
            <CardContent className="pt-6">
              <div className="text-xs text-gray-500 dark:text-gray-400 uppercase">
                {t("dashboard.kpiYtdRevenue") || "Umsatz YTD"}
              </div>
              <div className="text-2xl font-bold text-blue-600 dark:text-blue-400 mt-1">
                {fmtMoney(kpis?.ytd.revenue || 0)} €
              </div>
              <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                {kpis?.ytd.countInvoices || 0} Rechnungen
              </div>
            </CardContent>
          </Card>
          {/* YTD Expenses */}
          <Card>
            <CardContent className="pt-6">
              <div className="text-xs text-gray-500 dark:text-gray-400 uppercase">
                {t("dashboard.kpiYtdExpenses") || "Aufwand YTD"}
              </div>
              <div className="text-2xl font-bold text-red-600 dark:text-red-400 mt-1">
                {fmtMoney(kpis?.ytd.expenses || 0)} €
              </div>
              <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                {kpis?.ytd.countExpenses || 0} Eingangsrechnungen
              </div>
            </CardContent>
          </Card>
          {/* YTD Net Profit */}
          <Card>
            <CardContent className="pt-6">
              <div className="text-xs text-gray-500 dark:text-gray-400 uppercase">
                {t("dashboard.kpiYtdNet") || "Gewinn YTD"}
              </div>
              <div
                className={
                  "text-2xl font-bold mt-1 " +
                  ((kpis?.ytd.net || 0) >= 0 ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400")
                }
              >
                {fmtMoney(kpis?.ytd.net || 0)} €
              </div>
              <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                Umsatz − Aufwand
              </div>
            </CardContent>
          </Card>
          {/* Open Receivables */}
          <Card>
            <CardContent className="pt-6">
              <div className="text-xs text-gray-500 dark:text-gray-400 uppercase">
                {t("dashboard.kpiOpenRecv") || "Offene Forderungen"}
              </div>
              <div className="text-2xl font-bold text-yellow-700 dark:text-yellow-300 mt-1">
                {fmtMoney(kpis?.openReceivables || 0)} €
              </div>
              <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                Unbezahlte Rechnungen
              </div>
            </CardContent>
          </Card>
          {/* Tier 236: Overdue Counter — the most-
              actionable KPI for the Berater. Shows
              both the count and the total amount of
              overdue invoices. The number is derived
              from the same /invoices fetch that powers
              `stats.overdueAmount`, so no extra API
              call. Tile turns red when count > 0 (cash
              flow is at risk), green when zero (clean
              AR). Linked to /dashboard/invoices?status=
              overdue so the operator can jump straight
              to the list. */}
          <Card data-testid="dashboard-kpi-overdue">
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div className="text-xs text-gray-500 dark:text-gray-400 uppercase">
                  {t("dashboard.kpiOverdueTitle") || "Überfällige Rechnungen"}
                </div>
                {(stats?.overdueCount ?? 0) > 0 ? (
                  <span
                    data-testid="dashboard-kpi-overdue-badge"
                    className="text-xs font-bold px-2 py-0.5 rounded-full bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200"
                  >
                    !
                  </span>
                ) : (
                  <span
                    data-testid="dashboard-kpi-overdue-ok"
                    className="text-xs font-bold px-2 py-0.5 rounded-full bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200"
                  >
                    ✓
                  </span>
                )}
              </div>
              <div
                className={
                  "text-2xl font-bold mt-1 " +
                  ((stats?.overdueCount ?? 0) > 0
                    ? "text-red-600 dark:text-red-400"
                    : "text-green-600 dark:text-green-400")
                }
                data-testid="dashboard-kpi-overdue-count"
              >
                {stats?.overdueCount ?? 0}
              </div>
              <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                {fmtMoney(stats?.overdueAmount || 0)} € offen
              </div>
              {(stats?.overdueCount ?? 0) > 0 && (
                <a
                  href="/dashboard/invoices?status=overdue"
                  className="text-xs text-blue-600 dark:text-blue-400 hover:underline mt-2 inline-block"
                  data-testid="dashboard-kpi-overdue-link"
                >
                  Jetzt Mahnung starten →
                </a>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Month-over-Month change row. The user
            sees at a glance whether the business is
            trending up or down this month vs last. */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          {([
            { key: "revenue", label: t("dashboard.changeRevenue") || "Umsatz Δ", cur: kpis?.thisMonth.revenue || 0, prev: kpis?.lastMonth.revenue || 0, change: kpis?.changes.revenue || 0, color: "blue" },
            { key: "expenses", label: t("dashboard.changeExpenses") || "Aufwand Δ", cur: kpis?.thisMonth.expenses || 0, prev: kpis?.lastMonth.expenses || 0, change: kpis?.changes.expenses || 0, color: "red" },
            { key: "ust", label: t("dashboard.changeUst") || "USt Δ", cur: kpis?.thisMonth.ust || 0, prev: kpis?.lastMonth.ust || 0, change: kpis?.changes.ust || 0, color: "purple" },
            { key: "vorsteuer", label: t("dashboard.changeVorsteuer") || "Vorsteuer Δ", cur: kpis?.thisMonth.vorsteuer || 0, prev: kpis?.lastMonth.vorsteuer || 0, change: kpis?.changes.vorsteuer || 0, color: "green" },
          ] as const).map((c) => {
            // For "expenses" the user EXPECTS a
            // decrease (lower expenses = good), so the
            // "good" arrow is flipped. For revenue /
            // USt / Vorsteuer, an increase is good.
            const isExpense = c.key === "expenses"
            const goodWhenUp = !isExpense
            const up = c.change > 0
            const isGood = up ? goodWhenUp : !goodWhenUp
            const arrow = c.change === 0 ? "—" : up ? "▲" : "▼"
            return (
              <Card key={c.key}>
                <CardContent className="pt-6">
                  <div className="text-xs text-gray-500 dark:text-gray-400 uppercase">
                    {c.label}
                  </div>
                  <div className="text-xl font-bold mt-1">
                    {fmtMoney(c.cur)} €
                  </div>
                  <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                    vs. {fmtMoney(c.prev)} € Vormonat
                  </div>
                  <div
                    className={
                      "text-sm font-bold mt-2 " +
                      (c.change === 0
                        ? "text-gray-500 dark:text-gray-400"
                        : isGood
                        ? "text-green-600 dark:text-green-400"
                        : "text-red-600 dark:text-red-400")
                    }
                  >
                    {arrow} {Math.abs(c.change).toFixed(1)} %
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>

        {/* Tier 193 — System Health widget. Mirrors the
            backend's /api/v1/health/summary. Shows the
            Berater at a glance:
            - status badge (ok / degraded / down)
            - uptime (d/h/m)
            - DB + storage health
            - RSS / heap memory
            - business counts (companies / users /
              invoices / customers)
            The widget is intentionally compact — it
            lives BELOW the KPIs so the revenue/expense
            tiles stay at the top of the user's
            attention. Polled by the same useEffect as
            the rest of the dashboard; no separate
            polling loop (avoid hitting Throttler). */}
        <Card className="mb-8" data-testid="dashboard-system-health">
          <CardHeader>
            <CardTitle className="flex items-center justify-between flex-wrap gap-2">
              <span>{t("dashboard.systemHealthTitle") || "Systemstatus"}</span>
              <span
                className={
                  "text-xs px-2 py-1 rounded-full font-semibold " +
                  (systemHealth?.status === "ok"
                    ? "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200"
                    : systemHealth?.status === "degraded"
                    ? "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200"
                    : systemHealthError || systemHealth?.status === "down"
                    ? "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200"
                    : "bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300")
                }
                data-testid="system-health-status"
              >
                {systemHealth?.status === "ok"
                  ? t("dashboard.systemHealthStatusOk") || "Alles OK"
                  : systemHealth?.status === "degraded"
                  ? t("dashboard.systemHealthStatusDegraded") || "Eingeschränkt"
                  : systemHealthError || systemHealth?.status === "down"
                  ? t("dashboard.systemHealthStatusDown") || "Nicht verfügbar"
                  : "—"}
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {systemHealthError && !systemHealth ? (
              <div className="text-sm text-red-600 dark:text-red-400" data-testid="system-health-error">
                {t("dashboard.systemHealthLoadError") || "Systemstatus konnte nicht geladen werden"}
              </div>
            ) : !systemHealth ? (
              <div className="text-sm text-gray-500">…</div>
            ) : (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {/* Uptime */}
                <div>
                  <div className="text-xs text-gray-500 dark:text-gray-400 uppercase">
                    {t("dashboard.systemHealthUptime") || "Laufzeit"}
                  </div>
                  <div className="text-lg font-semibold mt-1" data-testid="system-health-uptime">
                    {(() => {
                      const s = systemHealth.uptimeSec
                      const d = Math.floor(s / 86400)
                      const h = Math.floor((s % 86400) / 3600)
                      const m = Math.floor((s % 3600) / 60)
                      return t("dashboard.systemHealthUptimeValue", { days: d, hours: h, minutes: m })
                    })()}
                  </div>
                </div>
                {/* DB */}
                <div>
                  <div className="text-xs text-gray-500 dark:text-gray-400 uppercase">
                    {t("dashboard.systemHealthDb") || "Datenbank"}
                  </div>
                  <div
                    className={
                      "text-lg font-semibold mt-1 " +
                      (systemHealth.dbOk
                        ? "text-green-600 dark:text-green-400"
                        : "text-red-600 dark:text-red-400")
                    }
                    data-testid="system-health-db"
                  >
                    {systemHealth.dbOk ? "✓" : "✗"}
                  </div>
                </div>
                {/* Storage */}
                <div>
                  <div className="text-xs text-gray-500 dark:text-gray-400 uppercase">
                    {t("dashboard.systemHealthStorage") || "Speicher"}
                  </div>
                  <div
                    className={
                      "text-lg font-semibold mt-1 " +
                      (systemHealth.storageOk
                        ? "text-green-600 dark:text-green-400"
                        : "text-red-600 dark:text-red-400")
                    }
                    data-testid="system-health-storage"
                  >
                    {systemHealth.storageOk ? "✓" : "✗"}
                  </div>
                </div>
                {/* Memory */}
                <div>
                  <div className="text-xs text-gray-500 dark:text-gray-400 uppercase">
                    {t("dashboard.systemHealthMemory") || "Speicherverbrauch"}
                  </div>
                  <div className="text-lg font-semibold mt-1" data-testid="system-health-memory">
                    {systemHealth.memory.rssMB} / {systemHealth.memory.heapMB} MB
                  </div>
                </div>
                {/* Business counts (full row) */}
                <div className="col-span-2 md:col-span-4">
                  <div className="text-xs text-gray-500 dark:text-gray-400 uppercase mb-1">
                    {t("dashboard.systemHealthBusiness") || "Datenbestand"}
                  </div>
                  <div className="grid grid-cols-4 gap-2 text-sm">
                    <div data-testid="system-health-companies">
                      <span className="font-semibold">{systemHealth.business.companies}</span>{" "}
                      <span className="text-gray-500 dark:text-gray-400">
                        {t("dashboard.systemHealthCompanies") || "Firmen"}
                      </span>
                    </div>
                    <div data-testid="system-health-users">
                      <span className="font-semibold">{systemHealth.business.users}</span>{" "}
                      <span className="text-gray-500 dark:text-gray-400">
                        {t("dashboard.systemHealthUsers") || "Benutzer"}
                      </span>
                    </div>
                    <div data-testid="system-health-invoices">
                      <span className="font-semibold">{systemHealth.business.invoices}</span>{" "}
                      <span className="text-gray-500 dark:text-gray-400">
                        {t("dashboard.systemHealthInvoices") || "Rechnungen"}
                      </span>
                    </div>
                    <div data-testid="system-health-customers">
                      <span className="font-semibold">{systemHealth.business.customers}</span>{" "}
                      <span className="text-gray-500 dark:text-gray-400">
                        {t("dashboard.systemHealthCustomers") || "Kunden"}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Revenue trend (last 12 months) — uses the
            new dashboard endpoint's byMonth (revenue
            + expenses as grouped bars). Falls back to
            the legacy monthlyRevenue (revenue only) if
            the dashboard endpoint is slow / fails. */}
        <Card className="mb-8">
          <CardHeader>
            <CardTitle>Umsatz- und Aufwandsentwicklung (letzte 12 Monate)</CardTitle>
          </CardHeader>
          <CardContent>
            <RevenueChart data={kpis?.byMonth || monthlyRevenue} height={240} />
          </CardContent>
        </Card>

        {/* Tier 159: credit-limit widget. Shows the
            customers that are over (or near) their
            credit limit. Sorted by severity
            (over > warning > ok) and within each
            bucket by utilization DESC. Soft hide when
            the company has no customers with a limit
            set (the backend returns [] for the empty
            case). Capped at 5 rows to keep the
            dashboard scannable. */}
        {creditUtilization.length > 0 && (
          <Card className="mb-8" data-testid="dashboard-credit-limit">
            <CardHeader>
              <CardTitle className="flex items-center justify-between flex-wrap gap-2">
                <span>
                  {t("dashboard.creditLimitTitle") || "Kreditlimit-Auslastung"}
                </span>
                <span className="text-xs text-gray-500">
                  {creditUtilization.filter((r) => r.status === 'over').length}{" "}
                  {t("dashboard.creditOver") || "überschritten"} ·{" "}
                  {creditUtilization.filter((r) => r.status === 'warning').length}{" "}
                  {t("dashboard.creditWarning") || "Warnung"}
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {creditUtilization.slice(0, 5).map((row) => {
                  const bucketColor =
                    row.status === 'over'
                      ? 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-700'
                      : row.status === 'warning'
                        ? 'bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-700'
                        : 'bg-emerald-50 dark:bg-emerald-900/20 border-emerald-200 dark:border-emerald-700'
                  const pct = Math.min(row.utilization, 100)
                  const barColor =
                    row.status === 'over'
                      ? 'bg-red-500'
                      : row.status === 'warning'
                        ? 'bg-amber-500'
                        : 'bg-emerald-500'
                  return (
                    <button
                      key={row.customerId}
                      type="button"
                      onClick={() => router.push(`/dashboard/customers/${row.customerId}`)}
                      className={
                        "w-full p-3 border rounded text-left hover:shadow transition-shadow " +
                        bucketColor
                      }
                      data-testid={`dashboard-credit-row-${row.customerId}`}
                      data-bucket={row.status}
                    >
                      <div className="flex items-center justify-between mb-1">
                        <span className="font-medium text-sm">
                          {row.customerNumber
                            ? `${row.customerNumber} — ${row.customerName}`
                            : row.customerName}
                        </span>
                        <span
                          className={
                            "text-sm font-mono font-bold " +
                            (row.status === 'over'
                              ? 'text-red-700 dark:text-red-300'
                              : row.status === 'warning'
                                ? 'text-amber-700 dark:text-amber-300'
                                : 'text-emerald-700 dark:text-emerald-300')
                          }
                          data-testid={`dashboard-credit-pct-${row.customerId}`}
                        >
                          {Math.round(row.utilization * 10) / 10}%
                        </span>
                      </div>
                      <div className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-300">
                        <span className="font-mono">
                          {row.totalOpen.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €
                          {" "}/ {" "}
                          {row.creditLimit.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €
                        </span>
                        {row.status === 'over' && (
                          <span className="px-1.5 py-0.5 rounded bg-red-200 dark:bg-red-800 text-red-900 dark:text-red-100 text-xs font-medium">
                            {t("dashboard.creditBadgeOver") || "Überschritten"}
                          </span>
                        )}
                        {row.status === 'warning' && (
                          <span className="px-1.5 py-0.5 rounded bg-amber-200 dark:bg-amber-800 text-amber-900 dark:text-amber-100 text-xs font-medium">
                            {t("dashboard.creditBadgeWarning") || "Warnung"}
                          </span>
                        )}
                      </div>
                      <div className="mt-1.5 h-1.5 w-full bg-gray-200 dark:bg-gray-700 rounded overflow-hidden">
                        <div
                          className={"h-full " + barColor}
                          style={{ width: pct + "%" }}
                        />
                      </div>
                    </button>
                  )
                })}
              </div>
              {creditUtilization.length > 5 && (
                <p className="text-xs text-gray-500 mt-2 text-center">
                  +{creditUtilization.length - 5}{" "}
                  {t("dashboard.creditMore") || "weitere — siehe Kundenliste"}
                </p>
              )}
            </CardContent>
          </Card>
        )}

        {/* Tier 161: USt-Voranmeldung Monatsvergleich.
            6-row table for the last 6 months: each row
            shows the 19% / 7% taxable base, total VAT, and
            the Zahllast (= umsatzsteuer − vorsteuer).
            Click a row → open the UStVA detail page for
            that month. Soft-hides when the backend
            returned an empty list (e.g. endpoint down
            or rate-limited). Sorted by month DESC so
            the most recent month is at the top — the
            operator wants to see "the current month"
            first. */}
        {ustvaHistory.length > 0 && (
          <Card className="mb-8" data-testid="dashboard-ustva-history">
            <CardHeader>
              <CardTitle className="flex items-center justify-between flex-wrap gap-2">
                <span>
                  {t("dashboard.ustvaHistoryTitle") ||
                    "USt-Voranmeldung der letzten 6 Monate"}
                </span>
                <span className="text-xs text-gray-500">
                  {t("dashboard.ustvaHistorySubtitle") ||
                    "Monatsvergleich für die Vorauszahlung"}
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-gray-500 dark:text-gray-400 text-xs border-b">
                      <th className="py-2 pr-2">
                        {t("dashboard.ustvaColMonth") || "Monat"}
                      </th>
                      <th className="text-right py-2 pr-2">
                        {t("dashboard.ustvaColNet19") ||
                          "Bemessungsgrundlage 19%"}
                      </th>
                      <th className="text-right py-2 pr-2">
                        {t("dashboard.ustvaColNet7") ||
                          "Bemessungsgrundlage 7%"}
                      </th>
                      <th className="text-right py-2 pr-2">
                        {t("dashboard.ustvaColVat") || "Steuer (USt)"}
                      </th>
                      <th className="text-right py-2">
                        {t("dashboard.ustvaColZahllast") || "Zahllast"}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {/* Show only the most recent 6 months
                        in the table (the chart below
                        shows all 12 for the trend view). */}
                    {ustvaHistory.slice(0, 6).map((row) => {
                      // Render the period as "Aug 2026"
                      // in the operator's locale. The
                      // YearMonth from the backend is
                      // 1-based (1=Jan) but JS Date uses
                      // 0-based, hence the -1.
                      const monthDate = new Date(row.year, row.month - 1, 1)
                      const monthLabel = monthDate.toLocaleDateString("de-DE", {
                        month: "short",
                        year: "numeric",
                      })
                      // Colour the Zahllast: positive
                      // = "we owe the FA" (red, payable
                      // Voranmeldung), negative = "the
                      // FA owes us" (green, refund).
                      const isRefund = row.zahllast < 0
                      const isZero = row.zahllast === 0
                      const zahllastClass = isZero
                        ? "text-gray-500 dark:text-gray-400"
                        : isRefund
                          ? "text-emerald-600 dark:text-emerald-400"
                          : "text-red-600 dark:text-red-400"
                      return (
                        <tr
                          key={row.periodLabel}
                          data-testid={`ustva-history-row-${row.periodLabel}`}
                          data-zahllast={row.zahllast}
                          onClick={() =>
                            router.push(
                              `/dashboard/accounting/ustva?year=${row.year}&month=${row.month}`
                            )
                          }
                          className="border-b hover:bg-blue-50 dark:hover:bg-blue-900/20 cursor-pointer"
                        >
                          <td className="py-2 pr-2 font-medium">
                            {monthLabel}
                          </td>
                          <td className="text-right py-2 pr-2 font-mono">
                            {row.taxableAmount19.toLocaleString("de-DE", {
                              minimumFractionDigits: 2,
                              maximumFractionDigits: 2,
                            })}{" "}
                            €
                          </td>
                          <td className="text-right py-2 pr-2 font-mono">
                            {row.taxableAmount7.toLocaleString("de-DE", {
                              minimumFractionDigits: 2,
                              maximumFractionDigits: 2,
                            })}{" "}
                            €
                          </td>
                          <td className="text-right py-2 pr-2 font-mono">
                            {(row.vat19 + row.vat7).toLocaleString("de-DE", {
                              minimumFractionDigits: 2,
                              maximumFractionDigits: 2,
                            })}{" "}
                            €
                          </td>
                          <td
                            className={
                              "text-right py-2 font-mono font-bold " +
                              zahllastClass
                            }
                            data-testid={`ustva-zahllast-${row.periodLabel}`}
                          >
                            {row.zahllast.toLocaleString("de-DE", {
                              minimumFractionDigits: 2,
                              maximumFractionDigits: 2,
                            })}{" "}
                            €
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Tier 162: UStVorauszahlung 12-Monats-Verlauf
            (diverging bar chart). Shows the same data
            as the 6-row table above, but for the full
            trailing 12 months. The chart layout makes
            it easy to spot months where the Zahllast
            was negative (Erstattung from the FA) vs
            positive (Vorauszahlung). YTD sum is shown
            in the legend. The data is ASC (oldest
            left, newest right) so the trend reads
            naturally. Hidden when no data (same
            conditional as the 6-row table). */}
        {ustvaHistory.length > 0 && (
          <Card className="mb-8" data-testid="dashboard-ustva-trend">
            <CardHeader>
              <CardTitle className="flex items-center justify-between flex-wrap gap-2">
                <span>
                  {t("dashboard.ustvaTrendTitle") ||
                    "USt-Vorauszahlung 12-Monats-Verlauf"}
                </span>
                <span className="text-xs text-gray-500">
                  {t("dashboard.ustvaTrendSubtitle") ||
                    "Zahllast = USt − Vorsteuer (positiv = Vorauszahlung, negativ = Erstattung)"}
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <UstvaZahllastChart
                data={ustvaHistory.map((r) => ({
                  periodLabel: r.periodLabel,
                  zahllast: r.zahllast,
                }))}
                height={220}
              />
            </CardContent>
          </Card>
        )}

        {/* Recent invoices */}
        {recentInvoices.length > 0 && (
          <Card className="mb-8">
            <CardHeader>
              <CardTitle>{t("dashboard.recentInvoices") || "Aktuelle Rechnungen"}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-gray-500 dark:text-gray-400 text-xs border-b">
                      <th className="py-2">{t("invoice.number") || "Nr."}</th>
                      <th>{t("invoice.customer") || "Kunde"}</th>
                      <th>{t("invoice.issueDate") || "Datum"}</th>
                      <th className="text-right">{t("common.amount") || "Betrag"}</th>
                      <th>{t("common.status") || "Status"}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentInvoices.map((inv) => {
                      const status = inv.status
                      const statusColor =
                        status === "paid" ? "bg-emerald-100 text-emerald-800"
                        : status === "overdue" ? "bg-red-100 text-red-800"
                        : status === "cancelled" ? "bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300"
                        : "bg-yellow-100 text-yellow-800"
                      return (
                        <tr key={inv.id} className="border-b hover:bg-gray-50 dark:bg-gray-900">
                          <td className="py-2 font-mono">
                            <Link
                              href={`/dashboard/invoices/${inv.id}`}
                              className="text-blue-600 dark:text-blue-400 hover:underline"
                            >
                              {inv.invoiceNumber}
                            </Link>
                          </td>
                          <td>
                            {inv.customer?.name || "—"}
                            {inv.customer?.customerNumber && (
                              <span className="text-xs text-gray-400 font-mono ml-1">
                                {inv.customer.customerNumber}
                              </span>
                            )}
                          </td>
                          <td className="font-mono text-xs">{fmtDate(inv.issueDate, dl)}</td>
                          <td className="text-right font-mono">€ {fmtMoney(Number(inv.total))}</td>
                          <td>
                            <span className={`text-xs px-1.5 py-0.5 rounded ${statusColor}`}>
                              {status}
                            </span>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Quick Actions */}
        <h2 className="text-xl font-semibold mb-4">{t("dashboard.quickActions")}</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
          <Card
            className="cursor-pointer hover:shadow-lg transition-shadow border-blue-300 dark:border-blue-700 bg-blue-50/50"
            onClick={() => router.push("/dashboard/invoices/create")}
          >
            <CardHeader>
              <CardTitle className="text-blue-700 dark:text-blue-300 flex items-center gap-2">
                <span className="text-2xl leading-none">+</span>
                {t("dashboard.cardCreateInvoiceTitle")}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-gray-600 dark:text-gray-300">{t("dashboard.cardCreateInvoiceDesc")}</p>
            </CardContent>
          </Card>
          <Card className="cursor-pointer hover:shadow-lg transition-shadow" onClick={() => router.push("/dashboard/invoices")}>
            <CardHeader>
              <CardTitle>{t("dashboard.cardInvoiceTitle")}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-gray-600 dark:text-gray-300">{t("dashboard.cardInvoiceDesc")}</p>
            </CardContent>
          </Card>
          <Card className="cursor-pointer hover:shadow-lg transition-shadow" onClick={() => router.push("/dashboard/customers")}>
            <CardHeader>
              <CardTitle>{t("dashboard.cardCustomerTitle")}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-gray-600 dark:text-gray-300">{t("dashboard.cardCustomerDesc")}</p>
            </CardContent>
          </Card>
          <Card className="cursor-pointer hover:shadow-lg transition-shadow" onClick={() => router.push("/dashboard/products")}>
            <CardHeader>
              <CardTitle>{t("dashboard.cardProductTitle")}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-gray-600 dark:text-gray-300">{t("dashboard.cardProductDesc")}</p>
            </CardContent>
          </Card>
          {/* Bulk import — sits next to Products and
              Customers because that's the primary use
              case ("I have 200 customers in a CSV, just
              import them"). Tier 13. */}
          <Card className="cursor-pointer hover:shadow-lg transition-shadow" onClick={() => router.push("/dashboard/import")}>
            <CardHeader>
              <CardTitle>📥 {t("import.title") || "Bulk-Import"}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-gray-600 dark:text-gray-300">{t("import.subtitle") || "CSV-Import für Kunden, Produkte und Eingangsrechnungen"}</p>
            </CardContent>
          </Card>
          {/* Inventory card — placed right after Products
              because the inventory is per-product (you
              adjust stock on a product, see a list of
              products that are below their threshold, and
              view the stock-change history). The backend
              /dashboard/inventory page has been there
              for a while (with its own /api/v1/inventory
              routes) but it was previously only reachable
              via the URL — no nav entry. This card fixes
              that. */}
          <Card className="cursor-pointer hover:shadow-lg transition-shadow" onClick={() => router.push("/dashboard/inventory")}>
            <CardHeader>
              <CardTitle>{t("dashboard.cardInventoryTitle")}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-gray-600 dark:text-gray-300">{t("dashboard.cardInventoryDesc")}</p>
            </CardContent>
          </Card>
          <Card className="cursor-pointer hover:shadow-lg transition-shadow" onClick={() => router.push("/dashboard/accounting")}>
            <CardHeader>
              <CardTitle>{t("dashboard.cardAccountingTitle")}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-gray-600 dark:text-gray-300">{t("dashboard.cardAccountingDesc")}</p>
            </CardContent>
          </Card>
          <Card className="cursor-pointer hover:shadow-lg transition-shadow" onClick={() => router.push("/dashboard/reports")}>
            <CardHeader>
              <CardTitle>{t("dashboard.cardReportsTitle")}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-gray-600 dark:text-gray-300">{t("dashboard.cardReportsDesc")}</p>
            </CardContent>
          </Card>
          <Card
            className="cursor-pointer hover:shadow-lg transition-shadow"
            onClick={() => router.push("/dashboard/cashflow")}
            data-testid="dashboard-card-cashflow"
          >
            <CardHeader>
              <CardTitle className="text-blue-600 dark:text-blue-400">
                💧 {t("cashflow.cardCashflowTitle")}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-gray-600 dark:text-gray-300">{t("cashflow.cardCashflowDesc")}</p>
            </CardContent>
          </Card>
          <Card className="cursor-pointer hover:shadow-lg transition-shadow" onClick={() => router.push("/dashboard/cost-center-report")}>
            <CardHeader>
              <CardTitle>{t("nav.costCenterReport")}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-gray-600 dark:text-gray-300">{t("costCenterReport.subtitle")}</p>
            </CardContent>
          </Card>
          <Card className="cursor-pointer hover:shadow-lg transition-shadow" onClick={() => router.push("/dashboard/reminders")}>
            <CardHeader>
              <CardTitle className="text-red-600 dark:text-red-400">{t("dashboard.cardRemindersTitle")}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-gray-600 dark:text-gray-300">{t("dashboard.cardRemindersDesc")}</p>
            </CardContent>
          </Card>
          <Card className="cursor-pointer hover:shadow-lg transition-shadow" onClick={() => router.push("/dashboard/system-errors")}>
            <CardHeader>
              <CardTitle className="text-orange-600 dark:text-orange-400">{t("dashboard.cardSystemErrorsTitle")}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-gray-600 dark:text-gray-300">{t("dashboard.cardSystemErrorsDesc")}</p>
            </CardContent>
          </Card>
          <Card className="cursor-pointer hover:shadow-lg transition-shadow" onClick={() => router.push("/dashboard/system-health")} data-testid="dashboard-card-system-health">
            <CardHeader>
              <CardTitle className="text-emerald-600 dark:text-emerald-400">{t("dashboard.cardSystemHealthTitle")}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-gray-600 dark:text-gray-300">{t("dashboard.cardSystemHealthDesc")}</p>
            </CardContent>
          </Card>
          <Card className="cursor-pointer hover:shadow-lg transition-shadow" onClick={() => router.push("/dashboard/backups")} data-testid="dashboard-card-backups">
            <CardHeader>
              <CardTitle className="text-cyan-600 dark:text-cyan-400">{t("dashboard.cardBackupsTitle")}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-gray-600 dark:text-gray-300">{t("dashboard.cardBackupsDesc")}</p>
            </CardContent>
          </Card>
          <Card className="cursor-pointer hover:shadow-lg transition-shadow" onClick={() => router.push("/dashboard/audit")} data-testid="dashboard-card-audit">
            <CardHeader>
              <CardTitle className="text-purple-600 dark:text-purple-400">{t("dashboard.cardAuditTitle")}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-gray-600 dark:text-gray-300">{t("dashboard.cardAuditDesc")}</p>
            </CardContent>
          </Card>
          <Card className="cursor-pointer hover:shadow-lg transition-shadow" onClick={() => router.push("/dashboard/activity")} data-testid="dashboard-card-activity">
            <CardHeader>
              <CardTitle className="text-rose-600 dark:text-rose-400">{t("dashboard.cardActivityTitle")}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-gray-600 dark:text-gray-300">{t("dashboard.cardActivityDesc")}</p>
            </CardContent>
          </Card>
          <Card className="cursor-pointer hover:shadow-lg transition-shadow" onClick={() => router.push("/dashboard/security")}>
            <CardHeader>
              <CardTitle className="text-blue-600 dark:text-blue-400">{t("dashboard.cardSecurityTitle")}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-gray-600 dark:text-gray-300">{t("dashboard.cardSecurityDesc")}</p>
            </CardContent>
          </Card>
          <Card className="cursor-pointer hover:shadow-lg transition-shadow" onClick={() => router.push("/dashboard/email")}>
            <CardHeader>
              <CardTitle>{t("dashboard.cardEmailTitle")}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-gray-600 dark:text-gray-300">{t("dashboard.cardEmailDesc")}</p>
            </CardContent>
          </Card>
          <Card className="cursor-pointer hover:shadow-lg transition-shadow" onClick={() => router.push("/dashboard/recurring-invoices")} data-testid="dashboard-card-recurring">
            <CardHeader>
              <CardTitle>{t("dashboard.cardRecurringTitle")}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-gray-600 dark:text-gray-300 mb-2">{t("dashboard.cardRecurringDesc")}</p>
              {/* Tier 63: live counts. Falls back to em-dash
                  while the /stats fetch is in flight or if
                  it failed. The "due this week" badge is
                  the most actionable — the user wants to
                  know "do I have anything to review today?"
                  without opening the page. */}
              <div className="flex items-center gap-3 text-sm flex-wrap" data-testid="dashboard-recurring-stats">
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200 font-medium" data-testid="dashboard-recurring-active">
                  <span aria-hidden>●</span>
                  {recurringStats
                    ? t("dashboard.recurringActive", { count: recurringStats.active })
                    : "—"}
                </span>
                {recurringStats && recurringStats.dueThisWeek > 0 && (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200 font-medium" data-testid="dashboard-recurring-due">
                    {t("dashboard.recurringDueThisWeek", { count: recurringStats.dueThisWeek })}
                  </span>
                )}
                {recurringStats && recurringStats.failedLast30Days > 0 && (
                  <span
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200 font-medium"
                    data-testid="dashboard-recurring-failed"
                    title={t("dashboard.recurringFailedTitle") || "Letzte 30 Tage fehlgeschlagen"}
                  >
                    ! {t("dashboard.recurringFailed", { count: recurringStats.failedLast30Days })}
                  </span>
                )}
              </div>
            </CardContent>
          </Card>
          <Card className="cursor-pointer hover:shadow-lg transition-shadow" onClick={() => router.push("/dashboard/cashbook")}>
            <CardHeader>
              <CardTitle className="text-emerald-700">{t("dashboard.cardCashbookTitle")}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-gray-600 dark:text-gray-300">{t("dashboard.cardCashbookDesc")}</p>
            </CardContent>
          </Card>
          <Card className="cursor-pointer hover:shadow-lg transition-shadow" onClick={() => router.push("/dashboard/bank-import")}>
            <CardHeader>
              <CardTitle className="text-blue-700 dark:text-blue-300">{t("dashboard.cardBankImportTitle")}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-gray-600 dark:text-gray-300">{t("dashboard.cardBankImportDesc")}</p>
            </CardContent>
          </Card>
          <Card className="cursor-pointer hover:shadow-lg transition-shadow" onClick={() => router.push("/dashboard/banking")}>
            <CardHeader>
              <CardTitle className="text-blue-700 dark:text-blue-300">{t("dashboard.cardBankingTitle")}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-gray-600 dark:text-gray-300">{t("dashboard.cardBankingDesc")}</p>
            </CardContent>
          </Card>
          <Card className="cursor-pointer hover:shadow-lg transition-shadow" onClick={() => router.push("/dashboard/invoice-templates")}>
            <CardHeader>
              <CardTitle className="text-blue-700 dark:text-blue-300">{t("invoiceTemplates.title")}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-gray-600 dark:text-gray-300">{t("invoiceTemplates.subtitle")}</p>
            </CardContent>
          </Card>
          <Card className="cursor-pointer hover:shadow-lg transition-shadow" onClick={() => router.push("/dashboard/suppliers")}>
            <CardHeader>
              <CardTitle className="text-orange-700 dark:text-orange-300">{t("dashboard.cardSuppliersTitle")}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-gray-600 dark:text-gray-300">{t("dashboard.cardSuppliersDesc")}</p>
            </CardContent>
          </Card>
          <Card className="cursor-pointer hover:shadow-lg transition-shadow" onClick={() => router.push("/dashboard/accounting")}>
            <CardHeader>
              <CardTitle className="text-emerald-700">{t("dashboard.cardVouchersTitle")}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-gray-600 dark:text-gray-300">{t("dashboard.cardVouchersDesc")}</p>
            </CardContent>
          </Card>
          <Card className="cursor-pointer hover:shadow-lg transition-shadow" onClick={() => router.push("/dashboard/expenses")}>
            <CardHeader>
              <CardTitle className="text-red-700 dark:text-red-300">{t("dashboard.cardExpensesTitle")}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-gray-600 dark:text-gray-300">{t("dashboard.cardExpensesDesc")}</p>
            </CardContent>
          </Card>
          <Card className="cursor-pointer hover:shadow-lg transition-shadow" onClick={() => router.push("/dashboard/payments")} data-testid="dashboard-card-payments">
            <CardHeader>
              <CardTitle className="text-teal-700 dark:text-teal-300">{t("payments.cardTitle")}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-gray-600 dark:text-gray-300">{t("payments.cardDesc")}</p>
            </CardContent>
          </Card>
          {/* Tier 112: SEPA pain.008 (Lastschrift / incoming
              direct debits) — the customer-side counterpart to
              the pain.001 "Sammelüberweisung" card above. The
              user creates SEPA-Lastschriftmandate, picks open
              invoices, and produces a pain.008 XML for the
              house bank. Sits next to its sibling for natural
              visual grouping. */}
          <Card className="cursor-pointer hover:shadow-lg transition-shadow" onClick={() => router.push("/dashboard/payments/direct-debit")} data-testid="dashboard-card-direct-debit">
            <CardHeader>
              <CardTitle className="text-indigo-700 dark:text-indigo-300">{t("directDebit.title")}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-gray-600 dark:text-gray-300">{t("directDebit.subtitle")}</p>
            </CardContent>
          </Card>
          <Card className="cursor-pointer hover:shadow-lg transition-shadow" onClick={() => router.push("/dashboard/settings")}>
            <CardHeader>
              <CardTitle>{t("dashboard.cardSettingsTitle")}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-gray-600 dark:text-gray-300">{t("dashboard.cardSettingsDesc")}</p>
            </CardContent>
          </Card>
        </div>
      </div>
    </main>
  )
}
