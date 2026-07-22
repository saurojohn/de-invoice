"use client"

import { useEffect, useRef, useState, useCallback } from "react"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { useI18n } from "@/components/useI18n"
import { useToast } from "@/components/useToast"
import { apiGet, ApiError } from "@/lib/api"

interface GuVLine {
  position: string
  label: string
  amount: number | null
  note?: string
}

interface GuVSection {
  title: string
  lines: GuVLine[]
  subtotal: number | null
  nichtAusgewiesen: number
}

interface GuVResult {
  year: number
  companyId: string
  revenue: GuVSection
  cost: GuVSection
  financial: GuVSection
  tax: GuVSection
  result: GuVSection
  totals: {
    umsatzerloese: number
    betriebsleistung: number
    betriebsergebnis: number
    finanzergebnis: number
    jahresueberschuss: number
  }
  counts: {
    invoices: number
    expenses: number
    credits: number
  }
  generatedAt: string
  disclaimer: string
}

/**
 * Tier 82: Anlage G+V section.
 *
 * Parallel to EuerSection / AnlageSSection /
 * BilanzSection but for the § 275 HGB income
 * statement. Pairs with the Bilanz for a
 * Bilanz-pflichtige entity (GmbH, AG, etc.) —
 * the Jahresüberschuss here is the change in
 * Eigenkapital between two year-end Bilanzen.
 *
 * Sections rendered (in § 275 HGB GKV order):
 *   - Revenue (§ 275 GKV Pos 1-4)
 *   - Cost (§ 275 GKV Pos 5-8)
 *   - Financial result (§ 275 GKV Pos 9-13)
 *   - Tax (§ 275 GKV Pos 14, 16)
 *   - Result (§ 275 GKV Pos 15, 17)
 */
