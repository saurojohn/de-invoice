"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import LanguageSwitcher from "@/components/LanguageSwitcher"
import { RevenueChart } from "@/components/RevenueChart"
import { useI18n } from "@/components/useI18n"

interface DashboardStats {
  totalInvoices: number
  pendingAmount: number
  overdueAmount: number
  paidAmount: number
}

export default function DashboardPage() {
  const router = useRouter()
  const { t } = useI18n()
  const [stats, setStats] = useState<DashboardStats | null>(null)
  const [monthlyRevenue, setMonthlyRevenue] = useState<Array<{ month: string; totalAmount: number; invoiceCount?: number }>>([])
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

    Promise.all([
      fetch(`http://localhost:3001/api/v1/invoices?companyId=${companyId}`).then(r => r.json()),
      fetch(`http://localhost:3001/api/v1/companies/${companyId}`).then(r => r.json()),
      fetch(`http://localhost:3001/api/v1/reports/sales?companyId=${companyId}&startDate=${startDate}&endDate=${endDate}`).then(r => r.json()),
    ])
      .then(([invoices, _company, salesReport]) => {
        const total = (invoices || []).reduce(
          (sum: number, inv: any) => sum + Number(inv.total || 0),
          0
        )
        const pending = (invoices || [])
          .filter((inv: any) => inv.status === "sent" || inv.status === "draft")
          .reduce((sum: number, inv: any) => sum + Number(inv.total || 0), 0)
        const overdue = (invoices || [])
          .filter((inv: any) => inv.status === "overdue")
          .reduce((sum: number, inv: any) => sum + Number(inv.total || 0), 0)
        const paid = (invoices || [])
          .filter((inv: any) => inv.status === "paid")
          .reduce((sum: number, inv: any) => sum + Number(inv.total || 0), 0)

        setStats({
          totalInvoices: (invoices || []).length,
          pendingAmount: pending,
          overdueAmount: overdue,
          paidAmount: paid,
        })
        setMonthlyRevenue(salesReport?.byMonth || [])
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [router])

  return (
    <main className="min-h-screen bg-gray-50">
      <header className="bg-white border-b shadow-sm">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <h1 className="text-2xl font-bold text-blue-600">{t("dashboard.title")}</h1>
          <div className="flex items-center gap-4">
            <LanguageSwitcher />
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
        {/* Stats Cards */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
          <Card>
            <CardContent className="pt-6">
              <div className="text-3xl font-bold text-blue-600">{stats?.totalInvoices || 0}</div>
              <div className="text-gray-500 mt-1">{t("dashboard.totalInvoices")}</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="text-3xl font-bold text-yellow-600">€{(stats?.pendingAmount || 0).toFixed(2)}</div>
              <div className="text-gray-500 mt-1">{t("dashboard.pending")}</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="text-3xl font-bold text-red-600">€{(stats?.overdueAmount || 0).toFixed(2)}</div>
              <div className="text-gray-500 mt-1">{t("dashboard.overdue")}</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="text-3xl font-bold text-green-600">€{(stats?.paidAmount || 0).toFixed(2)}</div>
              <div className="text-gray-500 mt-1">{t("dashboard.paid")}</div>
            </CardContent>
          </Card>
        </div>

        {/* Revenue trend (last 12 months) */}
        <Card className="mb-8">
          <CardHeader>
            <CardTitle>Umsatzentwicklung (letzte 12 Monate)</CardTitle>
          </CardHeader>
          <CardContent>
            <RevenueChart data={monthlyRevenue} height={220} />
          </CardContent>
        </Card>

        {/* Quick Actions */}
        <h2 className="text-xl font-semibold mb-4">{t("dashboard.quickActions")}</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
          <Card
            className="cursor-pointer hover:shadow-lg transition-shadow border-blue-300 bg-blue-50/50"
            onClick={() => router.push("/dashboard/invoices/create")}
          >
            <CardHeader>
              <CardTitle className="text-blue-700 flex items-center gap-2">
                <span className="text-2xl leading-none">+</span>
                {t("dashboard.cardCreateInvoiceTitle")}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-gray-600">{t("dashboard.cardCreateInvoiceDesc")}</p>
            </CardContent>
          </Card>
          <Card className="cursor-pointer hover:shadow-lg transition-shadow" onClick={() => router.push("/dashboard/invoices")}>
            <CardHeader>
              <CardTitle>{t("dashboard.cardInvoiceTitle")}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-gray-600">{t("dashboard.cardInvoiceDesc")}</p>
            </CardContent>
          </Card>
          <Card className="cursor-pointer hover:shadow-lg transition-shadow" onClick={() => router.push("/dashboard/customers")}>
            <CardHeader>
              <CardTitle>{t("dashboard.cardCustomerTitle")}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-gray-600">{t("dashboard.cardCustomerDesc")}</p>
            </CardContent>
          </Card>
          <Card className="cursor-pointer hover:shadow-lg transition-shadow" onClick={() => router.push("/dashboard/products")}>
            <CardHeader>
              <CardTitle>{t("dashboard.cardProductTitle")}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-gray-600">{t("dashboard.cardProductDesc")}</p>
            </CardContent>
          </Card>
          <Card className="cursor-pointer hover:shadow-lg transition-shadow" onClick={() => router.push("/dashboard/accounting")}>
            <CardHeader>
              <CardTitle>{t("dashboard.cardAccountingTitle")}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-gray-600">{t("dashboard.cardAccountingDesc")}</p>
            </CardContent>
          </Card>
          <Card className="cursor-pointer hover:shadow-lg transition-shadow" onClick={() => router.push("/dashboard/reports")}>
            <CardHeader>
              <CardTitle>{t("dashboard.cardReportsTitle")}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-gray-600">{t("dashboard.cardReportsDesc")}</p>
            </CardContent>
          </Card>
          <Card className="cursor-pointer hover:shadow-lg transition-shadow" onClick={() => router.push("/dashboard/reminders")}>
            <CardHeader>
              <CardTitle className="text-red-600">{t("dashboard.cardRemindersTitle")}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-gray-600">{t("dashboard.cardRemindersDesc")}</p>
            </CardContent>
          </Card>
          <Card className="cursor-pointer hover:shadow-lg transition-shadow" onClick={() => router.push("/dashboard/settings")}>
            <CardHeader>
              <CardTitle>{t("dashboard.cardSettingsTitle")}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-gray-600">{t("dashboard.cardSettingsDesc")}</p>
            </CardContent>
          </Card>
        </div>
      </div>
    </main>
  )
}
