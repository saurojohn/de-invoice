"use client"

// Tier 46: Cost-Center Transactions drill-in.
//
// Final drill level: shows the actual invoices +
// expenses that contribute to a single (year, month,
// cost-center) bucket. Reached via
// /cost-center-report/[year]/[month]/[costCenter].
//
// The cc param is URL-encoded by the linker because
// "Nicht zugewiesen" has a space in it — Next.js
// decodes the route segment automatically so
// params.costCenter comes through as the raw string.

import { useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { useParams } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import LanguageSwitcher from "@/components/LanguageSwitcher"
import { ThemeToggle } from "@/components/ThemeToggle"
import { useI18n } from "@/components/useI18n"
import { apiGet } from "@/lib/api"

interface Tx {
  kind: "invoice" | "expense"
  id: string
  date: string
  number: string
  counterparty: string
  amount: number
  vat: number
  currency: string
  status: string
}

interface TxReport {
  year: number
  month: number
  costCenter: string
  transactions: Tx[]
  totals: {
    revenue: number
    expense: number
    ust: number
    vorsteuer: number
    invoiceCount: number
    expenseCount: number
    invoiceTotal: number
    expenseTotal: number
  }
  pagination: { take: number; skip: number; hasMore: boolean }
}

const eur = (n: number): string =>
  new Intl.NumberFormat("de-DE", {
    style: "currency",
    currency: "EUR",
  }).format(n || 0)

/** Format an ISO date as dd.mm.yyyy (German). */
const fmtDate = (iso: string): string => {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  const day = String(d.getUTCDate()).padStart(2, "0")
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0")
  return `${day}.${mo}.${d.getUTCFullYear()}`
}

export default function CostCenterTransactionsPage() {
  const { t } = useI18n()
  const params = useParams<{
    year: string
    month: string
    costCenter: string
  }>()
  const yearNum = Number(params.year)
  const monthNum = Number(params.month)
  // Next.js does NOT auto-decode path segments on the
  // App Router — params.costCenter comes through with
  // URL-encoded characters intact ("Nicht%20zugewiesen"
  // rather than "Nicht zugewiesen"). We decode here so
  // the page title and the API query string both get
  // the human-readable label. The API endpoint
  // (/cost-center-transactions) URL-decodes its
  // `costCenter` query param by default, but we also
  // encodeURIComponent the value before sending to be
  // safe across routes.
  const costCenterRaw = (() => {
    try {
      return decodeURIComponent(params.costCenter || "")
    } catch {
      return params.costCenter || ""
    }
  })()

  const companyId =
    typeof window !== "undefined"
      ? localStorage.getItem("companyId") || ""
      : ""

  const [report, setReport] = useState<TxReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [skip, setSkip] = useState(0)
  const [loadingMore, setLoadingMore] = useState(false)
  const take = 50

  useEffect(() => {
    if (!companyId) return
    if (
      !Number.isFinite(yearNum) ||
      yearNum < 2000 ||
      yearNum > 2100
    ) {
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
    setSkip(0)
    apiGet<TxReport>(
      `/api/v1/reports/cost-center-transactions?companyId=${companyId}&year=${yearNum}&month=${monthNum}&costCenter=${encodeURIComponent(
        costCenterRaw,
      )}&take=${take}&skip=0`,
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
  }, [companyId, yearNum, monthNum, costCenterRaw])

  const monthShort = useMemo(() => {
    const arr = (t("costCenterReport.monthShort") as unknown) as string[]
    if (Array.isArray(arr) && arr.length === 12) return arr
    return ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"]
  }, [t])

  const monthName = monthShort[monthNum - 1] || String(monthNum)

  // Title + subtitle use the same {costCenter} / {month}
  // / {year} placeholder convention as the rest of the
  // report series.
  const title = (t("costCenterReport.txTitle") as string)
    .replace("{costCenter}", costCenterRaw)
    .replace("{month}", monthName)
    .replace("{year}", String(yearNum))
  const subtitle = (t("costCenterReport.txSubtitle") as string)
    .replace("{costCenter}", costCenterRaw)
    .replace("{month}", monthName)
    .replace("{year}", String(yearNum))

  const loadMore = async () => {
    if (!report) return
    setLoadingMore(true)
    try {
      const next = await apiGet<TxReport>(
        `/api/v1/reports/cost-center-transactions?companyId=${companyId}&year=${yearNum}&month=${monthNum}&costCenter=${encodeURIComponent(
          costCenterRaw,
        )}&take=${take}&skip=${skip + take}`,
      )
      setReport({
        ...next,
        transactions: [...report.transactions, ...next.transactions],
      })
      setSkip(skip + take)
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setLoadingMore(false)
    }
  }

  const totalRows = report
    ? report.totals.invoiceTotal + report.totals.expenseTotal
    : 0
  const shownFrom = report ? report.transactions.length > 0 ? 1 : 0 : 0
  const shownTo = report ? report.transactions.length : 0

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
            {subtitle}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Link
            href={`/dashboard/cost-center-report/${yearNum}/${monthNum}`}
            className="text-sm text-gray-600 dark:text-gray-300 hover:underline"
            data-testid="back-to-monthly"
          >
            ← {t("costCenterReport.backToYear")
              .replace(/Zurück zur Jahresauswertung|Back to yearly report|返回年度报表/g, "")
              .replace(/←\s*/, "")
              .trim() || "Back"}
          </Link>
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
        {report && report.transactions.length === 0 && !loading && (
          <div className="text-sm text-gray-500 dark:text-gray-400 py-8 text-center">
            {t("costCenterReport.txEmpty")}
          </div>
        )}
        {report && report.transactions.length > 0 && (
          <>
            {/* Totals strip — mirrors the monthly page's
                bottom totals row, but inline at the top so
                the user sees the bucket total before
                scrolling through the line list. */}
            <Card>
              <CardContent className="p-4">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                  <div>
                    <div className="text-xs uppercase text-gray-500">
                      {t("costCenterReport.colRevenue")}
                    </div>
                    <div className="font-mono mt-1">
                      {eur(report.totals.revenue)}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs uppercase text-gray-500">
                      {t("costCenterReport.colExpense")}
                    </div>
                    <div className="font-mono mt-1">
                      {eur(report.totals.expense)}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs uppercase text-gray-500">
                      {t("costCenterReport.colUst")}
                    </div>
                    <div className="font-mono mt-1">
                      {eur(report.totals.ust)}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs uppercase text-gray-500">
                      {t("costCenterReport.colVorsteuer")}
                    </div>
                    <div className="font-mono mt-1">
                      {eur(report.totals.vorsteuer)}
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-0 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left border-b border-gray-200 dark:border-gray-700 text-xs uppercase text-gray-500">
                      <th className="py-3 px-4">
                        {t("costCenterReport.txColDate")}
                      </th>
                      <th className="py-3 px-4">
                        {t("costCenterReport.txColType")}
                      </th>
                      <th className="py-3 px-4">
                        {t("costCenterReport.txColNumber")}
                      </th>
                      <th className="py-3 px-4">
                        {t("costCenterReport.txColCounterparty")}
                      </th>
                      <th className="py-3 px-4 text-right">
                        {t("costCenterReport.txColAmount")}
                      </th>
                      <th className="py-3 px-4 text-right">
                        {t("costCenterReport.txColVat")}
                      </th>
                      <th className="py-3 px-4">
                        {t("costCenterReport.txColStatus")}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.transactions.map((tx) => (
                      <tr
                        key={`${tx.kind}-${tx.id}`}
                        className="border-b border-gray-100 dark:border-gray-800"
                        data-testid="cc-tx-row"
                      >
                        <td
                          className="py-2 px-4 font-mono"
                          data-testid="cc-tx-date"
                        >
                          {fmtDate(tx.date)}
                        </td>
                        <td className="py-2 px-4">
                          {tx.kind === "invoice"
                            ? t("costCenterReport.txKindInvoice")
                            : t("costCenterReport.txKindExpense")}
                        </td>
                        <td className="py-2 px-4 font-mono">
                          {tx.number || "—"}
                        </td>
                        <td
                          className="py-2 px-4"
                          data-testid="cc-tx-counterparty"
                        >
                          {tx.counterparty || "—"}
                        </td>
                        <td
                          className={`py-2 px-4 text-right font-mono ${tx.kind === "expense" ? "text-rose-600 dark:text-rose-400" : "text-emerald-600 dark:text-emerald-400"}`}
                          data-testid="cc-tx-amount"
                        >
                          {tx.kind === "expense" ? "−" : "+"}
                          {eur(tx.amount)}
                        </td>
                        <td className="py-2 px-4 text-right font-mono text-xs">
                          {eur(tx.vat)}
                        </td>
                        <td className="py-2 px-4">
                          <span className="inline-block px-2 py-0.5 rounded text-xs bg-gray-100 dark:bg-gray-700">
                            {tx.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>

            {/* Pagination strip */}
            <div className="flex items-center justify-between text-sm">
              <div className="text-gray-500 dark:text-gray-400">
                {(t("costCenterReport.txPagination") as string)
                  .replace("{from}", String(shownFrom))
                  .replace("{to}", String(shownTo))
                  .replace("{total}", String(totalRows))}
              </div>
              {report.pagination.hasMore && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={loadMore}
                  disabled={loadingMore}
                  data-testid="cc-load-more"
                >
                  {loadingMore
                    ? "…"
                    : t("costCenterReport.txLoadMore")}
                </Button>
              )}
            </div>
          </>
        )}
      </main>
    </div>
  )
}