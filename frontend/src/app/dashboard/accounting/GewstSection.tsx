"use client"

import { useEffect, useRef, useState, useCallback } from "react"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { useI18n } from "@/components/useI18n"
import { useToast } from "@/components/useToast"
import { apiGet, apiPut, ApiError } from "@/lib/api"

interface GewstLine {
  kennziffer: string
  label: string
  amount?: number
  percent?: number
  source?: "computed" | "placeholder" | "manual"
  note?: string
}

interface GewstResult {
  year: number
  companyId: string
  periodLabel: string
  hebesatz: number
  freibetrag: number
  gewerbeertrag: number
  gewerbeertragNachFreibetrag: number
  lines: GewstLine[]
  vorauszahlungen: {
    q1: number
    q2: number
    q3: number
    q4: number
    total: number
  }
  totals: {
    gewerbesteuerMesszahl: number
    steuermessbetrag: number
    hebesatz: number
    festzusetzendeGewerbesteuer: number
    vorauszahlungenTotal: number
    differenz: number
  }
  counts: {
    hasGewerbeertrag: boolean
    hasVorauszahlungen: boolean
  }
  generatedAt: string
  disclaimer: string
}

/**
 * Tier 106: GewSt-Erklärung section.
 *
 * Standalone trade tax return (BMF Vordruck GewSt
 * 1A 2024). Reuses the underlying Gewerbeertrag +
 * Hebesatz + Freibetrag from Anlage G (tier 100)
 * — single source of truth. Berater enters the
 * 4 quarterly Vorauszahlungen (Q1-Q4) from the
 * quarterly Bescheide. The result is the
 * festzusetzende GewSt + Differenz.
 *
 * Always included in the Berater packager for
 * gewerbliche companies (Einzelunternehmen,
 * PersG, AND KapG). For KapG, the Steuermessbetrag
 * also flows into KSt 1's KSt-Anrechnung (3.8 ×
 * Messbetrag, § 35 EStG / § 26 KStG).
 */
