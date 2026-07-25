"use client"

import { useEffect, useRef, useState, useCallback } from "react"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { useI18n } from "@/components/useI18n"
import { useToast } from "@/components/useToast"
import { apiGet, apiPut, ApiError } from "@/lib/api"

interface AnlageNLine {
  kennziffer: string
  label: string
  amount: number
  source?: 'computed' | 'placeholder'
  note?: string
}

interface AnlageNResult {
  year: number
  companyId: string
  lohnsteuerbescheinigung: {
    bruttoArbeitslohn: number
    lohnsteuer: number
    soli: number
    kirchensteuer: number
    rentenversicherung: number
    arbeitslosenversicherung: number
    krankenversicherung: number
    pflegeversicherung: number
  }
  einnahmen: AnlageNLine[]
  werbungskosten: AnlageNLine[]
  sonderausgaben: AnlageNLine[]
  aussergewoehnlicheBelastungen: AnlageNLine[]
  totals: {
    bruttoArbeitslohn: number
    lohnsteuerTotal: number
    werbungskostenTotal: number
    sonderausgabenTotal: number
    aussergewoehnlicheBelastungenTotal: number
    altersentlastungsbetrag: number
    einkuenfte: number
  }
  counts: {
    hasLohnsteuerbescheinigung: boolean
  }
  generatedAt: string
  disclaimer: string
}

interface LohnsteuerbescheinigungInput {
  bruttoArbeitslohn: string
  lohnsteuer: string
  soli: string
  kirchensteuer: string
  rentenversicherung: string
  arbeitslosenversicherung: string
  krankenversicherung: string
  pflegeversicherung: string
  werbungskosten140: string
  werbungskosten150: string
  werbungskosten160: string
  werbungskosten170: string
  werbungskosten180: string
  werbungskosten190: string
}

/**
 * Tier 101: Anlage N section.
 *
 * Einkünfte aus nichtselbständiger Arbeit
 * (§ 3 EStG) — for employees + civil servants
 * + part-time workers + managing directors
 * with employment contracts. The 5th Anlage
 * form (after S / V / KAP / G).
 *
 * Data source: the Lohnsteuerbescheinigung
 * (annual wage tax certificate issued by
 * the employer). The user enters the values
 * via a small form (the LSB is one A4 page
 * per year, easy to transcribe).
 *
 * The bottom line is the Anlage-N-Einkünfte
 * (= Brutto − Werbungskosten − Sonderausgaben
 * − aB − Altersentlastungsbetrag). The user
 * adds this to their total Einkünfte in the
 * Hauptvordruck.
 */
