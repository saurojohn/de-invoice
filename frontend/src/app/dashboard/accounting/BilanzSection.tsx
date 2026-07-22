"use client"

import { useEffect, useRef, useState, useCallback } from "react"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { useI18n } from "@/components/useI18n"
import { useToast } from "@/components/useToast"
import { apiGet, ApiError } from "@/lib/api"

interface BilanzLine {
  position: string
  label: string
  amount: number | null
  note?: string
}

interface BilanzSection {
  title: string
  lines: BilanzLine[]
  subtotal: number | null
  nichtAusgewiesen: number
}

interface BilanzResult {
  year: number
  companyId: string
  aktiva: BilanzSection[]
  passiva: BilanzSection[]
  totals: {
    aktiva: number
    passiva: number
    eigenkapital: number
  }
  balanceCheck: {
    balanced: boolean
    diff: number
  }
  generatedAt: string
  disclaimer: string
}

/**
 * Tier 81: Bilanz (Balance Sheet) VORSCHAU.
 *
 * Year-end § 266 HGB layout for Bilanz-pflichtige
 * entities (GmbH, AG). v1 only computes positions
 * we can derive from existing data — the rest is
 * "nicht ausgewiesen" (not stated). The Saldoposten
 * in the Eigenkapital section balances the
 * Bilanzgleichung; the Berater replaces it with the
 * real equity values from the SKR03 / Handelsregister.
 *
 * Sections rendered:
 *   - Aktiva: A. Anlagevermögen / B. Umlaufvermögen /
 *     C. Rechnungsabgrenzungsposten
 *   - Passiva: A. Eigenkapital / B. Rückstellungen /
 *     C. Verbindlichkeiten / D. Rechnungsabgrenzungsposten
 */
