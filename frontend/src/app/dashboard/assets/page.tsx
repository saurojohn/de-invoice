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

/**
 * Tier 87: Booking-status row for one asset
 * for one year. Comes from
 * GET /api/v1/assets/booking-status?year=YYYY
 */
interface BookingStatusRow {
  assetId: string
  bezeichnung: string
  type: string
  anschaffungsDatum: string
  verkauftAm: string | null
  computedAfA: number
  booked: boolean
  bookedAfA: number
  // Tier 89: 'annual' | 'monthly' | null
  bookingMode: "annual" | "monthly" | null
  expenseId: string | null
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
  // Tier 87: AfA-Buchung state
  const [bookingStatus, setBookingStatus] = useState<BookingStatusRow[]>([])
  const [bookingSaving, setBookingSaving] = useState(false)
  const [bookingConfirm, setBookingConfirm] = useState(false)
  // Tier 89: separate confirm modal for the
  // monthly mode.
  const [bookingConfirmMonthly, setBookingConfirmMonthly] = useState(false)

  const load = useCallback(async () => {
    const companyId = typeof window !== "undefined" ? localStorage.getItem("companyId") : null
    if (!companyId) return
    setLoading(true)
    try {
      const [data, status] = await Promise.all([
        apiGet<Asset[]>(`/api/v1/assets?companyId=${companyId}`),
        apiGet<BookingStatusRow[]>(
          `/api/v1/assets/booking-status?companyId=${companyId}&year=${year}`,
        ),
      ])
      setAssets(data || [])
      setBookingStatus(status || [])
    } catch (e) {
      console.error("assets load failed", e)
      toastRef.current.error("Fehler beim Laden")
    } finally {
      setLoading(false)
    }
  }, [year])

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

  // Tier 87: One-click "AfA buchen" for the
  // selected year. Idempotent on the server
  // (re-running is a no-op for already-booked
  // assets). Reloads booking-status + assets
  // after the call so the per-row badges + the
  // summary card update in place.
  const bookAfa = async () => {
    const companyId = typeof window !== "undefined" ? localStorage.getItem("companyId") : null
    if (!companyId) return
    setBookingConfirm(false)
    setBookingSaving(true)
    try {
      const result = await apiPost<{
        year: number
        mode: "annual" | "monthly"
        bookedCount: number
        skippedAlreadyCount: number
        skippedZeroCount: number
        totalAnnualAfA: number
      }>(
        `/api/v1/assets/book-afa?companyId=${companyId}&year=${year}`,
        {},
      )
      toastRef.current.success(
        tRef.current("assets.bookAfaOk")
          .replace("{count}", String(result.bookedCount))
          .replace("{skipped}", String(result.skippedAlreadyCount))
          .replace("{total}", fmtEur(result.totalAnnualAfA)),
      )
      load()
    } catch (e: any) {
      const msg = e instanceof ApiError ? e.message : "Fehler beim Buchen"
      toastRef.current.error(msg)
    } finally {
      setBookingSaving(false)
    }
  }

  // Tier 89: monthly booking flow. Same UI
  // pattern as bookAfa but hits the
  // /book-afa-monthly endpoint.
  const bookAfaMonthly = async () => {
    const companyId = typeof window !== "undefined" ? localStorage.getItem("companyId") : null
    if (!companyId) return
    setBookingConfirmMonthly(false)
    setBookingSaving(true)
    try {
      const result = await apiPost<{
        year: number
        mode: "annual" | "monthly"
        bookedCount: number
        skippedAlreadyCount: number
        skippedZeroCount: number
        totalAnnualAfA: number
      }>(
        `/api/v1/assets/book-afa-monthly?companyId=${companyId}&year=${year}`,
        {},
      )
      toastRef.current.success(
        tRef.current("assets.bookAfaMonthlyOk")
          .replace("{count}", String(result.bookedCount))
          .replace("{total}", fmtEur(result.totalAnnualAfA)),
      )
      load()
    } catch (e: any) {
      const msg = e instanceof ApiError ? e.message : "Fehler beim Buchen"
      toastRef.current.error(msg)
    } finally {
      setBookingSaving(false)
    }
  }