export function AnlageNSection() {
  const { t } = useI18n()
  const toast = useToast()
  const toastRef = useRef(toast)
  toastRef.current = toast
  const tRef = useRef(t)
  tRef.current = t
  const [year, setYear] = useState<number>(new Date().getFullYear() - 1)
  const [data, setData] = useState<AnlageNResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [showLsbEditor, setShowLsbEditor] = useState(false)
  const [lsbInput, setLsbInput] = useState<LohnsteuerbescheinigungInput>({
    bruttoArbeitslohn: "",
    lohnsteuer: "",
    soli: "",
    kirchensteuer: "",
    rentenversicherung: "",
    arbeitslosenversicherung: "",
    krankenversicherung: "",
    pflegeversicherung: "",
    werbungskosten140: "",
    werbungskosten150: "",
    werbungskosten160: "",
    werbungskosten170: "",
    werbungskosten180: "",
    werbungskosten190: "",
  })
  const [savingLsb, setSavingLsb] = useState(false)

  const load = useCallback(async (y: number) => {
    setLoading(true)
    try {
      const companyId =
        typeof window !== "undefined" ? localStorage.getItem("companyId") : null
      const params = new URLSearchParams()
      if (companyId) params.set("companyId", companyId)
      params.set("year", String(y))
      const result = await apiGet<AnlageNResult>(
        `/api/v1/accounting/anlage-n?${params}`,
      )
      setData(result)
      // Pre-fill the LSB editor with the current
      // saved values (so the user can edit them
      // without re-typing everything).
      setLsbInput({
        bruttoArbeitslohn: String(result.lohnsteuerbescheinigung.bruttoArbeitslohn || ""),
        lohnsteuer: String(result.lohnsteuerbescheinigung.lohnsteuer || ""),
        soli: String(result.lohnsteuerbescheinigung.soli || ""),
        kirchensteuer: String(result.lohnsteuerbescheinigung.kirchensteuer || ""),
        rentenversicherung: String(result.lohnsteuerbescheinigung.rentenversicherung || ""),
        arbeitslosenversicherung: String(result.lohnsteuerbescheinigung.arbeitslosenversicherung || ""),
        krankenversicherung: String(result.lohnsteuerbescheinigung.krankenversicherung || ""),
        pflegeversicherung: String(result.lohnsteuerbescheinigung.pflegeversicherung || ""),
        werbungskosten140: String(
          result.werbungskosten.find((l) => l.kennziffer === "140")?.amount || "",
        ),
        werbungskosten150: String(
          result.werbungskosten.find((l) => l.kennziffer === "150")?.amount || "",
        ),
        werbungskosten160: String(
          result.werbungskosten.find((l) => l.kennziffer === "160")?.amount || "",
        ),
        werbungskosten170: String(
          result.werbungskosten.find((l) => l.kennziffer === "170")?.amount || "",
        ),
        werbungskosten180: String(
          result.werbungskosten.find((l) => l.kennziffer === "180")?.amount || "",
        ),
        werbungskosten190: String(
          result.werbungskosten.find((l) => l.kennziffer === "190")?.amount || "",
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

  const saveLsb = async () => {
    setSavingLsb(true)
    try {
      const companyId =
        typeof window !== "undefined" ? localStorage.getItem("companyId") : null
      if (!companyId) return
      const toNum = (s: string) => (s === "" ? 0 : Number(s))
      await apiPut(
        `/api/v1/accounting/anlage-n/settings?companyId=${companyId}`,
        {
          year,
          bruttoArbeitslohn: toNum(lsbInput.bruttoArbeitslohn),
          lohnsteuer: toNum(lsbInput.lohnsteuer),
          soli: toNum(lsbInput.soli),
          kirchensteuer: toNum(lsbInput.kirchensteuer),
          rentenversicherung: toNum(lsbInput.rentenversicherung),
          arbeitslosenversicherung: toNum(lsbInput.arbeitslosenversicherung),
          krankenversicherung: toNum(lsbInput.krankenversicherung),
          pflegeversicherung: toNum(lsbInput.pflegeversicherung),
          werbungskosten: {
            "140": toNum(lsbInput.werbungskosten140),
            "150": toNum(lsbInput.werbungskosten150),
            "160": toNum(lsbInput.werbungskosten160),
            "170": toNum(lsbInput.werbungskosten170),
            "180": toNum(lsbInput.werbungskosten180),
            "190": toNum(lsbInput.werbungskosten190),
          },
        },
      )
      toastRef.current.success(tRef.current("anlageN.savedOk"))
      setShowLsbEditor(false)
      await load(year)
    } catch (e: any) {
      const msg = e instanceof ApiError ? e.message : tRef.current("common.loadError")
      toastRef.current.error(msg)
    } finally {
      setSavingLsb(false)
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
    setPdfUrl(`${apiBase}/api/v1/accounting/anlage-n.pdf?companyId=${companyId}&year=${year}`)
  }, [year])

  // Render a Kennziffer row. The ⚠ indicator
  // marks placeholder lines (those that need
  // Berater input).
  const renderLine = (l: AnlageNLine) => (
    <tr
      key={l.kennziffer}
      className="border-b"
      data-testid={`anlage-n-${l.kennziffer}`}
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
    <div className="mt-6 space-y-4" data-testid="anlage-n-section">
      <Card>
        <CardHeader>
          <CardTitle>
            👤 {tRef.current("anlageN.title")} ({data?.year || year})
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">
            {tRef.current("anlageN.subtitle")}
          </p>
          <div className="flex flex-wrap items-end gap-3 mb-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">
                {tRef.current("anlageN.year")}
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
                data-testid="anlage-n-year"
              />
            </div>
            <Button
              onClick={() => load(year)}
              disabled={loading}
              data-testid="anlage-n-recompute"
            >
              {loading ? "..." : tRef.current("anlageN.recompute")}
            </Button>
            <Button
              variant="outline"
              onClick={() => setShowLsbEditor(true)}
              data-testid="anlage-n-edit-lsb"
            >
              ✏️ {tRef.current("anlageN.editLsb")}
            </Button>
            <a
              href={pdfUrl}
              target="_blank"
              rel="noreferrer"
              className="ml-auto"
              data-testid="anlage-n-pdf-link"
            >
              <Button variant="outline" type="button" disabled={pdfUrl === "#"}>
                📄 {tRef.current("anlageN.downloadPdf")}
              </Button>
            </a>
          </div>

          {!data?.counts.hasLohnsteuerbescheinigung && (
            <div
              className="mb-4 p-3 bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-700 rounded text-sm text-amber-800 dark:text-amber-200"
              data-testid="anlage-n-lsb-missing"
            >
              {tRef.current("anlageN.lsbMissing")}
            </div>
          )}

          {data && (
            <>
              {/* Lohnsteuerbescheinigung summary */}
              {data.counts.hasLohnsteuerbescheinigung && (
                <div
                  className="mb-4 p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-700 rounded text-xs"
                  data-testid="anlage-n-lsb-summary"
                >
                  <div className="font-semibold mb-1 text-blue-800 dark:text-blue-200">
                    Lohnsteuerbescheinigung {data.year}
                  </div>
                  <div className="text-blue-700 dark:text-blue-300 grid grid-cols-2 md:grid-cols-4 gap-2">
                    <div>
                      Brutto: <b>{fmt(data.lohnsteuerbescheinigung.bruttoArbeitslohn)}</b>
                    </div>
                    <div>
                      Lohnsteuer: <b>{fmt(data.lohnsteuerbescheinigung.lohnsteuer)}</b>
                    </div>
                    <div>
                      Soli: <b>{fmt(data.lohnsteuerbescheinigung.soli)}</b>
                    </div>
                    <div>
                      KiSt: <b>{fmt(data.lohnsteuerbescheinigung.kirchensteuer)}</b>
                    </div>
                  </div>
                </div>
              )}

              <div className="grid md:grid-cols-2 gap-4">
                <div>
                  <h3 className="text-sm font-semibold mb-2 text-emerald-700 dark:text-emerald-400">
                    {tRef.current("anlageN.einnahmen")} ({fmt(data.totals.bruttoArbeitslohn)})
                  </h3>
                  <table className="w-full text-sm" data-testid="anlage-n-einnahmen-table">
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
                    {tRef.current("anlageN.werbungskosten")} ({fmt(data.totals.werbungskostenTotal)})
                  </h3>
                  <table className="w-full text-sm" data-testid="anlage-n-werbungskosten-table">
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
                  <p className="mt-1 text-[10px] text-gray-500" data-testid="anlage-n-wk-hint">
                    ⚠ {tRef.current("anlageN.wkhint")}
                  </p>
                </div>
              </div>

              {/* Einkünfte pill — bottom line */}
              <div
                className={`mt-4 p-3 rounded text-center text-lg font-bold ${
                  data.totals.einkuenfte >= 0
                    ? "bg-amber-50 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300"
                    : "bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300"
                }`}
                data-testid="anlage-n-einkuenfte"
              >
                {tRef.current("anlageN.einkuenfte")}: {fmt(data.totals.einkuenfte)}
              </div>

              <div className="grid md:grid-cols-2 gap-4 mt-4">
                <div>
                  <h3 className="text-sm font-semibold mb-2 text-blue-700 dark:text-blue-400">
                    {tRef.current("anlageN.sonderausgaben")} ({fmt(data.totals.sonderausgabenTotal)})
                  </h3>
                  <table className="w-full text-sm" data-testid="anlage-n-sonderausgaben-table">
                    <thead>
                      <tr className="text-xs text-gray-500 border-b">
                        <th className="text-left py-1 w-12">Kz</th>
                        <th className="text-left py-1">Bezeichnung</th>
                        <th className="text-right py-1 w-32">Betrag (€)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.sonderausgaben.map(renderLine)}
                    </tbody>
                  </table>
                  <p className="mt-1 text-[10px] text-gray-500" data-testid="anlage-n-sa-hint">
                    ⚠ {tRef.current("anlageN.sahint")}
                  </p>
                </div>

                <div>
                  <h3 className="text-sm font-semibold mb-2 text-purple-700 dark:text-purple-400">
                    {tRef.current("anlageN.aussergewoehnlicheBelastungen")} ({fmt(data.totals.aussergewoehnlicheBelastungenTotal)})
                  </h3>
                  <table className="w-full text-sm" data-testid="anlage-n-ab-table">
                    <thead>
                      <tr className="text-xs text-gray-500 border-b">
                        <th className="text-left py-1 w-12">Kz</th>
                        <th className="text-left py-1">Bezeichnung</th>
                        <th className="text-right py-1 w-32">Betrag (€)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.aussergewoehnlicheBelastungen.map(renderLine)}
                    </tbody>
                  </table>
                  <p className="mt-1 text-[10px] text-gray-500" data-testid="anlage-n-ab-hint">
                    ⚠ {tRef.current("anlageN.abhint")}
                  </p>
                </div>
              </div>

              {/* Lohnsteuer-Anrechnung info box */}
              <div
                className="mt-4 p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-700 rounded text-xs"
                data-testid="anlage-n-lohnsteuer-info"
              >
                <div className="font-semibold mb-1 text-blue-800 dark:text-blue-200">
                  {tRef.current("anlageN.lohnsteuerInfo")}
                </div>
                <div className="text-blue-700 dark:text-blue-300">
                  Lohnsteuer: <b>{fmt(data.lohnsteuerbescheinigung.lohnsteuer)}</b> ·{" "}
                  Soli: <b>{fmt(data.lohnsteuerbescheinigung.soli)}</b> ·{" "}
                  KiSt: <b>{fmt(data.lohnsteuerbescheinigung.kirchensteuer)}</b> ·{" "}
                  Total: <b>{fmt(data.totals.lohnsteuerTotal)}</b>
                </div>
                <p className="text-[10px] text-blue-600 dark:text-blue-400 mt-1">
                  ⚠ {tRef.current("anlageN.lohnsteuerHint")}
                </p>
              </div>

              <div
                className="mt-3 p-3 bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-700 rounded text-xs text-amber-800 dark:text-amber-200"
                data-testid="anlage-n-disclaimer"
              >
                ⚠ {data.disclaimer}
              </div>

              <div className="mt-2 text-xs text-gray-500" data-testid="anlage-n-counts">
                {tRef.current("anlageN.generatedAt")}:{" "}
                {new Date(data.generatedAt).toLocaleString("de-DE")}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Lohnsteuerbescheinigung editor modal */}
      {showLsbEditor && (
        <div className="fixed inset-0 bg-black bg-opacity-40 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl w-full max-w-3xl p-6 max-h-[90vh] overflow-y-auto">
            <h2 className="text-xl font-bold mb-1">
              {tRef.current("anlageN.editLsb")} ({year})
            </h2>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
              {tRef.current("anlageN.fieldHint")}
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
              {(
                [
                  ["bruttoArbeitslohn", "fields.bruttoArbeitslohn"],
                  ["lohnsteuer", "fields.lohnsteuer"],
                  ["soli", "fields.soli"],
                  ["kirchensteuer", "fields.kirchensteuer"],
                  ["rentenversicherung", "fields.rentenversicherung"],
                  ["arbeitslosenversicherung", "fields.arbeitslosenversicherung"],
                  ["krankenversicherung", "fields.krankenversicherung"],
                  ["pflegeversicherung", "fields.pflegeversicherung"],
                ] as [keyof LohnsteuerbescheinigungInput, string][]
              ).map(([key, labelKey]) => (
                <div key={key}>
                  <label className="text-xs text-gray-500 dark:text-gray-400 uppercase">
                    {tRef.current(`anlageN.${labelKey}`)}
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    value={lsbInput[key]}
                    onChange={(e) =>
                      setLsbInput({ ...lsbInput, [key]: e.target.value })
                    }
                    className="w-full border rounded px-3 py-2 text-sm mt-1 font-mono text-right"
                    placeholder="0,00"
                    data-testid={`lsb-input-${key}`}
                  />
                </div>
              ))}
            </div>

            <h3 className="text-sm font-semibold mb-2 mt-4">
              Werbungskosten (manuell)
            </h3>
            <p className="text-xs text-gray-500 mb-2">
              {tRef.current("anlageN.wkhint")}
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
              {(
                [
                  ["werbungskosten140", "Kz 140 — Entfernungspauschale"],
                  ["werbungskosten150", "Kz 150 — Berufsverbände"],
                  ["werbungskosten160", "Kz 160 — Arbeitsmittel"],
                  ["werbungskosten170", "Kz 170 — Fortbildung"],
                  ["werbungskosten180", "Kz 180 — Doppelte Haushaltsführung"],
                  ["werbungskosten190", "Kz 190 — Sonstige Werbungskosten"],
                ] as [keyof LohnsteuerbescheinigungInput, string][]
              ).map(([key, label]) => (
                <div key={key}>
                  <label className="text-xs text-gray-500 dark:text-gray-400">
                    {label}
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    value={lsbInput[key]}
                    onChange={(e) =>
                      setLsbInput({ ...lsbInput, [key]: e.target.value })
                    }
                    className="w-full border rounded px-3 py-2 text-sm mt-1 font-mono text-right"
                    placeholder="0,00"
                    data-testid={`lsb-input-${key}`}
                  />
                </div>
              ))}
            </div>

            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => setShowLsbEditor(false)}
                disabled={savingLsb}
              >
                {tRef.current("common.cancel")}
              </Button>
              <Button
                onClick={saveLsb}
                disabled={savingLsb}
                className="bg-emerald-600 text-white hover:bg-emerald-700"
                data-testid="lsb-save"
              >
                {savingLsb ? "..." : tRef.current("anlageN.saveLsb")}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
