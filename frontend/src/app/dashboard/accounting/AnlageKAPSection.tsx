"use client"

import { useEffect, useRef, useState, useCallback } from "react"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { useI18n } from "@/components/useI18n"
import { useToast } from "@/components/useToast"
import { apiGet, apiPut, ApiError } from "@/lib/api"
import { FormLabel, FormNote, formTextNow } from "@/lib/tax-form-text"
import { useYearField } from "@/lib/year-field"

interface AnlageKAPLine {
  kennziffer: string
  label: string
  amount: number
  source: 'computed' | 'placeholder'
  note?: string
}

interface AnlageKAPResult {
  year: number
  companyId: string
  einnahmen: AnlageKAPLine[]
  abzuege: AnlageKAPLine[]
  totals: {
    einnahmenTotal: number
    abzuegeTotal: number
    zuVersteuern: number
  }
  abgeltungssteuer: {
    rate: number
    soliRate: number
    expectedSteuer: number
    expectedSoli: number
  }
  counts: {
    bankTransactions: number
    matchedZinsTransactions: number
    matchedDividendeTransactions: number
    leftOutBooked?: number
  }
  // Tier 670: the allowance of the year, and whether the spouses' joint one
  sparerPauschbetrag?: { voll: number; angesetzt: number; zusammenveranlagung: boolean }
  generatedAt: string
  disclaimer: string
}

/**
 * Anlage KAP — Einkünfte aus Kapitalvermögen (§ 20 EStG): interest and
 * dividend credits of the imported accounts that are not in the books.
 * What the form can and cannot know is said on it (Tier 670): income of a
 * business account is business income (§ 20 Abs. 8), a credit is what is
 * left after the tax the bank withheld, the Sparer-Pauschbetrag is the
 * year's and never more than the income.
 */
