"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import LanguageSwitcher from "@/components/LanguageSwitcher"
import { useI18n } from "@/components/useI18n"
import { apiGet } from "@/lib/api"

type Bucket = 'current' | '1-30' | '31-60' | '61-90' | '90+'

interface AgingRow {
  customerId: string
  customerName: string
  customerNumber?: string | null
  invoiceCount: number
  buckets: Record<Bucket, number>
  totalOpen: number
  oldestDaysOverdue: number
}

interface AgingReport {
  companyId: string
  asOf: string
  totals: Record<Bucket, number>
  grandTotal: number
  customerCount: number
  rows: AgingRow[]
}

const BUCKET_ORDER: Bucket[] = ['current', '1-30', '31-60', '61-90', '90+']

// Heat color: green (current / 1-30) → amber (31-60) → red (61+ / 90+).
// Drives the cell background so the eye is drawn to risk first.
function bucketColor(b: Bucket): string {
  switch (b) {
    case 'current': return 'bg-emerald-50 text-emerald-900'
    case '1-30': return 'bg-amber-50 text-amber-900'
    case '31-60': return 'bg-orange-100 text-orange-900'
    case '61-90': return 'bg-red-100 text-red-900'
    case '90+': return 'bg-red-200 text-red-950 font-semibold'
  }
}

