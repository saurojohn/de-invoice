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
    // Tier 93: BWA Granularitäts-Extension.
    // Die Bottom-Lines vom § 275 HGB GKV.
    finanzergebnisMonat: number
    finanzergebnisYtd: number
    finanzergebnisVorjahresYtd: number
    steuernMonat: number
    steuernYtd: number
    steuernVorjahresYtd: number
    jahresergebnisMonat: number
    jahresergebnisYtd: number
    jahresergebnisVorjahresYtd: number
  }
  counts: { invoices: number; expenses: number; assets: number; afaBookings: number }
  generatedAt: string
  disclaimer: string
}

const MONTHS_DE = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
]

const QUARTERS = [
  { value: 'Q1', label: 'Q1 (Jan–Mär)' },
  { value: 'Q2', label: 'Q2 (Apr–Jun)' },
  { value: 'Q3', label: 'Q3 (Jul–Sep)' },
  { value: 'Q4', label: 'Q4 (Okt–Dez)' },
]

/** Tier 163: Quarterly BWA response. */
interface BwaQuarterlyResult {
  current: BwaResult
  prior: BwaResult
  quarter: 'Q1' | 'Q2' | 'Q3' | 'Q4'
  year: number
  vorjahr: number
  endMonth: number
  quarterMonths: [number, number, number]
}

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

  // Tier 163: quarterly BWA state + loader
  // (separate from the monthly state above so
  // the two can be loaded independently — the
  // monthly card and the quarterly card have
  // different selectors).
  const currentMonth = now.getMonth() + 1
  const currentQuarter =
    currentMonth <= 3 ? 'Q1' :
    currentMonth <= 6 ? 'Q2' :
    currentMonth <= 9 ? 'Q3' : 'Q4'
  const [qYear, setQYear] = useState<number>(now.getFullYear())
  const [quarter, setQuarter] = useState<'Q1' | 'Q2' | 'Q3' | 'Q4'>(currentQuarter as any)
  const [qData, setQData] = useState<BwaQuarterlyResult | null>(null)
  const [qLoading, setQLoading] = useState(false)

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

  // Tier 163: quarterly BWA loader
  const loadQuarterly = useCallback(async () => {
    setQLoading(true)
    try {
      const companyId =
        typeof window !== "undefined" ? localStorage.getItem("companyId") : null
      const params = new URLSearchParams()
      if (companyId) params.set("companyId", companyId)
      params.set("year", String(qYear))
      params.set("quarter", quarter)
      const result = await apiGet<BwaQuarterlyResult>(
        `/api/v1/reports/bwa-quarterly?${params}`,
      )
      setQData(result)
    } catch (e: any) {
      const msg = e instanceof ApiError ? e.message : tRef.current("common.loadError")
      toastRef.current.error(msg)
    } finally {
      setQLoading(false)
    }
  }, [qYear, quarter])

  useEffect(() => {
    loadQuarterly()
  }, [loadQuarterly])

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
                    {/* Tier 93: Finanzergebnis (4100 - 4200) */}
                    <tr className="bg-gray-50/50 dark:bg-gray-800/50">
                      <td className="py-1"></td>
                      <td className="py-1 text-xs">Finanzergebnis (4100-4200)</td>
                      <td className="py-1 text-right font-mono text-xs" data-testid="bwa-finanzergebnis-monat">
                        {fmt(data.totals.finanzergebnisMonat)}
                      </td>
                      <td className="py-1 text-right font-mono text-gray-400 text-xs">—</td>
                      <td className="py-1 text-right font-mono text-xs" data-testid="bwa-finanzergebnis-ytd">
                        {fmt(data.totals.finanzergebnisYtd)}
                      </td>
                      <td className="py-1 text-right font-mono text-xs">
                        {fmt(data.totals.finanzergebnisVorjahresYtd)}
                      </td>
                      <td className="py-1 text-right font-mono text-gray-400 text-xs">—</td>
                    </tr>
                    {/* Tier 93: Steuern (5000 + 5100) */}
                    <tr className="bg-gray-50/50 dark:bg-gray-800/50">
                      <td className="py-1"></td>
                      <td className="py-1 text-xs">Steuern (5000+5100)</td>
                      <td className="py-1 text-right font-mono text-xs" data-testid="bwa-steuern-monat">
                        {fmt(data.totals.steuernMonat)}
                      </td>
                      <td className="py-1 text-right font-mono text-gray-400 text-xs">—</td>
                      <td className="py-1 text-right font-mono text-xs" data-testid="bwa-steuern-ytd">
                        {fmt(data.totals.steuernYtd)}
                      </td>
                      <td className="py-1 text-right font-mono text-xs">
                        {fmt(data.totals.steuernVorjahresYtd)}
                      </td>
                      <td className="py-1 text-right font-mono text-gray-400 text-xs">—</td>
                    </tr>
                    {/* Tier 93: Jahresergebnis (Betriebsergebnis + Finanzergebnis - Steuern) */}
                    <tr className="border-t border-gray-300 bg-gray-100 dark:bg-gray-900">
                      <td className="py-1"></td>
                      <td className="py-1 text-xs font-bold">Jahresergebnis</td>
                      <td
                        className="py-1 text-right font-mono font-bold"
                        data-testid="bwa-jahresergebnis-monat"
                      >
                        {fmt(data.totals.jahresergebnisMonat)}
                      </td>
                      <td className="py-1 text-right font-mono text-gray-400">—</td>
                      <td
                        className={`py-1 text-right font-mono font-bold ${
                          data.totals.jahresergebnisYtd >= 0
                            ? "text-emerald-700 dark:text-emerald-300"
                            : "text-red-700 dark:text-red-300"
                        }`}
                        data-testid="bwa-jahresergebnis-ytd"
                      >
                        {fmt(data.totals.jahresergebnisYtd)}
                      </td>
                      <td className="py-1 text-right font-mono font-bold">
                        {fmt(data.totals.jahresergebnisVorjahresYtd)}
                      </td>
                      <td className="py-1 text-right font-mono text-xs">—</td>
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

      {/* Tier 163: Quarterly BWA — Berater's
          most common view. This Q vs same Q
          last year. The YTD field of the BWA
          at quarter end (3, 6, 9, 12) is the
          Q-Summe by definition, so we just
          compare the ytd fields of two BWAs. */}
      <Card data-testid="bwa-quarterly-card">
        <CardHeader>
          <CardTitle>📅 {tRef.current("bwa.qtitle")}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">
            {tRef.current("bwa.qsubtitle")}
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
                value={qYear}
                onChange={(e) => setQYear(Number(e.target.value) || now.getFullYear())}
                className="border rounded px-3 py-2 w-32 dark:bg-gray-800 dark:border-gray-700"
                data-testid="bwa-qyear"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">
                {tRef.current("bwa.quarter")}
              </label>
              <select
                value={quarter}
                onChange={(e) => setQuarter(e.target.value as any)}
                className="border rounded px-3 py-2 w-40 dark:bg-gray-800 dark:border-gray-700"
                data-testid="bwa-quarter"
              >
                {QUARTERS.map((q) => (
                  <option key={q.value} value={q.value}>
                    {q.label}
                  </option>
                ))}
              </select>
            </div>
            <Button onClick={loadQuarterly} disabled={qLoading} data-testid="bwa-qrecompute">
              {qLoading ? "..." : tRef.current("bwa.recompute")}
            </Button>
          </div>

          {qData && (
            <>
              <div className="text-sm text-gray-600 dark:text-gray-300 mb-2">
                <b>{qData.current.company.legalName || qData.current.company.name}</b> —{" "}
                {qData.quarter} {qData.year} ({monthName(qData.quarterMonths[0])}–{monthName(qData.quarterMonths[2])}) vs. {qData.quarter} {qData.vorjahr}
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm" data-testid="bwa-qtable">
                  <thead>
                    <tr className="text-xs text-gray-500 border-b">
                      <th className="text-left py-1 w-12">{tRef.current("bwa.bucket")}</th>
                      <th className="text-left py-1">{tRef.current("bwa.label")}</th>
                      <th className="text-right py-1 w-28">
                        {qData.quarter} {qData.year}
                      </th>
                      <th className="text-right py-1 w-28">
                        {qData.quarter} {qData.vorjahr}
                      </th>
                      <th className="text-right py-1 w-28">
                        Δ absolut
                      </th>
                      <th className="text-right py-1 w-20">
                        {tRef.current("bwa.change")}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {qData.current.lines.map((cur) => {
                      const prior = qData.prior.lines.find((p) => p.bucket === cur.bucket)
                      const qVal = cur.ytd
                      const priorVal = prior?.ytd ?? 0
                      const diff = qVal - priorVal
                      // For revenue lines (1000, 1300): up = good (green)
                      // For cost lines (2000-5100): up = bad (red)
                      // For betriebsergebnis (we'll handle in totals): up = good
                      const isCost = !["1000", "1300"].includes(cur.bucket)
                      const pct =
                        priorVal === 0
                          ? 0
                          : (diff / Math.abs(priorVal)) * 100
                      return (
                        <tr
                          key={cur.bucket}
                          className="border-b"
                          data-testid={`bwa-qrow-${cur.bucket}`}
                        >
                          <td className="py-1 font-mono">{cur.bucket}</td>
                          <td className="py-1 text-xs">{bucketLabel(cur)}</td>
                          <td
                            className="py-1 text-right font-mono"
                            data-testid={`bwa-qrow-${cur.bucket}-cur`}
                          >
                            {fmt(qVal)}
                          </td>
                          <td className="py-1 text-right font-mono text-gray-500">
                            {fmt(priorVal)}
                          </td>
                          <td
                            className={`py-1 text-right font-mono text-xs ${
                              diff === 0
                                ? "text-gray-500"
                                : isCost
                                ? diff > 0
                                  ? "text-red-600 dark:text-red-400"
                                  : "text-emerald-600 dark:text-emerald-400"
                                : diff > 0
                                ? "text-emerald-600 dark:text-emerald-400"
                                : "text-red-600 dark:text-red-400"
                            }`}
                          >
                            {diff > 0 ? "+" : ""}
                            {fmt(diff)}
                          </td>
                          <td
                            className={`py-1 text-right font-mono text-xs ${
                              pct === 0
                                ? "text-gray-500"
                                : isCost
                                ? pct > 0
                                  ? "text-red-600 dark:text-red-400"
                                  : "text-emerald-600 dark:text-emerald-400"
                                : pct > 0
                                ? "text-emerald-600 dark:text-emerald-400"
                                : "text-red-600 dark:text-red-400"
                            }`}
                            data-testid={`bwa-qrow-${cur.bucket}-pct`}
                          >
                            {fmtPct(pct)}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 border-gray-300 bg-gray-50 dark:bg-gray-800">
                      <td className="py-1"></td>
                      <td className="py-1 text-xs font-bold">
                        {tRef.current("bwa.betriebsergebnis")}
                      </td>
                      <td
                        className="py-1 text-right font-mono font-bold"
                        data-testid="bwa-qbetriebsergebnis-cur"
                      >
                        {fmt(qData.current.totals.betriebsergebnisYtd)}
                      </td>
                      <td className="py-1 text-right font-mono font-bold text-gray-500">
                        {fmt(qData.prior.totals.betriebsergebnisYtd)}
                      </td>
                      <td
                        className={`py-1 text-right font-mono font-bold text-xs ${
                          qData.current.totals.betriebsergebnisYtd >=
                          qData.prior.totals.betriebsergebnisYtd
                            ? "text-emerald-600 dark:text-emerald-400"
                            : "text-red-600 dark:text-red-400"
                        }`}
                      >
                        {fmt(
                          qData.current.totals.betriebsergebnisYtd -
                            qData.prior.totals.betriebsergebnisYtd,
                        )}
                      </td>
                      <td
                        className={`py-1 text-right font-mono text-xs ${
                          qData.current.totals.betriebsergebnisYtd >=
                          qData.prior.totals.betriebsergebnisYtd
                            ? "text-emerald-600 dark:text-emerald-400"
                            : "text-red-600 dark:text-red-400"
                        }`}
                        data-testid="bwa-qbetriebsergebnis-pct"
                      >
                        {fmtPct(
                          qData.prior.totals.betriebsergebnisYtd === 0
                            ? 0
                            : ((qData.current.totals.betriebsergebnisYtd -
                                qData.prior.totals.betriebsergebnisYtd) /
                                Math.abs(qData.prior.totals.betriebsergebnisYtd)) *
                                100,
                        )}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
