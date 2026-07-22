"use client"

import { useEffect, useRef, useState, useCallback, useMemo } from "react"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import LanguageSwitcher from "@/components/LanguageSwitcher"
import { useI18n } from "@/components/useI18n"
import { useToast } from "@/components/useToast"
import { apiGet, apiPost, apiPatch, ApiError } from "@/lib/api"

interface Asset {
  id: string
  companyId: string
  type: string
  bezeichnung: string
  anschaffungsDatum: string
  anschaffungsKosten: string
  nutzungsdauerMonate: number
  restwert: string
  afaMethode: string
  bilanzKonto: string | null
  notiz: string | null
  verkauftAm: string | null
  verkaufsPreis: string | null
  createdAt: string
  updatedAt: string
}

const TYPES = [
  "Grundstueck",
  "Gebaeude",
  "Maschine",
  "Fahrzeug",
  "Betriebsausstattung",
  "GWG",
  "Software",
  "Sonstiges",
] as const

const typeI18nKey = (t: string): string => {
  switch (t) {
    case "Grundstueck": return "assets.typeGrundstueck"
    case "Gebaeude": return "assets.typeGebaeude"
    case "Maschine": return "assets.typeMaschine"
    case "Fahrzeug": return "assets.typeFahrzeug"
    case "Betriebsausstattung": return "assets.typeBetriebsausstattung"
    case "GWG": return "assets.typeGWG"
    case "Software": return "assets.typeSoftware"
    default: return "assets.typeSonstiges"
  }
}

function fmtEur(n: number) {
  return new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR", minimumFractionDigits: 2 }).format(n)
}

function fmtDate(s: string) {
  return new Date(s).toLocaleDateString("de-DE")
}

/**
 * Compute the per-asset AfA in the browser so
 * the user sees live Buchwert / annual AfA as
 * they type. Mirrors the backend
 * AssetsService.computeAfA.
 */
function computeAssetAfA(asset: {
  anschaffungsKosten: number
  restwert: number
  nutzungsdauerMonate: number
  anschaffungsDatum: Date
  verkauftAm: Date | null
}, snapshot: Date) {
  const ak = asset.anschaffungsKosten
  const restwert = asset.restwert
  const nd = asset.nutzungsdauerMonate
  const depreciable = Math.max(0, ak - restwert)
  const monthlyAfA = nd > 0 ? depreciable / nd : 0
  const effectiveEnd = asset.verkauftAm && asset.verkauftAm <= snapshot ? asset.verkauftAm : snapshot
  const y = effectiveEnd.getFullYear() - asset.anschaffungsDatum.getFullYear()
  const m = effectiveEnd.getMonth() - asset.anschaffungsDatum.getMonth()
  let monthsHeld = y * 12 + m
  if (effectiveEnd.getDate() >= asset.anschaffungsDatum.getDate()) monthsHeld += 1
  monthsHeld = Math.max(0, Math.min(monthsHeld, nd))
  const accumulatedAfA = Math.min(monthsHeld * monthlyAfA, depreciable)
  const buchwert = ak - accumulatedAfA
  // Annual AfA
  const yearStart = new Date(snapshot.getFullYear(), 0, 1)
  const yearEnd = new Date(snapshot.getFullYear(), 11, 31, 23, 59, 59, 999)
  const start = asset.anschaffungsDatum > yearStart ? asset.anschaffungsDatum : yearStart
  const assetEnd = asset.verkauftAm && asset.verkauftAm < yearEnd ? asset.verkauftAm : yearEnd
  const end = assetEnd < yearEnd ? assetEnd : yearEnd
  const yy = end.getFullYear() - start.getFullYear()
  const mm = end.getMonth() - start.getMonth()
  let monthsInYear = yy * 12 + mm
  if (end.getDate() >= start.getDate()) monthsInYear += 1
  // Cap by remaining ND at yearStart
  const yy2 = yearStart.getFullYear() - asset.anschaffungsDatum.getFullYear()
  const mm2 = yearStart.getMonth() - asset.anschaffungsDatum.getMonth()
  let monthsAlreadyHeldAtYearStart = yy2 * 12 + mm2
  if (yearStart.getDate() >= asset.anschaffungsDatum.getDate()) monthsAlreadyHeldAtYearStart += 1
  monthsAlreadyHeldAtYearStart = Math.max(0, Math.min(monthsAlreadyHeldAtYearStart, nd))
  const remainingNd = Math.max(0, nd - monthsAlreadyHeldAtYearStart)
  monthsInYear = Math.max(0, Math.min(monthsInYear, remainingNd))
  return {
    monthlyAfA,
    monthsHeld,
    accumulatedAfA,
    buchwert,
    annualAfA: monthsInYear * monthlyAfA,
  }
}