export default function AgingReportPage() {
  const router = useRouter()
  const { t, locale, getDateLocale } = useI18n()
  const [report, setReport] = useState<AgingReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [sortBy, setSortBy] = useState<'totalOpen' | 'oldest' | 'name'>('totalOpen')

  useEffect(() => {
    const companyId = localStorage.getItem("companyId")
    if (!companyId) {
      router.push("/login")
      return
    }
    apiGet<AgingReport>(`/reports/aging?companyId=${companyId}`)
      .then((d) => setReport(d))
      .catch((err) => console.error("Aging report load failed:", err))
      .finally(() => setLoading(false))
  }, [router])

  const fmt = (n: number) =>
    n.toLocaleString(getDateLocale() === 'de-DE' ? 'de-DE' : 'en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

  const fmtDate = (s: string) =>
    new Date(s).toLocaleDateString(getDateLocale(), { day: "2-digit", month: "2-digit", year: "numeric" })

  const sortedRows = report ? [...report.rows].sort((a, b) => {
    switch (sortBy) {
      case 'oldest': return b.oldestDaysOverdue - a.oldestDaysOverdue
      case 'name': return a.customerName.localeCompare(b.customerName)
      default: return b.totalOpen - a.totalOpen
    }
  }) : []

  const exportCsv = () => {
    if (!report) return
    const header = ['Kunde', 'KdNr', 'Rechnungen', ...BUCKET_ORDER, 'Summe offen', 'Älteste überfällig (Tage)']
    const rows = sortedRows.map((r) => [
      r.customerName,
      r.customerNumber || '',
      String(r.invoiceCount),
      ...BUCKET_ORDER.map((b) => r.buckets[b].toFixed(2)),
      r.totalOpen.toFixed(2),
      String(r.oldestDaysOverdue),
    ])
    const totals = ['GESAMT', '', '', ...BUCKET_ORDER.map((b) => report.totals[b].toFixed(2)), report.grandTotal.toFixed(2), '']
    const csv = [header, ...rows, totals]
      .map((r) => r.map((c) => /[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c).join(';'))
      .join('\n')
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `Aging_${report.asOf.split('T')[0]}.csv`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="container mx-auto px-4 py-8">
        <div className="flex justify-between items-center mb-6">
          <div>
            <h1 className="text-3xl font-bold text-gray-900">
              {t("aging.title") || "Altersstruktur (Aging Report)"}
            </h1>
            {report && (
              <p className="text-gray-500 mt-1">
                {t("aging.asOf") || "Stand"}: {fmtDate(report.asOf)} ·{" "}
                {report.customerCount} {t("aging.customers") || "Kunden"} ·{" "}
                <span className="font-mono font-medium">€ {fmt(report.grandTotal)}</span>{" "}
                {t("aging.openTotal") || "gesamt offen"}
              </p>
            )}
          </div>
          <div className="flex gap-2 items-center">
            <LanguageSwitcher />
            <Button variant="outline" onClick={() => router.push("/dashboard")}>
              {t("common.back") || "Zurück"}
            </Button>
            <Button onClick={exportCsv} disabled={!report || report.rows.length === 0}>
              {t("common.exportCsv") || "CSV exportieren"}
            </Button>
          </div>
        </div>

        {loading ? (
          <div className="text-center py-12 text-gray-500">{t("common.loading") || "Lädt..."}</div>
        ) : !report || report.rows.length === 0 ? (
          <Card>
            <CardContent className="pt-6 text-center text-gray-500 py-12">
              {t("aging.empty") || "Keine offenen Posten — alles bezahlt 🎉"}
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>{t("aging.outstandingInvoices") || "Offene Rechnungen pro Kunde"}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-gray-500">
                      <th className="py-2 font-medium">
                        <button onClick={() => setSortBy('name')} className="hover:underline">
                          {t("aging.colCustomer") || "Kunde"}
                        </button>
                      </th>
                      <th className="py-2 font-medium text-center">{t("aging.colInvoices") || "Rng."}</th>
                      {BUCKET_ORDER.map((b) => (
                        <th key={b} className="py-2 font-medium text-right">
                          {t(`aging.bucket.${b}`) || b}
                        </th>
                      ))}
                      <th className="py-2 font-medium text-right">
                        <button onClick={() => setSortBy('totalOpen')} className="hover:underline">
                          {t("aging.colTotalOpen") || "Summe offen"}
                        </button>
                      </th>
                      <th className="py-2 font-medium text-right">
                        <button onClick={() => setSortBy('oldest')} className="hover:underline">
                          {t("aging.colOldest") || "Älteste"}
                        </button>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedRows.map((r) => (
                      <tr key={r.customerId} className="border-b hover:bg-gray-50">
                        <td className="py-2">
                          <div className="font-medium">{r.customerName}</div>
                          {r.customerNumber && (
                            <div className="text-xs text-gray-500 font-mono">{r.customerNumber}</div>
                          )}
                        </td>
                        <td className="py-2 text-center text-gray-600">{r.invoiceCount}</td>
                        {BUCKET_ORDER.map((b) => {
                          const v = r.buckets[b]
                          if (v === 0) return <td key={b} className="py-2 text-right text-gray-300">—</td>
                          return (
                            <td key={b} className={`py-2 text-right font-mono ${bucketColor(b)}`}>
                              {fmt(v)}
                            </td>
                          )
                        })}
                        <td className="py-2 text-right font-mono font-medium">€ {fmt(r.totalOpen)}</td>
                        <td className="py-2 text-right text-sm">
                          {r.oldestDaysOverdue > 0
                            ? <span className={r.oldestDaysOverdue > 60 ? "text-red-700 font-medium" : "text-gray-600"}>
                                {r.oldestDaysOverdue} {t("aging.days") || "Tage"}
                              </span>
                            : <span className="text-emerald-700">{t("aging.notOverdue") || "nicht überfällig"}</span>
                          }
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 border-gray-300 font-bold">
                      <td className="py-3">{t("aging.total") || "GESAMT"}</td>
                      <td className="py-3 text-center">
                        {sortedRows.reduce((s, r) => s + r.invoiceCount, 0)}
                      </td>
                      {BUCKET_ORDER.map((b) => (
                        <td key={b} className={`py-3 text-right font-mono ${bucketColor(b)}`}>
                          {fmt(report.totals[b])}
                        </td>
                      ))}
                      <td className="py-3 text-right font-mono">€ {fmt(report.grandTotal)}</td>
                      <td></td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  )
}
