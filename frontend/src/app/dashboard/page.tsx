"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import LanguageSwitcher from "@/components/LanguageSwitcher"
import { RevenueChart } from "@/components/RevenueChart"
import { ThemeToggle } from "@/components/ThemeToggle"
import { useI18n } from "@/components/useI18n"
import { apiGet } from "@/lib/api"

interface DashboardStats {
  totalInvoices: number
  pendingAmount: number
  overdueAmount: number
  paidAmount: number
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

const fmtMoney = (n: number) =>
  n.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const fmtDate = (s: string | null | undefined, locale = "de-DE") =>
  s ? new Date(s).toLocaleDateString(locale, { day: "2-digit", month: "2-digit", year: "numeric" }) : "—"

export default function DashboardPage() {
  const router = useRouter()
  const { t, getDateLocale } = useI18n()
  const dl = getDateLocale()
  const [stats, setStats] = useState<DashboardStats | null>(null)
  const [kpis, setKpis] = useState<DashboardKpis | null>(null)
  const [monthlyRevenue, setMonthlyRevenue] = useState<Array<{ month: string; totalAmount: number; invoiceCount?: number }>>([])
  const [recentInvoices, setRecentInvoices] = useState<RecentInvoice[]>([])
  const [loading, setLoading] = useState(true)

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
    ])
      .then(([invoiceList, salesReport, dashboardKpis]) => {
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
          paidAmount: paid,
        })
        setMonthlyRevenue(salesReport?.byMonth || [])
        setKpis(dashboardKpis || null)
        setRecentInvoices(invoices.slice(0, 8) as RecentInvoice[])
        setLoading(false)
      })
      .catch((err) => {
        console.error("Dashboard load failed:", err)
        setLoading(false)
      })
  }, [router])

  return (
    <main className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <header className="bg-white dark:bg-gray-800 border-b shadow-sm">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <h1 className="text-2xl font-bold text-blue-600 dark:text-blue-400">{t("dashboard.title")}</h1>
          <div className="flex items-center gap-4">
            <LanguageSwitcher />
            <ThemeToggle />
            <Button variant="outline" onClick={() => {
              localStorage.clear()
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

      <div className="container mx-auto px-4 py-8">
        {/* KPI Tiles — YTD + Month-over-Month change
            indicators. The "change" arrows come from
            the dashboard endpoint's `changes` field
            (thisMonth vs lastMonth). Each tile also
            surfaces the previous-month value in
            muted text so the user has a reference. */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
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
          <Card className="cursor-pointer hover:shadow-lg transition-shadow" onClick={() => router.push("/dashboard/reminders")}>
            <CardHeader>
              <CardTitle className="text-red-600 dark:text-red-400">{t("dashboard.cardRemindersTitle")}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-gray-600 dark:text-gray-300">{t("dashboard.cardRemindersDesc")}</p>
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
          <Card className="cursor-pointer hover:shadow-lg transition-shadow" onClick={() => router.push("/dashboard/recurring-invoices")}>
            <CardHeader>
              <CardTitle>{t("dashboard.cardRecurringTitle")}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-gray-600 dark:text-gray-300">{t("dashboard.cardRecurringDesc")}</p>
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
