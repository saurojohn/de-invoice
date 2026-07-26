"use client"

import { useEffect, useRef, useState, useCallback } from "react"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { useI18n } from "@/components/useI18n"
import { useToast } from "@/components/useToast"
import { apiGet, ApiError } from "@/lib/api"

interface UstjaLine {
  kennziffer: string
  label: string
  net?: number
  vat?: number
  amount?: number
  source?: "computed" | "placeholder"
  note?: string
}

interface UstjaMonthlyRow {
  month: number
  monthLabel: string
  umsatzsteuer: number
  vorsteuer: number
  zahllast: number
}

interface UstjaResult {
  year: number
  companyId: string
  periodLabel: string
  lines: UstjaLine[]
  totals: {
    umsatzsteuer: number
    vorsteuer: number
    sondervorauszahlung: number
    zahllast: number
    restzahlung: number
    differenzbetrag: number
  }
  monthlyBreakdown: UstjaMonthlyRow[]
  counts: {
    hasData: boolean
    monthsWithData: number
  }
  generatedAt: string
  disclaimer: string
}

/**
 * Tier 105: UStJA — Umsatzsteuerjahreserklärung.
 *
 * The annual VAT return that consolidates the 12
 * monthly UStVAs (§ 18 Abs. 3 UStG, BMF Vordruck
 * 2024). Every company with USt obligation files
 * this (Kleinunternehmer § 19 UStG file it once a
 * year INSTEAD of the 12 monthly UStVAs).
 *
 * The Berater packager always includes the UStJA
 * PDF for every company — it's a separate Steuerart
 * (USt) from the ESt/KSt Anlage forms, so it sits
 * in its own slot in the year-end ZIP.
 */