export function GuVSection() {
  const { t } = useI18n()
  const toast = useToast()
  const toastRef = useRef(toast)
  toastRef.current = toast
  const tRef = useRef(t)
  tRef.current = t
  const [year, setYear] = useState<number>(new Date().getFullYear() - 1)
  const [data, setData] = useState<GuVResult | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async (y: number) => {
    setLoading(true)
    try {
      const companyId =
        typeof window !== "undefined" ? localStorage.getItem("companyId") : null
      const params = new URLSearchParams()
      if (companyId) params.set("companyId", companyId)
      params.set("year", String(y))
      const result = await apiGet<GuVResult>(`/api/v1/accounting/guv?${params}`)
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
    setPdfUrl(`${apiBase}/api/v1/accounting/guv.pdf?companyId=${companyId}&year=${year}`)
  }, [year])

  // Map the German backend section titles to i18n
  // keys. The backend titles are hard-coded German
  // (standard HGB vocabulary — never translated),
  // so we map them to localised labels.
  const sectionTitleKey = (s: GuVSection): string | null => {
    if (s.title === "Erträge") return "guv.revenue"
    if (s.title === "Aufwendungen") return "guv.cost"
    if (s.title === "Finanzergebnis") return "guv.financial"
    if (s.title === "Steuern") return "guv.tax"
    if (s.title === "Jahresergebnis") return "guv.result"
    return null
  }

  const renderSection = (section: GuVSection) => {
    const titleKey = sectionTitleKey(section)
    return (
      <div key={section.title} className="mb-4">
        <h4 className="text-sm font-semibold mb-2 text-gray-700 dark:text-gray-200">
          {titleKey ? tRef.current(titleKey) : section.title}
        </h4>
        <table className="w-full text-sm" data-testid={`guv-section-${section.title.toLowerCase()}`}>
          <thead>
            <tr className="text-xs text-gray-500 border-b">
              <th className="text-left py-1 w-12">Pos</th>
              <th className="text-left py-1">Bezeichnung</th>
              <th className="text-right py-1 w-32">Betrag (€)</th>
            </tr>
          </thead>
          <tbody>
            {section.lines.map((l) => (
              <tr
                key={l.position + "-" + l.label}
                className="border-b"
                data-testid={`guv-line-${l.position}`}
              >
                <td className="py-1 font-mono">{l.position}</td>
                <td className="py-1 text-xs">
                  {l.label}
                  {l.note && (
                    <div className="text-[10px] text-gray-500 italic mt-0.5">
                      ↳ {l.note}
                    </div>
                  )}
                </td>
                <td
                  className={`py-1 text-right font-mono ${
                    l.amount === null ? "text-gray-400 italic" : ""
                  }`}
                >
                  {l.amount === null
                    ? `— ${tRef.current("guv.nichtAusgewiesen")} —`
                    : fmt(l.amount)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-gray-300">
              <td className="py-1 text-xs font-semibold">{tRef.current("guv.summe")}</td>
              <td></td>
              <td
                className="py-1 text-right font-mono font-bold"
                data-testid={`guv-subtotal-${section.title.toLowerCase()}`}
              >
                {section.subtotal === null || section.subtotal === 0
                  ? "—"
                  : fmt(section.subtotal)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    )
  }

  const jahresueberschuss = data?.totals.jahresueberschuss ?? 0

  return (
    <div className="mt-6 space-y-4" data-testid="guv-section">
      <Card>
        <CardHeader>
          <CardTitle>
            📈 {tRef.current("guv.title")} ({data?.year || year})
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">
            {tRef.current("guv.subtitle")}
          </p>
          <div className="flex flex-wrap items-end gap-3 mb-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">
                {tRef.current("guv.year")}
              </label>
              <input
                type="number"
                min={2000}
                max={2100}
                value={year}
                onChange={(e) => setYear(Number(e.target.value) || new Date().getFullYear() - 1)}
                className="border rounded px-3 py-2 w-32 dark:bg-gray-800 dark:border-gray-700"
                data-testid="guv-year"
              />
            </div>
            <Button onClick={() => load(year)} disabled={loading} data-testid="guv-recompute">
              {loading ? "..." : tRef.current("guv.recompute")}
            </Button>
            <a href={pdfUrl} target="_blank" rel="noreferrer" className="ml-auto" data-testid="guv-pdf-link">
              <Button variant="outline" type="button" disabled={pdfUrl === "#"}>
                📄 {tRef.current("guv.downloadPdf")}
              </Button>
            </a>
          </div>

          {data && (
            <>
              <div className="grid md:grid-cols-2 gap-4">
                <div>
                  {renderSection(data.revenue)}
                  {renderSection(data.cost)}
                </div>
                <div>
                  {renderSection(data.financial)}
                  {renderSection(data.tax)}
                  {renderSection(data.result)}
                </div>
              </div>

              {/* Jahresergebnis pill — the bottom line */}
              <div
                className={`mt-4 p-3 rounded text-center text-lg font-bold ${
                  jahresueberschuss >= 0
                    ? "bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300"
                    : "bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-300"
                }`}
                data-testid="guv-jahresergebnis"
              >
                {jahresueberschuss >= 0
                  ? `${tRef.current("guv.jahresueberschuss")}: ${fmt(jahresueberschuss)}`
                  : `${tRef.current("guv.jahresfehlbetrag")}: ${fmt(Math.abs(jahresueberschuss))}`}
              </div>

              {/* Summary strip */}
              <div
                className="mt-3 p-3 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded text-xs space-y-1"
                data-testid="guv-summary"
              >
                <div className="font-semibold mb-1">{tRef.current("guv.summary")}:</div>
                <div>
                  {tRef.current("guv.betriebsleistung")}: <b>{fmt(data.totals.betriebsleistung)}</b>
                </div>
                <div>
                  {tRef.current("guv.betriebsergebnis")}: <b>{fmt(data.totals.betriebsergebnis)}</b>
                </div>
                <div>
                  {tRef.current("guv.finanzergebnis")}: <b>{fmt(data.totals.finanzergebnis)}</b>
                </div>
              </div>

              <div
                className="mt-3 p-3 bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-700 rounded text-xs text-amber-800 dark:text-amber-200"
                data-testid="guv-disclaimer"
              >
                ⚠ {data.disclaimer}
              </div>

              <div className="mt-2 text-xs text-gray-500" data-testid="guv-counts">
                {tRef.current("guv.counts")}: <b>{data.counts.invoices}</b> / <b>{data.counts.expenses}</b> /{" "}
                <b>{data.counts.credits}</b> · {tRef.current("guv.generatedAt")}:{" "}
                {new Date(data.generatedAt).toLocaleString("de-DE")}
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
