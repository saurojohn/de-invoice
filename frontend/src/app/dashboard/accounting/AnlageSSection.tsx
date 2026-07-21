"use client"

import { useEffect, useRef, useState, useCallback } from "react"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { useI18n } from "@/components/useI18n"
import { useToast } from "@/components/useToast"
import { apiGet, ApiError } from "@/lib/api"

interface AnlageSLine {
  kennziffer: string
  label: string
  amount: number
}

interface AnlageSResult {
  year: number
  companyId: string
  einnahmen: AnlageSLine[]
  ausgaben: AnlageSLine[]
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
 * Tier 80: Anlage S section.
 *
 * Parallel to EuerSection (tier 76) but for
 * Einkünfte aus selbständiger Arbeit (§ 18
 * EStG) — freelancers / Selbständige instead
 * of Gewerbebetrieb (§ 15 EStG). Same
 * Kennziffer vocabulary on the revenue side;
 * expense side is the typical freelance
 * deductible categories (Kfz, Fortbildung,
 * Steuerberatung, etc.).
 */
export function AnlageSSection() {
  const { t } = useI18n()
  const toast = useToast()
  const toastRef = useRef(toast)
  toastRef.current = toast
  const tRef = useRef(t)
  tRef.current = t
  const [year, setYear] = useState<number>(new Date().getFullYear() - 1)
  const [data, setData] = useState<AnlageSResult | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async (y: number) => {
    setLoading(true)
    try {
      const companyId =
        typeof window !== "undefined" ? localStorage.getItem("companyId") : null
      const params = new URLSearchParams()
      if (companyId) params.set("companyId", companyId)
      params.set("year", String(y))
      const result = await apiGet<AnlageSResult>(`/api/v1/accounting/anlage-s?${params}`)
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
  useEffect(() => {
    if (typeof window === "undefined") return
    const companyId = localStorage.getItem("companyId")
    if (!companyId) {
      setPdfUrl("#")
      return
    }
    const apiBase = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001"
    setPdfUrl(`${apiBase}/api/v1/accounting/anlage-s.pdf?companyId=${companyId}&year=${year}`)
  }, [year])

  return (
    <div className="mt-6 space-y-4" data-testid="anlage-s-section">
      <Card>
        <CardHeader>
          <CardTitle>
            🧑‍💼 {tRef.current("anlageS.title")} ({data?.year || year})
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">
            {tRef.current("anlageS.subtitle")}
          </p>
          <div className="flex flex-wrap items-end gap-3 mb-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">
                {tRef.current("anlageS.year")}
              </label>
              <input
                type="number"
                min={2000}
                max={2100}
                value={year}
                onChange={(e) => setYear(Number(e.target.value) || new Date().getFullYear() - 1)}
                className="border rounded px-3 py-2 w-32 dark:bg-gray-800 dark:border-gray-700"
                data-testid="anlage-s-year"
              />
            </div>
            <Button onClick={() => load(year)} disabled={loading} data-testid="anlage-s-recompute">
              {loading ? "..." : tRef.current("anlageS.recompute")}
            </Button>
            <a href={pdfUrl} target="_blank" rel="noreferrer" className="ml-auto" data-testid="anlage-s-pdf-link">
              <Button variant="outline" type="button" disabled={pdfUrl === "#"}>
                📄 {tRef.current("anlageS.downloadPdf")}
              </Button>
            </a>
          </div>

          {data && (
            <>
              <div className="grid md:grid-cols-2 gap-4">
                <div>
                  <h3 className="text-sm font-semibold mb-2 text-emerald-700 dark:text-emerald-400">
                    {tRef.current("anlageS.einnahmen")} ({data.totals.einnahmenTotal >= 0 ? "+" : ""}
                    {fmt(data.totals.einnahmenTotal)})
                  </h3>
                  <table className="w-full text-sm" data-testid="anlage-s-einnahmen-table">
                    <thead>
                      <tr className="text-xs text-gray-500 border-b">
                        <th className="text-left py-1 w-12">Kz</th>
                        <th className="text-left py-1">Bezeichnung</th>
                        <th className="text-right py-1 w-32">Betrag (€)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.einnahmen.map((l) => (
                        <tr key={l.kennziffer} className="border-b" data-testid={`anlage-s-rev-${l.kennziffer}`}>
                          <td className="py-1 font-mono">{l.kennziffer}</td>
                          <td className="py-1 text-xs">{l.label}</td>
                          <td className={`py-1 text-right font-mono ${l.amount < 0 ? "text-red-600 dark:text-red-400" : ""}`}>
                            {fmt(l.amount)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div>
                  <h3 className="text-sm font-semibold mb-2 text-red-700 dark:text-red-400">
                    {tRef.current("anlageS.ausgaben")} (−{fmt(data.totals.ausgabenTotal)})
                  </h3>
                  <table className="w-full text-sm" data-testid="anlage-s-ausgaben-table">
                    <thead>
                      <tr className="text-xs text-gray-500 border-b">
                        <th className="text-left py-1 w-12">Kz</th>
                        <th className="text-left py-1">Bezeichnung</th>
                        <th className="text-right py-1 w-32">Betrag (€)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.ausgaben.map((l) => (
                        <tr key={l.kennziffer} className="border-b" data-testid={`anlage-s-exp-${l.kennziffer}`}>
                          <td className="py-1 font-mono">{l.kennziffer}</td>
                          <td className="py-1 text-xs">{l.label}</td>
                          <td className="py-1 text-right font-mono">{fmt(l.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div
                className={`mt-4 p-3 rounded text-center text-lg font-bold ${
                  data.totals.gewinn >= 0
                    ? "bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300"
                    : "bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-300"
                }`}
                data-testid="anlage-s-gewinn"
              >
                {data.totals.gewinn >= 0
                  ? `${tRef.current("anlageS.gewinn")}: ${fmt(data.totals.gewinn)}`
                  : `${tRef.current("anlageS.verlust")}: ${fmt(Math.abs(data.totals.gewinn))}`}
              </div>

              <div
                className="mt-3 p-3 bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-700 rounded text-xs text-amber-800 dark:text-amber-200"
                data-testid="anlage-s-disclaimer"
              >
                ⚠ {data.disclaimer}
              </div>

              <div className="mt-2 text-xs text-gray-500" data-testid="anlage-s-counts">
                {tRef.current("anlageS.invoices")}: <b>{data.counts.invoices}</b> ·{" "}
                {tRef.current("anlageS.expenses")}: <b>{data.counts.expenses}</b> ·{" "}
                {tRef.current("anlageS.generatedAt")}: {new Date(data.generatedAt).toLocaleString("de-DE")}
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