export function GewstSection() {
  const { t } = useI18n()
  const toast = useToast()
  const toastRef = useRef(toast)
  toastRef.current = toast
  const tRef = useRef(t)
  tRef.current = t
  const [year, setYear] = useState<number>(new Date().getFullYear() - 1)
  const [data, setData] = useState<GewstResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [vorauszahlungenInput, setVorauszahlungenInput] = useState({
    q1: "",
    q2: "",
    q3: "",
    q4: "",
  })
  const [saving, setSaving] = useState(false)

  const load = useCallback(async (y: number) => {
    setLoading(true)
    try {
      const companyId =
        typeof window !== "undefined" ? localStorage.getItem("companyId") : null
      const params = new URLSearchParams()
      if (companyId) params.set("companyId", companyId)
      params.set("year", String(y))
      const result = await apiGet<GewstResult>(
        `/api/v1/accounting/gewst?${params}`,
      )
      setData(result)
      // Pre-fill the editor with current saved values
      setVorauszahlungenInput({
        q1: String(result.vorauszahlungen.q1 || ""),
        q2: String(result.vorauszahlungen.q2 || ""),
        q3: String(result.vorauszahlungen.q3 || ""),
        q4: String(result.vorauszahlungen.q4 || ""),
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

  const saveVorauszahlungen = async () => {
    setSaving(true)
    try {
      const companyId =
        typeof window !== "undefined" ? localStorage.getItem("companyId") : null
      if (!companyId) return
      const toNum = (s: string) => (s === "" ? 0 : Number(s))
      await apiPut(
        `/api/v1/accounting/gewst/settings?companyId=${companyId}`,
        {
          year,
          q1: toNum(vorauszahlungenInput.q1),
          q2: toNum(vorauszahlungenInput.q2),
          q3: toNum(vorauszahlungenInput.q3),
          q4: toNum(vorauszahlungenInput.q4),
        },
      )
      toastRef.current.success(tRef.current("gewst.savedOk"))
      await load(year)
    } catch (e: any) {
      const msg = e instanceof ApiError ? e.message : tRef.current("common.loadError")
      toastRef.current.error(msg)
    } finally {
      setSaving(false)
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
    setPdfUrl(`${apiBase}/api/v1/accounting/gewst.pdf?companyId=${companyId}&year=${year}`)
  }, [year])

  const renderLine = (l: GewstLine) => (
    <tr
      key={l.kennziffer}
      className="border-b"
      data-testid={`gewst-${l.kennziffer}`}
    >
      <td className="py-1 font-mono">{l.kennziffer}</td>
      <td className="py-1 text-xs">
        {l.label}
        {l.source === "placeholder" && (
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
          (l.amount ?? 0) > 0
            ? "font-bold"
            : (l.amount ?? 0) < 0
            ? "text-red-700 dark:text-red-300"
            : "text-gray-400"
        }`}
      >
        {l.amount !== undefined
          ? fmt(l.amount)
          : l.percent !== undefined
          ? `${l.percent.toFixed(0)} %`
          : "—"}
      </td>
    </tr>
  )

  return (
    <div className="mt-6 space-y-4" data-testid="gewst-section">
      <Card>
        <CardHeader>
          <CardTitle>
            🏛️ {tRef.current("gewst.title")} ({data?.year || year})
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">
            {tRef.current("gewst.subtitle")}
          </p>
          <div className="flex flex-wrap items-end gap-3 mb-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">
                {tRef.current("gewst.year")}
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
                data-testid="gewst-year"
              />
            </div>
            <Button
              onClick={() => load(year)}
              disabled={loading}
              data-testid="gewst-recompute"
            >
              {loading ? "..." : tRef.current("gewst.recompute")}
            </Button>
            <Button
              variant="outline"
              onClick={saveVorauszahlungen}
              disabled={saving}
              data-testid="gewst-save-vorauszahlungen"
            >
              💾 {tRef.current("gewst.saveVorauszahlungen")}
            </Button>
            <a
              href={pdfUrl}
              target="_blank"
              rel="noreferrer"
              className="ml-auto"
              data-testid="gewst-pdf-link"
            >
              <Button variant="outline" type="button" disabled={pdfUrl === "#"}>
                📄 {tRef.current("gewst.downloadPdf")}
              </Button>
            </a>
          </div>

          {data && (
            <>
              {/* Vorauszahlungen editor — 4 Q inputs */}
              <div className="mb-4 p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-700 rounded text-xs">
                <div className="font-semibold mb-2 text-blue-800 dark:text-blue-200">
                  {tRef.current("gewst.vorauszahlungen")} ({year})
                </div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-2">
                  {(
                    [
                      ["q1", "gewst.q1"],
                      ["q2", "gewst.q2"],
                      ["q3", "gewst.q3"],
                      ["q4", "gewst.q4"],
                    ] as [keyof typeof vorauszahlungenInput, string][]
                  ).map(([key, labelKey]) => (
                    <div key={key}>
                      <label className="text-xs text-gray-500 dark:text-gray-400 uppercase">
                        {tRef.current(labelKey)}
                      </label>
                      <input
                        type="number"
                        step="0.01"
                        value={vorauszahlungenInput[key]}
                        onChange={(e) =>
                          setVorauszahlungenInput({
                            ...vorauszahlungenInput,
                            [key]: e.target.value,
                          })
                        }
                        className="w-full border rounded px-3 py-2 text-sm mt-1 font-mono text-right"
                        placeholder="0,00"
                        data-testid={`gewst-vq-${key}`}
                      />
                    </div>
                  ))}
                </div>
                <p className="text-[10px] text-gray-500">
                  ⚠ {tRef.current("gewst.vorauszahlungenHint")}
                </p>
              </div>

              {/* BMF Vordruck GewSt 1A — Kennziffern table */}
              <h3 className="text-sm font-semibold mb-2 text-emerald-700 dark:text-emerald-400">
                {tRef.current("gewst.vordruck")}
              </h3>
              <table className="w-full text-sm mb-4" data-testid="gewst-vordruck-table">
                <thead>
                  <tr className="text-xs text-gray-500 border-b">
                    <th className="text-left py-1 w-12">Kz</th>
                    <th className="text-left py-1">Bezeichnung</th>
                    <th className="text-right py-1 w-32">Betrag / %</th>
                  </tr>
                </thead>
                <tbody>{data.lines.map(renderLine)}</tbody>
              </table>
              <p className="mt-1 text-[10px] text-gray-500" data-testid="gewst-fields-hint">
                ⚠ {tRef.current("gewst.fieldsHint")}
              </p>

              {/* Summary block — 3 pills */}
              <div className="mt-4 grid grid-cols-2 md:grid-cols-3 gap-3" data-testid="gewst-summary">
                <div className="p-3 rounded text-center bg-emerald-50 dark:bg-emerald-900/30">
                  <div className="text-xs text-gray-500 dark:text-gray-400 uppercase">
                    Festzusetzende GewSt
                  </div>
                  <div className="text-lg font-bold font-mono text-emerald-700 dark:text-emerald-300" data-testid="gewst-kz10">
                    {fmt(data.totals.festzusetzendeGewerbesteuer)}
                  </div>
                  <div className="text-[10px] text-gray-500">Kz 10</div>
                </div>
                <div className="p-3 rounded text-center bg-blue-50 dark:bg-blue-900/30">
                  <div className="text-xs text-gray-500 dark:text-gray-400 uppercase">
                    Vorauszahlungen
                  </div>
                  <div className="text-lg font-bold font-mono text-blue-700 dark:text-blue-300" data-testid="gewst-kz11">
                    {fmt(data.totals.vorauszahlungenTotal)}
                  </div>
                  <div className="text-[10px] text-gray-500">Kz 11 (Q1-Q4)</div>
                </div>
                <div
                  className={`p-3 rounded text-center ${
                    data.totals.differenz > 0
                      ? "bg-amber-50 dark:bg-amber-900/30"
                      : data.totals.differenz < 0
                      ? "bg-emerald-50 dark:bg-emerald-900/30"
                      : "bg-gray-50 dark:bg-gray-800"
                  }`}
                >
                  <div className="text-xs text-gray-500 dark:text-gray-400 uppercase">
                    Differenz
                  </div>
                  <div
                    className={`text-lg font-bold font-mono ${
                      data.totals.differenz > 0
                        ? "text-amber-700 dark:text-amber-300"
                        : data.totals.differenz < 0
                        ? "text-emerald-700 dark:text-emerald-300"
                        : "text-gray-400"
                    }`}
                    data-testid="gewst-kz12"
                  >
                    {fmt(data.totals.differenz)}
                  </div>
                  <div className="text-[10px] text-gray-500">
                    Kz 12 ({data.totals.differenz > 0 ? "Restzahlung" : data.totals.differenz < 0 ? "Erstattung" : "—"})
                  </div>
                </div>
              </div>

              <div
                className="mt-3 p-3 bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-700 rounded text-xs text-amber-800 dark:text-amber-200"
                data-testid="gewst-disclaimer"
              >
                ⚠ {data.disclaimer}
              </div>

              <div className="mt-2 text-xs text-gray-500" data-testid="gewst-counts">
                {tRef.current("gewst.generatedAt")}: {new Date(data.generatedAt).toLocaleString("de-DE")}
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
