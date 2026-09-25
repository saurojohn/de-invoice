"use client"

import { Suspense, useEffect, useRef, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import LanguageSwitcher from "@/components/LanguageSwitcher"
import { useI18n } from "@/components/useI18n"
import { useToast } from "@/components/useToast"
import { ApiError, apiDelete, apiFetch, apiGet, apiPost, apiPut } from "@/lib/api"

interface UstvaData {
  companyId: string
  year: number
  quarter?: number | null
  month?: number | null
  periodLabel: string
  // Tier 457: 'ist' — taxed sales in the period of their payment (§ 20 UStG)
  besteuerungsart?: "soll" | "ist"
  salesByRate: Array<{ rate: number; label: string; net: number; vat: number }>
  igL: number
  export: number
  otherExempt: number
  reverseCharge: number
  // Tier 417
  reverseChargeSales?: number
  euServicesSales?: number
  nonTaxableOther?: number
  kennzahlen?: Array<{ kz: string; label: string; value: number; kind: "base" | "tax" | "amount"; tax?: number }>
  vorsteuer: {
    from19: number
    from7: number
    fromIgE: number
    fromReverseCharge: number
    fromOther?: number
    total: number
  }
  umsatzsteuer: number
  vorsteuerSum: number
  differenzbetrag: number
  counts: { invoices: number; expenses: number }
}

interface UstvaFiling {
  id: string
  year: number
  quarter: number | null
  month: number | null
  periodLabel: string
  outputVat: string
  inputVat: string
  payableVat: string
  intraEUSales: string
  intraEUPurchase: string
  status: string
  submittedAt: string | null
  taxNumber: string | null
  notes: string | null
  createdAt: string
  // Tier 449: a submitted return the books no longer match (live − submitted).
  abweichung?: { outputVat: number; inputVat: number; payableVat: number } | null
  berichtigungNoetig?: boolean | null
}

interface Expense {
  id: string
  invoiceNumber: string | null
  description: string
  invoiceDate: string
  netAmount: string
  vatRate: string
  vatAmount: string
  grossAmount: string
  category: string | null
  isIntraEU: boolean
  isReverseCharge: boolean
  supplierId?: string | null
  supplier?: { id: string; name: string } | null
  // Tier 443: set when the expense is paid or an AfA row — no edit / delete.
  lockReason?: string | null
  paidAt?: string | null
}

interface Supplier { id: string; name: string }

type PeriodMode = "year" | "q1" | "q2" | "q3" | "q4" | "m1" | "m2" | "m3" | "m4" | "m5" | "m6" | "m7" | "m8" | "m9" | "m10" | "m11" | "m12"

export default function UstvaPage() {
  // Next.js 16 production build requires
  // useSearchParams() to be wrapped in a
  // Suspense boundary, otherwise the page
  // bails out of static prerendering with
  // "useSearchParams() should be wrapped
  // in a suspense boundary". We split
  // the page into an inner component
  // (UstvaPageInner) that does the actual
  // searchParams read + state, and a
  // Suspense wrapper at the default export
  // that catches the bailout gracefully
  // (shows a loading fallback during
  // SSR/prerender, then the real page
  // hydrates on the client). The inner
  // component is identical to the original
  // UstvaPage body — only renamed.
  return (
    <Suspense
      fallback={
        <div className="p-6 text-sm text-gray-500">Lade USt-Voranmeldung…</div>
      }
    >
      <UstvaPageInner />
    </Suspense>
  )
}

function UstvaPageInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { t } = useI18n()
  const toast = useToast()
  const currentYear = new Date().getFullYear()

  const [year, setYear] = useState(currentYear)
  const [period, setPeriod] = useState<PeriodMode>("year")
  const [data, setData] = useState<UstvaData | null>(null)
  const [filings, setFilings] = useState<UstvaFiling[]>([])
  const [expenses, setExpenses] = useState<Expense[]>([])
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [loading, setLoading] = useState(false)
  const [downloadError, setDownloadError] = useState<string | null>(null)

  const [taxNumber, setTaxNumber] = useState("")
  const [notes, setNotes] = useState("")
  const [saving, setSaving] = useState(false)
  const [savedMsg, setSavedMsg] = useState<string | null>(null)

  const [showAdd, setShowAdd] = useState(false)
  const emptyExpenseForm = () => ({
    invoiceDate: new Date().toISOString().split("T")[0],
    invoiceNumber: "",
    supplierId: "",
    description: "",
    netAmount: "",
    vatRate: "0.19",
    vatAmount: "",
    grossAmount: "",
    category: "",
    isIntraEU: false,
    isReverseCharge: false,
    // Tier 442: a supplier credit note — entered positive, stored negative.
    creditNote: false,
    // Tier 454: paid by card / privately — the EÜR counts it on this day
    paidAt: "",
  })
  const [exForm, setExForm] = useState(emptyExpenseForm)
  // Tier 443: the expense being corrected (PUT), null when adding one.
  const [editingId, setEditingId] = useState<string | null>(null)

  // Tier 161: prefill year + period from the URL
  // (deep-link from the dashboard Monatsvergleich
  // widget — /dashboard/accounting/ustva?year=YYYY
  // &month=MM). The ref guard ensures this only runs
  // once on mount, even if useSearchParams triggers
  // a re-render. After the initial prefill, the user
  // drives the state via the dropdowns (their changes
  // are NOT reflected back to the URL — we don't want
  // a setState → URL update → re-render loop). The
  // [router, year, period] effect below picks up the
  // new state and fetches the data.
  const urlPrefillApplied = useRef(false)
  useEffect(() => {
    if (urlPrefillApplied.current) return
    const yStr = searchParams?.get("year")
    const mStr = searchParams?.get("month")
    if (yStr) {
      const y = parseInt(yStr, 10)
      if (Number.isInteger(y) && y >= 2010 && y <= 2100) setYear(y)
    }
    if (mStr) {
      const m = parseInt(mStr, 10)
      if (m >= 1 && m <= 12) {
        setPeriod(`m${m}` as PeriodMode)
      }
    }
    urlPrefillApplied.current = true
     
  }, [searchParams])

  useEffect(() => {
    const companyId = localStorage.getItem("companyId")
    if (!companyId) {
      router.push("/login")
      return
    }
    loadAll(companyId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router, year, period])

  const buildQuery = (q: { year: number; period: PeriodMode }) => {
    const params = new URLSearchParams({ year: String(q.year) })
    if (q.period === "year") return params.toString()
    if (q.period.startsWith("q")) params.append("quarter", q.period.slice(1))
    else if (q.period.startsWith("m")) params.append("month", q.period.slice(1))
    return params.toString()
  }

  const loadAll = async (companyId: string) => {
    setLoading(true)
    setSavedMsg(null)
    try {
      const q = buildQuery({ year, period })

      // Tier 162 follow-up: use apiGet instead of
      // raw fetch. The raw fetch was sending no
      // auth headers, so the backend returned 401
      // and the page tried to render
      // data.vorsteuer.total on `{message: ...}`,
      // which crashed the entire page via the
      // error boundary. apiGet injects x-user-id
      // + x-company-id from localStorage.
      const [compute, filingList, expList, supList] = await Promise.all([
        apiGet<any>(`/api/v1/ustva/compute?companyId=${companyId}&${q}`).catch(() => null),
        apiGet<any[]>(`/api/v1/ustva/filings?companyId=${companyId}`).catch(() => []),
        apiGet<any[]>(`/api/v1/ustva/expenses?companyId=${companyId}&${q}`).catch(() => []),
        // Tier 443: the "Lieferant" select listed customers — the backend then
        // refused every chosen one ("Lieferant nicht gefunden").
        apiGet<any>(`/api/v1/suppliers?companyId=${companyId}`).catch(() => []),
      ])
      setData(compute)
      setFilings(Array.isArray(filingList) ? filingList : [])
      setExpenses(Array.isArray(expList) ? expList : [])
      const supplierRows = Array.isArray(supList) ? supList : supList?.data ?? []
      setSuppliers(supplierRows.map((c: any) => ({ id: c.id, name: c.name })))
    } catch (err) {
      console.error("UStVA load error:", err)
    } finally {
      setLoading(false)
    }
  }

  const formatCurrency = (n: number) =>
    new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" }).format(n)

  const formatDate = (s: string) => new Date(s).toLocaleDateString("de-DE")

  // Auto-compute vat/gross when net + rate change. Tier 443: it kept the first
  // value (`f.vatAmount || …`), so typing 1000 digit by digit saved VAT 0.19
  // and gross 1.19 — the VAT field is read-only, it always follows.
  useEffect(() => {
    const net = parseFloat(exForm.netAmount || "0")
    const rate = parseFloat(exForm.vatRate || "0")
    const vat = Math.round(net * rate * 100) / 100
    const gross = Math.round((net + vat) * 100) / 100
    setExForm((f) => ({
      ...f,
      vatAmount: net ? String(vat) : "",
      grossAmount: net ? String(gross) : "",
    }))
  }, [exForm.netAmount, exForm.vatRate])

  const closeExpenseForm = () => {
    setShowAdd(false)
    setEditingId(null)
    setExForm(emptyExpenseForm())
  }

  // Tier 443: correct an open expense in the same form. Amounts are shown
  // positive; a credit note keeps its checkbox.
  const startEditExpense = (ex: Expense) => {
    setEditingId(ex.id)
    setExForm({
      invoiceDate: String(ex.invoiceDate).slice(0, 10),
      invoiceNumber: ex.invoiceNumber || "",
      supplierId: ex.supplierId || "",
      description: ex.description || "",
      netAmount: String(Math.abs(Number(ex.netAmount))),
      vatRate: String(Number(ex.vatRate)),
      vatAmount: String(Math.abs(Number(ex.vatAmount))),
      grossAmount: String(Math.abs(Number(ex.grossAmount))),
      category: ex.category || "",
      isIntraEU: !!ex.isIntraEU,
      isReverseCharge: !!ex.isReverseCharge,
      creditNote: Number(ex.grossAmount) < 0,
      paidAt: ex.paidAt ? String(ex.paidAt).slice(0, 10) : "",
    })
    setShowAdd(true)
  }

  const submitExpense = async () => {
    const companyId = localStorage.getItem("companyId")
    if (!companyId) return
    if (!exForm.description || !exForm.invoiceDate || !exForm.netAmount) {
      toast.warn("Bitte Datum, Beschreibung und Nettobetrag angeben.")
      return
    }
    setSaving(true)
    try {
      const body = {
        ...exForm,
        netAmount: parseFloat(exForm.netAmount),
        vatRate: parseFloat(exForm.vatRate),
        vatAmount: parseFloat(exForm.vatAmount || "0"),
        grossAmount: parseFloat(exForm.grossAmount || "0"),
        paidAt: exForm.paidAt || null,
      }
      // Tier 390: was a raw fetch without the auth headers (401).
      if (editingId) {
        await apiPut(`/api/v1/ustva/expenses/${editingId}?companyId=${companyId}`, body)
      } else {
        await apiPost(`/api/v1/ustva/expenses?companyId=${companyId}`, body)
      }
      closeExpenseForm()
      await loadAll(companyId)
    } catch (err) {
      console.error("Add expense failed:", err)
      toast.error(err instanceof ApiError ? err.message : "Fehler beim Speichern der Eingangsrechnung")
    } finally {
      setSaving(false)
    }
  }

  const deleteExpense = async (id: string) => {
    if (!confirm(t("ustva.confirmDelete"))) return
    const companyId = localStorage.getItem("companyId")
    if (!companyId) return
    // Tier 390: was a raw fetch without the auth headers (401, nothing deleted).
    try {
      await apiDelete(`/api/v1/ustva/expenses/${id}?companyId=${companyId}`)
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Löschen fehlgeschlagen")
    }
    await loadAll(companyId)
  }

  const saveFiling = async (status: "draft" | "submitted") => {
    if (!data) return
    const companyId = localStorage.getItem("companyId")
    if (!companyId) return
    setSaving(true)
    setSavedMsg(null)
    const post = (berichtigt: boolean) =>
      apiPost(`/api/v1/ustva/filings?companyId=${companyId}`, {
        ...data,
        taxNumber: taxNumber || null,
        notes: notes || null,
        status,
        ...(berichtigt ? { berichtigt: true } : {}),
      })
    try {
      // Tier 390: was a raw fetch without the auth headers (401).
      try {
        await post(false)
      } catch (err) {
        // Tier 448: the period was already submitted — only a corrected
        // return (berichtigte Voranmeldung) may replace it.
        if (!(err instanceof ApiError && err.status === 409 && status === "submitted")) throw err
        if (!confirm(`${err.message}\n\n${t("ustva.confirmBerichtigt")}`)) return
        await post(true)
      }
      setSavedMsg(
        status === "submitted" ? t("ustva.submitSuccess") : t("ustva.saveSuccess")
      )
      await loadAll(companyId)
    } catch (err) {
      console.error("Save filing failed:", err)
      toast.error(err instanceof ApiError ? err.message : "Fehler beim Speichern der UStVA")
    } finally {
      setSaving(false)
    }
  }

  const downloadElster = (filingId: string, periodLabel: string) => {
    // Use a hidden <a> with the API endpoint + download=1. The
    // server sets Content-Disposition: attachment with a
    // sanitised filename, and apiFetch already adds the auth
    // headers. We use apiFetch + blob URL pattern instead of a
    // direct <a href> so x-user-id / x-company-id are included
    // (a plain <a> would skip the apiFetch authHeaders).
    const companyId = localStorage.getItem("companyId")
    if (!companyId) return
    ;(async () => {
      try {
        const res = await apiFetch(
          `/ustva/filings/${encodeURIComponent(filingId)}/elster-xml?companyId=${encodeURIComponent(companyId)}&format=xml&download=1`,
          { method: "GET" },
        )
        const blob = await res.blob()
        const url = URL.createObjectURL(blob)
        const a = document.createElement("a")
        a.href = url
        a.download = `UStVA_${periodLabel.replace(/[^A-Za-z0-9-]/g, "_")}.xml`
        document.body.appendChild(a)
        a.click()
        a.remove()
        URL.revokeObjectURL(url)
      } catch (e: any) {
        setDownloadError(e?.message || "ELSTER-XML konnte nicht heruntergeladen werden")
      }
    })()
  }

  const downloadCsv = () => {
    if (!data) return
    const lines: string[] = []
    // Tier 417: the official USt 1 A 2026 Kennzahlen, as the backend maps
    // them. This listed invented "Zeilen" (the payable amount as "Zeile 81",
    // which on the form is the 19 % tax base).
    lines.push("Kennzahl;Bezeichnung;Betrag;Steuer lt. Rechnungen")
    for (const k of data.kennzahlen ?? []) {
      if (k.value === 0 && k.kz !== "83") continue
      lines.push(`${k.kz};${k.label};${k.value.toFixed(2)};${k.tax != null ? k.tax.toFixed(2) : ""}`)
    }
    lines.push(`;Summe Umsatzsteuer;${data.umsatzsteuer.toFixed(2)};`)
    lines.push(`;Summe Vorsteuer;${data.vorsteuer.total.toFixed(2)};`)

    const csv = "\uFEFF" + lines.join("\n")
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" })
    const url = window.URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `UStVA_${data.periodLabel}.csv`
    a.click()
    window.URL.revokeObjectURL(url)
  }

  // Tier 182: UStVA-PDF download (Berater-readable A4).
  // The endpoint is /api/v1/ustva/ustva.pdf?year=&month=&companyId=
  // and `month` is REQUIRED (Zahllast is per-month). For
  // the PDF to be available, the user must have selected
  // a single month (m1..m12). Year / quarter selections
  // disable the button (the PDF doesn't exist for them —
  // the Finanzamt wants monthly, and a year would be 12
  // separate PDFs anyway).
  const downloadUstvaPdf = async () => {
    const companyId = localStorage.getItem("companyId")
    if (!companyId) return
    if (!period.startsWith("m")) {
      setDownloadError(t("ustva.downloadPdfMonthRequired"))
      return
    }
    const month = parseInt(period.slice(1), 10)
    if (!Number.isInteger(month) || month < 1 || month > 12) {
      setDownloadError(`Ungültiger Monat: ${month}`)
      return
    }
    try {
      const res = await apiFetch(
        `/api/v1/ustva/ustva.pdf?companyId=${encodeURIComponent(companyId)}&year=${year}&month=${month}`,
        { method: "GET" },
      )
      if (!res.ok) {
        setDownloadError(
          t("ustva.downloadPdfLoadError", { status: res.status }),
        )
        return
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = `UStVA-${year}-${String(month).padStart(2, "0")}.pdf`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch (e: any) {
      setDownloadError(e?.message || t("ustva.downloadPdfError"))
    }
  }
  const isMonthSelected = period.startsWith("m")

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 p-6">
      <div className="max-w-7xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t("ustva.title")}</h1>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{t("ustva.subtitle")}</p>
          </div>
          <div className="flex items-center gap-3">
            <LanguageSwitcher />
            <Button variant="outline" onClick={() => router.push("/dashboard/accounting")}>
              {t("accounting.back")}
            </Button>
          </div>
        </div>

        {/* Period Selector */}
        <Card className="mb-6">
          <CardContent className="pt-6">
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">
                  {t("ustva.yearly")}
                </label>
                <input
                  type="number"
                  value={year}
                  onChange={(e) => setYear(parseInt(e.target.value, 10))}
                  min="2010"
                  max="2100"
                  className="w-full px-3 py-2 border border-gray dark:border-gray-700-300 dark:border-gray-600 rounded-md"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">
                  {t("ustva.period")}
                </label>
                <select
                  value={period}
                  onChange={(e) => setPeriod(e.target.value as PeriodMode)}
                  className="w-full px-3 py-2 border border-gray dark:border-gray-700-300 dark:border-gray-600 rounded-md"
                >
                  <option value="year">{t("ustva.yearly")}</option>
                  <option value="q1">{t("ustva.q1")}</option>
                  <option value="q2">{t("ustva.q2")}</option>
                  <option value="q3">{t("ustva.q3")}</option>
                  <option value="q4">{t("ustva.q4")}</option>
                  <option value="m1">01 — Januar</option>
                  <option value="m2">02 — Februar</option>
                  <option value="m3">03 — März</option>
                  <option value="m4">04 — April</option>
                  <option value="m5">05 — Mai</option>
                  <option value="m6">06 — Juni</option>
                  <option value="m7">07 — Juli</option>
                  <option value="m8">08 — August</option>
                  <option value="m9">09 — September</option>
                  <option value="m10">10 — Oktober</option>
                  <option value="m11">11 — November</option>
                  <option value="m12">12 — Dezember</option>
                </select>
              </div>
              <div className="md:col-span-2 flex items-end gap-2 justify-end">
                <Button
                  variant="outline"
                  onClick={downloadCsv}
                  disabled={!data}
                  data-testid="ustva-export-csv"
                >
                  {t("ustva.exportCsv")}
                </Button>
                <Button
                  variant="outline"
                  onClick={downloadUstvaPdf}
                  disabled={!data || !isMonthSelected}
                  title={
                    isMonthSelected
                      ? t("ustva.downloadPdf")
                      : t("ustva.downloadPdfMonthRequiredShort")
                  }
                  data-testid="ustva-export-pdf"
                >
                  {t("ustva.downloadPdf")}
                </Button>
              </div>
            </div>
            <div className="mt-3 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2">
              {t("ustva.hintVoranmeldung")}
            </div>
          </CardContent>
        </Card>

        {loading || !data || !data.vorsteuer ? (
          <div className="text-center py-12 text-gray-500 dark:text-gray-400">…</div>
        ) : (
          <>
            {/* Summary Cards */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
              <Card>
                <CardContent className="pt-6">
                  <div className="text-xs text-gray-500 dark:text-gray-400 mb-1">{t("ustva.umsatzsteuer")}</div>
                  <div className="text-2xl font-bold text-blue-700 dark:text-blue-300">
                    {formatCurrency(data.umsatzsteuer)}
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-6">
                  <div className="text-xs text-gray-500 dark:text-gray-400 mb-1">{t("ustva.vorsteuerTotal")}</div>
                  <div className="text-2xl font-bold text-green-700 dark:text-green-300">
                    {formatCurrency(data.vorsteuer.total)}
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-6">
                  <div className="text-xs text-gray-500 dark:text-gray-400 mb-1">{t("ustva.differenzbetrag")}</div>
                  <div
                    className={`text-2xl font-bold ${
                      data.differenzbetrag > 0
                        ? "text-red-700 dark:text-red-300"
                        : data.differenzbetrag < 0
                          ? "text-emerald-700"
                          : "text-gray-700 dark:text-gray-200"
                    }`}
                  >
                    {formatCurrency(data.differenzbetrag)}
                  </div>
                  <div className="text-xs mt-1 text-gray-500 dark:text-gray-400">
                    {data.differenzbetrag > 0
                      ? t("ustva.zahllast")
                      : data.differenzbetrag < 0
                        ? t("ustva.erstattung")
                        : "—"}
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Sales by rate (Zeile 20-23) */}
            <Card className="mb-6">
              <CardHeader>
                <CardTitle>{t("ustva.taxableSales")}</CardTitle>
                {data.besteuerungsart === "ist" && (
                  <p className="text-xs text-gray-600 dark:text-gray-300" data-testid="ustva-ist">
                    {t("ustva.istVersteuerung")}
                  </p>
                )}
              </CardHeader>
              <CardContent>
                {data.salesByRate.length === 0 ? (
                  <p className="text-sm text-gray-500 dark:text-gray-400 text-center py-4">—</p>
                ) : (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b">
                        <th className="text-left py-2 font-medium">USt-Satz</th>
                        <th className="text-right py-2 font-medium">{t("ustva.lineNet")}</th>
                        <th className="text-right py-2 font-medium">{t("ustva.lineVat")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.salesByRate.map((r) => (
                        <tr key={r.rate} className="border-b">
                          <td className="py-2">{r.label}</td>
                          <td className="py-2 text-right">{formatCurrency(r.net)}</td>
                          <td className="py-2 text-right font-medium">{formatCurrency(r.vat)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t-2 font-semibold">
                        <td className="py-2">Σ {t("ustva.umsatzsteuer")}</td>
                        <td className="py-2 text-right">
                          {formatCurrency(data.salesByRate.reduce((s, r) => s + r.net, 0))}
                        </td>
                        <td className="py-2 text-right">{formatCurrency(data.umsatzsteuer)}</td>
                      </tr>
                    </tfoot>
                  </table>
                )}
              </CardContent>
            </Card>

            {/* Exempt sales + input tax */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
              <Card>
                <CardHeader>
                  <CardTitle>{t("ustva.taxExempt")}</CardTitle>
                </CardHeader>
                <CardContent>
                  <table className="w-full text-sm">
                    <tbody>
                      <tr className="border-b">
                        <td className="py-2">{t("ustva.igL")}</td>
                        <td className="py-2 text-right font-medium">{formatCurrency(data.igL)}</td>
                      </tr>
                      <tr className="border-b">
                        <td className="py-2">{t("ustva.export")}</td>
                        <td className="py-2 text-right font-medium">
                          {formatCurrency(data.export)}
                        </td>
                      </tr>
                      <tr className="border-b">
                        <td className="py-2">{t("ustva.otherExempt")}</td>
                        <td className="py-2 text-right font-medium">
                          {formatCurrency(data.otherExempt)}
                        </td>
                      </tr>
                      {/* Tier 417: sales on which the customer owes the tax */}
                      <tr className="border-b" data-testid="ustva-rc-sales">
                        <td className="py-2">§ 13b — Leistungsempfänger schuldet die Steuer (Kz 60)</td>
                        <td className="py-2 text-right font-medium">{formatCurrency(data.reverseChargeSales ?? 0)}</td>
                      </tr>
                      <tr className="border-b" data-testid="ustva-eu-services">
                        <td className="py-2">Sonstige Leistungen an Unternehmer in der EU (Kz 21)</td>
                        <td className="py-2 text-right font-medium">{formatCurrency(data.euServicesSales ?? 0)}</td>
                      </tr>
                      <tr>
                        <td className="py-2">Übrige nicht steuerbare Umsätze (Kz 45)</td>
                        <td className="py-2 text-right font-medium">{formatCurrency(data.nonTaxableOther ?? 0)}</td>
                      </tr>
                    </tbody>
                  </table>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>{t("ustva.inputTax")}</CardTitle>
                </CardHeader>
                <CardContent>
                  <table className="w-full text-sm">
                    <tbody>
                      <tr className="border-b">
                        <td className="py-2">{t("ustva.vorsteuer19")}</td>
                        <td className="py-2 text-right font-medium">
                          {formatCurrency(data.vorsteuer.from19)}
                        </td>
                      </tr>
                      <tr className="border-b">
                        <td className="py-2">{t("ustva.vorsteuer7")}</td>
                        <td className="py-2 text-right font-medium">
                          {formatCurrency(data.vorsteuer.from7)}
                        </td>
                      </tr>
                      <tr className="border-b">
                        <td className="py-2">{t("ustva.vorsteuerIgE")}</td>
                        <td className="py-2 text-right font-medium">
                          {formatCurrency(data.vorsteuer.fromIgE)}
                        </td>
                      </tr>
                      <tr className="border-b">
                        <td className="py-2">{t("ustva.vorsteuerRc")}</td>
                        <td className="py-2 text-right font-medium">
                          {formatCurrency(data.vorsteuer.fromReverseCharge)}
                        </td>
                      </tr>
                      <tr className="border-t-2 font-semibold">
                        <td className="py-2">Σ {t("ustva.vorsteuerTotal")}</td>
                        <td className="py-2 text-right">{formatCurrency(data.vorsteuer.total)}</td>
                      </tr>
                    </tbody>
                  </table>
                </CardContent>
              </Card>
            </div>

            {/* Tier 417: the amounts under their official Kennzahlen */}
            {data.kennzahlen && data.kennzahlen.some((k) => k.value !== 0) && (
              <Card className="mb-6" data-testid="ustva-kennzahlen">
                <CardHeader>
                  <CardTitle>Kennzahlen (Vordruck USt 1 A 2026)</CardTitle>
                </CardHeader>
                <CardContent>
                  <table className="w-full text-sm">
                    <tbody>
                      {data.kennzahlen
                        .filter((k) => k.value !== 0 || k.kz === "83")
                        .map((k) => (
                          <tr key={k.kz} className="border-b" data-testid={`ustva-kz-${k.kz}`}>
                            <td className="py-2 font-mono w-12">{k.kz}</td>
                            <td className="py-2 text-xs">{k.label}</td>
                            <td className="py-2 text-right font-medium">{formatCurrency(k.value)}</td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                  <p className="text-[11px] text-gray-500 mt-2">
                    Zur Übertragung in Mein ELSTER. Bemessungsgrundlagen werden dort in vollen Euro eingetragen; die Steuer zu Kz 81/86/89/93 berechnet ELSTER selbst.
                  </p>
                </CardContent>
              </Card>
            )}

            {/* Reverse charge line */}
            {data.reverseCharge > 0 && (
              <Card className="mb-6 bg-amber-50 border-amber-200">
                <CardContent className="pt-6">
                  <div className="flex items-baseline justify-between">
                    <div>
                      <div className="text-sm font-medium text-amber-900">
                        {t("ustva.reverseCharge")}
                      </div>
                      <div className="text-xs text-amber-700 mt-1">
                        §13b UStG / igE — Steuerschuldnerschaft des Leistungsempfängers
                      </div>
                    </div>
                    <div className="text-2xl font-bold text-amber-900">
                      {formatCurrency(data.reverseCharge)}
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Expenses (Eingangsrechnungen) */}
            <Card className="mb-6">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle>{t("ustva.expenses")}</CardTitle>
                  <Button size="sm" onClick={() => (showAdd ? closeExpenseForm() : setShowAdd(true))} data-testid="ustva-add-expense-toggle">
                    {showAdd ? "×" : `+ ${t("ustva.addExpense")}`}
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                {showAdd && (
                  <div className="mb-4 p-4 bg-gray-50 dark:bg-gray-900 border rounded-lg">
                    {editingId && (
                      <p className="mb-3 text-sm font-medium" data-testid="ustva-expense-editing">
                        {t("ustva.editingExpense")}
                      </p>
                    )}
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                      <div>
                        <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">
                          {t("ustva.expenseDate")}
                        </label>
                        <input
                          type="date"
                          value={exForm.invoiceDate}
                          onChange={(e) => setExForm({ ...exForm, invoiceDate: e.target.value })}
                          className="w-full px-2 py-1.5 border rounded text-sm"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">
                          {t("ustva.expenseNumber")}
                        </label>
                        <input
                          value={exForm.invoiceNumber}
                          onChange={(e) => setExForm({ ...exForm, invoiceNumber: e.target.value })}
                          className="w-full px-2 py-1.5 border rounded text-sm"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">
                          {t("ustva.supplier")}
                        </label>
                        <select
                          value={exForm.supplierId}
                          onChange={(e) => setExForm({ ...exForm, supplierId: e.target.value })}
                          className="w-full px-2 py-1.5 border rounded text-sm"
                        >
                          <option value="">—</option>
                          {suppliers.map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.name}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="md:col-span-2">
                        <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">
                          {t("ustva.description")} *
                        </label>
                        <input
                          value={exForm.description}
                          onChange={(e) => setExForm({ ...exForm, description: e.target.value })}
                          data-testid="ustva-expense-description"
                          className="w-full px-2 py-1.5 border rounded text-sm"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">
                          {t("ustva.category")}
                        </label>
                        <input
                          value={exForm.category}
                          onChange={(e) => setExForm({ ...exForm, category: e.target.value })}
                          placeholder="z.B. Material, Miete"
                          className="w-full px-2 py-1.5 border rounded text-sm"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">
                          {t("expenses.paidAt")}
                        </label>
                        <input
                          type="date"
                          value={exForm.paidAt}
                          onChange={(e) => setExForm({ ...exForm, paidAt: e.target.value })}
                          data-testid="ustva-expense-paid-at"
                          title={t("expenses.paidAtHint")}
                          className="w-full px-2 py-1.5 border rounded text-sm"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">
                          {t("ustva.net")} *
                        </label>
                        <input
                          type="number"
                          step="0.01"
                          value={exForm.netAmount}
                          onChange={(e) => setExForm({ ...exForm, netAmount: e.target.value })}
                          data-testid="ustva-expense-net"
                          className="w-full px-2 py-1.5 border rounded text-sm text-right"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">
                          {t("ustva.taxRate")}
                        </label>
                        <select
                          value={exForm.vatRate}
                          onChange={(e) => setExForm({ ...exForm, vatRate: e.target.value })}
                          className="w-full px-2 py-1.5 border rounded text-sm"
                        >
                          <option value="0.19">19%</option>
                          <option value="0.07">7%</option>
                          <option value="0">0%</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">
                          {t("ustva.vat")} (auto)
                        </label>
                        <input
                          readOnly
                          value={exForm.vatAmount}
                          className="w-full px-2 py-1.5 border rounded text-sm bg-gray-100 dark:bg-gray-800 text-right"
                        />
                      </div>
                      <div className="md:col-span-3 flex flex-wrap gap-3">
                        <label className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={exForm.isIntraEU}
                            onChange={(e) =>
                              setExForm({ ...exForm, isIntraEU: e.target.checked })
                            }
                          />
                          igE (innergemeinschaftlicher Erwerb)
                        </label>
                        <label className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={exForm.isReverseCharge}
                            onChange={(e) =>
                              setExForm({ ...exForm, isReverseCharge: e.target.checked })
                            }
                          />
                          Reverse Charge (§13b UStG)
                        </label>
                        <label className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={exForm.creditNote}
                            onChange={(e) =>
                              setExForm({ ...exForm, creditNote: e.target.checked })
                            }
                            data-testid="ustva-expense-credit-note"
                          />
                          {t("ustva.creditNote")}
                        </label>
                      </div>
                    </div>
                    <div className="mt-3 flex justify-end gap-2">
                      <Button variant="outline" size="sm" onClick={closeExpenseForm}>
                        ×
                      </Button>
                      <Button size="sm" onClick={submitExpense} disabled={saving} data-testid="ustva-expense-submit">
                        ✓ {saving ? "…" : t(editingId ? "ustva.saveExpense" : "ustva.saveDraft")}
                      </Button>
                    </div>
                  </div>
                )}

                {expenses.length === 0 ? (
                  <p className="text-sm text-gray-500 dark:text-gray-400 text-center py-6">
                    {t("ustva.noExpenses")}
                  </p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b">
                          <th className="text-left py-2 font-medium">{t("ustva.expenseDate")}</th>
                          <th className="text-left py-2 font-medium">{t("ustva.expenseNumber")}</th>
                          <th className="text-left py-2 font-medium">{t("ustva.supplier")}</th>
                          <th className="text-left py-2 font-medium">{t("ustva.description")}</th>
                          <th className="text-right py-2 font-medium">{t("ustva.net")}</th>
                          <th className="text-right py-2 font-medium">{t("ustva.vat")}</th>
                          <th className="text-right py-2 font-medium">{t("ustva.gross")}</th>
                          <th className="text-center py-2 font-medium">{t("ustva.actions")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {expenses.map((ex) => (
                          <tr key={ex.id} className="border-b hover:bg-gray-50 dark:bg-gray-900">
                            <td className="py-2">{formatDate(ex.invoiceDate)}</td>
                            <td className="py-2">{ex.invoiceNumber || "—"}</td>
                            <td className="py-2">{ex.supplier?.name || "—"}</td>
                            <td className="py-2">
                              {ex.description}
                              {(ex.isIntraEU || ex.isReverseCharge) && (
                                <span className="ml-2 text-xs px-1.5 py-0.5 bg-amber-100 text-amber-800 rounded">
                                  {ex.isIntraEU ? "igE" : "§13b"}
                                </span>
                              )}
                            </td>
                            <td className="py-2 text-right">{formatCurrency(Number(ex.netAmount))}</td>
                            <td className="py-2 text-right">
                              {formatCurrency(Number(ex.vatAmount))} (
                              {(Number(ex.vatRate) * 100).toFixed(0)}%)
                            </td>
                            <td className="py-2 text-right font-medium">
                              {formatCurrency(Number(ex.grossAmount))}
                            </td>
                            <td className="py-2 text-center">
                              {/* Tier 443: a paid expense or an AfA row is corrected
                                  elsewhere — the reason says where. */}
                              {ex.lockReason ? (
                                <span
                                  title={ex.lockReason}
                                  className="text-xs text-gray-500 dark:text-gray-400 cursor-help"
                                  data-testid={`ustva-expense-locked-${ex.id}`}
                                >
                                  🔒 {t("ustva.lockedExpense")}
                                </span>
                              ) : (
                                <span className="inline-flex gap-3">
                                  <button
                                    onClick={() => startEditExpense(ex)}
                                    className="text-blue-600 dark:text-blue-400 hover:underline text-xs"
                                    data-testid={`ustva-expense-edit-${ex.id}`}
                                  >
                                    {t("ustva.editExpense")}
                                  </button>
                                  <button
                                    onClick={() => deleteExpense(ex.id)}
                                    className="text-red-600 dark:text-red-400 hover:underline text-xs"
                                  >
                                    {t("ustva.delete")}
                                  </button>
                                </span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Filing form */}
            <Card className="mb-6">
              <CardHeader>
                <CardTitle>
                  UStVA {data.periodLabel} — {t("ustva.status")}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">
                      {t("ustva.steuernummer")}
                    </label>
                    <input
                      value={taxNumber}
                      onChange={(e) => setTaxNumber(e.target.value)}
                      placeholder={t("ustva.steuernummerPlaceholder")}
                      className="w-full px-3 py-2 border border-gray dark:border-gray-700-300 dark:border-gray-600 rounded-md"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">
                      {t("ustva.notes")}
                    </label>
                    <input
                      value={notes}
                      onChange={(e) => setNotes(e.target.value)}
                      placeholder={t("ustva.notizenPlaceholder")}
                      className="w-full px-3 py-2 border border-gray dark:border-gray-700-300 dark:border-gray-600 rounded-md"
                    />
                  </div>
                </div>
                <div className="mt-4 flex flex-wrap items-center gap-3">
                  <Button variant="outline" onClick={() => saveFiling("draft")} disabled={saving} data-testid="ustva-save-draft">
                    {t("ustva.saveDraft")}
                  </Button>
                  <Button onClick={() => saveFiling("submitted")} disabled={saving} data-testid="ustva-submit">
                    {t("ustva.submit")}
                  </Button>
                  {savedMsg && (
                    <span className="text-sm text-emerald-700 font-medium">✓ {savedMsg}</span>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* Past filings */}
            <Card>
              <CardHeader>
                <CardTitle>{t("ustva.prevFilings")}</CardTitle>
              </CardHeader>
              <CardContent>
                {filings.length === 0 ? (
                  <p className="text-sm text-gray-500 dark:text-gray-400 text-center py-4">—</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b">
                          <th className="text-left py-2 font-medium">{t("ustva.period")}</th>
                          <th className="text-right py-2 font-medium">
                            {t("ustva.umsatzsteuer")}
                          </th>
                          <th className="text-right py-2 font-medium">
                            {t("ustva.vorsteuerTotal")}
                          </th>
                          <th className="text-right py-2 font-medium">
                            {t("ustva.differenzbetrag")}
                          </th>
                          <th className="text-center py-2 font-medium">{t("ustva.status")}</th>
                           <th className="text-left py-2 font-medium">
                            {t("ustva.steuernummer")}
                          </th>
                          <th className="text-right py-2 font-medium">
                            {t("ustva.actions") || "Aktionen"}
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {filings.map((f) => (
                          <tr key={f.id} className="border-b">
                            <td className="py-2 font-medium">{f.periodLabel}</td>
                            <td className="py-2 text-right">
                              {formatCurrency(Number(f.outputVat))}
                            </td>
                            <td className="py-2 text-right">
                              {formatCurrency(Number(f.inputVat))}
                            </td>
                            <td
                              className={`py-2 text-right font-medium ${
                                Number(f.payableVat) > 0
                                  ? "text-red-700 dark:text-red-300"
                                  : Number(f.payableVat) < 0
                                    ? "text-emerald-700"
                                    : ""
                              }`}
                            >
                              {formatCurrency(Number(f.payableVat))}
                            </td>
                            <td className="py-2 text-center">
                              <span
                                className={`text-xs px-2 py-0.5 rounded ${
                                  f.status === "submitted"
                                    ? "bg-blue-100 text-blue-800"
                                    : f.status === "accepted"
                                      ? "bg-emerald-100 text-emerald-800"
                                      : f.status === "rejected"
                                        ? "bg-red-100 text-red-800"
                                        : "bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-200"
                                }`}
                              >
                                {f.status === "draft"
                                  ? t("ustva.statusDraft")
                                  : f.status === "submitted"
                                    ? t("ustva.statusSubmitted")
                                    : f.status === "accepted"
                                      ? t("ustva.statusAccepted")
                                      : t("ustva.statusRejected")}
                              </span>
                              {f.berichtigungNoetig && f.abweichung && (
                                <span
                                  className="ml-2 text-xs px-2 py-0.5 rounded bg-amber-100 text-amber-900 dark:bg-amber-900/30 dark:text-amber-200 cursor-help"
                                  title={t("ustva.berichtigungHint").replace(
                                    "{diff}",
                                    formatCurrency(f.abweichung.payableVat),
                                  )}
                                  data-testid={`ustva-berichtigung-${f.id}`}
                                >
                                  ⚠ {t("ustva.berichtigungNoetig")}
                                </span>
                              )}
                            </td>
                            <td className="py-2 text-gray-600 dark:text-gray-300">{f.taxNumber || "—"}</td>
                            <td className="py-2 text-right">
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => downloadElster(f.id, f.periodLabel)}
                                title={t("ustva.elsterTooltip") || "ELSTER-XML für Mein-ELSTER-Upload herunterladen"}
                              >
                                {t("ustva.downloadElster") || "ELSTER XML"}
                              </Button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
          </>
        )}
        {downloadError && (
          <div className="mt-4 p-3 bg-red-50 border border-red-200 text-red-800 rounded text-sm">
            {downloadError}
          </div>
        )}
      </div>
    </div>
  )
}