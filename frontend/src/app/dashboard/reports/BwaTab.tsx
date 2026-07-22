"use client"

import { useEffect, useRef, useState, useCallback } from "react"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { useI18n } from "@/components/useI18n"
import { useToast } from "@/components/useToast"
import { apiGet, ApiError } from "@/lib/api"

interface BwaLine {
  bucket: string
  label: string
  monat: number
  vormonat: number
  ytd: number
  vorjahresYtd: number
  ytdChangePct: number
}

interface BwaResult {
  year: number
  month: number
  vorjahr: number
  company: { name: string; legalName: string | null }
  lines: BwaLine[]
  totals: {
    erloeseMonat: number
    erloeseVormonat: number
    erloeseYtd: number
    erloeseVorjahresYtd: number
    materialaufwandMonat: number
    personalaufwandMonat: number
    abschreibungenMonat: number
    sonstigeMonat: number
    betriebsergebnisMonat: number
    betriebsergebnisYtd: number
    betriebsergebnisVorjahresYtd: number
  }
  counts: { invoices: number; expenses: number; assets: number }
  generatedAt: string
  disclaimer: string
}

const MONTHS_DE = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
]

/**
 * Tier 86: BWA (Betriebswirtschaftliche
 * Auswertung) tab on /dashboard/reports.
 *
 * The monthly operating report that a
 * Steuerberater sends to the Mandant.
 * Canonical DATEV BWA structure (4-digit
 * bucket codes 1000-5999) with Monatswert /
 * Vormonat / YTD / Vorjahres-YTD / % change.
 */
