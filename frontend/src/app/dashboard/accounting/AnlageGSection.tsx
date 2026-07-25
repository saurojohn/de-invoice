"use client"

import { useEffect, useRef, useState, useCallback } from "react"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { useI18n } from "@/components/useI18n"
import { useToast } from "@/components/useToast"
import { apiGet, ApiError } from "@/lib/api"

interface AnlageGLine {
  kennziffer: string
  label: string
  amount: number
  source?: 'computed' | 'placeholder'
  note?: string
}

interface AnlageGResult {
  year: number
  companyId: string
  einnahmen: AnlageGLine[]
  betriebsausgaben: AnlageGLine[]
  hinzurechnungen: AnlageGLine[]
  kurzungen: AnlageGLine[]
  totals: {
    einnahmenTotal: number
    betriebsausgabenTotal: number
    gewinnVorKorrektur: number
    hinzurechnungenTotal: number
    kurzungenTotal: number
    gewerbeertrag: number
    freibetrag: number
    gewerbeertragNachFreibetrag: number
    gewerbesteuerMesszahl: number
    hebesatz: number
    gewerbesteuerSchaetzung: number
  }
  counts: {
    invoices: number
    expenses: number
    matchedMieteExpenses: number
  }
  generatedAt: string
  disclaimer: string
}

/**
 * Tier 100: Anlage G section.
 *
 * Einkünfte aus Gewerbebetrieb (§ 15 EStG)
 * — for gewerbliche Einzelunternehmen +
 * Personengesellschaften. The 4th Anlage
 * form (after S / V / KAP). Pairs with the
 * EÜR: the EÜR is the generic Einnahmen
 * minus Betriebsausgaben, Anlage G adds
 * the § 8/9 GewStG Hinzurechnungs-/
 * Kürzungs-Mechanik to derive the
 * Gewerbeertrag.
 *
 * The bottom line of the section is the
 * Gewerbeertrag + a very rough Gewerbesteuer-
 * Schätzung (3.5% × Hebesatz, default 400%).
 * The Berater adjusts the Hebesatz via
 * Company.settings.hebesatz.
 *
 * For capital companies (GmbH/AG), Anlage G
 * is NOT the right form — they file a separate
 * KSt 1 (Körperschaftsteuererklärung). The
 * disclaimer in the section footer makes this
 * explicit.
 *
 * v1: All paid/sent/overdue invoices in the
 * year are gewerbliche Umsatzerlöse. Expense
 * categorization follows the Anlage S / EÜR
 * pattern. Only Kz 4100 (25% Miete/Pacht
 * Hinzurechnung) and Kz 5100 (50% Kfz
 * Kürzung) are auto-computed; the rest is
 * placeholder.
 */
