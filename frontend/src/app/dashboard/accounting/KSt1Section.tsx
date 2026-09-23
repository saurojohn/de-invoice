"use client"

import { useEffect, useRef, useState, useCallback } from "react"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { useI18n } from "@/components/useI18n"
import { useToast } from "@/components/useToast"
import { apiGet, ApiError } from "@/lib/api"

interface KSt1Line {
  kennziffer: string
  label: string
  amount: number
  source?: 'computed' | 'placeholder'
  note?: string
}

interface KSt1Result {
  year: number
  companyId: string
  isKapitalgesellschaft: boolean
  rechtsform: string
  jahresueberschuss: number
  corrections: KSt1Line[]
  totals: {
    jahresueberschuss: number
    zve: number
    kst: number
    soli: number
    gewstMessbetrag: number
    hebesatz: number
    gewst: number
    zuZahlen: number
  }
  counts: {
    invoices: number
    expenses: number
    jahresueberschussSource: 'computed' | 'nicht_ausgewiesen'
  }
  generatedAt: string
  disclaimer: string
}

/**
 * Tier 102: KSt 1 section.
 *
 * Körperschaftsteuererklärung — the PRIMARY
 * tax return for Kapitalgesellschaften (GmbH,
 * AG, KGaA). Pairs with the E-Bilanz for the
 * Jahresabschluss-based filing.
 *
 * Bottom line: Zu versteuerndes Einkommen (ZvE)
 * = G+V Jahresüberschuss + KSt-Korrekturen
 * (placeholder for v1). KSt 15% + Soli 5.5%
 * + GewSt (default Hebesatz 400%, kein 24.500 €
 * Freibetrag für GmbH); no credit of the GewSt
 * against the KSt (Tier 439 — § 35 EStG is for
 * natural persons).
 */
