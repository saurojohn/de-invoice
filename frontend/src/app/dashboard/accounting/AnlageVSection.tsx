"use client"

import { useEffect, useRef, useState, useCallback } from "react"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { useI18n } from "@/components/useI18n"
import { useToast } from "@/components/useToast"
import { apiGet, ApiError } from "@/lib/api"

interface AnlageVLine {
  kennziffer: string
  label: string
  amount: number
}

interface AnlageVResult {
  year: number
  companyId: string
  einnahmen: AnlageVLine[]
  werbungskosten: AnlageVLine[]
  totals: {
    einnahmenTotal: number
    werbungskostenTotal: number
    ueberschuss: number
  }
  counts: {
    invoices: number
    expenses: number
    // Tier 455: issued / dated in the year, counted when paid
    unbezahlt?: { invoices: number; expenses: number }
    afaBookings: number
    buildingAssets: number
  }
  afaSource: 'booked' | 'computed' | 'nicht_gebucht'
  generatedAt: string
  disclaimer: string
}

/**
 * Tier 92: Anlage V section.
 *
 * Einkünfte aus Vermietung und Verpachtung
 * (§ 21 EStG) — for landlords / Vermieter.
 * Mirrors AnlageSSection: same JSON shape
 * + Kennziffer rendering. The Werbungskosten
 * side is shifted to the typical landlord
 * categories (Schuldzinsen, Grundsteuer,
 * Gebäude-AfA, Gebäudeversicherung, etc.).
 *
 * The 8600 Gebäude-AfA line has a special
 * source tag ('booked' / 'computed' /
 * 'nicht_gebucht') so the user knows whether
 * the AfA comes from real booked rows
 * (tier 87+89) or from the in-memory
 * computation. Same UX as Anlage S 4600.
 */