interface DraftAsset {
  type: string
  bezeichnung: string
  anschaffungsDatum: string
  anschaffungsKosten: string
  nutzungsdauerMonate: string
  restwert: string
  notiz: string
}

const emptyDraft: DraftAsset = {
  type: "Maschine",
  bezeichnung: "",
  anschaffungsDatum: new Date().toISOString().slice(0, 10),
  anschaffungsKosten: "",
  nutzungsdauerMonate: "",
  restwert: "0",
  notiz: "",
}

export default function AssetsPage() {
  const { t } = useI18n()
  const toast = useToast()
  const toastRef = useRef(toast)
  toastRef.current = toast
  const tRef = useRef(t)
  tRef.current = t
  const [assets, setAssets] = useState<Asset[]>([])
  const [loading, setLoading] = useState(true)
  const [year, setYear] = useState<number>(new Date().getFullYear())
  const [showCreate, setShowCreate] = useState(false)
  const [draft, setDraft] = useState<DraftAsset>(emptyDraft)
  const [createError, setCreateError] = useState<string | null>(null)
  const [createSaving, setCreateSaving] = useState(false)
  const [disposeModal, setDisposeModal] = useState<Asset | null>(null)
  const [disposeForm, setDisposeForm] = useState({
    verkauftAm: new Date().toISOString().slice(0, 10),
    verkaufsPreis: "",
  })

  const load = useCallback(async () => {
    const companyId = typeof window !== "undefined" ? localStorage.getItem("companyId") : null
    if (!companyId) return
    setLoading(true)
    try {
      const data = await apiGet<Asset[]>(`/api/v1/assets?companyId=${companyId}`)
      setAssets(data || [])
    } catch (e) {
      console.error("assets load failed", e)
      toastRef.current.error("Fehler beim Laden")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const snapshot = useMemo(() => new Date(year, 11, 31, 23, 59, 59, 999), [year])

  const summaries = useMemo(() => {
    return assets.map((a) => {
      const ak = Number(a.anschaffungsKosten)
      const restwert = Number(a.restwert)
      const nd = a.nutzungsdauerMonate
      const afa = computeAssetAfA(
        {
          anschaffungsKosten: ak,
          restwert,
          nutzungsdauerMonate: nd,
          anschaffungsDatum: new Date(a.anschaffungsDatum),
          verkauftAm: a.verkauftAm ? new Date(a.verkauftAm) : null,
        },
        snapshot,
      )
      return { asset: a, ...afa }
    })
  }, [assets, snapshot])

  const totalAHK = summaries.reduce((s, x) => s + Number(x.asset.anschaffungsKosten), 0)
  const totalBuchwert = summaries.reduce((s, x) => s + x.buchwert, 0)
  const totalAnnualAfA = summaries.reduce((s, x) => s + x.annualAfA, 0)
  const totalMonateAfA = summaries.reduce((s, x) => s + x.accumulatedAfA, 0)

  const save = async () => {
    const companyId = typeof window !== "undefined" ? localStorage.getItem("companyId") : null
    if (!companyId) return
    setCreateError(null)
    if (!draft.bezeichnung.trim()) {
      setCreateError("Bezeichnung fehlt")
      return
    }
    const ak = parseFloat(draft.anschaffungsKosten)
    if (!ak || ak <= 0) {
      setCreateError("Anschaffungskosten müssen > 0 sein")
      return
    }
    const nd = parseInt(draft.nutzungsdauerMonate, 10)
    if (!nd || nd <= 0) {
      setCreateError("Nutzungsdauer muss > 0 Monate sein")
      return
    }
    setCreateSaving(true)
    try {
      await apiPost(`/api/v1/assets?companyId=${companyId}`, {
        type: draft.type,
        bezeichnung: draft.bezeichnung,
        anschaffungsDatum: new Date(draft.anschaffungsDatum).toISOString(),
        anschaffungsKosten: ak,
        nutzungsdauerMonate: nd,
        restwert: parseFloat(draft.restwert) || 0,
        notiz: draft.notiz || null,
      })
      setShowCreate(false)
      setDraft(emptyDraft)
      load()
    } catch (e: any) {
      const msg = e instanceof ApiError ? e.message : "Fehler beim Speichern"
      setCreateError(msg)
    } finally {
      setCreateSaving(false)
    }
  }

  const dispose = async () => {
    if (!disposeModal) return
    const companyId = typeof window !== "undefined" ? localStorage.getItem("companyId") : null
    if (!companyId) return
    try {
      await apiPost(
        `/api/v1/assets/${disposeModal.id}/dispose?companyId=${companyId}`,
        {
          verkauftAm: new Date(disposeForm.verkauftAm).toISOString(),
          verkaufsPreis: parseFloat(disposeForm.verkaufsPreis) || 0,
        },
      )
      setDisposeModal(null)
      toastRef.current.success(tRef.current("assets.disposeOk"))
      load()
    } catch (e: any) {
      const msg = e instanceof ApiError ? e.message : "Fehler beim Veräußern"
      toastRef.current.error(msg)
    }
  }

  return (
    <main className="min-h-screen bg-gray-50 dark:bg-gray-900 p-6">
      <div className="max-w-7xl mx-auto">
        <div className="flex justify-between items-center mb-6">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
              📦 {t("assets.title")}
            </h1>
            <p className="text-sm text-gray-600 dark:text-gray-300 mt-1 max-w-3xl">
              {t("assets.subtitle")}
            </p>
          </div>
          <div className="flex gap-2 items-center">
            <Button
              onClick={() => setShowCreate(true)}
              className="bg-emerald-600 text-white hover:bg-emerald-700"
              data-testid="assets-new"
            >
              + {t("assets.newAsset")}
            </Button>
            <LanguageSwitcher />
          </div>
        </div>

        <Card className="mb-4">
          <CardContent className="pt-6">
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <label className="text-xs text-gray-500 dark:text-gray-400 uppercase">
                  Bilanz-Stichtag
                </label>
                <input
                  type="number"
                  min={2000}
                  max={2100}
                  value={year}
                  onChange={(e) => setYear(Number(e.target.value) || new Date().getFullYear())}
                  className="border rounded px-3 py-2 w-32 dark:bg-gray-800 dark:border-gray-700"
                  data-testid="assets-year"
                />
              </div>
            </div>
          </CardContent>
        </Card>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
          <div className="bg-white dark:bg-gray-800 rounded-lg border p-4">
            <div className="text-xs text-gray-500 dark:text-gray-400 uppercase">
              {t("assets.totalAnlagen")}
            </div>
            <div className="text-xl font-bold mt-1 font-mono" data-testid="assets-count">
              {summaries.length}
            </div>
          </div>
          <div className="bg-white dark:bg-gray-800 rounded-lg border p-4">
            <div className="text-xs text-gray-500 dark:text-gray-400 uppercase">
              {t("assets.totalAHK")}
            </div>
            <div className="text-xl font-bold mt-1 font-mono" data-testid="assets-total-ahk">
              {fmtEur(totalAHK)}
            </div>
          </div>
          <div className="bg-white dark:bg-gray-800 rounded-lg border p-4">
            <div className="text-xs text-gray-500 dark:text-gray-400 uppercase">
              {t("assets.totalBuchwert")}
            </div>
            <div className="text-xl font-bold mt-1 font-mono" data-testid="assets-total-buchwert">
              {fmtEur(totalBuchwert)}
            </div>
          </div>
          <div className="bg-white dark:bg-gray-800 rounded-lg border p-4">
            <div className="text-xs text-gray-500 dark:text-gray-400 uppercase">
              {t("assets.totalJahresAfA")}
            </div>
            <div
              className="text-xl font-bold mt-1 font-mono"
              data-testid="assets-total-annual-afa"
            >
              {fmtEur(totalAnnualAfA)}
            </div>
          </div>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>{t("assets.title")} ({summaries.length})</CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="space-y-4">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="h-12 bg-gray-100 dark:bg-gray-800 rounded animate-pulse" />
                ))}
              </div>
            ) : summaries.length === 0 ? (
              <div className="text-center py-12 text-gray-500 dark:text-gray-400" data-testid="assets-empty">
                {t("assets.noAssets")}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm" data-testid="assets-table">
                  <thead>
                    <tr className="border-b">
                      <th className="text-left py-2 px-2 text-xs">{t("assets.type")}</th>
                      <th className="text-left py-2 px-2 text-xs">{t("assets.bezeichnung")}</th>
                      <th className="text-left py-2 px-2 text-xs">{t("assets.anschaffungsDatum")}</th>
                      <th className="text-right py-2 px-2 text-xs">{t("assets.anschaffungsKosten")}</th>
                      <th className="text-right py-2 px-2 text-xs">{t("assets.nutzungsdauerMonate")}</th>
                      <th className="text-right py-2 px-2 text-xs">{t("assets.akAfA")}</th>
                      <th className="text-right py-2 px-2 text-xs">{t("assets.buchwert")}</th>
                      <th className="text-right py-2 px-2 text-xs">{t("assets.jahresAfA")}</th>
                      <th className="text-center py-2 px-2 text-xs">{t("assets.actions")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summaries.map((s) => {
                      const a = s.asset
                      const disposed = !!a.verkauftAm
                      return (
                        <tr
                          key={a.id}
                          className={`border-b ${disposed ? "opacity-50" : ""}`}
                          data-testid={`assets-row-${a.id}`}
                        >
                          <td className="py-2 px-2 font-mono text-xs">{t(typeI18nKey(a.type))}</td>
                          <td className="py-2 px-2 text-xs">
                            {a.bezeichnung}
                            {disposed && (
                              <span className="ml-2 text-red-600 text-[10px]">
                                verkauft {fmtDate(a.verkauftAm!)}
                              </span>
                            )}
                          </td>
                          <td className="py-2 px-2 text-xs">{fmtDate(a.anschaffungsDatum)}</td>
                          <td className="py-2 px-2 text-right font-mono text-xs">
                            {fmtEur(Number(a.anschaffungsKosten))}
                          </td>
                          <td className="py-2 px-2 text-right font-mono text-xs">
                            {a.nutzungsdauerMonate}
                          </td>
                          <td className="py-2 px-2 text-right font-mono text-xs">
                            {fmtEur(s.accumulatedAfA)}
                          </td>
                          <td className="py-2 px-2 text-right font-mono text-xs font-bold">
                            {fmtEur(s.buchwert)}
                          </td>
                          <td className="py-2 px-2 text-right font-mono text-xs">
                            {fmtEur(s.annualAfA)}
                          </td>
                          <td className="py-2 px-2 text-center">
                            {!disposed && (
                              <button
                                onClick={() => {
                                  setDisposeModal(a)
                                  setDisposeForm({
                                    verkauftAm: new Date().toISOString().slice(0, 10),
                                    verkaufsPreis: "",
                                  })
                                }}
                                className="text-xs text-blue-600 dark:text-blue-300 hover:underline"
                                data-testid={`assets-dispose-${a.id}`}
                              >
                                {t("assets.dispose")}
                              </button>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {showCreate && (
        <div className="fixed inset-0 bg-black bg-opacity-40 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl w-full max-w-2xl p-6 max-h-[90vh] overflow-y-auto">
            <h2 className="text-xl font-bold mb-4">+ {t("assets.newAsset")}</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-gray-500 dark:text-gray-400 uppercase">
                  {t("assets.type")}
                </label>
                <select
                  value={draft.type}
                  onChange={(e) => setDraft({ ...draft, type: e.target.value })}
                  className="w-full border rounded px-2 py-1 text-sm mt-1"
                  data-testid="assets-draft-type"
                >
                  {TYPES.map((tp) => (
                    <option key={tp} value={tp}>
                      {t(typeI18nKey(tp))}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs text-gray-500 dark:text-gray-400 uppercase">
                  {t("assets.bezeichnung")}
                </label>
                <input
                  type="text"
                  value={draft.bezeichnung}
                  onChange={(e) => setDraft({ ...draft, bezeichnung: e.target.value })}
                  className="w-full border rounded px-2 py-1 text-sm mt-1"
                  placeholder="z.B. CNC-Fräse, Firmenwagen VW Caddy"
                  data-testid="assets-draft-bez"
                />
              </div>
              <div>
                <label className="text-xs text-gray-500 dark:text-gray-400 uppercase">
                  {t("assets.anschaffungsDatum")}
                </label>
                <input
                  type="date"
                  value={draft.anschaffungsDatum}
                  onChange={(e) => setDraft({ ...draft, anschaffungsDatum: e.target.value })}
                  className="w-full border rounded px-2 py-1 text-sm mt-1"
                  data-testid="assets-draft-datum"
                />
              </div>
              <div>
                <label className="text-xs text-gray-500 dark:text-gray-400 uppercase">
                  {t("assets.anschaffungsKosten")}
                </label>
                <input
                  type="number"
                  step="0.01"
                  value={draft.anschaffungsKosten}
                  onChange={(e) => setDraft({ ...draft, anschaffungsKosten: e.target.value })}
                  className="w-full border rounded px-2 py-1 text-sm text-right font-mono mt-1"
                  placeholder="0,00"
                  data-testid="assets-draft-ak"
                />
              </div>
              <div>
                <label className="text-xs text-gray-500 dark:text-gray-400 uppercase">
                  {t("assets.nutzungsdauerMonate")}
                </label>
                <input
                  type="number"
                  value={draft.nutzungsdauerMonate}
                  onChange={(e) => setDraft({ ...draft, nutzungsdauerMonate: e.target.value })}
                  className="w-full border rounded px-2 py-1 text-sm text-right font-mono mt-1"
                  placeholder="z.B. 60"
                  data-testid="assets-draft-nd"
                />
              </div>
              <div>
                <label className="text-xs text-gray-500 dark:text-gray-400 uppercase">
                  {t("assets.restwert")}
                </label>
                <input
                  type="number"
                  step="0.01"
                  value={draft.restwert}
                  onChange={(e) => setDraft({ ...draft, restwert: e.target.value })}
                  className="w-full border rounded px-2 py-1 text-sm text-right font-mono mt-1"
                  placeholder="0,00"
                  data-testid="assets-draft-restwert"
                />
              </div>
              <div className="md:col-span-2">
                <label className="text-xs text-gray-500 dark:text-gray-400 uppercase">
                  {t("assets.notiz")}
                </label>
                <input
                  type="text"
                  value={draft.notiz}
                  onChange={(e) => setDraft({ ...draft, notiz: e.target.value })}
                  className="w-full border rounded px-2 py-1 text-sm mt-1"
                  placeholder="optional"
                  data-testid="assets-draft-notiz"
                />
              </div>
            </div>
            {createError && (
              <div className="mt-3 p-3 bg-red-50 border border-red-300 dark:border-red-700 rounded text-sm text-red-800">
                {createError}
              </div>
            )}
            <div className="flex justify-end gap-2 mt-4">
              <Button variant="outline" onClick={() => setShowCreate(false)} disabled={createSaving}>
                {t("assets.cancel")}
              </Button>
              <Button
                onClick={save}
                disabled={createSaving}
                className="bg-emerald-600 text-white hover:bg-emerald-700"
                data-testid="assets-draft-save"
              >
                {createSaving ? "…" : t("assets.save")}
              </Button>
            </div>
          </div>
        </div>
      )}

      {disposeModal && (
        <div className="fixed inset-0 bg-black bg-opacity-40 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl w-full max-w-md p-6">
            <h2 className="text-xl font-bold mb-2">{t("assets.dispose")}</h2>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
              {t("assets.disposeHint")}
            </p>
            <div className="space-y-3">
              <div>
                <label className="text-xs text-gray-500 dark:text-gray-400 uppercase">
                  {t("assets.verkauftAm")}
                </label>
                <input
                  type="date"
                  value={disposeForm.verkauftAm}
                  onChange={(e) => setDisposeForm({ ...disposeForm, verkauftAm: e.target.value })}
                  className="w-full border rounded px-2 py-1 text-sm mt-1"
                  data-testid="assets-dispose-date"
                />
              </div>
              <div>
                <label className="text-xs text-gray-500 dark:text-gray-400 uppercase">
                  {t("assets.verkaufsPreis")}
                </label>
                <input
                  type="number"
                  step="0.01"
                  value={disposeForm.verkaufsPreis}
                  onChange={(e) => setDisposeForm({ ...disposeForm, verkaufsPreis: e.target.value })}
                  className="w-full border rounded px-2 py-1 text-sm text-right font-mono mt-1"
                  placeholder="0,00"
                  data-testid="assets-dispose-price"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <Button variant="outline" onClick={() => setDisposeModal(null)}>
                {t("assets.cancel")}
              </Button>
              <Button
                onClick={dispose}
                className="bg-red-600 text-white hover:bg-red-700"
                data-testid="assets-dispose-confirm"
              >
                {t("assets.dispose")}
              </Button>
            </div>
          </div>
        </div>
      )}
    </main>
  )
}
