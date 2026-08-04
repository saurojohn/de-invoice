"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import LanguageSwitcher from "@/components/LanguageSwitcher"
import { useI18n } from "@/components/useI18n"
import { apiGet, apiPost, apiPut, apiDelete } from "@/lib/api"

type Interval = "monthly" | "quarterly" | "yearly" | "weekly"

interface RecurringItem {
  description: string
  productNumber?: string | null
  quantity: number
  unit?: string | null
  unitPrice: number
  vatRate: number
}

interface RecurringTemplate {
  id: string
  name: string
  customerId: string
  customer: { id: string; name: string; customerNumber?: string | null }
  interval: Interval
  intervalCount: number
  dayOfMonth: number
  startDate: string
  endDate: string | null
  nextRunAt: string
  lastRunAt: string | null
  currency: string
  language: string
  notes: string | null
  invoiceStatus: 'draft' | 'sent'
  isActive: boolean
  // Tier 129: when true, the scheduler emails the
  // generated invoice to the customer via the same
  // path as the manual "Per E-Mail senden" button.
  // Default true. We keep the field in the type
  // even when the backend is older (the field is
  // ignored on save) so older backends don't crash
  // the form.
  sendEmail: boolean
  createdAt: string
  items: (RecurringItem & { id: string; position: number })[]
  _count: { runs: number; invoices: number }
  invoices?: { id: string; invoiceNumber: string; issueDate: string; total: string; status: string }[]
  runs?: { id: string; periodStart: string; periodEnd: string; status: string; trigger: string; createdAt: string; invoiceId: string | null; errorMessage: string | null }[]
}

interface Customer { id: string; name: string; customerNumber?: string | null }

const fmtDate = (s: string | null | undefined, locale = 'de-DE') =>
  s ? new Date(s).toLocaleDateString(locale, { day: "2-digit", month: "2-digit", year: "numeric" }) : "—"

