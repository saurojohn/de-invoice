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
  const [templates, setTemplates] = useState<RecurringTemplate[]>([])
  const [customers, setCustomers] = useState<Customer[]>([])
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [editing, setEditing] = useState<RecurringTemplate | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ subject: string; body: string } | null>(null)
  const [saving, setSaving] = useState(false)
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
      <div className="container mx-auto px-4 py-8">
        <div className="flex justify-between items-center mb-6">
          <div>
            <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100">
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
            <Button onClick={openCreate}>
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
              <Card key={tpl.id} className={tpl.isActive ? "" : "opacity-60"}>
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

                    {/* Actions */}
                    <div className="flex gap-1 ml-auto">
                      <Button size="sm" variant="outline" onClick={() => expandTpl(tpl)}>
                        {expanded === tpl.id ? "▾" : "▸"}
                      </Button>
                      <Button size="sm" onClick={() => runNow(tpl)} disabled={!tpl.isActive}>
                        {t("recurring.runNow") || "Generieren"}
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => toggleActive(tpl)}>
                        {tpl.isActive ? (t("common.pause") || "Pause") : (t("common.resume") || "Fortsetzen")}
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => openEdit(tpl)}>
                        {t("common.edit") || "Bearbeiten"}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => deleteTpl(tpl)}>
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
                                className={`flex items-center justify-between p-2 rounded ${
                                  r.status === "success" ? "bg-emerald-50"
                                  : r.status === "failed" ? "bg-red-50"
                                  : "bg-gray-50 dark:bg-gray-900"
                                }`}
                              >
                                <div>
                                  <span className="font-mono text-xs">
                                    {fmtDate(r.periodStart, getDateLocale())} → {fmtDate(r.periodEnd, getDateLocale())}
                                  </span>
                                  <span className="ml-2 text-xs px-1.5 py-0.5 rounded bg-white dark:bg-gray-800 border">
                                    {r.trigger}
                                  </span>
                                </div>
                                <div className="flex items-center gap-2">
                                  <span className={`text-xs ${
                                    r.status === "success" ? "text-emerald-700"
                                    : r.status === "failed" ? "text-red-700 dark:text-red-300" : "text-gray-700 dark:text-gray-200"
                                  }`}>
                                    {r.status}
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
                    />
                  </div>
                </div>

                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="block text-sm font-medium">
                      {t("recurring.items") || "Positionen"} *
                    </label>
                    <Button size="sm" variant="outline" onClick={addItem}>
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
                  <Button onClick={save} disabled={saving}>
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
    </div>
  )
}