export function AnlageVSection() {
  const { t } = useI18n()
  const toast = useToast()
  const toastRef = useRef(toast)
  toastRef.current = toast
  const tRef = useRef(t)
  tRef.current = t
  const [year, setYear] = useState<number>(new Date().getFullYear() - 1)
  const [data, setData] = useState<AnlageVResult | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async (y: number) => {
    setLoading(true)
    try {
      const companyId =
        typeof window !== "undefined" ? localStorage.getItem("companyId") : null
      const params = new URLSearchParams()
      if (companyId) params.set("companyId", companyId)
      params.set("year", String(y))
      const result = await apiGet<AnlageVResult>(`/api/v1/accounting/anlage-v?${params}`)
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
    setPdfUrl(`${apiBase}/api/v1/accounting/anlage-v.pdf?companyId=${companyId}&year=${year}`)
  }, [year])

  // AfA source label + color (mirrors Anlage S
  // convention from tier 87: 'booked' = green,
  // 'computed' = amber, 'nicht_gebucht' = red).
  const afaSourceLabel = data
    ? data.afaSource === 'booked'
      ? tRef.current("anlageV.afaBooked")
      : data.afaSource === 'computed'
        ? tRef.current("anlageV.afaComputed")
        : tRef.current("anlageV.afaNotBooked")
    : ''
  const afaSourceColor = data
    ? data.afaSource === 'booked'
      ? 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300'
      : data.afaSource === 'computed'
        ? 'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300'
        : 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300'
    : ''

  return (
    <div className="mt-6 space-y-4" data-testid="anlage-v-section">
      <Card>
        <CardHeader>
          <CardTitle>
            🏠 {tRef.current("anlageV.title")} ({data?.year || year})
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">
            {tRef.current("anlageV.subtitle")}
          </p>
          <div className="flex flex-wrap items-end gap-3 mb-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">
                {tRef.current("anlageV.year")}
              </label>
              <input
                type="number"
                min={2000}
                max={2100}
                value={year}
                onChange={(e) => setYear(Number(e.target.value) || new Date().getFullYear() - 1)}
                className="border rounded px-3 py-2 w-32 dark:bg-gray-800 dark:border-gray-700"
                data-testid="anlage-v-year"
              />
            </div>
            <Button onClick={() => load(year)} disabled={loading} data-testid="anlage-v-recompute">
              {loading ? "..." : tRef.current("anlageV.recompute")}
            </Button>
            <a href={pdfUrl} target="_blank" rel="noreferrer" className="ml-auto" data-testid="anlage-v-pdf-link">
              <Button variant="outline" type="button" disabled={pdfUrl === "#"}>
                📄 {tRef.current("anlageV.downloadPdf")}
              </Button>
            </a>
          </div>

          {data && (
            <>
              {/* AfA source badge — tells the user
                  whether 8600 is from real booked
                  rows (best), computed in-memory
                  (ok), or not available (worst). */}
              <div className="mb-3 flex items-center gap-2" data-testid="anlage-v-afa-source">
                <span className="text-xs text-gray-500">
                  {tRef.current("anlageV.afaSourceLabel")}:
                </span>
                <Badge className={afaSourceColor} data-testid="anlage-v-afa-source-badge">
                  {afaSourceLabel}
                </Badge>
              </div>

              <div className="grid md:grid-cols-2 gap-4">
                <div>
                  <h3 className="text-sm font-semibold mb-2 text-emerald-700 dark:text-emerald-400">
                    {tRef.current("anlageV.einnahmen")} ({data.totals.einnahmenTotal >= 0 ? "+" : ""}
                    {fmt(data.totals.einnahmenTotal)})
                  </h3>
                  <table className="w-full text-sm" data-testid="anlage-v-einnahmen-table">
                    <thead>
                      <tr className="text-xs text-gray-500 border-b">
                        <th className="text-left py-1 w-12">Kz</th>
                        <th className="text-left py-1">Bezeichnung</th>
                        <th className="text-right py-1 w-32">Betrag (€)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.einnahmen.map((l) => (
                        <tr key={l.kennziffer} className="border-b" data-testid={`anlage-v-rev-${l.kennziffer}`}>
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
                    {tRef.current("anlageV.werbungskosten")} (−{fmt(data.totals.werbungskostenTotal)})
                  </h3>
                  <table className="w-full text-sm" data-testid="anlage-v-werbungskosten-table">
                    <thead>
                      <tr className="text-xs text-gray-500 border-b">
                        <th className="text-left py-1 w-12">Kz</th>
                        <th className="text-left py-1">Bezeichnung</th>
                        <th className="text-right py-1 w-32">Betrag (€)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.werbungskosten.map((l) => (
                        <tr key={l.kennziffer} className="border-b" data-testid={`anlage-v-exp-${l.kennziffer}`}>
                          <td className="py-1 font-mono">{l.kennziffer}</td>
                          <td className="py-1 text-xs">{l.label}</td>
                          <td className={`py-1 text-right font-mono ${l.amount === 0 && l.kennziffer === '8600' ? 'text-amber-600 dark:text-amber-400' : ''}`}>
                            {fmt(l.amount)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div
                className={`mt-4 p-3 rounded text-center text-lg font-bold ${
                  data.totals.ueberschuss >= 0
                    ? "bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300"
                    : "bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-300"
                }`}
                data-testid="anlage-v-ueberschuss"
              >
                {data.totals.ueberschuss >= 0
                  ? `${tRef.current("anlageV.ueberschuss")}: ${fmt(data.totals.ueberschuss)}`
                  : `${tRef.current("anlageV.verlust")}: ${fmt(Math.abs(data.totals.ueberschuss))}`}
              </div>

              {/* Tier 455: counted when paid (§ 11 EStG), as the EÜR */}
              <div className="mt-3 text-xs text-gray-600 dark:text-gray-300" data-testid="anlage-v-zufluss">
                {tRef.current("euer.zufluss")}
                {data.counts.unbezahlt && (data.counts.unbezahlt.invoices > 0 || data.counts.unbezahlt.expenses > 0) && (
                  <>
                    {" "}
                    {tRef.current("euer.offen", {
                      year: data.year,
                      invoices: data.counts.unbezahlt.invoices,
                      expenses: data.counts.unbezahlt.expenses,
                    })}
                  </>
                )}
              </div>

              <div
                className="mt-3 p-3 bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-700 rounded text-xs text-amber-800 dark:text-amber-200"
                data-testid="anlage-v-disclaimer"
              >
                ⚠ {data.disclaimer}
              </div>

              <div className="mt-2 text-xs text-gray-500" data-testid="anlage-v-counts">
                {tRef.current("anlageV.invoices")}: <b>{data.counts.invoices}</b> ·{" "}
                {tRef.current("anlageV.expenses")}: <b>{data.counts.expenses}</b> ·{" "}
                {tRef.current("anlageV.afaBookingsCount")}: <b>{data.counts.afaBookings}</b> ·{" "}
                {tRef.current("anlageV.buildingAssets")}: <b>{data.counts.buildingAssets}</b> ·{" "}
                {tRef.current("anlageV.generatedAt")}: {new Date(data.generatedAt).toLocaleString("de-DE")}
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
