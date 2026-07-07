"use client"

// Tier 44: Kostenstellen-Jahresauswertung.
//
// Renders GET /reports/cost-center-yearly?companyId=X&year=YYYY as:
//   - Year filter (top-left, default current year)
//   - CSV export button (top-right)
//   - One table per cost-center row with 12 monthly cells
//     showing the net amount (revenue − expense). Positive
//     green-ish, negative red-ish. Totals row at the bottom.
//
// The page reuses the same dark-mode + i18n pattern as
// dashboard/v2. All UI labels go through useI18n. The
// CSV export is hand-built (just text/csv with ; as a
// separator — German Excel defaults to ; so ; is the
// pragmatic choice without dragging in papaparse).

import { useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
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
  monthly: number[]
}

interface CostCenterReport {
  year: number
  rows: CostCenterRow[]
  totals: CostCenterRow
  generatedAt: string
}

const eur = (n: number): string =>
  new Intl.NumberFormat("de-DE", {
    style: "currency",
    currency: "EUR",
  }).format(n || 0)

/** Render a delta with the right sign for German accounting
 *  culture — negatives in parentheses, positives prefixed
 *  with "+". Matches the dashboard-v2 monthly-bar style. */
const signed = (n: number): string => {
  if (n === 0) return eur(0)
  const sign = n > 0 ? "+" : "−"
  return `${sign}${eur(Math.abs(n))}`
}

/**
 * Build the CSV payload. Header row + per-cc rows +
 * totals. German Excel's default separator is `;` so
 * we use that and quote every field (handles ;, " and
 * newlines inside cost-center names). Encoding is
 * UTF-8 with a BOM so Excel double-click on macOS
 * opens it correctly without mojibake.
 */