export function UstjaSection() {
  const { t } = useI18n()
  const toast = useToast()
  const toastRef = useRef(toast)
  toastRef.current = toast
  const tRef = useRef(t)
  tRef.current = t
  const [year, setYear] = useState<number>(new Date().getFullYear() - 1)
  const [data, setData] = useState<UstjaResult | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async (y: number) => {
    setLoading(true)
    try {
      const companyId =
        typeof window !== "undefined" ? localStorage.getItem("companyId") : null
      const params = new URLSearchParams()
      if (companyId) params.set("companyId", companyId)
      params.set("year", String(y))
      const result = await apiGet<UstjaResult>(
        `/api/v1/ustva/ustja?${params}`,
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
    setPdfUrl(`${apiBase}/api/v1/ustva/ustja.pdf?companyId=${companyId}&year=${year}`)
  }, [year])

  return (
    <div className="mt-6 space-y-4" data-testid="ustja-section">
      <Card>
        <CardHeader>
          <CardTitle>
            🧾 {tRef.current("ustja.title")} ({data?.year || year})
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">
            {tRef.current("ustja.subtitle")}
          </p>
          <div className="flex flex-wrap items-end gap-3 mb-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">
                {tRef.current("ustja.year")}
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
                data-testid="ustja-year"
              />
            </div>
            <Button
              onClick={() => load(year)}
              disabled={loading}
              data-testid="ustja-recompute"
            >
              {loading ? "..." : tRef.current("ustja.recompute")}
            </Button>
            <a
              href={pdfUrl}
              target="_blank"
              rel="noreferrer"
              className="ml-auto"
              data-testid="ustja-pdf-link"
            >
              <Button variant="outline" type="button" disabled={pdfUrl === "#"}>
                📄 {tRef.current("ustja.downloadPdf")}
              </Button>
            </a>
          </div>

          {!data?.counts.hasData && (
            <div
              className="mb-4 p-3 bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-700 rounded text-sm text-amber-800 dark:text-amber-200"
              data-testid="ustja-no-data"
            >
              ⚠ Keine USt-Daten für {data?.year || year} erfasst. Buchen Sie Rechnungen / Eingangsrechnungen, um die UStJA zu berechnen.
            </div>
          )}

          {data && (
            <>
              {/* Monthly breakdown table (12 rows) */}
              <h3 className="text-sm font-semibold mb-2 text-blue-700 dark:text-blue-400">
                {tRef.current("ustja.monthlyBreakdown")} ({data.counts.monthsWithData}/12)
              </h3>
              <div className="overflow-x-auto mb-4">
                <table className="w-full text-sm" data-testid="ustja-monthly-table">
                  <thead>
                    <tr className="text-xs text-gray-500 border-b">
                      <th className="text-left py-1 w-24">{tRef.current("ustja.month")}</th>
                      <th className="text-right py-1 w-32">{tRef.current("ustja.umsatzsteuer")}</th>
                      <th className="text-right py-1 w-32">{tRef.current("ustja.vorsteuer")}</th>
                      <th className="text-right py-1 w-32">{tRef.current("ustja.zahllast")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.monthlyBreakdown.map((m) => (
                      <tr
                        key={m.month}
                        className="border-b"
                        data-testid={`ustja-month-${m.month}`}
                      >
                        <td className="py-1">{m.monthLabel}</td>
                        <td className={`py-1 text-right font-mono ${m.umsatzsteuer > 0 ? "font-bold" : "text-gray-400"}`}>
                          {fmt(m.umsatzsteuer)}
                        </td>
                        <td className={`py-1 text-right font-mono ${m.vorsteuer > 0 ? "" : "text-gray-400"}`}>
                          {fmt(m.vorsteuer)}
                        </td>
                        <td className={`py-1 text-right font-mono ${m.zahllast > 0 ? "text-amber-700 dark:text-amber-300" : m.zahllast < 0 ? "text-emerald-700 dark:text-emerald-300" : "text-gray-400"}`}>
                          {fmt(m.zahllast)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* BMF Vordruck — Kennziffern table */}
              <h3 className="text-sm font-semibold mb-2 text-emerald-700 dark:text-emerald-400">
                {tRef.current("ustja.vordruck")}
              </h3>
              <div className="overflow-x-auto mb-4">
                <table className="w-full text-sm" data-testid="ustja-vordruck-table">
                  <thead>
                    <tr className="text-xs text-gray-500 border-b">
                      <th className="text-left py-1 w-12">Kz</th>
                      <th className="text-left py-1">Bezeichnung</th>
                      <th className="text-right py-1 w-32">Betrag (€)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.lines.map((l) => (
                      <tr
                        key={l.kennziffer}
                        className="border-b"
                        data-testid={`ustja-${l.kennziffer}`}
                      >
                        <td className="py-1 font-mono">{l.kennziffer}</td>
                        <td className="py-1 text-xs">{l.label}</td>
                        <td
                          className={`py-1 text-right font-mono ${
                            (l.amount ?? l.net ?? 0) > 0
                              ? "font-bold"
                              : (l.amount ?? l.net ?? 0) < 0
                              ? "text-red-700 dark:text-red-300"
                              : "text-gray-400"
                          }`}
                        >
                          {fmt(l.amount ?? l.net ?? 0)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-1 text-[10px] text-gray-500" data-testid="ustja-fields-hint">
                ⚠ {tRef.current("ustja.fieldsHint")}
              </p>

              {/* Summary block — 4 pills */}
              <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-3" data-testid="ustja-summary">
                <div className="p-3 rounded text-center bg-emerald-50 dark:bg-emerald-900/30">
                  <div className="text-xs text-gray-500 dark:text-gray-400 uppercase">
                    {tRef.current("ustja.umsatzsteuer")}
                  </div>
                  <div className="text-lg font-bold font-mono text-emerald-700 dark:text-emerald-300" data-testid="ustja-kz66">
                    {fmt(data.totals.umsatzsteuer)}
                  </div>
                  <div className="text-[10px] text-gray-500">Kz 66</div>
                </div>
                <div className="p-3 rounded text-center bg-blue-50 dark:bg-blue-900/30">
                  <div className="text-xs text-gray-500 dark:text-gray-400 uppercase">
                    {tRef.current("ustja.vorsteuer")}
                  </div>
                  <div className="text-lg font-bold font-mono text-blue-700 dark:text-blue-300" data-testid="ustja-kz67">
                    {fmt(data.totals.vorsteuer)}
                  </div>
                  <div className="text-[10px] text-gray-500">Kz 67</div>
                </div>
                <div className="p-3 rounded text-center bg-amber-50 dark:bg-amber-900/30">
                  <div className="text-xs text-gray-500 dark:text-gray-400 uppercase">
                    {tRef.current("ustja.zahllast")}
                  </div>
                  <div className="text-lg font-bold font-mono text-amber-700 dark:text-amber-300" data-testid="ustja-kz68">
                    {fmt(data.totals.zahllast)}
                  </div>
                  <div className="text-[10px] text-gray-500">Kz 68</div>
                </div>
                <div className="p-3 rounded text-center bg-red-50 dark:bg-red-900/30">
                  <div className="text-xs text-gray-500 dark:text-gray-400 uppercase">
                    Restzahlung
                  </div>
                  <div className="text-lg font-bold font-mono text-red-700 dark:text-red-300" data-testid="ustja-kz69">
                    {fmt(data.totals.restzahlung)}
                  </div>
                  <div className="text-[10px] text-gray-500">Kz 69 (bis 31.07.)</div>
                </div>
              </div>

              <div
                className="mt-3 p-3 bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-700 rounded text-xs text-amber-800 dark:text-amber-200"
                data-testid="ustja-disclaimer"
              >
                ⚠ {data.disclaimer}
              </div>

              <div className="mt-2 text-xs text-gray-500" data-testid="ustja-counts">
                {tRef.current("ustja.generatedAt")}: {new Date(data.generatedAt).toLocaleString("de-DE")}
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
