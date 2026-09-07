"use client"

import { useEffect, useRef, useState, useCallback } from "react"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { useI18n } from "@/components/useI18n"
import { useToast } from "@/components/useToast"
import { apiGet, ApiError } from "@/lib/api"

interface PnlMonth {
  month: string
  revenue: number
  materialExpenses: number
  otherExpenses: number
  operatingResult: number
  vat: number
  priorYearOperatingResult: number | null
  priorYearChangePercent: number | null
}

interface PnlResult {
  year: number
  months: PnlMonth[]
  ytd: {
    revenue: number
    materialExpenses: number
    otherExpenses: number
    operatingResult: number
    vat: number
  }
  priorYearYtd: {
    revenue: number
    materialExpenses: number
    otherExpenses: number
    operatingResult: number
    vat: number
  }
  generatedAt: string
  counts: { invoices: number; expenses: number }
}

const MONTH_SHORT_DE = [
  "Jan", "Feb", "Mär", "Apr", "Mai", "Jun",
  "Jul", "Aug", "Sep", "Okt", "Nov", "Dez",
]

/**
 * Tier 75: P&L (Gewinn- und Verlustrechnung) tab.
 *
 * Reuses the same patterns as the other reports
 * tabs: a year input + a "Berechnen" button +
 * a table with monthly + YTD rows. The "Vorjahr"
 * column shows the prior-year operatingResult
 * side-by-side with a % change badge.
 */
export function PnlTab() {
  const { t } = useI18n()
  const toast = useToast()
  // Tier 73: useToast/useI18n return fresh objects
  // every render — capture in refs so useCallback
  // deps stay stable.
  const toastRef = useRef(toast)
  toastRef.current = toast
  const tRef = useRef(t)
  tRef.current = t
  const [year, setYear] = useState<number>(new Date().getFullYear())
  const [data, setData] = useState<PnlResult | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async (y: number) => {
    setLoading(true)
    try {
      const companyId =
        typeof window !== "undefined" ? localStorage.getItem("companyId") : null
      const params = new URLSearchParams()
      if (companyId) params.set("companyId", companyId)
      params.set("year", String(y))
      const result = await apiGet<PnlResult>(`/api/v1/reports/pnl?${params}`)
      setData(result)
    } catch (e: any) {
      const msg = e instanceof ApiError ? e.message : tRef.current("common.loadError")
      toastRef.current.error(msg)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load(year)
  }, [year, load])

  const fmt = (n: number) =>
    new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(n)

  return (
    <div className="space-y-4" data-testid="pnl-tab">
      <Card>
        <CardContent className="pt-6">
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">
                {tRef.current("pnl.year")}
              </label>
              <input
                type="number"
                min={2000}
                max={2100}
                value={year}
                onChange={(e) => setYear(Number(e.target.value) || new Date().getFullYear())}
                className="border rounded px-3 py-2 w-32 dark:bg-gray-800 dark:border-gray-700"
                data-testid="pnl-year"
              />
            </div>
            <Button
              onClick={() => load(year)}
              disabled={loading}
              data-testid="pnl-recompute"
            >
              {loading ? "..." : tRef.current("pnl.recompute")}
            </Button>
            {data && (
              <div className="text-xs text-gray-500 ml-auto" data-testid="pnl-counts">
                {tRef.current("pnl.invoices")}: <b>{data.counts.invoices}</b> ·{" "}
                {tRef.current("pnl.expenses")}: <b>{data.counts.expenses}</b>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {data && (
        <Card>
          <CardHeader>
            <CardTitle>
              {tRef.current("pnl.title")} {data.year}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="pnl-table">
                <thead>
                  <tr className="border-b text-xs text-gray-500 uppercase">
                    <th className="text-left py-2">{tRef.current("pnl.month")}</th>
                    <th className="text-right py-2">{tRef.current("pnl.revenue")}</th>
                    <th className="text-right py-2">{tRef.current("pnl.material")}</th>
                    <th className="text-right py-2">{tRef.current("pnl.other")}</th>
                    <th className="text-right py-2">{tRef.current("pnl.operatingResult")}</th>
                    <th className="text-right py-2">{tRef.current("pnl.vat")}</th>
                    <th className="text-right py-2">{tRef.current("pnl.priorYear")}</th>
                    <th className="text-right py-2">{tRef.current("pnl.change")}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.months.map((m, idx) => {
                    const monthLabel = MONTH_SHORT_DE[idx]
                    return (
                      <tr
                        key={m.month}
                        className="border-b"
                        data-testid={`pnl-row-${m.month}`}
                      >
                        <td className="py-2 font-mono">{monthLabel}</td>
                        <td className="text-right font-mono text-emerald-600 dark:text-emerald-400">
                          +{fmt(m.revenue)}
                        </td>
                        <td className="text-right font-mono text-red-600 dark:text-red-400">
                          −{fmt(m.materialExpenses)}
                        </td>
                        <td className="text-right font-mono text-red-600 dark:text-red-400">
                          −{fmt(m.otherExpenses)}
                        </td>
                        <td
                          className={`text-right font-mono font-semibold ${
                            m.operatingResult < 0
                              ? "text-red-600 dark:text-red-400"
                              : "text-emerald-700 dark:text-emerald-300"
                          }`}
                        >
                          {fmt(m.operatingResult)}
                        </td>
                        <td className="text-right font-mono text-gray-500">
                          {fmt(m.vat)}
                        </td>
                        <td className="text-right font-mono text-gray-500">
                          {m.priorYearOperatingResult != null
                            ? fmt(m.priorYearOperatingResult)
                            : "—"}
                        </td>
                        <td className="text-right text-xs">
                          {m.priorYearChangePercent != null ? (
                            <span
                              className={`px-2 py-0.5 rounded ${
                                m.priorYearChangePercent >= 0
                                  ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200"
                                  : "bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-200"
                              }`}
                            >
                              {m.priorYearChangePercent >= 0 ? "+" : ""}
                              {m.priorYearChangePercent.toFixed(1)}%
                            </span>
                          ) : (
                            "—"
                          )}
                        </td>
                      </tr>
                    )
                  })}
                  {/* YTD row */}
                  <tr
                    className="border-t-2 border-gray-400 dark:border-gray-500 font-semibold bg-gray-50 dark:bg-gray-800/50"
                    data-testid="pnl-ytd-row"
                  >
                    <td className="py-2">Σ {tRef.current("pnl.ytd")}</td>
                    <td className="text-right font-mono text-emerald-600 dark:text-emerald-400">
                      +{fmt(data.ytd.revenue)}
                    </td>
                    <td className="text-right font-mono text-red-600 dark:text-red-400">
                      −{fmt(data.ytd.materialExpenses)}
                    </td>
                    <td className="text-right font-mono text-red-600 dark:text-red-400">
                      −{fmt(data.ytd.otherExpenses)}
                    </td>
                    <td
                      className={`text-right font-mono ${
                        data.ytd.operatingResult < 0
                          ? "text-red-600 dark:text-red-400"
                          : "text-emerald-700 dark:text-emerald-300"
                      }`}
                      data-testid="pnl-ytd-result"
                    >
                      {fmt(data.ytd.operatingResult)}
                    </td>
                    <td className="text-right font-mono text-gray-500">
                      {fmt(data.ytd.vat)}
                    </td>
                    <td className="text-right font-mono text-gray-500">
                      {data.priorYearYtd.operatingResult !== 0
                        ? fmt(data.priorYearYtd.operatingResult)
                        : "—"}
                    </td>
                    <td className="text-right text-xs">—</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