export function AnlageGSection() {
  const { t } = useI18n()
  const toast = useToast()
  const toastRef = useRef(toast)
  toastRef.current = toast
  const tRef = useRef(t)
  tRef.current = t
  const [year, setYear] = useState<number>(new Date().getFullYear() - 1)
  const [data, setData] = useState<AnlageGResult | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async (y: number) => {
    setLoading(true)
    try {
      const companyId =
        typeof window !== "undefined" ? localStorage.getItem("companyId") : null
      const params = new URLSearchParams()
      if (companyId) params.set("companyId", companyId)
      params.set("year", String(y))
      const result = await apiGet<AnlageGResult>(
        `/api/v1/accounting/anlage-g?${params}`,
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
    setPdfUrl(`${apiBase}/api/v1/accounting/anlage-g.pdf?companyId=${companyId}&year=${year}`)
  }, [year])

  // Render a Kennziffer row. The ⚠ indicator
  // marks placeholder lines (those that need
  // Berater input).
  const renderLine = (l: AnlageGLine) => (
    <tr
      key={l.kennziffer}
      className="border-b"
      data-testid={`anlage-g-${l.kennziffer}`}
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
    <div className="mt-6 space-y-4" data-testid="anlage-g-section">
      <Card>
        <CardHeader>
          <CardTitle>
            🏭 {tRef.current("anlageG.title")} ({data?.year || year})
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">
            {tRef.current("anlageG.subtitle")}
          </p>
          <div className="flex flex-wrap items-end gap-3 mb-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">
                {tRef.current("anlageG.year")}
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
                data-testid="anlage-g-year"
              />
            </div>
            <Button
              onClick={() => load(year)}
              disabled={loading}
              data-testid="anlage-g-recompute"
            >
              {loading ? "..." : tRef.current("anlageG.recompute")}
            </Button>
            <a
              href={pdfUrl}
              target="_blank"
              rel="noreferrer"
              className="ml-auto"
              data-testid="anlage-g-pdf-link"
            >
              <Button variant="outline" type="button" disabled={pdfUrl === "#"}>
                📄 {tRef.current("anlageG.downloadPdf")}
              </Button>
            </a>
          </div>

          {data && (
            <>
              <div className="grid md:grid-cols-2 gap-4">
                <div>
                  <h3 className="text-sm font-semibold mb-2 text-emerald-700 dark:text-emerald-400">
                    {tRef.current("anlageG.einnahmen")} ({fmt(data.totals.einnahmenTotal)})
                  </h3>
                  <table className="w-full text-sm" data-testid="anlage-g-einnahmen-table">
                    <thead>
                      <tr className="text-xs text-gray-500 border-b">
                        <th className="text-left py-1 w-12">Kz</th>
                        <th className="text-left py-1">Bezeichnung</th>
                        <th className="text-right py-1 w-32">Betrag (€)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.einnahmen.map(renderLine)}
                    </tbody>
                  </table>
                </div>

                <div>
                  <h3 className="text-sm font-semibold mb-2 text-red-700 dark:text-red-400">
                    {tRef.current("anlageG.betriebsausgaben")} ({fmt(data.totals.betriebsausgabenTotal)})
                  </h3>
                  <table className="w-full text-sm" data-testid="anlage-g-ausgaben-table">
                    <thead>
                      <tr className="text-xs text-gray-500 border-b">
                        <th className="text-left py-1 w-12">Kz</th>
                        <th className="text-left py-1">Bezeichnung</th>
                        <th className="text-right py-1 w-32">Betrag (€)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.betriebsausgaben.map(renderLine)}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Gewinn / Verlust — the bottom line
                  after Einnahmen − Betriebsausgaben. */}
              <div
                className={`mt-4 p-3 rounded text-center text-lg font-bold ${
                  data.totals.gewinnVorKorrektur >= 0
                    ? "bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300"
                    : "bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-300"
                }`}
                data-testid="anlage-g-gewinn"
              >
                {data.totals.gewinnVorKorrektur >= 0
                  ? `${tRef.current("anlageG.gewinn")}: ${fmt(data.totals.gewinnVorKorrektur)}`
                  : `${tRef.current("anlageG.gewinn")}: −${fmt(Math.abs(data.totals.gewinnVorKorrektur))}`}
              </div>

              <div className="grid md:grid-cols-2 gap-4 mt-4">
                <div>
                  <h3 className="text-sm font-semibold mb-2 text-amber-700 dark:text-amber-400">
                    {tRef.current("anlageG.hinzurechnungen")} (+{fmt(data.totals.hinzurechnungenTotal)})
                  </h3>
                  <table className="w-full text-sm" data-testid="anlage-g-hinzu-table">
                    <thead>
                      <tr className="text-xs text-gray-500 border-b">
                        <th className="text-left py-1 w-12">Kz</th>
                        <th className="text-left py-1">Bezeichnung</th>
                        <th className="text-right py-1 w-32">Betrag (€)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.hinzurechnungen.map(renderLine)}
                    </tbody>
                  </table>
                  <p
                    className="mt-1 text-[10px] text-gray-500"
                    data-testid="anlage-g-hinzu-hint"
                  >
                    ⚠ {tRef.current("anlageG.hinzuHint")}
                  </p>
                </div>

                <div>
                  <h3 className="text-sm font-semibold mb-2 text-blue-700 dark:text-blue-400">
                    {tRef.current("anlageG.kurzungen")} (−{fmt(data.totals.kurzungenTotal)})
                  </h3>
                  <table className="w-full text-sm" data-testid="anlage-g-kurzungen-table">
                    <thead>
                      <tr className="text-xs text-gray-500 border-b">
                        <th className="text-left py-1 w-12">Kz</th>
                        <th className="text-left py-1">Bezeichnung</th>
                        <th className="text-right py-1 w-32">Betrag (€)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.kurzungen.map(renderLine)}
                    </tbody>
                  </table>
                  <p
                    className="mt-1 text-[10px] text-gray-500"
                    data-testid="anlage-g-kurzungen-hint"
                  >
                    ⚠ {tRef.current("anlageG.kurzungHint")}
                  </p>
                </div>
              </div>

              {/* Gewerbeertrag + Gewerbesteuer-Schätzung */}
              <div
                className="mt-4 p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-700 rounded"
                data-testid="anlage-g-gewerbeertrag"
              >
                <div className="text-sm font-semibold mb-1 text-blue-800 dark:text-blue-200">
                  {tRef.current("anlageG.gewerbeertrag")}
                </div>
                <div className="text-xs text-blue-700 dark:text-blue-300 space-y-0.5">
                  <div>
                    Gewerbeertrag: <b>{fmt(data.totals.gewerbeertrag)}</b>
                  </div>
                  <div>
                    ./. {tRef.current("anlageG.freibetrag")}: <b>{fmt(data.totals.freibetrag)}</b>
                  </div>
                  <div>
                    = Gewerbeertrag nach Freibetrag:{" "}
                    <b>{fmt(data.totals.gewerbeertragNachFreibetrag)}</b>
                  </div>
                  <div>
                    × Steuermesszahl:{" "}
                    <b>{(data.totals.gewerbesteuerMesszahl * 100).toFixed(1)} %</b>
                  </div>
                  <div>
                    × {tRef.current("anlageG.hebesatz")}: <b>{data.totals.hebesatz} %</b>
                  </div>
                  <div
                    className="mt-2 pt-2 border-t border-blue-200 dark:border-blue-700 font-bold text-red-700 dark:text-red-300"
                    data-testid="anlage-g-gewst-amount"
                  >
                    = {tRef.current("anlageG.gewStSchätzung")}:{" "}
                    {fmt(data.totals.gewerbesteuerSchaetzung)}
                  </div>
                  <p className="text-[10px] text-blue-600 dark:text-blue-400 mt-1">
                    ⚠ {tRef.current("anlageG.hebesatzHint")}
                  </p>
                </div>
              </div>

              <div
                className="mt-3 p-3 bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-700 rounded text-xs text-amber-800 dark:text-amber-200"
                data-testid="anlage-g-disclaimer"
              >
                ⚠ {data.disclaimer}
              </div>

              <div className="mt-2 text-xs text-gray-500" data-testid="anlage-g-counts">
                {tRef.current("common.invoices")}: <b>{data.counts.invoices}</b> ·{" "}
                {tRef.current("anlageG.betriebsausgaben")}: <b>{data.counts.expenses}</b> ·{" "}
                {tRef.current("anlageG.matchedMiete")}:{" "}
                <b>{data.counts.matchedMieteExpenses}</b> ·{" "}
                {tRef.current("anlageG.generatedAt")}: {new Date(data.generatedAt).toLocaleString("de-DE")}
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