function buildCsv(report: CostCenterReport, monthShort: string[]): string {
  const headers = [
    "Kostenstelle",
    "Erlöse (brutto)",
    "Aufwand (brutto)",
    "Netto",
    "USt",
    "Vorsteuer",
    "Anzahl Rechnungen",
    "Anzahl Belege",
    ...monthShort,
  ]
  const rows = report.rows.map((r) => [
    r.costCenter,
    r.revenue.toFixed(2).replace(".", ","),
    r.expense.toFixed(2).replace(".", ","),
    r.net.toFixed(2).replace(".", ","),
    r.ust.toFixed(2).replace(".", ","),
    r.vorsteuer.toFixed(2).replace(".", ","),
    r.invoiceCount.toString(),
    r.expenseCount.toString(),
    ...r.monthly.map((v) => v.toFixed(2).replace(".", ",")),
  ])
  const t = report.totals
  const totalRow = [
    "Summe",
    t.revenue.toFixed(2).replace(".", ","),
    t.expense.toFixed(2).replace(".", ","),
    t.net.toFixed(2).replace(".", ","),
    t.ust.toFixed(2).replace(".", ","),
    t.vorsteuer.toFixed(2).replace(".", ","),
    t.invoiceCount.toString(),
    t.expenseCount.toString(),
    ...t.monthly.map((v) => v.toFixed(2).replace(".", ",")),
  ]
  const all = [headers, ...rows, totalRow]
  const escape = (v: string) =>
    /[";\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
  return all.map((row) => row.map(escape).join(";")).join("\n")
}

export default function CostCenterReportPage() {
  const { t, locale } = useI18n()
  const [year, setYear] = useState<number>(new Date().getFullYear())
  const [report, setReport] = useState<CostCenterReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const companyId =
    typeof window !== "undefined"
      ? localStorage.getItem("companyId") || ""
      : ""

  useEffect(() => {
    if (!companyId) return
    let cancelled = false
    setLoading(true)
    setError(null)
    apiGet<CostCenterReport>(
      `/api/v1/reports/cost-center-yearly?companyId=${companyId}&year=${year}`,
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
  }, [companyId, year])

  // German number format on the table cells. Don't pre-
  // render Intl — we re-derive on each render anyway.
  const monthShort = useMemo(() => {
    const arr = (t("costCenterReport.monthShort") as unknown) as string[]
    if (Array.isArray(arr) && arr.length === 12) return arr
    // Fallback if i18n missing the array — DE short names.
    return ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"]
  }, [t, locale])

  const title = (t("costCenterReport.title") as string).replace(
    "{year}",
    String(year),
  )

  const exportCsv = () => {
    if (!report) return
    const csv = buildCsv(report, monthShort)
    // Prepend BOM so Excel recognises UTF-8.
    const blob = new Blob(["\ufeff" + csv], {
      type: "text/csv;charset=utf-8",
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `kostenstellen-auswertung-${year}.csv`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <header className="border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
            {title}
          </h1>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 max-w-2xl">
            {t("costCenterReport.subtitle")}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Link
            href="/dashboard/reports"
            className="text-sm text-gray-600 dark:text-gray-300 hover:underline"
          >
            ← {t("nav.reports")}
          </Link>
          <LanguageSwitcher />
          <ThemeToggle />
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8 space-y-6">
        {/* Filters + actions */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-base">
              {t("costCenterReport.filterYear")}
            </CardTitle>
            <div className="flex items-center gap-2">
              <select
                data-testid="cc-year-select"
                value={year}
                onChange={(e) => setYear(Number(e.target.value))}
                className="border rounded px-2 py-1 text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100"
              >
                {Array.from({ length: 5 }).map((_, i) => {
                  const y = new Date().getFullYear() - i
                  return (
                    <option key={y} value={y}>
                      {y}
                    </option>
                  )
                })}
              </select>
              <Button
                variant="outline"
                onClick={exportCsv}
                disabled={!report}
                data-testid="cc-export-csv"
              >
                {t("costCenterReport.exportCsv")}
              </Button>
            </div>
          </CardHeader>
        </Card>

        {/* Body */}
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
                    <th className="py-3 px-4 sticky left-0 bg-white dark:bg-gray-800">
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
                    {monthShort.map((m) => (
                      <th
                        key={m}
                        className="py-3 px-2 text-right text-[10px] font-mono"
                        title={m}
                      >
                        {m}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {report.rows.map((r) => (
                    <tr
                      key={r.costCenter}
                      className="border-b border-gray-100 dark:border-gray-800"
                      data-testid="cc-row"
                    >
                      <td
                        className="py-2 px-4 sticky left-0 bg-white dark:bg-gray-800 font-medium"
                        data-testid="cc-row-name"
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
                        data-testid="cc-row-net"
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
                      {r.monthly.map((v, i) => (
                        <td
                          key={i}
                          className={`py-2 px-2 text-right font-mono text-xs ${v >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}
                          data-testid="cc-row-month"
                        >
                          {/* Tier 45: wrap the value in a
                              Link to the monthly drill-in.
                              We only render the link when
                              v !== 0 — a click on an empty
                              cell would just land on an
                              empty monthly report. The
                              rowIndex in the testid makes
                              month-cells selector-targetable
                              in Playwright. */}
                          {v === 0 ? (
                            <span className="text-gray-300 dark:text-gray-600">
                              —
                            </span>
                          ) : (
                            <Link
                              href={`/dashboard/cost-center-report/${year}/${i + 1}`}
                              className="hover:underline focus:outline-none focus:ring-2 focus:ring-blue-500 rounded"
                              data-testid={`cc-row-month-link-${i}`}
                              data-month={i + 1}
                              title={`Drill-in ${monthShort[i]} ${year}`}
                            >
                              {signed(v)}
                            </Link>
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                  {/* Totals row */}
                  <tr
                    className="border-t-2 border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-900 font-semibold"
                    data-testid="cc-row-total"
                  >
                    <td className="py-2 px-4 sticky left-0 bg-gray-50 dark:bg-gray-900">
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
                      data-testid="cc-totals-net"
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
                    {report.totals.monthly.map((v, i) => (
                      <td
                        key={i}
                        className={`py-2 px-2 text-right font-mono text-xs ${v >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}
                      >
                        {v === 0 ? "" : signed(v)}
                      </td>
                    ))}
                  </tr>
                </tbody>
              </table>
            </CardContent>
          </Card>
        )}
      </main>
    </div>
  )
}