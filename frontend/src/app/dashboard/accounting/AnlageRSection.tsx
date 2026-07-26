"use client"

import { useEffect, useRef, useState, useCallback } from "react"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { useI18n } from "@/components/useI18n"
import { useToast } from "@/components/useToast"
import { apiGet, apiPut, ApiError } from "@/lib/api"

interface AnlageRLine {
  kennziffer: string
  label: string
  amount: number
  source?: 'computed' | 'placeholder'
  note?: string
}

interface AnlageRResult {
  year: number
  companyId: string
  rentenbezuege: {
    drv: number
    bav: number
    riester: number
    ruerup: number
    privat: number
    sonstige: number
  }
  einnahmen: AnlageRLine[]
  werbungskosten: AnlageRLine[]
  totals: {
    rentenbezuegeTotal: number
    besteuerungsanteil: number
    ertragsanteil: number
    einnahmenTotal: number
    werbungskostenTotal: number
    einkuenfte: number
  }
  counts: {
    hasRentenbezuege: boolean
  }
  generatedAt: string
  disclaimer: string
}

interface RentenInput {
  drv: string
  bav: string
  riester: string
  ruerup: string
  privat: string
  sonstige: string
  werbungskosten200: string
  werbungskosten220: string
  werbungskosten230: string
}

/**
 * Tier 103: Anlage R section.
 *
 * Einkünfte aus Renten und Bezügen (§ 22 EStG)
 * — for retirees / pension recipients. The
 * 6th Anlage form (after S / V / KAP / G / N).
 *
 * The bottom line is the Einkünfte aus Renten
 * (= Besteuerungsanteil × Rentenbezug −
 * Werbungskosten). The user adds this to their
 * total Einkünfte in the Hauptvordruck.
 */
