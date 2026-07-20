"use client"

import { useEffect, useRef, useState, useCallback } from "react"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { useI18n } from "@/components/useI18n"
import { useToast } from "@/components/useToast"
import { apiGet, ApiError } from "@/lib/api"

interface EuerLine {
  kennziffer: string
  label: string
  amount: number
}

interface EuerResult {
  year: number
  companyId: string
  einnahmen: EuerLine[]
  ausgaben: EuerLine[]
  totals: {
    einnahmenTotal: number
    ausgabenTotal: number
    gewinn: number
  }
  counts: { invoices: number; expenses: number }
  generatedAt: string
  disclaimer: string
}

/**
 * Tier 76: Anlage EÜR (Einnahmen-Überschuss-Rechnung) section.
 *
 * Shows a year picker + a button that triggers
 * /api/v1/accounting/euer. Renders the BMF
 * Kennziffern in two stacked tables (Einnahmen +
 * Ausgaben) with the Gewinn/Verlust total.
 *
 * The section is a VORSCHAU — the disclaimer
 * is always shown next to the totals, and the
 * PDF download links to /api/v1/accounting/euer.pdf.
 */
export function EuerSection() {
  const { t } = useI18n()
  const toast = useToast()
  // Tier 73 pattern: useToast/useI18n return fresh
  // objects every render — capture in refs.
  const toastRef = useRef(toast)
  toastRef.current = toast
  const tRef = useRef(t)
  tRef.current = t
  const [year, setYear] = useState<number>(new Date().getFullYear() - 1)
  const [data, setData] = useState<EuerResult | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async (y: number) => {
    setLoading(true)
    try {
      const companyId =
        typeof window !== "undefined" ? localStorage.getItem("companyId") : null
      const params = new URLSearchParams()
      if (companyId) params.set("companyId", companyId)
      params.set("year", String(y))
      const result = await apiGet<EuerResult>(`/api/v1/accounting/euer?${params}`)
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
    new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR", minimumFractionDigits: 2 }).format(n)

  const [pdfUrl, setPdfUrl] = useState<string>("#")
  // Compute the PDF URL in a useEffect so the
  // localStorage value is reliably available
  // (avoids the SSR / pre-hydration window where
  // the JSX is evaluated but window is undefined
  // OR the addInitScript hasn't fired yet).
  useEffect(() => {
    if (typeof window === "undefined") return
    const companyId = localStorage.getItem("companyId")
    if (!companyId) {
      setPdfUrl("#")
      return
    }
    const apiBase =
      process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001"
    setPdfUrl(
      `${apiBase}/api/v1/accounting/euer.pdf?companyId=${companyId}&year=${year}`,
    )
  }, [year])

  return (
    <div className="mt-6 space-y-4" data-testid="euer-section">
      <Card>
        <CardHeader>
          <CardTitle>
            📑 {tRef.current("euer.title")} ({data?.year || year})
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-end gap-3 mb-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">
                {tRef.current("euer.year")}
              </label>
              <input
                type="number"
                min={2000}
                max={2100}
                value={year}
                onChange={(e) => setYear(Number(e.target.value) || new Date().getFullYear() - 1)}
                className="border rounded px-3 py-2 w-32 dark:bg-gray-800 dark:border-gray-700"
                data-testid="euer-year"
              />
            </div>
            <Button
              onClick={() => load(year)}
              disabled={loading}
              data-testid="euer-recompute"
            >
              {loading ? "..." : tRef.current("euer.recompute")}
            </Button>
            <a
              href={pdfUrl}
              target="_blank"
              rel="noreferrer"
              className="ml-auto"
              data-testid="euer-pdf-link"
            >
              <Button variant="outline" type="button">
                📄 {tRef.current("euer.downloadPdf")}
              </Button>
            </a>
          </div>

          {data && (
            <>
              <div className="grid md:grid-cols-2 gap-4">
                {/* Einnahmen */}
                <div>
                  <h3 className="text-sm font-semibold mb-2 text-emerald-700 dark:text-emerald-400">
                    {tRef.current("euer.einnahmen")} ({data.totals.einnahmenTotal >= 0 ? "+" : ""}
                    {fmt(data.totals.einnahmenTotal)})
                  </h3>
                  <table className="w-full text-sm" data-testid="euer-einnahmen-table">
                    <thead>
                      <tr className="text-xs text-gray-500 border-b">
                        <th className="text-left py-1 w-12">Kz</th>
                        <th className="text-left py-1">Bezeichnung</th>
                        <th className="text-right py-1 w-32">Betrag (€)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.einnahmen.map((l) => (
                        <tr
                          key={l.kennziffer}
                          className="border-b"
                          data-testid={`euer-rev-${l.kennziffer}`}
                        >
                          <td className="py-1 font-mono">{l.kennziffer}</td>
                          <td className="py-1 text-xs">{l.label}</td>
                          <td
                            className={`py-1 text-right font-mono ${
                              l.amount < 0
                                ? "text-red-600 dark:text-red-400"
                                : "text-emerald-600 dark:text-emerald-400"
                            }`}
                          >
                            {l.amount >= 0 ? "+" : ""}
                            {fmt(l.amount)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Ausgaben */}
                <div>
                  <h3 className="text-sm font-semibold mb-2 text-red-700 dark:text-red-400">
                    {tRef.current("euer.ausgaben")} (−{fmt(data.totals.ausgabenTotal)})
                  </h3>
                  <table className="w-full text-sm" data-testid="euer-ausgaben-table">
                    <thead>
                      <tr className="text-xs text-gray-500 border-b">
                        <th className="text-left py-1 w-12">Kz</th>
                        <th className="text-left py-1">Bezeichnung</th>
                        <th className="text-right py-1 w-32">Betrag (€)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.ausgaben.map((l) => (
                        <tr
                          key={l.kennziffer}
                          className="border-b"
                          data-testid={`euer-exp-${l.kennziffer}`}
                        >
                          <td className="py-1 font-mono">{l.kennziffer}</td>
                          <td className="py-1 text-xs">{l.label}</td>
                          <td
                            className={`py-1 text-right font-mono ${
                              l.amount < 0
                                ? "text-red-600 dark:text-red-400"
                                : ""
                            }`}
                          >
                            {fmt(l.amount)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Gewinn / Verlust total */}
              <div
                className={`mt-4 p-3 rounded text-center text-lg font-bold ${
                  data.totals.gewinn >= 0
                    ? "bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300"
                    : "bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-300"
                }`}
                data-testid="euer-gewinn"
              >
                {data.totals.gewinn >= 0
                  ? `${tRef.current("euer.gewinn")}: ${fmt(data.totals.gewinn)}`
                  : `${tRef.current("euer.verlust")}: ${fmt(Math.abs(data.totals.gewinn))}`}
              </div>

              {/* Disclaimer */}
              <div
                className="mt-3 p-3 bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-700 rounded text-xs text-amber-800 dark:text-amber-200"
                data-testid="euer-disclaimer"
              >
                ⚠ {data.disclaimer}
              </div>

              {/* Counts */}
              <div className="mt-2 text-xs text-gray-500" data-testid="euer-counts">
                {tRef.current("euer.invoices")}: <b>{data.counts.invoices}</b> ·{" "}
                {tRef.current("euer.expenses")}: <b>{data.counts.expenses}</b> ·{" "}
                {tRef.current("euer.generatedAt")}: {new Date(data.generatedAt).toLocaleString("de-DE")}
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