export function BilanzSection() {
  const { t } = useI18n()
  const toast = useToast()
  const toastRef = useRef(toast)
  toastRef.current = toast
  const tRef = useRef(t)
  tRef.current = t
  const [year, setYear] = useState<number>(new Date().getFullYear() - 1)
  const [data, setData] = useState<BilanzResult | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async (y: number) => {
    setLoading(true)
    try {
      const companyId =
        typeof window !== "undefined" ? localStorage.getItem("companyId") : null
      const params = new URLSearchParams()
      if (companyId) params.set("companyId", companyId)
      params.set("year", String(y))
      const result = await apiGet<BilanzResult>(`/api/v1/accounting/bilanz?${params}`)
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
    setPdfUrl(`${apiBase}/api/v1/accounting/bilanz.pdf?companyId=${companyId}&year=${year}`)
  }, [year])

  const renderSection = (section: BilanzSection) => {
    // Build a section-title-keyed translation. We
    // map the German backend titles to i18n keys
    // (the backend titles are hard-coded German by
    // convention — the Berater sees the German
    // accounting vocabulary regardless of UI
    // language, just like the SKR03 doesn't get
    // translated).
    const titleKey = section.title.startsWith("A. Anlagevermögen")
      ? "bilanz.sectionAktivaAnlagevermoegen"
      : section.title.startsWith("B. Umlaufvermögen")
      ? "bilanz.sectionAktivaUmlaufvermoegen"
      : section.title.startsWith("C. Rechnungsabgrenzungsposten")
      ? "bilanz.sectionAktivaRap"
      : section.title.startsWith("A. Eigenkapital")
      ? "bilanz.sectionPassivaEigenkapital"
      : section.title.startsWith("B. Rückstellungen")
      ? "bilanz.sectionPassivaRueckstellungen"
      : section.title.startsWith("C. Verbindlichkeiten")
      ? "bilanz.sectionPassivaVerbindlichkeiten"
      : section.title.startsWith("D. Rechnungsabgrenzungsposten")
      ? "bilanz.sectionPassivaRap"
      : null
    return (
      <div key={section.title} className="mb-4">
        <h4 className="text-sm font-semibold mb-2 text-gray-700 dark:text-gray-200">
          {titleKey ? tRef.current(titleKey) : section.title}
        </h4>
        <table className="w-full text-sm" data-testid={`bilanz-section-${section.title.split(" ")[0].replace(".", "").toLowerCase()}`}>
          <thead>
            <tr className="text-xs text-gray-500 border-b">
              <th className="text-left py-1 w-16">Pos</th>
              <th className="text-left py-1">Bezeichnung</th>
              <th className="text-right py-1 w-32">Betrag (€)</th>
            </tr>
          </thead>
          <tbody>
            {section.lines.map((l) => (
              <tr
                key={l.position + "-" + l.label}
                className="border-b"
                data-testid={`bilanz-line-${section.title.split(" ")[0].replace(".", "").toLowerCase()}-${l.position}`}
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
                    ? `— ${tRef.current("bilanz.nichtAusgewiesen")} —`
                    : fmt(l.amount)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-gray-300">
              <td className="py-1 text-xs font-semibold">{tRef.current("bilanz.summe")}</td>
              <td></td>
              <td
                className="py-1 text-right font-mono font-bold"
                data-testid={`bilanz-subtotal-${section.title.split(" ")[0].replace(".", "").toLowerCase()}`}
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

  return (
    <div className="mt-6 space-y-4" data-testid="bilanz-section">
      <Card>
        <CardHeader>
          <CardTitle>
            📊 {tRef.current("bilanz.title")} ({data?.year || year})
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">
            {tRef.current("bilanz.subtitle")}
          </p>
          <div className="flex flex-wrap items-end gap-3 mb-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">
                {tRef.current("bilanz.year")}
              </label>
              <input
                type="number"
                min={2000}
                max={2100}
                value={year}
                onChange={(e) => setYear(Number(e.target.value) || new Date().getFullYear() - 1)}
                className="border rounded px-3 py-2 w-32 dark:bg-gray-800 dark:border-gray-700"
                data-testid="bilanz-year"
              />
            </div>
            <Button onClick={() => load(year)} disabled={loading} data-testid="bilanz-recompute">
              {loading ? "..." : tRef.current("bilanz.recompute")}
            </Button>
            <a href={pdfUrl} target="_blank" rel="noreferrer" className="ml-auto" data-testid="bilanz-pdf-link">
              <Button variant="outline" type="button" disabled={pdfUrl === "#"}>
                📄 {tRef.current("bilanz.downloadPdf")}
              </Button>
            </a>
          </div>

          {data && (
            <>
              <div className="grid md:grid-cols-2 gap-4">
                <div>
                  <h3
                    className="text-sm font-semibold mb-2 text-emerald-700 dark:text-emerald-400"
                    data-testid="bilanz-aktiva-title"
                  >
                    {tRef.current("bilanz.aktiva")}
                  </h3>
                  {data.aktiva.map(renderSection)}
                </div>

                <div>
                  <h3
                    className="text-sm font-semibold mb-2 text-blue-700 dark:text-blue-400"
                    data-testid="bilanz-passiva-title"
                  >
                    {tRef.current("bilanz.passiva")}
                  </h3>
                  {data.passiva.map(renderSection)}
                </div>
              </div>

              <div
                className={`mt-4 p-3 rounded text-center text-lg font-bold ${
                  data.balanceCheck.balanced
                    ? "bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300"
                    : "bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-300"
                }`}
                data-testid="bilanz-balance-check"
              >
                {data.balanceCheck.balanced
                  ? `✓ ${tRef.current("bilanz.balanced")}`
                  : `✗ ${tRef.current("bilanz.unbalanced")}: ${fmt(data.balanceCheck.diff)}`}
              </div>

              <div
                className="mt-3 p-3 bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-700 rounded text-xs text-amber-800 dark:text-amber-200"
                data-testid="bilanz-disclaimer"
              >
                ⚠ {data.disclaimer}
              </div>

              <div className="mt-2 text-xs text-gray-500" data-testid="bilanz-counts">
                {tRef.current("bilanz.totalsAktiva")}: <b>{fmt(data.totals.aktiva)}</b> ·{" "}
                {tRef.current("bilanz.totalsPassiva")}: <b>{fmt(data.totals.passiva)}</b> ·{" "}
                {tRef.current("bilanz.totalsEigenkapital")}: <b>{fmt(data.totals.eigenkapital)}</b> ·{" "}
                {tRef.current("bilanz.generatedAt")}: {new Date(data.generatedAt).toLocaleString("de-DE")}
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
