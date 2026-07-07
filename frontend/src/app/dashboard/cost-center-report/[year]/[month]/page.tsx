"use client"

// Tier 45: Cost-Center Monthly drill-in.
//
// Companion to /cost-center-report (tier-44). Reached
// via /cost-center-report/[year]/[month] (1-indexed
// month: 1 = Jan, 12 = Dec). The yearly page links
// each month-cell to this route.
//
// Renders a single-month table with the same shape
// as the yearly rows (revenue / expense / net / ust /
// vorsteuer / counts) but without the per-month
// buckets — there's only one month here.

import { useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { useParams, useRouter } from "next/navigation"
import { Card, CardContent } from "@/components/ui/card"
import LanguageSwitcher from "@/components/LanguageSwitcher"
import { ThemeToggle } from "@/components/ThemeToggle"
import { useI18n } from "@/components/useI18n"
import { apiGet } from "@/lib/api"

interface CostCenterRow {
  costCenter: string
  revenue: number
  expense: number
  net: number
  ust: number
  vorsteuer: number
  invoiceCount: number
  expenseCount: number
}

interface MonthlyReport {
  year: number
  month: number
  rows: CostCenterRow[]
  totals: CostCenterRow
  generatedAt: string
}

const eur = (n: number): string =>
  new Intl.NumberFormat("de-DE", {
    style: "currency",
    currency: "EUR",
  }).format(n || 0)

const signed = (n: number): string => {
  if (n === 0) return eur(0)
  const sign = n > 0 ? "+" : "−"
  return `${sign}${eur(Math.abs(n))}`
}

export default function CostCenterMonthlyPage() {
  const { t } = useI18n()
  const router = useRouter()
  const params = useParams<{ year: string; month: string }>()
  const yearNum = Number(params.year)
  const monthNum = Number(params.month)

  const companyId =
    typeof window !== "undefined"
      ? localStorage.getItem("companyId") || ""
      : ""

  const [report, setReport] = useState<MonthlyReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!companyId) return
    if (!Number.isFinite(yearNum) || yearNum < 2000 || yearNum > 2100) {
      setError("Ungültiges Jahr")
      setLoading(false)
      return
    }
    if (!Number.isFinite(monthNum) || monthNum < 1 || monthNum > 12) {
      setError("Ungültiger Monat")
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    apiGet<MonthlyReport>(
      `/api/v1/reports/cost-center-monthly?companyId=${companyId}&year=${yearNum}&month=${monthNum}`,
    )
      .then((r) => {
        if (cancelled) return
        setReport(r)
        setLoading(false)
      })
      .catch((e) => {
        if (cancelled) return
        setError(e?.message || String(e))
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [companyId, yearNum, monthNum])

  // Use the same monthShort i18n array as the yearly
  // page so the displayed month name is consistent.
  const monthShort = useMemo(() => {
    const arr = (t("costCenterReport.monthShort") as unknown) as string[]
    if (Array.isArray(arr) && arr.length === 12) return arr
    return ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"]
  }, [t])

  const monthName =
    monthShort[monthNum - 1] || String(monthNum)

  const title = (t("costCenterReport.monthlyTitle") as string)
    .replace("{month}", monthName)
    .replace("{year}", String(yearNum))

  // The page is only mounted when params parse; if a
  // direct hit lands on /cost-center-report/abc/12 we
  // surface the error instead of crashing.
  if (!Number.isFinite(yearNum) || !Number.isFinite(monthNum)) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex items-center justify-center">
        <p className="text-sm text-red-600">Ungültiger URL-Pfad.</p>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <header className="border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
            {title}
          </h1>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 max-w-2xl">
            {t("costCenterReport.monthlySubtitle")}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => router.push("/dashboard/cost-center-report")}
            className="text-sm text-gray-600 dark:text-gray-300 hover:underline"
            data-testid="back-to-yearly"
          >
            {t("costCenterReport.backToYear")}
          </button>
          <LanguageSwitcher />
          <ThemeToggle />
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8 space-y-6">
        {loading && (
          <div className="text-sm text-gray-500 dark:text-gray-400 py-8 text-center">
            {t("costCenterReport.loading")}
          </div>
        )}
        {error && (
          <div className="text-sm text-red-600 dark:text-red-400 py-8 text-center">
            {t("costCenterReport.error")}: {error}
          </div>
        )}
        {report && report.rows.length === 0 && (
          <div className="text-sm text-gray-500 dark:text-gray-400 py-8 text-center">
            {t("costCenterReport.empty")}
          </div>
        )}
        {report && report.rows.length > 0 && (
          <Card>
            <CardContent className="p-0 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left border-b border-gray-200 dark:border-gray-700 text-xs uppercase text-gray-500">
                    <th className="py-3 px-4">
                      {t("costCenterReport.colCostCenter")}
                    </th>
                    <th className="py-3 px-4 text-right">
                      {t("costCenterReport.colRevenue")}
                    </th>
                    <th className="py-3 px-4 text-right">
                      {t("costCenterReport.colExpense")}
                    </th>
                    <th className="py-3 px-4 text-right">
                      {t("costCenterReport.colNet")}
                    </th>
                    <th className="py-3 px-4 text-right">
                      {t("costCenterReport.colUst")}
                    </th>
                    <th className="py-3 px-4 text-right">
                      {t("costCenterReport.colVorsteuer")}
                    </th>
                    <th className="py-3 px-4 text-right">
                      {t("costCenterReport.colInvoices")}
                    </th>
                    <th className="py-3 px-4 text-right">
                      {t("costCenterReport.colExpenses")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {report.rows.map((r) => (
                    <tr
                      key={r.costCenter}
                      className="border-b border-gray-100 dark:border-gray-800"
                      data-testid="cc-monthly-row"
                    >
                      <td
                        className="py-2 px-4 font-medium"
                        data-testid="cc-monthly-row-name"
                      >
                        {r.costCenter}
                      </td>
                      <td className="py-2 px-4 text-right font-mono">
                        {eur(r.revenue)}
                      </td>
                      <td className="py-2 px-4 text-right font-mono">
                        {eur(r.expense)}
                      </td>
                      <td
                        className={`py-2 px-4 text-right font-mono ${r.net >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}
                        data-testid="cc-monthly-row-net"
                      >
                        {signed(r.net)}
                      </td>
                      <td className="py-2 px-4 text-right font-mono">
                        {eur(r.ust)}
                      </td>
                      <td className="py-2 px-4 text-right font-mono">
                        {eur(r.vorsteuer)}
                      </td>
                      <td className="py-2 px-4 text-right font-mono">
                        {r.invoiceCount}
                      </td>
                      <td className="py-2 px-4 text-right font-mono">
                        {r.expenseCount}
                      </td>
                    </tr>
                  ))}
                  <tr
                    className="border-t-2 border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-900 font-semibold"
                    data-testid="cc-monthly-total"
                  >
                    <td className="py-2 px-4">
                      {t("costCenterReport.rowTotal")}
                    </td>
                    <td className="py-2 px-4 text-right font-mono">
                      {eur(report.totals.revenue)}
                    </td>
                    <td className="py-2 px-4 text-right font-mono">
                      {eur(report.totals.expense)}
                    </td>
                    <td
                      className={`py-2 px-4 text-right font-mono ${report.totals.net >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}
                      data-testid="cc-monthly-totals-net"
                    >
                      {signed(report.totals.net)}
                    </td>
                    <td className="py-2 px-4 text-right font-mono">
                      {eur(report.totals.ust)}
                    </td>
                    <td className="py-2 px-4 text-right font-mono">
                      {eur(report.totals.vorsteuer)}
                    </td>
                    <td className="py-2 px-4 text-right font-mono">
                      {report.totals.invoiceCount}
                    </td>
                    <td className="py-2 px-4 text-right font-mono">
                      {report.totals.expenseCount}
                    </td>
                  </tr>
                </tbody>
              </table>
            </CardContent>
          </Card>
        )}

        {/* Back-to-yearly shortcut at the bottom for
            scrolling deep-page users. */}
        {report && (
          <div className="text-center">
            <Link
              href="/dashboard/cost-center-report"
              className="text-sm text-gray-600 dark:text-gray-300 hover:underline"
            >
              {t("costCenterReport.backToYear")}
            </Link>
          </div>
        )}
      </main>
    </div>
  )
}