"use client"

import { useEffect, useRef, useState, useCallback } from "react"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { useI18n } from "@/components/useI18n"
import { useToast } from "@/components/useToast"
import { apiGet, apiPut, ApiError } from "@/lib/api"

interface AnlageKindLine {
  kennziffer: string
  label: string
  amount: number
  source?: 'computed' | 'placeholder'
  note?: string
}

interface AnlageKindResult {
  year: number
  companyId: string
  kinder: Array<{
    name: string
    birthDate: string
    kindergeldEligible: boolean
  }>
  einnahmen: AnlageKindLine[]
  ausgaben: AnlageKindLine[]
  totals: {
    anzahlKinder: number
    kindergeldTotal: number
    freibetragTotal: number
    net: number
  }
  counts: {
    hasKinder: boolean
  }
  generatedAt: string
  disclaimer: string
}

interface KindDraft {
  name: string
  birthDate: string
  kindergeldEligible: boolean
}

/**
 * Tier 104: Anlage Kind section.
 *
 * Kinderfreibetrag + Kindergeld (§ 32 / § 33 /
 * § 33a EStG) — for families with children. The
 * 7th Anlage form (after S / V / KAP / G / N / R).
 *
 * Standard rates (2024):
 *   - Kindergeld 250 EUR / child (1-3),
 *     max 1,000 EUR for 4+ children
 *   - Kinderfreibetrag 7,932 EUR / child
 *     (6,612 EUR sächliches Existenzminimum +
 *      1,320 EUR Betreuungs-/Erziehungs-/
 *      Ausbildungsbedarf)
 *
 * v1: simple per-year array of children. The
 * actual Einkommensteuer uses the more favorable
 * of (Kindergeld) vs (Kinderfreibetrag × tax
 * rate) — the Berater decides. v1 just shows
 * both side-by-side.
 */