export function KSt1Section() {
  const { t } = useI18n()
  const toast = useToast()
  const toastRef = useRef(toast)
  toastRef.current = toast
  const tRef = useRef(t)
  tRef.current = t
  const [year, setYear] = useState<number>(new Date().getFullYear() - 1)
  const [data, setData] = useState<KSt1Result | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async (y: number) => {
    setLoading(true)
    try {
      const companyId =
        typeof window !== "undefined" ? localStorage.getItem("companyId") : null
      const params = new URLSearchParams()
      if (companyId) params.set("companyId", companyId)
      params.set("year", String(y))
      const result = await apiGet<KSt1Result>(
        `/api/v1/accounting/kst1?${params}`,
      )
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
    new Intl.NumberFormat("de-DE", {
      style: "currency",
      currency: "EUR",
      minimumFractionDigits: 2,
    }).format(n)

  const [pdfUrl, setPdfUrl] = useState<string>("#")
  useEffect(() => {
    if (typeof window === "undefined") return
    const companyId = localStorage.getItem("companyId")
    if (!companyId) {
      setPdfUrl("#")
      return
    }
    const apiBase = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001"
    setPdfUrl(`${apiBase}/api/v1/accounting/kst1.pdf?companyId=${companyId}&year=${year}`)
  }, [year])

  // Render a Kennziffer row.
  const renderLine = (l: KSt1Line) => (
    <tr
      key={l.kennziffer}
      className="border-b"
      data-testid={`kst1-${l.kennziffer}`}
    >
      <td className="py-1 font-mono">{l.kennziffer}</td>
      <td className="py-1 text-xs">
        {l.label}
        {l.source === 'placeholder' && (
          <span
            className="ml-1 text-[10px] text-amber-600 dark:text-amber-400"
            title={l.note}
          >
            ⚠
          </span>
        )}
      </td>
      <td
        className={`py-1 text-right font-mono ${
          l.amount > 0 ? "font-bold" : l.amount < 0 ? "text-red-700 dark:text-red-300" : "text-gray-400"
        }`}
      >
        {fmt(l.amount)}
      </td>
    </tr>
  )

  return (
    <div className="mt-6 space-y-4" data-testid="kst1-section">
      <Card>
        <CardHeader>
          <CardTitle>
            🏛️ {tRef.current("kst1.title")} ({data?.year || year})
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">
            {tRef.current("kst1.subtitle")}
          </p>
          <div className="flex flex-wrap items-end gap-3 mb-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">
                {tRef.current("kst1.year")}
              </label>
              <input
                type="number"
                min={2000}
                max={2100}
                value={year}
                onChange={(e) =>
                  setYear(Number(e.target.value) || new Date().getFullYear() - 1)
                }
                className="border rounded px-3 py-2 w-32 dark:bg-gray-800 dark:border-gray-700"
                data-testid="kst1-year"
              />
            </div>
            <Button
              onClick={() => load(year)}
              disabled={loading}
              data-testid="kst1-recompute"
            >
              {loading ? "..." : tRef.current("kst1.recompute")}
            </Button>
            <a
              href={pdfUrl}
              target="_blank"
              rel="noreferrer"
              className="ml-auto"
              data-testid="kst1-pdf-link"
            >
              <Button variant="outline" type="button" disabled={pdfUrl === "#"}>
                📄 {tRef.current("kst1.downloadPdf")}
              </Button>
            </a>
          </div>

          {data && (
            <>
              {data.isKapitalgesellschaft ? (
                <div
                  className="mb-4 p-3 bg-emerald-50 dark:bg-emerald-900/30 border border-emerald-200 dark:border-emerald-700 rounded text-sm text-emerald-800 dark:text-emerald-200"
                  data-testid="kst1-kap-hinweis"
                >
                  ✓ {tRef.current("kst1.kapitalgesellschaftHinweis")}{" "}
                  <span className="text-xs text-gray-500">
                    ({tRef.current("kst1.rechtsform")}: {data.rechtsform})
                  </span>
                </div>
              ) : (
                <div
                  className="mb-4 p-3 bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-700 rounded text-sm text-amber-800 dark:text-amber-200"
                  data-testid="kst1-kein-kap-hinweis"
                >
                  ⚠ {tRef.current("kst1.keinKStHinweis")}{" "}
                  <span className="text-xs text-gray-500">
                    ({tRef.current("kst1.rechtsform")}: {data.rechtsform})
                  </span>
                </div>
              )}

              {/* Jahresüberschuss summary */}
              <div
                className="mb-4 p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-700 rounded"
                data-testid="kst1-jahresueberschuss"
              >
                <div className="text-sm font-semibold text-blue-800 dark:text-blue-200 mb-1">
                  {tRef.current("kst1.jahresueberschuss")}
                </div>
                <div className="text-2xl font-bold text-blue-900 dark:text-blue-100">
                  {fmt(data.totals.jahresueberschuss)}
                </div>
                <p className="text-[10px] text-blue-600 dark:text-blue-400 mt-1">
                  {data.counts.jahresueberschussSource === "computed"
                    ? `aus G+V Vorschau (${data.counts.invoices} Rechnungen, ${data.counts.expenses} Ausgaben)`
                    : "nicht ausgewiesen — bitte Gu+V prüfen"}
                </p>
              </div>

              {/* KSt-Korrekturen */}
              <h3 className="text-sm font-semibold mb-2 text-amber-700 dark:text-amber-400">
                {tRef.current("kst1.korrekturen")}
              </h3>
              <table className="w-full text-sm" data-testid="kst1-korrekturen-table">
                <thead>
                  <tr className="text-xs text-gray-500 border-b">
                    <th className="text-left py-1 w-12">Kz</th>
                    <th className="text-left py-1">Bezeichnung</th>
                    <th className="text-right py-1 w-32">Betrag (€)</th>
                  </tr>
                </thead>
                <tbody>
                  {data.corrections.map(renderLine)}
                </tbody>
              </table>
              <p
                className="mt-1 text-[10px] text-gray-500 mb-4"
                data-testid="kst1-korrekturen-hint"
              >
                ⚠ {tRef.current("kst1.korrekturenHint")}
              </p>

              {/* ZvE */}
              <div
                className={`mt-2 p-3 rounded text-center text-lg font-bold ${
                  data.totals.zve > 0
                    ? "bg-amber-50 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300"
                    : data.totals.zve < 0
                      ? "bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300"
                      : "bg-gray-50 dark:bg-gray-800 text-gray-600"
                }`}
                data-testid="kst1-zve"
              >
                {tRef.current("kst1.zve")}: {fmt(data.totals.zve)}
              </div>

              <div className="grid md:grid-cols-3 gap-3 mt-4">
                <div
                  className="p-3 bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-700 rounded"
                  data-testid="kst1-kst-block"
                >
                  <div className="text-xs font-semibold text-emerald-800 dark:text-emerald-200 mb-1">
                    {tRef.current("kst1.kst")}
                  </div>
                  <div className="text-xl font-bold text-emerald-900 dark:text-emerald-100">
                    {fmt(data.totals.kst)}
                  </div>
                </div>

                <div
                  className="p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-700 rounded"
                  data-testid="kst1-soli-block"
                >
                  <div className="text-xs font-semibold text-blue-800 dark:text-blue-200 mb-1">
                    {tRef.current("kst1.soli")}
                  </div>
                  <div className="text-xl font-bold text-blue-900 dark:text-blue-100">
                    {fmt(data.totals.soli)}
                  </div>
                </div>

                <div
                  className="p-3 bg-purple-50 dark:bg-purple-900/20 border border-purple-200 dark:border-purple-700 rounded"
                  data-testid="kst1-gewst-block"
                >
                  <div className="text-xs font-semibold text-purple-800 dark:text-purple-200 mb-1">
                    {tRef.current("kst1.gewst")}
                  </div>
                  <div className="text-xl font-bold text-purple-900 dark:text-purple-100">
                    {fmt(data.totals.gewst)}
                  </div>
                  <p className="text-[10px] text-purple-600 dark:text-purple-400 mt-1">
                    {fmt(data.totals.gewstMessbetrag)} × {data.totals.hebesatz} %
                  </p>
                </div>
              </div>

              {/* Tier 439: no credit of the GewSt against the KSt (§ 35 EStG is for natural persons) */}
              <div
                className="mt-3 p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-700 rounded text-xs text-blue-700 dark:text-blue-300"
                data-testid="kst1-anrechnung-block"
              >
                {tRef.current("kst1.keineAnrechnung")}
              </div>

              {/* Zu zahlen */}
              <div
                className="mt-4 p-3 rounded text-center text-lg font-bold bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-300"
                data-testid="kst1-zu-zahlen"
              >
                {tRef.current("kst1.zuZahlen")}: {fmt(data.totals.zuZahlen)}
              </div>
              <p className="mt-1 text-[10px] text-gray-500" data-testid="kst1-kst-hint">
                ⚠ {tRef.current("kst1.kstHint")}
              </p>

              <div
                className="mt-3 p-3 bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-700 rounded text-xs text-amber-800 dark:text-amber-200"
                data-testid="kst1-disclaimer"
              >
                ⚠ {data.disclaimer}
              </div>

              <div className="mt-2 text-xs text-gray-500" data-testid="kst1-counts">
                {tRef.current("common.invoices")}: <b>{data.counts.invoices}</b> ·{" "}
                {tRef.current("kst1.korrekturen").replace(/§ 8 KStG/, '')}: <b>{data.corrections.length}</b> ·{" "}
                {tRef.current("kst1.generatedAt")}: {new Date(data.generatedAt).toLocaleString("de-DE")}
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
