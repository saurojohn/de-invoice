"use client"

/**
 * Tier 709 — Rechnungsstatistik: what was invoiced, per month and per year,
 * in amounts and in numbers, and what was sold, in quantities.
 * GET /api/v1/reports/invoice-statistics (invoice-statistics.service.ts has the rules).
 */
import { useCallback, useEffect, useState } from "react"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { useI18n } from "@/components/useI18n"
import { apiGet, ApiError } from "@/lib/api"
import { useYearField } from "@/lib/year-field"
import { formatMoney } from "@/lib/money"
import { todayIso } from "@/lib/today"

interface Figures {
  invoiceCount: number
  creditNoteCount: number
  cancelledCount: number
  net: number
  vat: number
  gross: number
}
interface ProductRow {
  key: string
  productId: string | null
  name: string
  unit: string
  quantity: number
  net: number
  invoiceCount: number
}
interface Stats {
  year: number
  month: number | null
  total: Figures
  months: Array<Figures & { month: number }>
  years: Array<Figures & { year: number; netChangePct: number | null }>
  products: { rows: ProductRow[]; cancelledNet: number; creditNotesNet: number; net: number }
}

const qty = (n: number) => n.toLocaleString("de-DE", { maximumFractionDigits: 4 })

function downloadCsv(rows: Array<Record<string, string | number>>, filename: string) {
  if (!rows.length) return
  const cell = (v: unknown) => {
    const s = typeof v === "number" ? String(v).replace(".", ",") : String(v ?? "")
    return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const content = [Object.keys(rows[0]).map(cell).join(";"), ...rows.map((r) => Object.values(r).map(cell).join(";"))].join("\n")
  const url = URL.createObjectURL(new Blob(["﻿" + content], { type: "text/csv;charset=utf-8;" }))
  const a = document.createElement("a")
  a.href = url
  a.download = `${filename}_${todayIso()}.csv`
  document.body.appendChild(a)
  a.click()
  URL.revokeObjectURL(url)
  document.body.removeChild(a)
}

export function InvoiceStatsTab() {
  const { t, getDateLocale } = useI18n()
  const [year, setYear] = useState(() => Number(todayIso().slice(0, 4)))
  const [month, setMonth] = useState<number | null>(null)
  const [stats, setStats] = useState<Stats | null>(null)
  const [error, setError] = useState<string | null>(null)
  const yearField = useYearField(year, (y) => { setYear(y); setMonth(null) })

  const load = useCallback(async () => {
    setError(null)
    try {
      const companyId = localStorage.getItem("companyId") || ""
      setStats(await apiGet<Stats>(
        `/api/v1/reports/invoice-statistics?companyId=${companyId}&year=${year}${month ? `&month=${month}` : ""}`,
      ))
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    }
  }, [year, month])
  useEffect(() => { void load() }, [load])

  const monthName = (m: number) =>
    new Date(Date.UTC(2000, m - 1, 1)).toLocaleDateString(getDateLocale(), { month: "long", timeZone: "UTC" })
  const maxNet = Math.max(1, ...(stats?.months ?? []).map((m) => Math.abs(m.net)))

  const monthsCsv = () =>
    stats && downloadCsv(
      [...stats.months.map((m) => ({ [t("invoiceStats.month")]: monthName(m.month), ...figuresRow(m) })),
        { [t("invoiceStats.month")]: t("invoiceStats.total"), ...figuresRow(stats.total) }],
      `rechnungsstatistik_${year}`,
    )
  const figuresRow = (f: Figures) => ({
    [t("invoiceStats.invoices")]: f.invoiceCount,
    [t("invoiceStats.cancelled")]: f.cancelledCount,
    [t("invoiceStats.creditNotes")]: f.creditNoteCount,
    [t("invoiceStats.net")]: f.net,
    [t("invoiceStats.vat")]: f.vat,
    [t("invoiceStats.gross")]: f.gross,
  })
  const productsCsv = () =>
    stats && downloadCsv(
      [...stats.products.rows.map((r) => ({
        [t("invoiceStats.article")]: r.name,
        [t("invoiceStats.unit")]: r.unit,
        [t("invoiceStats.quantity")]: r.quantity,
        [t("invoiceStats.net")]: r.net,
        [t("invoiceStats.invoices")]: r.invoiceCount,
      })),
        { [t("invoiceStats.article")]: t("invoiceStats.cancelledRow"), [t("invoiceStats.unit")]: "", [t("invoiceStats.quantity")]: "", [t("invoiceStats.net")]: stats.products.cancelledNet, [t("invoiceStats.invoices")]: "" },
        { [t("invoiceStats.article")]: t("invoiceStats.creditNotesRow"), [t("invoiceStats.unit")]: "", [t("invoiceStats.quantity")]: "", [t("invoiceStats.net")]: stats.products.creditNotesNet, [t("invoiceStats.invoices")]: "" }],
      `verkaufte_mengen_${year}${month ? `_${String(month).padStart(2, "0")}` : ""}`,
    )

  return (
    <div className="space-y-6" data-testid="invoice-stats">
      <Card>
        <CardContent className="pt-6 flex flex-wrap items-end gap-4">
          <div>
            <label className="block text-sm font-medium mb-1" htmlFor="invoice-stats-year">{t("invoiceStats.year")}</label>
            <input id="invoice-stats-year" type="number" min={2000} max={2100} {...yearField}
              className="w-28 h-10 border rounded-md px-3 dark:bg-gray-800 dark:border-gray-700" data-testid="invoice-stats-year" />
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400 max-w-xl">{t("invoiceStats.rules")}</p>
        </CardContent>
      </Card>

      {error && <p className="text-sm text-red-600 dark:text-red-400" data-testid="invoice-stats-error">{error}</p>}

      {stats && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4" data-testid="invoice-stats-total">
            {[
              { label: t("invoiceStats.invoices"), value: String(stats.total.invoiceCount), hint: stats.total.cancelledCount ? t("invoiceStats.cancelledHint").replace("{n}", String(stats.total.cancelledCount)) : "" },
              { label: t("invoiceStats.creditNotes"), value: String(stats.total.creditNoteCount), hint: "" },
              { label: t("invoiceStats.net"), value: formatMoney(stats.total.net), hint: "" },
              { label: t("invoiceStats.vat"), value: formatMoney(stats.total.vat), hint: "" },
              { label: t("invoiceStats.gross"), value: formatMoney(stats.total.gross), hint: "" },
            ].map((k) => (
              <Card key={k.label}>
                <CardContent className="pt-6">
                  <div className="text-2xl font-bold">{k.value}</div>
                  <div className="text-sm text-gray-500 dark:text-gray-400">{k.label}</div>
                  {k.hint && <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">{k.hint}</div>}
                </CardContent>
              </Card>
            ))}
          </div>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle>{t("invoiceStats.byMonth").replace("{year}", String(stats.year))}</CardTitle>
              <Button variant="outline" size="sm" onClick={monthsCsv}>CSV</Button>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="invoice-stats-months">
                <thead>
                  <tr className="border-b text-left">
                    <th className="py-2">{t("invoiceStats.month")}</th>
                    <th className="py-2 text-right">{t("invoiceStats.invoices")}</th>
                    <th className="py-2 text-right">{t("invoiceStats.creditNotes")}</th>
                    <th className="py-2 text-right">{t("invoiceStats.net")}</th>
                    <th className="py-2 text-right">{t("invoiceStats.vat")}</th>
                    <th className="py-2 text-right">{t("invoiceStats.gross")}</th>
                    <th className="py-2 pl-4 w-40"></th>
                  </tr>
                </thead>
                <tbody>
                  {stats.months.map((m) => (
                    <tr
                      key={m.month}
                      className={`border-b cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800 ${month === m.month ? "bg-blue-50 dark:bg-blue-950/40" : ""}`}
                      onClick={() => setMonth(month === m.month ? null : m.month)}
                      title={t("invoiceStats.pickMonth")}
                      data-testid="invoice-stats-month"
                      data-month={m.month}
                    >
                      <td className="py-2">{monthName(m.month)}</td>
                      <td className="py-2 text-right">{m.invoiceCount}{m.cancelledCount ? <span className="text-xs text-gray-500 dark:text-gray-400"> ({t("invoiceStats.cancelledShort").replace("{n}", String(m.cancelledCount))})</span> : null}</td>
                      <td className="py-2 text-right">{m.creditNoteCount}</td>
                      <td className="py-2 text-right font-mono whitespace-nowrap">{formatMoney(m.net)}</td>
                      <td className="py-2 text-right font-mono whitespace-nowrap">{formatMoney(m.vat)}</td>
                      <td className="py-2 text-right font-mono whitespace-nowrap">{formatMoney(m.gross)}</td>
                      <td className="py-2 pl-4">
                        <div className="h-2 rounded bg-gray-100 dark:bg-gray-800">
                          <div className={`h-2 rounded ${m.net < 0 ? "bg-red-400" : "bg-blue-500"}`} style={{ width: `${(Math.abs(m.net) / maxNet) * 100}%` }} />
                        </div>
                      </td>
                    </tr>
                  ))}
                  <tr className="font-semibold" data-testid="invoice-stats-months-total">
                    <td className="py-2">{t("invoiceStats.total")}</td>
                    <td className="py-2 text-right">{stats.total.invoiceCount}</td>
                    <td className="py-2 text-right">{stats.total.creditNoteCount}</td>
                    <td className="py-2 text-right font-mono whitespace-nowrap">{formatMoney(stats.total.net)}</td>
                    <td className="py-2 text-right font-mono whitespace-nowrap">{formatMoney(stats.total.vat)}</td>
                    <td className="py-2 text-right font-mono whitespace-nowrap">{formatMoney(stats.total.gross)}</td>
                    <td />
                  </tr>
                </tbody>
              </table>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t("invoiceStats.byYear")}</CardTitle>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="invoice-stats-years">
                <thead>
                  <tr className="border-b text-left">
                    <th className="py-2">{t("invoiceStats.year")}</th>
                    <th className="py-2 text-right">{t("invoiceStats.invoices")}</th>
                    <th className="py-2 text-right">{t("invoiceStats.creditNotes")}</th>
                    <th className="py-2 text-right">{t("invoiceStats.net")}</th>
                    <th className="py-2 text-right">{t("invoiceStats.gross")}</th>
                    <th className="py-2 text-right">{t("invoiceStats.change")}</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.years.map((y) => (
                    <tr key={y.year} className="border-b" data-testid="invoice-stats-year-row" data-year={y.year}>
                      <td className="py-2">
                        <button type="button" className="underline" onClick={() => { setYear(y.year); setMonth(null) }}>{y.year}</button>
                      </td>
                      <td className="py-2 text-right">{y.invoiceCount}</td>
                      <td className="py-2 text-right">{y.creditNoteCount}</td>
                      <td className="py-2 text-right font-mono whitespace-nowrap">{formatMoney(y.net)}</td>
                      <td className="py-2 text-right font-mono whitespace-nowrap">{formatMoney(y.gross)}</td>
                      <td className={`py-2 text-right ${y.netChangePct == null ? "" : y.netChangePct < 0 ? "text-red-600 dark:text-red-400" : "text-green-700 dark:text-green-400"}`}>
                        {y.netChangePct == null ? "—" : `${y.netChangePct > 0 ? "+" : ""}${y.netChangePct.toLocaleString("de-DE", { maximumFractionDigits: 1 })} %`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-4">
              <CardTitle>
                {month
                  ? t("invoiceStats.soldInMonth").replace("{month}", monthName(month)).replace("{year}", String(stats.year))
                  : t("invoiceStats.soldInYear").replace("{year}", String(stats.year))}
              </CardTitle>
              <div className="flex gap-2">
                {month && <Button variant="outline" size="sm" onClick={() => setMonth(null)} data-testid="invoice-stats-whole-year">{t("invoiceStats.wholeYear")}</Button>}
                <Button variant="outline" size="sm" onClick={productsCsv}>CSV</Button>
              </div>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="invoice-stats-products">
                <thead>
                  <tr className="border-b text-left">
                    <th className="py-2">{t("invoiceStats.article")}</th>
                    <th className="py-2 text-right">{t("invoiceStats.quantity")}</th>
                    <th className="py-2 pl-3">{t("invoiceStats.unit")}</th>
                    <th className="py-2 text-right">{t("invoiceStats.net")}</th>
                    <th className="py-2 text-right">{t("invoiceStats.invoices")}</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.products.rows.length === 0 && (
                    <tr><td colSpan={5} className="py-4 text-center text-gray-500 dark:text-gray-400">{t("invoiceStats.nothingSold")}</td></tr>
                  )}
                  {stats.products.rows.map((r) => (
                    <tr key={r.key} className="border-b" data-testid="invoice-stats-product">
                      <td className="py-2">{r.name}</td>
                      <td className="py-2 text-right font-mono">{qty(r.quantity)}</td>
                      <td className="py-2 pl-3">{r.unit}</td>
                      <td className="py-2 text-right font-mono whitespace-nowrap">{formatMoney(r.net)}</td>
                      <td className="py-2 text-right">{r.invoiceCount}</td>
                    </tr>
                  ))}
                  {[
                    { id: "cancelled", label: t("invoiceStats.cancelledRow"), hint: t("invoiceStats.cancelledRowHint"), net: stats.products.cancelledNet },
                    { id: "credit-notes", label: t("invoiceStats.creditNotesRow"), hint: t("invoiceStats.creditNotesRowHint"), net: stats.products.creditNotesNet },
                  ].filter((r) => Math.abs(r.net) > 0.004).map((r) => (
                    <tr key={r.id} className="border-b text-gray-600 dark:text-gray-300" data-testid={`invoice-stats-${r.id}`}>
                      <td className="py-2" colSpan={3} title={r.hint}>{r.label}</td>
                      <td className="py-2 text-right font-mono whitespace-nowrap">{formatMoney(r.net)}</td>
                      <td />
                    </tr>
                  ))}
                  <tr className="font-semibold" data-testid="invoice-stats-products-total">
                    <td className="py-2" colSpan={3}>{t("invoiceStats.total")}</td>
                    <td className="py-2 text-right font-mono whitespace-nowrap">{formatMoney(stats.products.net)}</td>
                    <td />
                  </tr>
                </tbody>
              </table>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}