  // Bookable = computedAfA > 0 AND not yet booked.
  // The button shows the count + total to give
  // the user a clear preview before they confirm.
  const bookableRows = bookingStatus.filter(
    (r) => !r.booked && r.computedAfA > 0,
  )
  const bookableTotal = bookableRows.reduce((s, r) => s + r.computedAfA, 0)
  const alreadyBookedRows = bookingStatus.filter((r) => r.booked)
  const alreadyBookedTotal = alreadyBookedRows.reduce((s, r) => s + r.bookedAfA, 0)
  const bookingByAssetId = new Map(bookingStatus.map((r) => [r.assetId, r]))

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
              {/* Tier 87: one-click AfA-Buchung. The
                  button toggles between "AfA buchen"
                  (with preview count + total) and
                  "AfA gebucht" (with the booked
                  total + a small ✓). The confirm
                  modal lists the per-asset amounts
                  before the user commits. */}
              {bookableRows.length > 0 ? (
                <div>
                  <label className="text-xs text-gray-500 dark:text-gray-400 uppercase">
                    {t("assets.afaBuchung")}
                  </label>
                  <div className="flex items-center gap-2 mt-1 flex-wrap">
                    <Button
                      onClick={() => setBookingConfirm(true)}
                      disabled={bookingSaving}
                      className="bg-emerald-600 text-white hover:bg-emerald-700"
                      data-testid="assets-book-afa"
                    >
                      {bookingSaving
                        ? "…"
                        : `${t("assets.bookAfa")} (${bookableRows.length} • ${fmtEur(bookableTotal)})`}
                    </Button>
                    {/* Tier 89: monthly mode — same
                        count + total, but creates
                        12 rows (one per month)
                        instead of 1 year-end row. */}
                    <Button
                      onClick={() => setBookingConfirmMonthly(true)}
                      disabled={bookingSaving}
                      variant="outline"
                      className="border-emerald-600 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-50 dark:hover:bg-emerald-900/30"
                      data-testid="assets-book-afa-monthly"
                    >
                      {bookingSaving
                        ? "…"
                        : `${t("assets.bookAfaMonthly")} (${bookableRows.length} • ${fmtEur(bookableTotal)})`}
                    </Button>
                  </div>
                </div>
              ) : alreadyBookedRows.length > 0 ? (
                <div data-testid="assets-booked-badge">
                  <label className="text-xs text-gray-500 dark:text-gray-400 uppercase">
                    {t("assets.afaBuchung")}
                  </label>
                  <div className="flex items-center gap-2 mt-1 flex-wrap">
                    <span className="inline-flex items-center gap-1 px-3 py-2 rounded bg-emerald-50 dark:bg-emerald-900/30 text-emerald-800 dark:text-emerald-200 text-sm font-mono border border-emerald-200 dark:border-emerald-800">
                      <span className="text-emerald-600">✓</span>
                      {t("assets.bookAfaBooked")} ({fmtEur(alreadyBookedTotal)})
                    </span>
                    {/* Tier 89: show booking mode chip
                        next to the booked badge so
                        the user knows if the
                        booking was annual or
                        monthly. */}
                    {alreadyBookedRows[0]?.bookingMode === "monthly" && (
                      <span
                        className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-mono bg-blue-50 dark:bg-blue-900/30 text-blue-800 dark:text-blue-200 border border-blue-200 dark:border-blue-800"
                        data-testid="assets-book-mode-monthly"
                      >
                        {t("assets.afaBookedMonthly")}
                      </span>
                    )}
                  </div>
                </div>
              ) : null}
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
                      <th className="text-center py-2 px-2 text-xs">{t("assets.afaStatus")}</th>
                      <th className="text-center py-2 px-2 text-xs">{t("assets.actions")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summaries.map((s) => {
                      const a = s.asset
                      const disposed = !!a.verkauftAm
                      const booking = bookingByAssetId.get(a.id)
                      const booked = booking?.booked ?? false
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
                          <td
                            className="py-2 px-2 text-center"
                            data-testid={`assets-afa-status-${a.id}`}
                          >
                            {disposed ? (
                              <span className="text-xs text-gray-400">—</span>
                            ) : booked ? (
                              <span
                                className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono bg-emerald-50 dark:bg-emerald-900/30 text-emerald-800 dark:text-emerald-200 border border-emerald-200 dark:border-emerald-800"
                                title={t("assets.afaBookedHint")}
                              >
                                <span className="text-emerald-600">✓</span>
                                {t("assets.afaBooked")}
                                {booking?.bookingMode === "monthly" && (
                                  <span className="ml-1 text-[9px] text-emerald-600/80 font-normal">
                                    {t("assets.afaBookedMonthly")}
                                  </span>
                                )}
                              </span>
                            ) : s.annualAfA > 0 ? (
                              <span
                                className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono bg-amber-50 dark:bg-amber-900/30 text-amber-800 dark:text-amber-200 border border-amber-200 dark:border-amber-800"
                                title={t("assets.afaNotBookedHint")}
                              >
                                {t("assets.afaNotBooked")}
                              </span>
                            ) : (
                              <span className="text-xs text-gray-400">—</span>
                            )}
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

      {bookingConfirm && (
        <div className="fixed inset-0 bg-black bg-opacity-40 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl w-full max-w-2xl p-6 max-h-[90vh] overflow-y-auto">
            <h2 className="text-xl font-bold mb-2">
              {t("assets.bookAfaConfirmTitle")}
            </h2>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
              {t("assets.bookAfaConfirmHint").replace("{year}", String(year))}
            </p>
            <div className="overflow-x-auto mb-4">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-xs">
                    <th className="text-left py-2 px-2">{t("assets.bezeichnung")}</th>
                    <th className="text-right py-2 px-2">{t("assets.anschaffungsKosten")}</th>
                    <th className="text-right py-2 px-2">{t("assets.jahresAfA")}</th>
                  </tr>
                </thead>
                <tbody>
                  {bookableRows.map((r) => (
                    <tr key={r.assetId} className="border-b">
                      <td className="py-1 px-2 text-xs">{r.bezeichnung}</td>
                      <td className="py-1 px-2 text-right text-xs font-mono">
                        {fmtEur(
                          Number(
                            assets.find((a) => a.id === r.assetId)?.anschaffungsKosten ?? 0,
                          ),
                        )}
                      </td>
                      <td className="py-1 px-2 text-right text-xs font-mono font-bold">
                        {fmtEur(r.computedAfA)}
                      </td>
                    </tr>
                  ))}
                  <tr className="border-t-2 border-t-gray-300">
                    <td className="py-2 px-2 text-xs font-bold" colSpan={2}>
                      {t("assets.bookAfaTotal")}
                    </td>
                    <td
                      className="py-2 px-2 text-right text-sm font-mono font-bold"
                      data-testid="assets-book-total"
                    >
                      {fmtEur(bookableTotal)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
              {t("assets.bookAfaConfirmFootnote")}
            </p>
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => setBookingConfirm(false)}
                disabled={bookingSaving}
              >
                {t("assets.cancel")}
              </Button>
              <Button
                onClick={bookAfa}
                disabled={bookingSaving}
                className="bg-emerald-600 text-white hover:bg-emerald-700"
                data-testid="assets-book-confirm"
              >
                {bookingSaving ? "…" : t("assets.bookAfa")}
              </Button>
            </div>
          </div>
        </div>
      )}

      {bookingConfirmMonthly && (
        <div className="fixed inset-0 bg-black bg-opacity-40 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl w-full max-w-2xl p-6 max-h-[90vh] overflow-y-auto">
            <h2 className="text-xl font-bold mb-2">
              {t("assets.bookAfaMonthlyConfirmTitle")}
            </h2>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
              {t("assets.bookAfaMonthlyConfirmHint").replace("{year}", String(year))}
            </p>
            <div className="overflow-x-auto mb-4">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-xs">
                    <th className="text-left py-2 px-2">{t("assets.bezeichnung")}</th>
                    <th className="text-right py-2 px-2">{t("assets.anschaffungsKosten")}</th>
                    <th className="text-right py-2 px-2">{t("assets.jahresAfA")}</th>
                    <th className="text-right py-2 px-2">{t("assets.afaProMonat")}</th>
                  </tr>
                </thead>
                <tbody>
                  {bookableRows.map((r) => {
                    const ak = Number(
                      assets.find((a) => a.id === r.assetId)?.anschaffungsKosten ?? 0,
                    )
                    const monthly = r.computedAfA / 12
                    return (
                      <tr key={r.assetId} className="border-b">
                        <td className="py-1 px-2 text-xs">{r.bezeichnung}</td>
                        <td className="py-1 px-2 text-right text-xs font-mono">
                          {fmtEur(ak)}
                        </td>
                        <td className="py-1 px-2 text-right text-xs font-mono">
                          {fmtEur(r.computedAfA)}
                        </td>
                        <td className="py-1 px-2 text-right text-xs font-mono font-bold">
                          {fmtEur(monthly)}
                        </td>
                      </tr>
                    )
                  })}
                  <tr className="border-t-2 border-t-gray-300">
                    <td className="py-2 px-2 text-xs font-bold" colSpan={2}>
                      {t("assets.bookAfaTotal")}
                    </td>
                    <td
                      className="py-2 px-2 text-right text-sm font-mono font-bold"
                      data-testid="assets-book-monthly-total-annual"
                    >
                      {fmtEur(bookableTotal)}
                    </td>
                    <td
                      className="py-2 px-2 text-right text-sm font-mono font-bold"
                      data-testid="assets-book-monthly-total"
                    >
                      {fmtEur(bookableTotal / 12)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
              {t("assets.bookAfaMonthlyConfirmFootnote")}
            </p>
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => setBookingConfirmMonthly(false)}
                disabled={bookingSaving}
              >
                {t("assets.cancel")}
              </Button>
              <Button
                onClick={bookAfaMonthly}
                disabled={bookingSaving}
                className="bg-emerald-600 text-white hover:bg-emerald-700"
                data-testid="assets-book-monthly-confirm"
              >
                {bookingSaving ? "…" : t("assets.bookAfaMonthly")}
              </Button>
            </div>
          </div>
        </div>
      )}
    </main>
  )
}