export function AnlageRSection() {
  const { t } = useI18n()
  const toast = useToast()
  const toastRef = useRef(toast)
  toastRef.current = toast
  const tRef = useRef(t)
  tRef.current = t
  const [year, setYear] = useState<number>(new Date().getFullYear() - 1)
  const [data, setData] = useState<AnlageRResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [showRentenEditor, setShowRentenEditor] = useState(false)
  const [rentenInput, setRentenInput] = useState<RentenInput>({
    drv: "",
    bav: "",
    riester: "",
    ruerup: "",
    privat: "",
    sonstige: "",
    werbungskosten200: "",
    werbungskosten220: "",
    werbungskosten230: "",
  })
  const [savingRenten, setSavingRenten] = useState(false)

  const load = useCallback(async (y: number) => {
    setLoading(true)
    try {
      const companyId =
        typeof window !== "undefined" ? localStorage.getItem("companyId") : null
      const params = new URLSearchParams()
      if (companyId) params.set("companyId", companyId)
      params.set("year", String(y))
      const result = await apiGet<AnlageRResult>(
        `/api/v1/accounting/anlage-r?${params}`,
      )
      setData(result)
      // Pre-fill the editor with current saved values
      setRentenInput({
        drv: String(result.rentenbezuege.drv || ""),
        bav: String(result.rentenbezuege.bav || ""),
        riester: String(result.rentenbezuege.riester || ""),
        ruerup: String(result.rentenbezuege.ruerup || ""),
        privat: String(result.rentenbezuege.privat || ""),
        sonstige: String(result.rentenbezuege.sonstige || ""),
        werbungskosten200: String(
          result.werbungskosten.find((l) => l.kennziffer === "200")?.amount || "",
        ),
        werbungskosten220: String(
          result.werbungskosten.find((l) => l.kennziffer === "220")?.amount || "",
        ),
        werbungskosten230: String(
          result.werbungskosten.find((l) => l.kennziffer === "230")?.amount || "",
        ),
      })
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

  const saveRenten = async () => {
    setSavingRenten(true)
    try {
      const companyId =
        typeof window !== "undefined" ? localStorage.getItem("companyId") : null
      if (!companyId) return
      const toNum = (s: string) => (s === "" ? 0 : Number(s))
      await apiPut(
        `/api/v1/accounting/anlage-r/settings?companyId=${companyId}`,
        {
          year,
          drv: toNum(rentenInput.drv),
          bav: toNum(rentenInput.bav),
          riester: toNum(rentenInput.riester),
          ruerup: toNum(rentenInput.ruerup),
          privat: toNum(rentenInput.privat),
          sonstige: toNum(rentenInput.sonstige),
          werbungskosten: {
            "200": toNum(rentenInput.werbungskosten200),
            "220": toNum(rentenInput.werbungskosten220),
            "230": toNum(rentenInput.werbungskosten230),
          },
        },
      )
      toastRef.current.success(tRef.current("anlageR.savedOk"))
      setShowRentenEditor(false)
      await load(year)
    } catch (e: any) {
      const msg = e instanceof ApiError ? e.message : tRef.current("common.loadError")
      toastRef.current.error(msg)
    } finally {
      setSavingRenten(false)
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
    setPdfUrl(`${apiBase}/api/v1/accounting/anlage-r.pdf?companyId=${companyId}&year=${year}`)
  }, [year])

  const renderLine = (l: AnlageRLine) => (
    <tr
      key={l.kennziffer}
      className="border-b"
      data-testid={`anlage-r-${l.kennziffer}`}
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
    <div className="mt-6 space-y-4" data-testid="anlage-r-section">
      <Card>
        <CardHeader>
          <CardTitle>
            🏖️ {tRef.current("anlageR.title")} ({data?.year || year})
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">
            {tRef.current("anlageR.subtitle")}
          </p>
          <div className="flex flex-wrap items-end gap-3 mb-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">
                {tRef.current("anlageR.year")}
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
                data-testid="anlage-r-year"
              />
            </div>
            <Button
              onClick={() => load(year)}
              disabled={loading}
              data-testid="anlage-r-recompute"
            >
              {loading ? "..." : tRef.current("anlageR.recompute")}
            </Button>
            <Button
              variant="outline"
              onClick={() => setShowRentenEditor(true)}
              data-testid="anlage-r-edit-renten"
            >
              ✏️ {tRef.current("anlageR.editRenten")}
            </Button>
            <a
              href={pdfUrl}
              target="_blank"
              rel="noreferrer"
              className="ml-auto"
              data-testid="anlage-r-pdf-link"
            >
              <Button variant="outline" type="button" disabled={pdfUrl === "#"}>
                📄 {tRef.current("anlageR.downloadPdf")}
              </Button>
            </a>
          </div>

          {!data?.counts.hasRentenbezuege && (
            <div
              className="mb-4 p-3 bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-700 rounded text-sm text-amber-800 dark:text-amber-200"
              data-testid="anlage-r-renten-missing"
            >
              {tRef.current("anlageR.rentenMissing")}
            </div>
          )}

          {data && (
            <>
              {data.counts.hasRentenbezuege && (
                <div
                  className="mb-4 p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-700 rounded text-xs"
                  data-testid="anlage-r-renten-summary"
                >
                  <div className="font-semibold mb-1 text-blue-800 dark:text-blue-200">
                    Rentenbezüge (Brutto) {data.year}
                  </div>
                  <div className="text-blue-700 dark:text-blue-300 grid grid-cols-2 md:grid-cols-3 gap-2">
                    <div>DRV: <b>{fmt(data.rentenbezuege.drv)}</b></div>
                    <div>BAV: <b>{fmt(data.rentenbezuege.bav)}</b></div>
                    <div>Riester: <b>{fmt(data.rentenbezuege.riester)}</b></div>
                    <div>Rürup: <b>{fmt(data.rentenbezuege.ruerup)}</b></div>
                    <div>Privat: <b>{fmt(data.rentenbezuege.privat)}</b></div>
                    <div>Sonstige: <b>{fmt(data.rentenbezuege.sonstige)}</b></div>
                  </div>
                  <p
                    className="mt-2 text-[10px] text-blue-600 dark:text-blue-400"
                    data-testid="anlage-r-besteuerungsanteil-hint"
                  >
                    Besteuerungsanteil {data.totals.besteuerungsanteil.toFixed(0)} % (§ 22 Nr. 1 S. 3 lit. a EStG, BMF-Tabelle)
                  </p>
                </div>
              )}

              <div className="grid md:grid-cols-2 gap-4">
                <div>
                  <h3 className="text-sm font-semibold mb-2 text-emerald-700 dark:text-emerald-400">
                    {tRef.current("anlageR.einnahmen")} ({fmt(data.totals.einnahmenTotal)})
                  </h3>
                  <table className="w-full text-sm" data-testid="anlage-r-einnahmen-table">
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
                    {tRef.current("anlageR.werbungskosten")} ({fmt(data.totals.werbungskostenTotal)})
                  </h3>
                  <table className="w-full text-sm" data-testid="anlage-r-werbungskosten-table">
                    <thead>
                      <tr className="text-xs text-gray-500 border-b">
                        <th className="text-left py-1 w-12">Kz</th>
                        <th className="text-left py-1">Bezeichnung</th>
                        <th className="text-right py-1 w-32">Betrag (€)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.werbungskosten.map(renderLine)}
                    </tbody>
                  </table>
                  <p className="mt-1 text-[10px] text-gray-500" data-testid="anlage-r-wk-hint">
                    ⚠ {tRef.current("anlageR.wkHint")}
                  </p>
                </div>
              </div>

              {/* Einkünfte pill */}
              <div
                className={`mt-4 p-3 rounded text-center text-lg font-bold ${
                  data.totals.einkuenfte >= 0
                    ? "bg-amber-50 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300"
                    : "bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300"
                }`}
                data-testid="anlage-r-einkuenfte"
              >
                {tRef.current("anlageR.einkuenfte")}: {fmt(data.totals.einkuenfte)}
              </div>

              <div
                className="mt-3 p-3 bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-700 rounded text-xs text-amber-800 dark:text-amber-200"
                data-testid="anlage-r-disclaimer"
              >
                ⚠ {data.disclaimer}
              </div>

              <div className="mt-2 text-xs text-gray-500" data-testid="anlage-r-counts">
                {tRef.current("anlageR.generatedAt")}: {new Date(data.generatedAt).toLocaleString("de-DE")}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Rentenbezüge editor modal */}
      {showRentenEditor && (
        <div className="fixed inset-0 bg-black bg-opacity-40 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl w-full max-w-3xl p-6 max-h-[90vh] overflow-y-auto">
            <h2 className="text-xl font-bold mb-1">
              {tRef.current("anlageR.editRenten")} ({year})
            </h2>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
              {tRef.current("anlageR.fieldHint")}
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
              {(
                [
                  ["drv", "fields.drv"],
                  ["bav", "fields.bav"],
                  ["riester", "fields.riester"],
                  ["ruerup", "fields.ruerup"],
                  ["privat", "fields.privat"],
                  ["sonstige", "fields.sonstige"],
                ] as [keyof RentenInput, string][]
              ).map(([key, labelKey]) => (
                <div key={key}>
                  <label className="text-xs text-gray-500 dark:text-gray-400 uppercase">
                    {tRef.current(`anlageR.${labelKey}`)}
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    value={rentenInput[key]}
                    onChange={(e) =>
                      setRentenInput({ ...rentenInput, [key]: e.target.value })
                    }
                    className="w-full border rounded px-3 py-2 text-sm mt-1 font-mono text-right"
                    placeholder="0,00"
                    data-testid={`renten-input-${key}`}
                  />
                </div>
              ))}
            </div>

            <h3 className="text-sm font-semibold mb-2 mt-4">Werbungskosten (manuell)</h3>
            <p className="text-xs text-gray-500 mb-2">
              {tRef.current("anlageR.wkHint")}
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
              {(
                [
                  ["werbungskosten200", "Kz 200 — Krankheitskosten"],
                  ["werbungskosten220", "Kz 220 — Pflegekosten"],
                  ["werbungskosten230", "Kz 230 — Sonstige Werbungskosten"],
                ] as [keyof RentenInput, string][]
              ).map(([key, label]) => (
                <div key={key}>
                  <label className="text-xs text-gray-500 dark:text-gray-400">
                    {label}
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    value={rentenInput[key]}
                    onChange={(e) =>
                      setRentenInput({ ...rentenInput, [key]: e.target.value })
                    }
                    className="w-full border rounded px-3 py-2 text-sm mt-1 font-mono text-right"
                    placeholder="0,00"
                    data-testid={`renten-input-${key}`}
                  />
                </div>
              ))}
            </div>

            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => setShowRentenEditor(false)}
                disabled={savingRenten}
              >
                {tRef.current("common.cancel")}
              </Button>
              <Button
                onClick={saveRenten}
                disabled={savingRenten}
                className="bg-emerald-600 text-white hover:bg-emerald-700"
                data-testid="renten-save"
              >
                {savingRenten ? "..." : tRef.current("anlageR.saveRenten")}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