const fmtMoney = (n: number) =>
  n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export default function RecurringInvoicesPage() {
  const router = useRouter()
  const { t, getDateLocale } = useI18n()
  // Read companyId once at component mount so the
  // Tier 147 generated-invoices button (and any
  // other inline event handlers) can use it
  // without re-reading localStorage.
  const companyId =
    typeof window !== "undefined"
      ? localStorage.getItem("companyId") || ""
      : ""
  const [templates, setTemplates] = useState<RecurringTemplate[]>([])
  const [customers, setCustomers] = useState<Customer[]>([])
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  // Tier 136: email preview modal state.
  // Only meaningful for existing templates (we need
  // the saved ID to query the preview endpoint).
  // Pre-save: show a disabled "Save first" hint.
  const [emailPreview, setEmailPreview] = useState<{
    open: boolean
    loading: boolean
    data?: {
      subject: string
      text: string
      recipient: string | null
      recipientMissing: boolean
      sample: {
        invoiceNumber: string
        amount: string
        dueDate: string
        language: 'de' | 'en' | 'zh'
      }
    }
    error?: string
  }>({ open: false, loading: false })
  const [editing, setEditing] = useState<RecurringTemplate | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ subject: string; body: string } | null>(null)
  const [saving, setSaving] = useState(false)
  // Tier 147: generated-invoices modal. The
  // admin clicks "📋 Verlauf" on a template row
  // to see every invoice this template has
  // ever generated. Same modal pattern as the
  // email-preview modal (Tier 136).
  const [generatedFor, setGeneratedFor] = useState<RecurringTemplate | null>(null)
  const [generated, setGenerated] = useState<{
    rows: Array<{
      id: string
      invoiceNumber: string
      type: string
      status: string
      currency: string
      total: number
      issueDate: string
      dueDate: string | null
      customer: { id: string; name: string; customerNumber: string | null }
    }>
    total: number
    summary: { totalAmount: number; byStatus: Record<string, { count: number; total: number }> }
  } | null>(null)
  const [generatedLoading, setGeneratedLoading] = useState(false)
  const [runError, setRunError] = useState<string | null>(null)

  // Form state
  const [name, setName] = useState("")
  const [customerId, setCustomerId] = useState("")
  const [interval, setInterval] = useState<Interval>("monthly")
  const [intervalCount, setIntervalCount] = useState(1)
  const [dayOfMonth, setDayOfMonth] = useState(1)
  const [startDate, setStartDate] = useState(new Date().toISOString().split("T")[0])
  const [endDate, setEndDate] = useState("")
  const [invoiceStatus, setInvoiceStatus] = useState<"draft" | "sent">("draft")
  // Tier 129: when true, the scheduler emails the
  // generated invoice to the customer. Default
  // true — the user opted into recurring generation,
  // they want the customer notified. Uncheck this
  // for "internal review" templates where the
  // billing team wants to look at the generated
  // invoice before it goes out.
  const [sendEmail, setSendEmail] = useState(true)
  const [items, setItems] = useState<RecurringItem[]>([
    { description: "", quantity: 1, unit: "Stück", unitPrice: 0, vatRate: 0.19 },
  ])

  useEffect(() => {
    const companyId = localStorage.getItem("companyId")
    if (!companyId) {
      router.push("/login")
      return
    }
    Promise.all([
      apiGet<RecurringTemplate[]>(`/api/v1/recurring-invoices?companyId=${companyId}`),
      apiGet<{ data: Customer[] }>(`/api/v1/customers?companyId=${companyId}&pageSize=500`),
    ])
      .then(([list, custs]) => {
        setTemplates(list || [])
        setCustomers(custs?.data || [])
      })
      .catch((err) => console.error("Recurring load failed:", err))
      .finally(() => setLoading(false))
  }, [router])

  // Tier 63: detect ?prefill=1 in the URL (set by
  // the invoice detail page's "Wiederkehrend" button)
  // and open the create modal with the prefill payload
  // from sessionStorage. The check runs once on mount;
  // subsequent re-renders don't re-trigger the modal
  // because we clear the search param via history.replace.
  useEffect(() => {
    if (typeof window === "undefined") return
    const params = new URLSearchParams(window.location.search)
    if (params.get("prefill") !== "1") return
    const raw = sessionStorage.getItem("recurring-prefill")
    if (!raw) return
    try {
      const p = JSON.parse(raw)
      setEditing(null)
      setName(p.name || "")
      setCustomerId(p.customerId || "")
      setInterval((p.interval as Interval) || "monthly")
      setIntervalCount(p.intervalCount || 1)
      setDayOfMonth(p.dayOfMonth || 1)
      setStartDate(p.startDate || new Date().toISOString().split("T")[0])
      setEndDate(p.endDate || "")
      setInvoiceStatus(p.invoiceStatus || "draft")
      setItems(p.items || [{ description: "", quantity: 1, unit: "Stück", unitPrice: 0, vatRate: 0.19 }])
      setShowModal(true)
      // Clean up so a refresh on the same page doesn't
      // re-open the modal. sessionStorage is single-tab
      // so this only affects the current tab.
      sessionStorage.removeItem("recurring-prefill")
      // Strip ?prefill=1 from the URL so a back-button
      // nav doesn't re-open.
      params.delete("prefill")
      const newQs = params.toString()
      const newUrl =
        window.location.pathname + (newQs ? "?" + newQs : "")
      window.history.replaceState({}, "", newUrl)
    } catch (e) {
      console.error("Failed to apply recurring prefill:", e)
      sessionStorage.removeItem("recurring-prefill")
    }
  }, [customers])

  const openCreate = () => {
    setEditing(null)
    setName("")
    setCustomerId(customers[0]?.id || "")
    setInterval("monthly")
    setIntervalCount(1)
    setDayOfMonth(1)
    setStartDate(new Date().toISOString().split("T")[0])
    setEndDate("")
    setInvoiceStatus("draft")
    setItems([{ description: "", quantity: 1, unit: "Stück", unitPrice: 0, vatRate: 0.19 }])
    setShowModal(true)
  }

  const openEdit = (tpl: RecurringTemplate) => {
    setEditing(tpl)
    setName(tpl.name)
    setCustomerId(tpl.customerId)
    setInterval(tpl.interval)
    setIntervalCount(tpl.intervalCount)
    setDayOfMonth(tpl.dayOfMonth)
    setStartDate(tpl.startDate.split("T")[0])
    setEndDate(tpl.endDate ? tpl.endDate.split("T")[0] : "")
    setInvoiceStatus(tpl.invoiceStatus)
    // Tier 129: load the sendEmail flag too. Older
    // backend versions don't have this field — we
    // default to true (the safe default = "send the
    // email") so a fresh fetch on an old backend
    // doesn't silently disable notifications.
    setSendEmail(tpl.sendEmail ?? true)
    setItems(tpl.items.map((it) => ({
      description: it.description,
      productNumber: it.productNumber,
      quantity: Number(it.quantity),
      unit: it.unit,
      unitPrice: Number(it.unitPrice),
      vatRate: Number(it.vatRate),
    })))
    setShowModal(true)
  }

  const closeModal = () => {
    setShowModal(false)
    setEditing(null)
  }

  // Tier 136: fetch the email preview for the
  // currently-edited template. We need a saved
  // template ID (the backend reads the saved
  // language + customer + items from the DB), so
  // a new (un-saved) template can't be previewed
  // — we surface a "Save first" hint in the UI.
  const previewEmail = async () => {
    if (!editing?.id) {
      setEmailPreview({
        open: true,
        loading: false,
        error: t("recurring.emailPreviewSaveFirst") || "Bitte zuerst speichern, dann ist eine Vorschau möglich.",
      })
      return
    }
    const companyId = localStorage.getItem("companyId")
    if (!companyId) return
    setEmailPreview({ open: true, loading: true })
    try {
      const data = await apiGet<{
        subject: string
        text: string
        recipient: string | null
        recipientMissing: boolean
        sample: {
          invoiceNumber: string
          amount: string
          dueDate: string
          language: 'de' | 'en' | 'zh'
        }
      }>(
        `/api/v1/recurring-invoices/${editing.id}/preview-email?companyId=${companyId}`,
      )
      setEmailPreview({ open: true, loading: false, data })
    } catch (err) {
      setEmailPreview({
        open: true,
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  const closeEmailPreview = () =>
    setEmailPreview({ open: false, loading: false })

  const addItem = () => {
    setItems([...items, { description: "", quantity: 1, unit: "Stück", unitPrice: 0, vatRate: 0.19 }])
  }

  const removeItem = (i: number) => {
    setItems(items.filter((_, idx) => idx !== i))
  }

  const updateItem = (i: number, patch: Partial<RecurringItem>) => {
    setItems(items.map((it, idx) => (idx === i ? { ...it, ...patch } : it)))
  }

  const save = async () => {
    if (!name.trim() || !customerId) {
      alert(t("recurring.alerts_required") || "Name + Kunde sind erforderlich")
      return
    }
    if (items.length === 0 || items.some((it) => !it.description.trim())) {
      alert(t("recurring.alerts_emptyItem") || "Alle Positionen brauchen eine Beschreibung")
      return
    }
    const companyId = localStorage.getItem("companyId")!
    const userId = localStorage.getItem("userId") || undefined
    setSaving(true)
    try {
      const body = {
        createdById: userId,
        name: name.trim(),
        customerId,
        interval,
        intervalCount: intervalCount || 1,
        dayOfMonth: interval === "monthly" || interval === "quarterly" ? dayOfMonth : 1,
        startDate,
        endDate: endDate || null,
        invoiceStatus,
        // Tier 129: include the sendEmail flag so the
        // scheduler knows whether to auto-email. Old
        // backends ignore the unknown field.
        sendEmail,
        items,
      }
      if (editing) {
        await apiPut(`/api/v1/recurring-invoices/${editing.id}?companyId=${companyId}`, body)
      } else {
        await apiPost(`/api/v1/recurring-invoices?companyId=${companyId}`, body)
      }
      // Reload
      const list = await apiGet<RecurringTemplate[]>(`/api/v1/recurring-invoices?companyId=${companyId}`)
      setTemplates(list || [])
      closeModal()
    } catch (e: any) {
      alert(e?.message || "Fehler beim Speichern")
    } finally {
      setSaving(false)
    }
  }

  const toggleActive = async (tpl: RecurringTemplate) => {
    const companyId = localStorage.getItem("companyId")!
    try {
      await apiPut(`/api/v1/recurring-invoices/${tpl.id}?companyId=${companyId}`, { isActive: !tpl.isActive })
      const list = await apiGet<RecurringTemplate[]>(`/api/v1/recurring-invoices?companyId=${companyId}`)
      setTemplates(list || [])
    } catch (e: any) {
      alert(e?.message || "Fehler")
    }
  }

  const deleteTpl = async (tpl: RecurringTemplate) => {
    if (!confirm(`${t("recurring.confirmDelete") || "Löschen"} "${tpl.name}"? Vorhandene Rechnungen bleiben erhalten.`)) return
    const companyId = localStorage.getItem("companyId")!
    try {
      await apiDelete(`/api/v1/recurring-invoices/${tpl.id}?companyId=${companyId}`)
      const list = await apiGet<RecurringTemplate[]>(`/api/v1/recurring-invoices?companyId=${companyId}`)
      setTemplates(list || [])
    } catch (e: any) {
      alert(e?.message || "Fehler")
    }
  }

  const runNow = async (tpl: RecurringTemplate) => {
    const companyId = localStorage.getItem("companyId")!
    setRunError(null)
    try {
      const r = await apiPost<{ invoiceId: string; runId: string; periodStart: string }>(
        `/api/v1/recurring-invoices/${tpl.id}/run?companyId=${companyId}`
      )
      // Reload to pick up new invoice + advanced nextRunAt
      const list = await apiGet<RecurringTemplate[]>(`/api/v1/recurring-invoices?companyId=${companyId}`)
      setTemplates(list || [])
      // Open the generated invoice in a new tab so the
      // user can review before sending.
      window.open(`/dashboard/invoices/${r.invoiceId}`, "_blank")
    } catch (e: any) {
      setRunError(e?.message || "Fehler")
    }
  }

  const expandTpl = async (tpl: RecurringTemplate) => {
    if (expanded === tpl.id) {
      setExpanded(null)
      return
    }
    const companyId = localStorage.getItem("companyId")!
    try {
      const fresh = await apiGet<RecurringTemplate>(`/api/v1/recurring-invoices/${tpl.id}?companyId=${companyId}`)
      setTemplates((prev) => prev.map((t) => (t.id === tpl.id ? fresh : t)))
      setExpanded(tpl.id)
    } catch (e) {
      console.error("expand failed:", e)
    }
  }

  const intervalLabel = (i: Interval, n: number) => {
    if (n === 1) {
      if (i === "monthly") return t("recurring.interval_monthly") || "Monatlich"
      if (i === "quarterly") return t("recurring.interval_quarterly") || "Quartalsweise"
      if (i === "yearly") return t("recurring.interval_yearly") || "Jährlich"
      return t("recurring.interval_weekly") || "Wöchentlich"
    }
    return `Alle ${n} ${i === "monthly" ? "Monate" : i === "quarterly" ? "Quartale" : i === "yearly" ? "Jahre" : "Wochen"}`
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      {/* Tier 125: responsive padding — same pattern as
          the other list pages in Tier 121. */}
      <div className="container mx-auto px-3 sm:px-4 py-4 sm:py-8">
        <div className="flex flex-wrap justify-between items-center gap-2 mb-6">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold text-gray-900 dark:text-gray-100">
              {t("recurring.title") || "Wiederkehrende Rechnungen"}
            </h1>
            <p className="text-gray-500 dark:text-gray-400 mt-1">
              {t("recurring.subtitle") || "Abo-Rechnungen monatlich, quartalsweise oder jährlich automatisch generieren"}
            </p>
          </div>
          <div className="flex gap-2 items-center">
            <LanguageSwitcher />
            <Button variant="outline" onClick={() => router.push("/dashboard")}>
              {t("common.back") || "Zurück"}
            </Button>
            <Button onClick={openCreate} data-testid="recurring-new-button">
              {t("recurring.new") || "Neue Vorlage"}
            </Button>
          </div>
        </div>

        {runError && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-800 rounded text-sm">
            {runError}
          </div>
        )}

        {loading ? (
          <div className="text-center py-12 text-gray-500 dark:text-gray-400">{t("common.loading") || "Lädt..."}</div>
        ) : templates.length === 0 ? (
          <Card>
            <CardContent className="pt-6 text-center text-gray-500 dark:text-gray-400 py-12">
              {t("recurring.empty") || "Noch keine wiederkehrenden Rechnungen. Klicken Sie auf 'Neue Vorlage'."}
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {templates.map((tpl) => (
              <Card key={tpl.id} className={tpl.isActive ? "" : "opacity-60"} data-testid="recurring-card" data-recurring-name={tpl.name}>
                <CardContent className="pt-6">
                  <div className="flex flex-wrap items-center gap-4">
                    {/* Status dot */}
                    <div className={`w-2 h-2 rounded-full ${tpl.isActive ? "bg-emerald-500" : "bg-gray-400"}`} />

                    {/* Name + customer */}
                    <div className="flex-1 min-w-[200px]">
                      <div className="font-medium text-lg">{tpl.name}</div>
                      <div className="text-sm text-gray-600 dark:text-gray-300">
                        {tpl.customer.name}
                        {tpl.customer.customerNumber && (
                          <span className="font-mono text-xs ml-2">{tpl.customer.customerNumber}</span>
                        )}
                      </div>
                    </div>

                    {/* Cadence */}
                    <div className="text-sm">
                      <span className="text-gray-500 dark:text-gray-400">{t("recurring.interval") || "Intervall"}: </span>
                      <span className="font-medium">{intervalLabel(tpl.interval, tpl.intervalCount)}</span>
                    </div>

                    {/* Next run */}
                    <div className="text-sm">
                      <span className="text-gray-500 dark:text-gray-400">{t("recurring.nextRun") || "Nächste"}: </span>
                      <span className="font-mono">{fmtDate(tpl.nextRunAt, getDateLocale())}</span>
                    </div>

                    {/* Last run */}
                    <div className="text-sm text-gray-500 dark:text-gray-400">
                      {t("recurring.lastRun") || "Zuletzt"}: {fmtDate(tpl.lastRunAt, getDateLocale())}
                    </div>

                    {/* Counts */}
                    <div className="text-xs text-gray-500 dark:text-gray-400">
                      {tpl._count?.runs ?? 0} runs / {tpl._count?.invoices ?? 0} inv.
                    </div>

                    {/* Actions — Tier 136: flex-wrap so the
                        5 buttons (▸/▾, Generieren, Pause,
                        Bearbeiten, 🗑) wrap to a 2nd row on
                        375px instead of overflowing the card
                        right edge. The ml-auto keeps them
                        right-aligned when the row fits. */}
                    <div className="flex flex-wrap gap-1 ml-auto">
                      <Button size="sm" variant="outline" onClick={() => expandTpl(tpl)}>
                        {expanded === tpl.id ? "▾" : "▸"}
                      </Button>
                      <Button size="sm" onClick={() => runNow(tpl)} disabled={!tpl.isActive} data-testid="recurring-run-now">
                        {t("recurring.runNow") || "Generieren"}
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => toggleActive(tpl)} data-testid="recurring-toggle-active">
                        {tpl.isActive ? (t("common.pause") || "Pause") : (t("common.resume") || "Fortsetzen")}
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => openEdit(tpl)} data-testid="recurring-edit">
                        {t("common.edit") || "Bearbeiten"}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setGeneratedFor(tpl)
                          setGenerated(null)
                          setGeneratedLoading(true)
                          apiGet<any>(
                            `/api/v1/recurring-invoices/${tpl.id}/generated-invoices?companyId=${companyId}&take=200`,
                          )
                            .then((d) => setGenerated(d))
                            .catch((err) => console.error("generated-invoices load failed:", err))
                            .finally(() => setGeneratedLoading(false))
                        }}
                        data-testid="recurring-generated-invoices"
                        title={t("recurring.generatedTitle") || "Generierte Rechnungen dieser Vorlage anzeigen"}
                      >
                        📋 {t("recurring.generatedBtn") || "Verlauf"}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => deleteTpl(tpl)} data-testid="recurring-delete">
                        🗑
                      </Button>
                    </div>
                  </div>

                  {/* Expanded details */}
                  {expanded === tpl.id && (
                    <div className="mt-4 pt-4 border-t grid md:grid-cols-2 gap-4">
                      <div>
                        <h4 className="font-medium text-sm mb-2">{t("recurring.items") || "Positionen"}</h4>
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="text-left text-gray-500 dark:text-gray-400 text-xs">
                              <th>Beschreibung</th>
                              <th className="text-right">Menge</th>
                              <th className="text-right">Preis</th>
                              <th className="text-right">MwSt</th>
                            </tr>
                          </thead>
                          <tbody>
                            {tpl.items.map((it) => (
                              <tr key={it.id} className="border-b">
                                <td>{it.description}</td>
                                <td className="text-right font-mono">{Number(it.quantity)} {it.unit}</td>
                                <td className="text-right font-mono">€ {fmtMoney(Number(it.unitPrice))}</td>
                                <td className="text-right font-mono">{(Number(it.vatRate) * 100).toFixed(0)}%</td>
                              </tr>
                            ))}
                          </tbody>
                          <tfoot>
                            <tr>
                              <td colSpan={3} className="text-right font-medium pt-2">
                                {t("recurring.total") || "Summe"} (netto):
                              </td>
                              <td className="text-right font-mono font-medium pt-2">
                                € {fmtMoney(tpl.items.reduce((s, it) => s + Number(it.unitPrice) * Number(it.quantity), 0))}
                              </td>
                            </tr>
                          </tfoot>
                        </table>
                      </div>

                      <div>
                        <h4 className="font-medium text-sm mb-2">
                          {t("recurring.runHistory") || "Generierungschronik"}
                          {tpl.invoices && tpl.invoices.length > 0 && (
                            <span className="ml-2 text-xs text-gray-500 dark:text-gray-400">
                              ({tpl.invoices.length} {t("recurring.recentInvoices") || "letzte Rechnungen"})
                            </span>
                          )}
                        </h4>
                        {tpl.runs && tpl.runs.length > 0 ? (
                          <div className="space-y-1 text-sm max-h-60 overflow-y-auto">
                            {tpl.runs.map((r) => (
                              <div
                                key={r.id}
                                data-testid="recurring-run-row"
                                data-run-status={r.status}
                                className={`flex items-center justify-between p-2 rounded ${
                                  r.status === "success" ? "bg-emerald-50 dark:bg-emerald-950/30"
                                  : r.status === "failed" ? "bg-red-50 dark:bg-red-950/30"
                                  : "bg-gray-50 dark:bg-gray-900"
                                }`}
                              >
                                <div className="flex-1 min-w-0">
                                  <span className="font-mono text-xs">
                                    {fmtDate(r.periodStart, getDateLocale())} → {fmtDate(r.periodEnd, getDateLocale())}
                                  </span>
                                  <span className="ml-2 text-xs px-1.5 py-0.5 rounded bg-white dark:bg-gray-800 border">
                                    {r.trigger}
                                  </span>
                                  {/* Tier 63: surface the failure
                                      reason inline. Previously the
                                      `errorMessage` field was set by
                                      the service but never rendered
                                      — the user had to query the DB
                                      to see WHY a run failed. Now we
                                      show it on the row, prefixed by
                                      the localised "Fehler:" label. */}
                                  {r.status === "failed" && r.errorMessage && (
                                    <div
                                      className="mt-1 text-xs text-red-700 dark:text-red-300 break-words"
                                      data-testid="recurring-run-error"
                                      title={r.errorMessage}
                                    >
                                      <span className="font-semibold">
                                        {t("recurring.runError") || "Fehler"}:
                                      </span>{" "}
                                      {r.errorMessage}
                                    </div>
                                  )}
                                </div>
                                <div className="flex items-center gap-2 ml-2">
                                  <span
                                    className={`text-xs px-1.5 py-0.5 rounded font-medium ${
                                      r.status === "success" ? "bg-emerald-200 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200"
                                      : r.status === "failed" ? "bg-red-200 text-red-800 dark:bg-red-900 dark:text-red-200"
                                      : r.status === "skipped" ? "bg-amber-200 text-amber-800 dark:bg-amber-900 dark:text-amber-200"
                                      : "bg-gray-200 text-gray-700 dark:bg-gray-700 dark:text-gray-200"
                                    }`}
                                    data-testid="recurring-run-status-badge"
                                  >
                                    {r.status === "success" ? (t("recurring.runStatusSuccess") || "OK")
                                      : r.status === "failed" ? (t("recurring.runStatusFailed") || "Fehler")
                                      : r.status === "skipped" ? (t("recurring.runStatusSkipped") || "Übersprungen")
                                      : r.status}
                                  </span>
                                  {r.invoiceId && (
                                    <Link
                                      href={`/dashboard/invoices/${r.invoiceId}`}
                                      className="text-blue-600 dark:text-blue-400 hover:underline text-xs"
                                    >
                                      →
                                    </Link>
                                  )}
                                </div>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div className="text-sm text-gray-500 dark:text-gray-400">
                            {t("recurring.noRuns") || "Noch keine Generierungen."}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Create / Edit modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <Card className="w-full max-w-3xl max-h-[90vh] overflow-y-auto">
            <CardHeader>
              <CardTitle>
                {editing ? (t("recurring.edit") || "Vorlage bearbeiten") : (t("recurring.new") || "Neue Vorlage")}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium mb-1">
                      {t("recurring.name") || "Name"} *
                    </label>
                    <input
                      type="text"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="z.B. Wartungsvertrag 2026"
                      className="w-full border rounded px-3 py-2 text-sm"
                      data-testid="recurring-form-name"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1">
                      {t("recurring.customer") || "Kunde"} *
                    </label>
                    <select
                      value={customerId}
                      onChange={(e) => setCustomerId(e.target.value)}
                      className="w-full border rounded px-3 py-2 text-sm"
                      data-testid="recurring-form-customer"
                    >
                      <option value="">—</option>
                      {customers.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name} {c.customerNumber ? `(${c.customerNumber})` : ""}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                  <div>
                    <label className="block text-sm font-medium mb-1">
                      {t("recurring.interval") || "Intervall"} *
                    </label>
                    <select
                      value={interval}
                      onChange={(e) => setInterval(e.target.value as Interval)}
                      className="w-full border rounded px-3 py-2 text-sm"
                      data-testid="recurring-form-interval"
                    >
                      <option value="monthly">{t("recurring.interval_monthly") || "Monatlich"}</option>
                      <option value="quarterly">{t("recurring.interval_quarterly") || "Quartalsweise"}</option>
                      <option value="yearly">{t("recurring.interval_yearly") || "Jährlich"}</option>
                      <option value="weekly">{t("recurring.interval_weekly") || "Wöchentlich"}</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1">
                      {t("recurring.intervalCount") || "Alle X"}
                    </label>
                    <input
                      type="number"
                      min="1"
                      max="120"
                      value={intervalCount}
                      onChange={(e) => setIntervalCount(parseInt(e.target.value, 10) || 1)}
                      className="w-full border rounded px-3 py-2 text-sm"
                      data-testid="recurring-form-interval-count"
                    />
                  </div>
                  {(interval === "monthly" || interval === "quarterly") && (
                    <div>
                      <label className="block text-sm font-medium mb-1">
                        {t("recurring.dayOfMonth") || "Tag (1-28)"}
                      </label>
<input
                      type="number"
                      min="1"
                      max="28"
                      value={dayOfMonth}
                      onChange={(e) => setDayOfMonth(parseInt(e.target.value, 10) || 1)}
                      className="w-full border rounded px-3 py-2 text-sm"
                      data-testid="recurring-form-day-of-month"
                    />
                    </div>
                  )}
                  <div>
                    <label className="block text-sm font-medium mb-1">
                      {t("recurring.invoiceStatus") || "Rechnungs-Status"}
                    </label>
                    <select
                      value={invoiceStatus}
                      onChange={(e) => setInvoiceStatus(e.target.value as "draft" | "sent")}
                      className="w-full border rounded px-3 py-2 text-sm"
                    >
                      <option value="draft">{t("recurring.status_draft") || "Entwurf"}</option>
                      <option value="sent">{t("recurring.status_sent") || "Versendet"}</option>
                    </select>
                  </div>
                  {/* Tier 129: sendEmail checkbox. When
                      checked, the scheduler emails the
                      generated invoice to the customer
                      after each successful run. Same path
                      as the manual "Per E-Mail senden"
                      button on the invoice detail page. */}
                  <div className="flex items-center pt-6">
                    <input
                      type="checkbox"
                      id="recurring-send-email"
                      checked={sendEmail}
                      onChange={(e) => setSendEmail(e.target.checked)}
                      className="mr-2"
                      data-testid="recurring-form-send-email"
                    />
                    <label
                      htmlFor="recurring-send-email"
                      className="text-sm font-medium cursor-pointer"
                    >
                      {t("recurring.sendEmail") || "Rechnung nach Generierung an Kunden senden"}
                    </label>
                    {/* Tier 136: Email-Vorschau button. Sits
                        next to the sendEmail label so the
                        operator can see exactly what the
                        customer will receive before
                        flipping sendEmail=true. Disabled
                        with a hint when the template
                        hasn't been saved yet (we need the
                        ID to query the backend). */}
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={previewEmail}
                      className="ml-3"
                      data-testid="recurring-form-preview-email"
                      title={
                        editing?.id
                          ? (t("recurring.emailPreview") || "Email-Vorschau anzeigen")
                          : (t("recurring.emailPreviewSaveFirstHint") || "Erst speichern, dann ist eine Vorschau möglich")
                      }
                    >
                      📧 {t("recurring.emailPreview") || "Email-Vorschau"}
                    </Button>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium mb-1">
                      {t("recurring.startDate") || "Start"} *
                    </label>
                    <input
                      type="date"
                      value={startDate}
                      onChange={(e) => setStartDate(e.target.value)}
                      className="w-full border rounded px-3 py-2 text-sm"
                      data-testid="recurring-form-start-date"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1">
                      {t("recurring.endDate") || "Ende (optional)"}
                    </label>
                    <input
                      type="date"
                      value={endDate}
                      onChange={(e) => setEndDate(e.target.value)}
                      className="w-full border rounded px-3 py-2 text-sm"
                      data-testid="recurring-form-end-date"
                    />
                  </div>
                </div>

                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="block text-sm font-medium">
                      {t("recurring.items") || "Positionen"} *
                    </label>
                    <Button size="sm" variant="outline" onClick={addItem} data-testid="recurring-form-add-item">
                      + {t("recurring.addItem") || "Position"}
                    </Button>
                  </div>
                  <div className="space-y-2">
                    {items.map((it, i) => (
                      <div key={i} className="grid grid-cols-12 gap-2 items-center">
                        <input
                          type="text"
                          value={it.description}
                          onChange={(e) => updateItem(i, { description: e.target.value })}
                          placeholder="Beschreibung"
                          className="col-span-5 border rounded px-2 py-1 text-sm"
                          data-testid="recurring-item-description"
                        />
                        <input
                          type="number"
                          step="0.01"
                          value={it.quantity}
                          onChange={(e) => updateItem(i, { quantity: parseFloat(e.target.value) || 0 })}
                          placeholder="Menge"
                          className="col-span-1 border rounded px-2 py-1 text-sm"
                        />
                        <input
                          type="text"
                          value={it.unit || ""}
                          onChange={(e) => updateItem(i, { unit: e.target.value })}
                          placeholder="Einheit"
                          className="col-span-1 border rounded px-2 py-1 text-sm"
                        />
                        <input
                          type="number"
                          step="0.01"
                          value={it.unitPrice}
                          onChange={(e) => updateItem(i, { unitPrice: parseFloat(e.target.value) || 0 })}
                          placeholder="Preis"
                          className="col-span-2 border rounded px-2 py-1 text-sm"
                          data-testid="recurring-item-unit-price"
                        />
                        <select
                          value={it.vatRate}
                          onChange={(e) => updateItem(i, { vatRate: parseFloat(e.target.value) })}
                          className="col-span-2 border rounded px-2 py-1 text-sm"
                        >
                          <option value="0.19">19%</option>
                          <option value="0.07">7%</option>
                          <option value="0">0%</option>
                        </select>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => removeItem(i)}
                          disabled={items.length === 1}
                          className="col-span-1"
                        >
                          ✕
                        </Button>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="flex gap-2 pt-4 border-t">
                  <Button onClick={save} disabled={saving} data-testid="recurring-form-save">
                    {saving ? (t("common.saving") || "Speichert...") : (t("common.save") || "Speichern")}
                  </Button>
                  <Button variant="outline" onClick={closeModal}>
                    {t("common.cancel") || "Abbrechen"}
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Tier 136: Email-Vorschau modal. Shows the
          rendered subject + body (with sample invoice
          number, amounts, due date) the customer
          would receive if the template ran right now.
          Three states: loading (spinner), error
          (red banner), data (subject + recipient +
          body). The body uses whitespace-pre-wrap so
          newlines in the email render as line breaks. */}
      {emailPreview.open && (
        <div
          className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4"
          onClick={closeEmailPreview}
          data-testid="recurring-email-preview-modal"
        >
          <div
            className="bg-white dark:bg-gray-800 rounded-lg shadow-xl p-6 w-full max-w-2xl max-h-[90vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-semibold mb-1">
              📧 {t("recurring.emailPreviewTitle") || "Email-Vorschau"}
            </h2>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
              {t("recurring.emailPreviewDesc") ||
                "So sieht die automatische Email aus. Werte sind Beispieldaten (Rechnungsnummer, Fälligkeit)."}
            </p>

            {emailPreview.loading && (
              <div
                className="py-8 flex flex-col items-center"
                data-testid="recurring-email-preview-loading"
              >
                <div className="animate-spin rounded-full h-10 w-10 border-4 border-blue-200 border-t-blue-600 mb-3" />
                <p className="text-sm text-gray-700 dark:text-gray-300">
                  {t("common.loading") || "Wird geladen…"}
                </p>
              </div>
            )}

            {emailPreview.error && (
              <div
                className="mb-3 p-3 bg-amber-50 border border-amber-200 text-amber-900 rounded text-sm"
                data-testid="recurring-email-preview-error"
              >
                {emailPreview.error}
              </div>
            )}

            {emailPreview.data && (
              <div
                className="flex-1 overflow-y-auto"
                data-testid="recurring-email-preview-data"
              >
                {emailPreview.data.recipientMissing && (
                  <div className="mb-3 p-3 bg-red-50 border border-red-200 text-red-800 rounded text-sm">
                    ⚠{" "}
                    {t("recurring.emailPreviewNoRecipient") ||
                      "Kein Empfänger: Der Kunde hat keine E-Mail-Adresse hinterlegt."}
                  </div>
                )}
                <div className="mb-3">
                  <div className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase">
                    {t("recurring.emailPreviewRecipient") || "Empfänger"}
                  </div>
                  <div
                    className="text-sm font-mono"
                    data-testid="recurring-email-preview-recipient"
                  >
                    {emailPreview.data.recipient || "—"}
                  </div>
                </div>
                <div className="mb-3">
                  <div className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase">
                    {t("recurring.emailPreviewSubject") || "Betreff"}
                  </div>
                  <div
                    className="text-sm font-medium"
                    data-testid="recurring-email-preview-subject"
                  >
                    {emailPreview.data.subject}
                  </div>
                </div>
                <div className="mb-3">
                  <div className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase">
                    {t("recurring.emailPreviewBody") || "Text"}
                  </div>
                  <pre
                    className="text-sm bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded p-3 whitespace-pre-wrap font-sans"
                    data-testid="recurring-email-preview-body"
                  >
                    {emailPreview.data.text}
                  </pre>
                </div>
                <div className="text-xs text-gray-500 dark:text-gray-400">
                  <span className="font-semibold">
                    {t("recurring.emailPreviewSample") || "Beispieldaten"}:
                  </span>{" "}
                  {emailPreview.data.sample.invoiceNumber} ·{" "}
                  {emailPreview.data.sample.amount} ·{" "}
                  {t("recurring.emailPreviewDue") || "Fällig"}{" "}
                  {emailPreview.data.sample.dueDate}
                </div>
              </div>
            )}

            <div className="flex justify-end mt-4">
              <Button
                onClick={closeEmailPreview}
                data-testid="recurring-email-preview-close"
              >
                {t("common.close") || "Schließen"}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Tier 147: generated-invoices modal. Shows
          every invoice this template has ever
          generated, sorted newest-first. The
          header summary tile (totalAmount +
          byStatus breakdown) gives the admin a
          quick "what's the lifetime of this
          template?" view. Click a row to open
          the invoice detail page in a new tab. */}
      {generatedFor && (
        <div
          className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50"
          data-testid="recurring-generated-modal"
          onClick={() => {
            setGeneratedFor(null)
            setGenerated(null)
          }}
        >
          <div
            className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-3xl w-full max-h-[85vh] overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-6 py-4 border-b flex items-center justify-between">
              <h3 className="font-semibold text-lg">
                📋 {t("recurring.generatedTitle") || "Generierte Rechnungen"} ·{" "}
                <span className="text-sm font-normal text-gray-500">
                  {generatedFor.name}
                </span>
              </h3>
              <button
                className="text-gray-400 hover:text-gray-600 text-xl"
                onClick={() => {
                  setGeneratedFor(null)
                  setGenerated(null)
                }}
                data-testid="recurring-generated-close"
                aria-label="Schließen"
              >
                ✕
              </button>
            </div>
            <div className="px-6 py-4 overflow-y-auto flex-1 text-sm">
              {generatedLoading && (
                <p className="text-gray-500">
                  {t("common.loading") || "Lädt..."}
                </p>
              )}
              {generated && generated.summary && (
                <div
                  className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-4"
                  data-testid="recurring-generated-summary"
                >
                  <div className="bg-blue-50 dark:bg-blue-900/20 rounded px-3 py-2">
                    <div className="text-xs text-gray-500">
                      {t("recurring.generatedCount") || "Anzahl"}
                    </div>
                    <div className="text-lg font-semibold">{generated.total}</div>
                  </div>
                  <div className="bg-emerald-50 dark:bg-emerald-900/20 rounded px-3 py-2">
                    <div className="text-xs text-gray-500">
                      {t("recurring.generatedTotal") || "Gesamt"}
                    </div>
                    <div className="text-lg font-semibold">
                      {generated.summary.totalAmount.toLocaleString("de-DE", {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}{" "}
                      €
                    </div>
                  </div>
                  {Object.entries(generated.summary.byStatus).map(([status, agg]) => (
                    <div
                      key={status}
                      className="bg-gray-50 dark:bg-gray-700/30 rounded px-3 py-2"
                    >
                      <div className="text-xs text-gray-500">{status}</div>
                      <div className="text-sm font-semibold">
                        {agg.count} ·{" "}
                        {agg.total.toLocaleString("de-DE", {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })}{" "}
                        €
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {generated && generated.rows.length === 0 && (
                <p
                  className="text-center text-gray-500 py-8"
                  data-testid="recurring-generated-empty"
                >
                  {t("recurring.generatedEmpty") ||
                    "Diese Vorlage hat noch keine Rechnungen generiert."}
                </p>
              )}
              {generated && generated.rows.length > 0 && (
                <div className="overflow-x-auto">
                  <table
                    className="w-full min-w-[640px] text-xs"
                    data-testid="recurring-generated-table"
                  >
                    <thead>
                      <tr className="border-b border-gray-200 dark:border-gray-700">
                        <th className="text-left py-1 px-1">
                          {t("recurring.generatedColDate") || "Datum"}
                        </th>
                        <th className="text-left py-1 px-1">
                          {t("recurring.generatedColInvoice") || "Rechnung"}
                        </th>
                        <th className="text-left py-1 px-1">
                          {t("recurring.generatedColCustomer") || "Kunde"}
                        </th>
                        <th className="text-right py-1 px-1">
                          {t("recurring.generatedColTotal") || "Betrag"}
                        </th>
                        <th className="text-left py-1 px-1">
                          {t("recurring.generatedColStatus") || "Status"}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {generated.rows.map((r) => (
                        <tr
                          key={r.id}
                          className="border-b border-gray-100 dark:border-gray-800"
                          data-testid="recurring-generated-row"
                        >
                          <td className="py-1 px-1 whitespace-nowrap">
                            {new Date(r.issueDate).toLocaleDateString("de-DE", {
                              day: "2-digit",
                              month: "2-digit",
                              year: "numeric",
                            })}
                          </td>
                          <td className="py-1 px-1">
                            <a
                              href={`/dashboard/invoices/${r.id}`}
                              target="_blank"
                              rel="noreferrer"
                              className="text-blue-600 hover:underline font-mono"
                              data-testid="recurring-generated-invoice-link"
                            >
                              {r.invoiceNumber}
                            </a>
                          </td>
                          <td className="py-1 px-1">
                            <a
                              href={`/dashboard/customers/${r.customer.id}`}
                              target="_blank"
                              rel="noreferrer"
                              className="text-blue-600 hover:underline"
                            >
                              {r.customer.name}
                            </a>
                          </td>
                          <td className="text-right py-1 px-1 font-mono">
                            {r.total.toLocaleString("de-DE", {
                              minimumFractionDigits: 2,
                              maximumFractionDigits: 2,
                            })}{" "}
                            €
                          </td>
                          <td className="py-1 px-1">
                            <span
                              className={
                                "text-xs px-1.5 py-0.5 rounded-full " +
                                (r.status === "paid"
                                  ? "bg-green-100 text-green-800"
                                  : r.status === "overdue"
                                    ? "bg-red-100 text-red-800"
                                    : "bg-gray-100 text-gray-700")
                              }
                            >
                              {r.status}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
            <div className="px-6 py-4 border-t flex justify-end">
              <Button
                onClick={() => {
                  setGeneratedFor(null)
                  setGenerated(null)
                }}
                data-testid="recurring-generated-done"
              >
                {t("common.close") || "Schließen"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