export function BwaTab() {
  const { t, locale } = useI18n()
  const toast = useToast()
  const toastRef = useRef(toast)
  toastRef.current = toast
  const tRef = useRef(t)
  tRef.current = t
  const now = new Date()
  const [year, setYear] = useState<number>(now.getFullYear())
  const [month, setMonth] = useState<number>(now.getMonth() + 1)
  const [data, setData] = useState<BwaResult | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const companyId =
        typeof window !== "undefined" ? localStorage.getItem("companyId") : null
      const params = new URLSearchParams()
      if (companyId) params.set("companyId", companyId)
      params.set("year", String(year))
      params.set("month", String(month))
      const result = await apiGet<BwaResult>(`/api/v1/reports/bwa?${params}`)
      setData(result)
    } catch (e: any) {
      const msg = e instanceof ApiError ? e.message : tRef.current("common.loadError")
      toastRef.current.error(msg)
    } finally {
      setLoading(false)
    }
  }, [year, month])

  useEffect(() => {
    load()
  }, [load])

  const [pdfUrl, setPdfUrl] = useState<string>("#")
  useEffect(() => {
    if (typeof window === "undefined") return
    const companyId = localStorage.getItem("companyId")
    if (!companyId) {
      setPdfUrl("#")
      return
    }
    const apiBase = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001"
    setPdfUrl(`${apiBase}/api/v1/reports/bwa.pdf?companyId=${companyId}&year=${year}&month=${month}`)
  }, [year, month])

  const fmt = (n: number) =>
    new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR", minimumFractionDigits: 2 }).format(n)

  const fmtPct = (n: number) => {
    if (n === 0) return "—"
    const sign = n > 0 ? "+" : ""
    return `${sign}${new Intl.NumberFormat("de-DE", { maximumFractionDigits: 1 }).format(n)} %`
  }

  // Localised bucket labels
  const bucketLabel = (b: BwaLine): string => {
    switch (b.bucket) {
      case "1000": return tRef.current("bwa.bucketUmsatz")
      case "1300": return tRef.current("bwa.bucketSonstigeErloese")
      case "2000": return tRef.current("bwa.bucketMaterial")
      case "3000": return tRef.current("bwa.bucketPersonal")
      case "3100": return tRef.current("bwa.bucketAfA")
      case "3600": return tRef.current("bwa.bucketSonstige")
      case "4200": return tRef.current("bwa.bucketZins")
      default: return b.label
    }
  }

  const monthName = (m: number): string => {
    if (locale === "de") return MONTHS_DE[m - 1]
    if (locale === "zh") {
      return ['一月', '二月', '三月', '四月', '五月', '六月',
              '七月', '八月', '九月', '十月', '十一月', '十二月'][m - 1]
    }
    return new Date(2000, m - 1).toLocaleString("en-US", { month: "long" })
  }

  return (
    <div className="space-y-4" data-testid="bwa-tab">
      <Card>
        <CardHeader>
          <CardTitle>📊 {tRef.current("bwa.title")}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">
            {tRef.current("bwa.subtitle")}
          </p>
          <div className="flex flex-wrap items-end gap-3 mb-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">
                {tRef.current("bwa.year")}
              </label>
              <input
                type="number"
                min={2000}
                max={2100}
                value={year}
                onChange={(e) => setYear(Number(e.target.value) || now.getFullYear())}
                className="border rounded px-3 py-2 w-32 dark:bg-gray-800 dark:border-gray-700"
                data-testid="bwa-year"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">
                {tRef.current("bwa.month")}
              </label>
              <select
                value={month}
                onChange={(e) => setMonth(Number(e.target.value))}
                className="border rounded px-3 py-2 w-40 dark:bg-gray-800 dark:border-gray-700"
                data-testid="bwa-month"
              >
                {MONTHS_DE.map((name, i) => (
                  <option key={i + 1} value={i + 1}>
                    {name}
                  </option>
                ))}
              </select>
            </div>
            <Button onClick={load} disabled={loading} data-testid="bwa-recompute">
              {loading ? "..." : tRef.current("bwa.recompute")}
            </Button>
            <a href={pdfUrl} target="_blank" rel="noreferrer" className="ml-auto" data-testid="bwa-pdf-link">
              <Button variant="outline" type="button" disabled={pdfUrl === "#"}>
                📄 {tRef.current("bwa.downloadPdf")}
              </Button>
            </a>
          </div>

          {data && (
            <>
              <div className="text-sm text-gray-600 dark:text-gray-300 mb-2">
                <b>{data.company.legalName || data.company.name}</b> —{" "}
                {monthName(data.month)} {data.year} (Vorjahres-Vergleich: Jan-{monthName(data.month)} {data.vorjahr})
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm" data-testid="bwa-table">
                  <thead>
                    <tr className="text-xs text-gray-500 border-b">
                      <th className="text-left py-1 w-12">{tRef.current("bwa.bucket")}</th>
                      <th className="text-left py-1">{tRef.current("bwa.label")}</th>
                      <th className="text-right py-1 w-28">{tRef.current("bwa.monat")}</th>
                      <th className="text-right py-1 w-28">{tRef.current("bwa.vormonat")}</th>
                      <th className="text-right py-1 w-28">{tRef.current("bwa.ytd")}</th>
                      <th className="text-right py-1 w-28">{tRef.current("bwa.vorjahresYtd")}</th>
                      <th className="text-right py-1 w-20">{tRef.current("bwa.change")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.lines.map((l) => (
                      <tr
                        key={l.bucket}
                        className="border-b"
                        data-testid={`bwa-row-${l.bucket}`}
                      >
                        <td className="py-1 font-mono">{l.bucket}</td>
                        <td className="py-1 text-xs">{bucketLabel(l)}</td>
                        <td className="py-1 text-right font-mono">{fmt(l.monat)}</td>
                        <td className="py-1 text-right font-mono">{fmt(l.vormonat)}</td>
                        <td className="py-1 text-right font-mono">{fmt(l.ytd)}</td>
                        <td className="py-1 text-right font-mono">{fmt(l.vorjahresYtd)}</td>
                        <td
                          className={`py-1 text-right font-mono text-xs ${
                            l.ytdChangePct > 0
                              ? "text-emerald-600 dark:text-emerald-400"
                              : l.ytdChangePct < 0
                              ? "text-red-600 dark:text-red-400"
                              : "text-gray-500"
                          }`}
                        >
                          {fmtPct(l.ytdChangePct)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 border-gray-300 bg-gray-50 dark:bg-gray-800">
                      <td className="py-1"></td>
                      <td className="py-1 text-xs font-bold">{tRef.current("bwa.betriebsergebnis")}</td>
                      <td
                        className="py-1 text-right font-mono font-bold"
                        data-testid="bwa-betriebsergebnis-monat"
                      >
                        {fmt(data.totals.betriebsergebnisMonat)}
                      </td>
                      <td className="py-1 text-right font-mono text-gray-400">—</td>
                      <td
                        className="py-1 text-right font-mono font-bold"
                        data-testid="bwa-betriebsergebnis-ytd"
                      >
                        {fmt(data.totals.betriebsergebnisYtd)}
                      </td>
                      <td className="py-1 text-right font-mono font-bold">
                        {fmt(data.totals.betriebsergebnisVorjahresYtd)}
                      </td>
                      <td
                        className={`py-1 text-right font-mono text-xs ${
                          data.totals.betriebsergebnisYtd >= data.totals.betriebsergebnisVorjahresYtd
                            ? "text-emerald-600 dark:text-emerald-400"
                            : "text-red-600 dark:text-red-400"
                        }`}
                      >
                        {fmtPct(
                          data.totals.betriebsergebnisVorjahresYtd === 0
                            ? 0
                            : ((data.totals.betriebsergebnisYtd - data.totals.betriebsergebnisVorjahresYtd) /
                                Math.abs(data.totals.betriebsergebnisVorjahresYtd)) *
                                100,
                        )}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>

              <div
                className="mt-3 p-3 bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-700 rounded text-xs text-amber-800 dark:text-amber-200"
                data-testid="bwa-disclaimer"
              >
                ⚠ {data.disclaimer}
              </div>

              <div className="mt-2 text-xs text-gray-500" data-testid="bwa-counts">
                {tRef.current("bwa.generatedAt")}: {new Date(data.generatedAt).toLocaleString("de-DE")} · Rechnungen: <b>{data.counts.invoices}</b> · Ausgaben: <b>{data.counts.expenses}</b> · Anlagen: <b>{data.counts.assets}</b>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