export function AnlageKindSection() {
  const { t } = useI18n()
  const toast = useToast()
  const toastRef = useRef(toast)
  toastRef.current = toast
  const tRef = useRef(t)
  tRef.current = t
  const [year, setYear] = useState<number>(new Date().getFullYear() - 1)
  const [data, setData] = useState<AnlageKindResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [showKinderEditor, setShowKinderEditor] = useState(false)
  const [kinderDraft, setKinderDraft] = useState<KindDraft[]>([])
  const [savingKinder, setSavingKinder] = useState(false)

  const load = useCallback(async (y: number) => {
    setLoading(true)
    try {
      const companyId =
        typeof window !== "undefined" ? localStorage.getItem("companyId") : null
      const params = new URLSearchParams()
      if (companyId) params.set("companyId", companyId)
      params.set("year", String(y))
      const result = await apiGet<AnlageKindResult>(
        `/api/v1/accounting/anlage-kind?${params}`,
      )
      setData(result)
      // Pre-fill the editor with current saved children
      setKinderDraft(
        result.kinder.map((k) => ({
          name: k.name || "",
          birthDate: k.birthDate || "",
          kindergeldEligible: k.kindergeldEligible !== false,
        })),
      )
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

  const addKind = () => {
    setKinderDraft((prev) => [
      ...prev,
      { name: "", birthDate: "", kindergeldEligible: true },
    ])
  }

  const removeKind = (idx: number) => {
    setKinderDraft((prev) => prev.filter((_, i) => i !== idx))
  }

  const updateKind = (idx: number, patch: Partial<KindDraft>) => {
    setKinderDraft((prev) =>
      prev.map((k, i) => (i === idx ? { ...k, ...patch } : k)),
    )
  }

  const saveKinder = async () => {
    setSavingKinder(true)
    try {
      const companyId =
        typeof window !== "undefined" ? localStorage.getItem("companyId") : null
      if (!companyId) return
      // Filter out empty rows (no name AND no birthDate)
      const cleaned = kinderDraft.filter(
        (k) => (k.name || "").trim() || (k.birthDate || "").trim(),
      )
      await apiPut(
        `/api/v1/accounting/anlage-kind/settings?companyId=${companyId}`,
        {
          year,
          kinder: cleaned.map((k) => ({
            name: (k.name || "").trim(),
            birthDate: (k.birthDate || "").trim(),
            kindergeldEligible: k.kindergeldEligible !== false,
          })),
        },
      )
      toastRef.current.success(tRef.current("anlageKind.savedOk"))
      setShowKinderEditor(false)
      await load(year)
    } catch (e: any) {
      const msg = e instanceof ApiError ? e.message : tRef.current("common.loadError")
      toastRef.current.error(msg)
    } finally {
      setSavingKinder(false)
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
    setPdfUrl(`${apiBase}/api/v1/accounting/anlage-kind.pdf?companyId=${companyId}&year=${year}`)
  }, [year])

  const renderLine = (l: AnlageKindLine) => (
    <tr
      key={l.kennziffer}
      className="border-b"
      data-testid={`anlage-kind-${l.kennziffer}`}
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
    <div className="mt-6 space-y-4" data-testid="anlage-kind-section">
      <Card>
        <CardHeader>
          <CardTitle>
            👨‍👩‍👧‍👦 {tRef.current("anlageKind.title")} ({data?.year || year})
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">
            {tRef.current("anlageKind.subtitle")}
          </p>
          <div className="flex flex-wrap items-end gap-3 mb-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">
                {tRef.current("anlageKind.year")}
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
                data-testid="anlage-kind-year"
              />
            </div>
            <Button
              onClick={() => load(year)}
              disabled={loading}
              data-testid="anlage-kind-recompute"
            >
              {loading ? "..." : tRef.current("anlageKind.recompute")}
            </Button>
            <Button
              variant="outline"
              onClick={() => setShowKinderEditor(true)}
              data-testid="anlage-kind-edit-kinder"
            >
              ✏️ {tRef.current("anlageKind.editKinder")}
            </Button>
            <a
              href={pdfUrl}
              target="_blank"
              rel="noreferrer"
              className="ml-auto"
              data-testid="anlage-kind-pdf-link"
            >
              <Button variant="outline" type="button" disabled={pdfUrl === "#"}>
                📄 {tRef.current("anlageKind.downloadPdf")}
              </Button>
            </a>
          </div>

          {!data?.counts.hasKinder && (
            <div
              className="mb-4 p-3 bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-700 rounded text-sm text-amber-800 dark:text-amber-200"
              data-testid="anlage-kind-kinder-missing"
            >
              {tRef.current("anlageKind.kinderMissing")}
            </div>
          )}

          {data && (
            <>
              {data.counts.hasKinder && (
                <div
                  className="mb-4 p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-700 rounded text-xs"
                  data-testid="anlage-kind-kinder-summary"
                >
                  <div className="font-semibold mb-1 text-blue-800 dark:text-blue-200">
                    Kinder im Haushalt {data.year} ({data.totals.anzahlKinder})
                  </div>
                  <div className="text-blue-700 dark:text-blue-300 grid grid-cols-2 md:grid-cols-3 gap-2">
                    {data.kinder.map((k, i) => (
                      <div key={i}>
                        {k.name}
                        {k.birthDate ? ` (geb. ${k.birthDate})` : ""}
                        {!k.kindergeldEligible && (
                          <span className="ml-1 text-amber-600"> [kein Kindergeld]</span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="grid md:grid-cols-2 gap-4">
                <div>
                  <h3 className="text-sm font-semibold mb-2 text-emerald-700 dark:text-emerald-400">
                    {tRef.current("anlageKind.kindergeld")} ({fmt(data.totals.kindergeldTotal)})
                  </h3>
                  <table className="w-full text-sm" data-testid="anlage-kind-einnahmen-table">
                    <thead>
                      <tr className="text-xs text-gray-500 border-b">
                        <th className="text-left py-1 w-12">Kz</th>
                        <th className="text-left py-1">Bezeichnung</th>
                        <th className="text-right py-1 w-32">Betrag (€)</th>
                      </tr>
                    </thead>
                    <tbody>{data.einnahmen.map(renderLine)}</tbody>
                  </table>
                </div>

                <div>
                  <h3 className="text-sm font-semibold mb-2 text-blue-700 dark:text-blue-400">
                    {tRef.current("anlageKind.freibetrag")} ({fmt(data.totals.freibetragTotal)})
                  </h3>
                  <table className="w-full text-sm" data-testid="anlage-kind-ausgaben-table">
                    <thead>
                      <tr className="text-xs text-gray-500 border-b">
                        <th className="text-left py-1 w-12">Kz</th>
                        <th className="text-left py-1">Bezeichnung</th>
                        <th className="text-right py-1 w-32">Betrag (€)</th>
                      </tr>
                    </thead>
                    <tbody>{data.ausgaben.map(renderLine)}</tbody>
                  </table>
                  <p className="mt-1 text-[10px] text-gray-500" data-testid="anlage-kind-betrag-hint">
                    ⚠ {tRef.current("anlageKind.betragHint")}
                  </p>
                </div>
              </div>

              {/* Summary pill */}
              <div
                className="mt-4 p-3 rounded text-center text-sm font-bold bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300"
                data-testid="anlage-kind-summary"
              >
                {tRef.current("anlageKind.summary")}: {data.totals.anzahlKinder}{" "}
                {data.totals.anzahlKinder === 1 ? "Kind" : "Kinder"} · Kindergeld{" "}
                {fmt(data.totals.kindergeldTotal)} · Kinderfreibetrag{" "}
                {fmt(data.totals.freibetragTotal)} · Net (FB - KG){" "}
                {fmt(data.totals.net)}
              </div>

              <div
                className="mt-3 p-3 bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-700 rounded text-xs text-amber-800 dark:text-amber-200"
                data-testid="anlage-kind-disclaimer"
              >
                ⚠ {data.disclaimer}
              </div>

              <div className="mt-2 text-xs text-gray-500" data-testid="anlage-kind-counts">
                {tRef.current("anlageKind.generatedAt")}: {new Date(data.generatedAt).toLocaleString("de-DE")}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Kinder editor modal */}
      {showKinderEditor && (
        <div className="fixed inset-0 bg-black bg-opacity-40 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl w-full max-w-3xl p-6 max-h-[90vh] overflow-y-auto">
            <h2 className="text-xl font-bold mb-1">
              {tRef.current("anlageKind.editKinder")} ({year})
            </h2>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
              {tRef.current("anlageKind.fieldHint")}
            </p>

            <div className="space-y-3 mb-4">
              {kinderDraft.map((k, idx) => (
                <div
                  key={idx}
                  className="grid grid-cols-12 gap-2 items-end p-2 border rounded"
                  data-testid={`kind-row-${idx}`}
                >
                  <div className="col-span-5">
                    <label className="text-xs text-gray-500 dark:text-gray-400 uppercase">
                      {tRef.current("anlageKind.fields.name")}
                    </label>
                    <input
                      type="text"
                      value={k.name}
                      onChange={(e) =>
                        updateKind(idx, { name: e.target.value })
                      }
                      className="w-full border rounded px-3 py-2 text-sm mt-1"
                      placeholder="z.B. Max"
                      data-testid={`kind-name-${idx}`}
                    />
                  </div>
                  <div className="col-span-3">
                    <label className="text-xs text-gray-500 dark:text-gray-400 uppercase">
                      {tRef.current("anlageKind.fields.birthDate")}
                    </label>
                    <input
                      type="date"
                      value={k.birthDate}
                      onChange={(e) =>
                        updateKind(idx, { birthDate: e.target.value })
                      }
                      className="w-full border rounded px-3 py-2 text-sm mt-1"
                      data-testid={`kind-birthdate-${idx}`}
                    />
                  </div>
                  <div className="col-span-3 flex items-center">
                    <label className="flex items-center text-xs gap-2 mt-5">
                      <input
                        type="checkbox"
                        checked={k.kindergeldEligible}
                        onChange={(e) =>
                          updateKind(idx, {
                            kindergeldEligible: e.target.checked,
                          })
                        }
                        data-testid={`kind-eligible-${idx}`}
                      />
                      <span className="text-xs text-gray-700 dark:text-gray-200">
                        {tRef.current("anlageKind.fields.kindergeldEligible")}
                      </span>
                    </label>
                  </div>
                  <div className="col-span-1 flex items-center justify-center mt-5">
                    <button
                      onClick={() => removeKind(idx)}
                      className="text-red-600 dark:text-red-400 hover:text-red-800 text-lg"
                      title={tRef.current("anlageKind.remove")}
                      data-testid={`kind-remove-${idx}`}
                    >
                      ×
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <div className="flex justify-between items-center">
              <Button variant="outline" onClick={addKind} data-testid="kind-add">
                {tRef.current("anlageKind.addKind")}
              </Button>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={() => setShowKinderEditor(false)}
                  disabled={savingKinder}
                >
                  {tRef.current("common.cancel")}
                </Button>
                <Button
                  onClick={saveKinder}
                  disabled={savingKinder}
                  className="bg-emerald-600 text-white hover:bg-emerald-700"
                  data-testid="kind-save"
                >
                  {savingKinder ? "..." : tRef.current("anlageKind.saveKinder")}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