export function AnlageKAPSection() {
  const { t } = useI18n()
  const toast = useToast()
  const toastRef = useRef(toast)
  toastRef.current = toast
  const tRef = useRef(t)
  tRef.current = t
  const [year, setYear] = useState<number>(new Date().getFullYear() - 1)
  const yearField = useYearField(year, setYear)
  const [together, setTogether] = useState(false)
  const [data, setData] = useState<AnlageKAPResult | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async (y: number) => {
    setLoading(true)
    try {
      const companyId =
        typeof window !== "undefined" ? localStorage.getItem("companyId") : null
      const params = new URLSearchParams()
      if (companyId) params.set("companyId", companyId)
      params.set("year", String(y))
      const result = await apiGet<AnlageKAPResult>(
        `/api/v1/accounting/anlage-kap?${params}`,
      )
      setData(result)
      setTogether(result.sparerPauschbetrag?.zusammenveranlagung === true)
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

  // Tier 670: spouses assessed together share twice the Sparer-Pauschbetrag
  const saveTogether = async (zusammenveranlagung: boolean) => {
    // the box shows the choice at once; the figures follow when it is saved
    setTogether(zusammenveranlagung)
    try {
      const companyId =
        typeof window !== "undefined" ? localStorage.getItem("companyId") : null
      if (!companyId) return
      await apiPut(`/api/v1/accounting/zusammenveranlagung?companyId=${companyId}`, { zusammenveranlagung })
      await load(year)
    } catch (e: any) {
      setTogether(!zusammenveranlagung)
      const msg = e instanceof ApiError ? e.message : tRef.current("common.saveError")
      toastRef.current.error(msg)
    }
  }

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
    setPdfUrl(`${apiBase}/api/v1/accounting/anlage-kap.pdf?companyId=${companyId}&year=${year}`)
  }, [year])

  return (
    <div className="mt-6 space-y-4" data-testid="anlage-kap-section">
      <Card>
        <CardHeader>
          <CardTitle>
            💰 {tRef.current("anlageKAP.title")} ({data?.year || year})
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">
            {tRef.current("anlageKAP.subtitle")}
          </p>
          <div className="flex flex-wrap items-end gap-3 mb-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">
                {tRef.current("anlageKAP.year")}
              </label>
              <input
                type="number"
                min={2000}
                max={2100}
                {...yearField}
                className="border rounded px-3 py-2 w-32 dark:bg-gray-800 dark:border-gray-700"
                data-testid="anlage-kap-year"
              />
            </div>
            <label className="flex items-center gap-2 text-sm pb-2">
              <input
                type="checkbox"
                checked={together}
                disabled={!data || loading}
                onChange={(e) => saveTogether(e.target.checked)}
                data-testid="anlage-kap-zusammen"
              />
              {tRef.current("anlageKAP.zusammenveranlagung")}
            </label>
            <Button
              onClick={() => load(year)}
              disabled={loading}
              data-testid="anlage-kap-recompute"
            >
              {loading ? "..." : tRef.current("anlageKAP.recompute")}
            </Button>
            <a
              href={pdfUrl}
              target="_blank"
              rel="noreferrer"
              className="ml-auto"
              data-testid="anlage-kap-pdf-link"
            >
              <Button variant="outline" type="button" disabled={pdfUrl === "#"}>
                📄 {tRef.current("anlageKAP.downloadPdf")}
              </Button>
            </a>
          </div>

          {data && (
            <>
              <div className="grid md:grid-cols-2 gap-4">
                <div>
                  <h3 className="text-sm font-semibold mb-2 text-emerald-700 dark:text-emerald-400">
                    {tRef.current("anlageKAP.einnahmen")} ({fmt(data.totals.einnahmenTotal)})
                  </h3>
                  <table className="w-full text-sm" data-testid="anlage-kap-einnahmen-table">
                    <thead>
                      <tr className="text-xs text-gray-500 border-b">
                        <th className="text-left py-1 w-12">Kz</th>
                        <th className="text-left py-1"><FormNote text="Bezeichnung" /></th>
                        <th className="text-right py-1 w-32"><FormNote text="Betrag (€)" /></th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.einnahmen.map((l) => (
                        <tr
                          key={l.kennziffer}
                          className="border-b"
                          data-testid={`anlage-kap-rev-${l.kennziffer}`}
                        >
                          <td className="py-1 font-mono">{l.kennziffer}</td>
                          <td className="py-1 text-xs">
                            <FormLabel text={l.label} />
                            {l.source === 'placeholder' && (
                              <span
                                className="ml-1 text-[10px] text-amber-600 dark:text-amber-400"
                                title={formTextNow(l.note)}
                              >
                                ⚠
                              </span>
                            )}
                          </td>
                          <td
                            className={`py-1 text-right font-mono ${
                              l.amount > 0 ? "font-bold" : "text-gray-400"
                            }`}
                          >
                            {fmt(l.amount)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div>
                  <h3 className="text-sm font-semibold mb-2 text-red-700 dark:text-red-400">
                    {tRef.current("anlageKAP.abzuege")} (−{fmt(data.totals.abzuegeTotal)})
                  </h3>
                  <table className="w-full text-sm" data-testid="anlage-kap-abzuege-table">
                    <thead>
                      <tr className="text-xs text-gray-500 border-b">
                        <th className="text-left py-1 w-12">Kz</th>
                        <th className="text-left py-1"><FormNote text="Bezeichnung" /></th>
                        <th className="text-right py-1 w-32"><FormNote text="Betrag (€)" /></th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.abzuege.map((l) => (
                        <tr
                          key={l.kennziffer}
                          className="border-b"
                          data-testid={`anlage-kap-abz-${l.kennziffer}`}
                        >
                          <td className="py-1 font-mono">{l.kennziffer}</td>
                          <td className="py-1 text-xs"><FormLabel text={l.label} /></td>
                          <td className="py-1 text-right font-mono">
                            {fmt(l.amount)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Zu versteuern — the bottom line
                  after Sparer-Pauschbetrag */}
              <div
                className={`mt-4 p-3 rounded text-center text-lg font-bold ${
                  data.totals.zuVersteuern > 0
                    ? "bg-amber-50 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300"
                    : "bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300"
                }`}
                data-testid="anlage-kap-zu-versteuern"
              >
                {tRef.current("anlageKAP.zuVersteuern")}: {fmt(data.totals.zuVersteuern)}
              </div>

              {/* Abgeltungssteuer info — what the
                  bank usually already deducted */}
              <div
                className="mt-3 p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-700 rounded text-xs"
                data-testid="anlage-kap-abgeltung-info"
              >
                <div className="font-semibold mb-1 text-blue-800 dark:text-blue-200">
                  {tRef.current("anlageKAP.abgeltungssteuer")}
                </div>
                <div className="text-blue-700 dark:text-blue-300">
                  {(data.abgeltungssteuer.rate * 100).toFixed(0)}%: {fmt(data.abgeltungssteuer.expectedSteuer)}{" "}
                  · Soli {(data.abgeltungssteuer.soliRate * 100).toFixed(1)}%: {fmt(data.abgeltungssteuer.expectedSoli)}
                </div>
                <div className="text-blue-600 dark:text-blue-400 mt-1 text-[10px]">
                  {tRef.current("anlageKAP.abgeltungHint")}
                </div>
              </div>

              <div
                className="mt-3 p-3 bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-700 rounded text-xs text-amber-800 dark:text-amber-200"
                data-testid="anlage-kap-disclaimer"
              >
                ⚠ <FormNote text={data.disclaimer} />
              </div>

              <div className="mt-2 text-xs text-gray-500" data-testid="anlage-kap-counts">
                {tRef.current("anlageKAP.bankTransactions")}: <b>{data.counts.bankTransactions}</b> ·{" "}
                {tRef.current("anlageKAP.matchedZins")}: <b>{data.counts.matchedZinsTransactions}</b> ·{" "}
                {tRef.current("anlageKAP.matchedDividende")}: <b>{data.counts.matchedDividendeTransactions}</b> ·{" "}
                {tRef.current("anlageKAP.generatedAt")}: {new Date(data.generatedAt).toLocaleString("de-DE")}
              </div>
              {(data.counts.leftOutBooked ?? 0) > 0 && (
                <div className="mt-1 text-xs text-gray-500" data-testid="anlage-kap-left-out">
                  {tRef.current("anlageKAP.leftOutBooked").replace("{n}", String(data.counts.leftOutBooked))}
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
