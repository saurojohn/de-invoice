"use client"

// Tier 112: SEPA pain.008 (Lastschrift / Direct Debit) batch creation.
//
// The Berater opens this page, manages the customer-side
// SEPA-Lastschriftmandate (CORE / B2B), selects the open
// Ausgangsrechnungen (with an active mandate) to collect, picks
// an execution date (5+ banking days after the due date), and
// clicks "Lastschrift-Batch erzeugen". The backend bundles them
// into a pain.008.001.02 XML the user downloads + uploads to the
// house bank's online banking portal.
//
// Three cards, stacked vertically:
//   1. SEPA-Lastschriftmandate — table of existing mandates with
//      inline "Neues Mandat" form + revoke button
//   2. Offene Rechnungen für Lastschrift — checkbox list + sticky
//      "Lastschrift-Batch erzeugen" CTA. Selecting 0 disables CTA.
//   3. Letzte Lastschrift-Batches — list of generated batches with
//      per-row "XML herunterladen" button.
//
// Empty states:
//   - No mandates yet → green hint
//   - No open invoices with mandate → green hint
//   - No past batches → neutral hint
//
// Sub-navigation tabs at the top mirror the SEPA-pain.* split:
// Ausgehende Zahlungen (pain.001) sits next to Eingehende
// Lastschriften (pain.008). Both pages share the same
// /dashboard/payments/* subtree.

import { useEffect, useState, useCallback, useMemo, useRef } from "react"
import { useRouter, usePathname } from "next/navigation"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import LanguageSwitcher from "@/components/LanguageSwitcher"
import { ThemeToggle } from "@/components/ThemeToggle"
import { useI18n } from "@/components/useI18n"
import { useToast } from "@/components/useToast"
import { apiGet, apiPost, apiDelete, ApiError } from "@/lib/api"

// ---- shared formatting helpers (intentionally duplicated from
// /payments — keeping the two pages self-contained so future
// changes to one don't accidentally ripple into the other) ----

function fmtMoney(n: number | string) {
  const v = typeof n === "string" ? Number(n) : n
  return new Intl.NumberFormat("de-DE", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(v || 0)
}

function fmtDateDE(d: string | null) {
  if (!d) return "—"
  const dt = new Date(d)
  return `${String(dt.getDate()).padStart(2, "0")}.${String(dt.getMonth() + 1).padStart(2, "0")}.${dt.getFullYear()}`
}

function todayISO() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

function plusDaysISO(days: number) {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

function ibanMasked(iban: string) {
  if (!iban) return "—"
  if (iban.length <= 10) return iban
  return iban.slice(0, 6) + "…" + iban.slice(-4)
}

function typeBadgeColor(type: string) {
  if (type === "CORE") return "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200"
  if (type === "B2B") return "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200"
  return "bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-200"
}

function batchStatusColor(s: string) {
  if (s === "generated") return "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200"
  if (s === "submitted") return "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200"
  if (s === "confirmed") return "bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200"
  if (s === "failed") return "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200"
  return "bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-200"
}

// ---- types ----

interface CustomerMini {
  id: string
  name: string
  customerNumber?: string | null
}

interface Mandate {
  id: string
  customerId: string
  customer: { id: string; name: string; customerNumber?: string | null }
  mandateReference: string
  dateOfSignature: string
  type: "CORE" | "B2B"
  iban: string
  bic: string | null
  debitorName: string
  description: string | null
  status: "active" | "revoked"
  _count?: { collections: number }
}

interface OpenInvoice {
  id: string
  invoiceNumber: string
  customerId: string
  customerName: string
  customerNumber?: string | null
  issueDate: string
  dueDate: string
  total: number
  status: string
  mandateId: string
  mandateReference: string
  mandateType: "CORE" | "B2B"
  iban: string
}

interface DirectDebitBatch {
  id: string
  collectionCount: number
  totalAmount: string
  creditorIban: string
  creditorName: string
  creditorIdentifier: string
  type: string
  executionDate: string
  status: string
  notes: string | null
  createdAt: string
}

export default function DirectDebitPage() {
  const router = useRouter()
  const pathname = usePathname()
  const { t } = useI18n()
  const toast = useToast()
  const toastRef = useRef(toast)
  toastRef.current = toast
  const tRef = useRef(t)
  tRef.current = t

  const [customers, setCustomers] = useState<CustomerMini[]>([])
  const [mandates, setMandates] = useState<Mandate[]>([])
  const [openInvoices, setOpenInvoices] = useState<OpenInvoice[]>([])
  const [batches, setBatches] = useState<DirectDebitBatch[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [executionDate, setExecutionDate] = useState<string>(plusDaysISO(7))
  const [creating, setCreating] = useState(false)

  // form state
  const [formOpen, setFormOpen] = useState(false)
  const [formCustomerId, setFormCustomerId] = useState("")
  const [formDateOfSignature, setFormDateOfSignature] = useState(todayISO())
  const [formType, setFormType] = useState<"CORE" | "B2B">("CORE")
  const [formIban, setFormIban] = useState("")
  const [formBic, setFormBic] = useState("")
  const [formDebitorName, setFormDebitorName] = useState("")
  const [formDescription, setFormDescription] = useState("")
  const [formSubmitting, setFormSubmitting] = useState(false)

  const companyId =
    typeof window !== "undefined" ? localStorage.getItem("companyId") : null

  const load = useCallback(async () => {
    if (!companyId) {
      router.push("/login")
      return
    }
    setLoading(true)
    try {
      const [custs, ms, oi, bs] = await Promise.all([
        apiGet<{ data: CustomerMini[] } | CustomerMini[]>(
          `/api/v1/customers?companyId=${companyId}&pageSize=500`,
        ),
        apiGet<Mandate[]>(`/api/v1/payments/mandates?companyId=${companyId}`),
        apiGet<OpenInvoice[]>(
          `/api/v1/payments/direct-debit/open?companyId=${companyId}`,
        ),
        apiGet<DirectDebitBatch[]>(
          `/api/v1/payments/direct-debit/batches?companyId=${companyId}`,
        ),
      ])
      const custList = Array.isArray(custs) ? custs : custs?.data || []
      setCustomers(custList)
      setMandates(Array.isArray(ms) ? ms : [])
      setOpenInvoices(Array.isArray(oi) ? oi : [])
      setBatches(Array.isArray(bs) ? bs : [])
      setError(null)
    } catch (err: any) {
      setError(
        err?.message || tRef.current("directDebit.toast.error", { message: "load" }),
      )
    } finally {
      setLoading(false)
    }
  }, [companyId, router])

  useEffect(() => {
    load()
  }, [load])

  // When a customer is picked in the form, default the
  // account-holder (Kontoinhaber) to the customer's name.
  // The user can override it (some companies mandate a
  // different bank account for collection than the primary
  // account of the customer). This is the same behaviour
  // as Lexware / SevDesk mandate forms.
  useEffect(() => {
    if (!formCustomerId) {
      setFormDebitorName("")
      return
    }
    const c = customers.find((x) => x.id === formCustomerId)
    if (c && !formDebitorName) {
      setFormDebitorName(c.name)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formCustomerId, customers])

  const totalSelected = useMemo(
    () =>
      openInvoices
        .filter((e) => selected.has(e.id))
        .reduce((sum, e) => sum + Number(e.total || 0), 0),
    [openInvoices, selected],
  )

  const toggleOne = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleAll = () => {
    if (selected.size === openInvoices.length) {
      setSelected(new Set())
    } else {
      setSelected(new Set(openInvoices.map((e) => e.id)))
    }
  }

  const resetForm = () => {
    setFormOpen(false)
    setFormCustomerId("")
    setFormDateOfSignature(todayISO())
    setFormType("CORE")
    setFormIban("")
    setFormBic("")
    setFormDebitorName("")
    setFormDescription("")
  }

  const handleCreateMandate = async () => {
    if (!formCustomerId) {
      toastRef.current.warn(tRef.current("directDebit.toast.selectCustomer"))
      return
    }
    if (!/^[A-Z]{2}\d{2}/.test(formIban.replace(/\s+/g, ""))) {
      toastRef.current.warn(tRef.current("directDebit.toast.invalidIban"))
      return
    }
    setFormSubmitting(true)
    try {
      await apiPost<Mandate>("/api/v1/payments/mandates", {
        companyId,
        customerId: formCustomerId,
        dateOfSignature: formDateOfSignature,
        type: formType,
        iban: formIban.replace(/\s+/g, "").toUpperCase(),
        bic: formBic || undefined,
        debitorName: formDebitorName || undefined,
        description: formDescription || undefined,
      })
      toastRef.current.success(tRef.current("directDebit.toast.mandateCreated"))
      resetForm()
      await load()
    } catch (err: any) {
      const msg =
        err instanceof ApiError
          ? err.message
          : err?.message || tRef.current("directDebit.toast.createError")
      toastRef.current.error(msg)
    } finally {
      setFormSubmitting(false)
    }
  }

  const handleRevokeMandate = async (mandate: Mandate) => {
    const reason =
      typeof window !== "undefined"
        ? window.prompt(tRef.current("directDebit.mandatesCard.revokeReason"))
        : ""
    if (reason === null) return // user pressed cancel
    if (
      !window.confirm(tRef.current("directDebit.mandatesCard.revokeConfirm"))
    ) {
      return
    }
    try {
      await apiDelete(
        `/api/v1/payments/mandates/${mandate.id}?companyId=${companyId}${
          reason ? `&reason=${encodeURIComponent(reason)}` : ""
        }`,
      )
      toastRef.current.success(tRef.current("directDebit.toast.mandateRevoked"))
      await load()
    } catch (err: any) {
      const msg =
        err instanceof ApiError
          ? err.message
          : err?.message || tRef.current("directDebit.toast.revokeError")
      toastRef.current.error(msg)
    }
  }

  const handleCreateBatch = async () => {
    if (selected.size === 0) {
      toastRef.current.warn(tRef.current("directDebit.openInvoicesCard.noSelected"))
      return
    }
    if (!executionDate) {
      toastRef.current.warn(tRef.current("directDebit.openInvoicesCard.executionDate"))
      return
    }
    if (executionDate < todayISO()) {
      toastRef.current.warn(tRef.current("directDebit.openInvoicesCard.executionDateHelp"))
      return
    }
    setCreating(true)
    try {
      const collections = Array.from(selected)
        .map((invoiceId) => {
          const inv = openInvoices.find((x) => x.id === invoiceId)
          if (!inv) return null
          return { invoiceId, mandateId: inv.mandateId }
        })
        .filter(Boolean) as { invoiceId: string; mandateId: string }[]
      const result = await apiPost<DirectDebitBatch & { collectionCount: number; totalAmount: number }>(
        "/api/v1/payments/direct-debit/batches",
        {
          companyId,
          collections,
          executionDate,
        },
      )
      setSelected(new Set())
      toastRef.current.success(
        tRef.current("directDebit.toast.batchCreated", {
          count: result.collectionCount || collections.length,
          amount: fmtMoney(result.totalAmount || totalSelected),
        }),
      )
      await load()
    } catch (err: any) {
      const msg =
        err instanceof ApiError
          ? err.message
          : err?.message || tRef.current("directDebit.toast.batchCreateError")
      toastRef.current.error(msg)
    } finally {
      setCreating(false)
    }
  }

  const handleDownloadXml = async (batchId: string) => {
    try {
      const url = `/api/v1/payments/direct-debit/batches/${batchId}/xml?companyId=${companyId}`
      const res = await fetch(url, {
        headers: {
          "x-user-id": localStorage.getItem("userId") || "",
          "x-company-id": companyId || "",
        },
        credentials: "include",
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const blob = await res.blob()
      const blobUrl = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = blobUrl
      a.download = `SEPA_pain008_${batchId}.xml`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(blobUrl)
    } catch (err: any) {
      toastRef.current.error(
        err?.message || tRef.current("directDebit.toast.error", { message: "download" }),
      )
    }
  }

  // Active tab = pathname matches the pain.* endpoint
  const isOutgoingActive = pathname === "/dashboard/payments"
  const isIncomingActive = pathname === "/dashboard/payments/direct-debit"

  return (
    <main
      className="min-h-screen bg-gray-50 dark:bg-gray-900"
      data-testid="direct-debit-page"
    >
      <header className="bg-white dark:bg-gray-800 border-b shadow-sm">
        <div className="container mx-auto px-4 py-4 flex flex-wrap items-center justify-between gap-3">
          <h1
            className="text-2xl font-bold text-blue-600 dark:text-blue-400"
            data-testid="direct-debit-title"
          >
            {t("directDebit.title")}
          </h1>
          <div className="flex flex-wrap items-center gap-2 sm:gap-4">
            <LanguageSwitcher />
            <ThemeToggle />
            <Button variant="outline" onClick={() => router.push("/dashboard")}>
              ← {t("dashboard.title")}
            </Button>
          </div>
        </div>

        {/* Sub-nav tabs: pain.001 (Ausgehende) ↔ pain.008 (Eingehende) */}
        <div className="container mx-auto px-4">
          <div className="flex border-b" data-testid="payments-tabs">
            <button
              type="button"
              onClick={() => router.push("/dashboard/payments")}
              className={`px-6 py-3 font-medium border-b-2 transition-colors ${
                isOutgoingActive
                  ? "border-blue-600 text-blue-600 dark:text-blue-400"
                  : "border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
              }`}
              data-testid="tab-pain001"
            >
              {t("directDebit.tabOutgoing")}
            </button>
            <button
              type="button"
              onClick={() => router.push("/dashboard/payments/direct-debit")}
              className={`px-6 py-3 font-medium border-b-2 transition-colors ${
                isIncomingActive
                  ? "border-blue-600 text-blue-600 dark:text-blue-400"
                  : "border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
              }`}
              data-testid="tab-pain008"
            >
              {t("directDebit.tabIncoming")}
            </button>
          </div>
        </div>
      </header>

      <div className="container mx-auto px-4 py-8 space-y-6">
        {/* Subtitle */}
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-gray-600 dark:text-gray-300 leading-relaxed">
              {t("directDebit.subtitle")}
            </p>
          </CardContent>
        </Card>

        {error && (
          <Card>
            <CardContent className="pt-6">
              <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
            </CardContent>
          </Card>
        )}

        {/* Card 1 — Mandates */}
        <Card data-testid="mandates-card">
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <CardTitle>{t("directDebit.mandatesCard.title")}</CardTitle>
              <Button
                size="sm"
                onClick={() => setFormOpen((v) => !v)}
                data-testid="add-mandate-button"
              >
                + {t("directDebit.mandatesCard.addMandate")}
              </Button>
            </div>
            <p className="text-sm text-gray-600 dark:text-gray-300 mt-2 leading-relaxed">
              {t("directDebit.mandatesCard.subtitle")}
            </p>
          </CardHeader>
          <CardContent>
            {formOpen && (
              <div
                className="mb-4 p-4 bg-gray-50 dark:bg-gray-800 rounded border border-gray-200 dark:border-gray-700 space-y-3"
                data-testid="mandate-form"
              >
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <Label htmlFor="mandate-customer">
                      {t("directDebit.mandatesCard.form.customer")}
                    </Label>
                    <select
                      id="mandate-customer"
                      value={formCustomerId}
                      onChange={(ev) => setFormCustomerId(ev.target.value)}
                      className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 rounded px-3 py-2 text-sm"
                      data-testid="mandate-customer-select"
                    >
                      <option value="">
                        {t("directDebit.mandatesCard.form.customerPlaceholder")}
                      </option>
                      {customers.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                          {c.customerNumber ? ` (${c.customerNumber})` : ""}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <Label htmlFor="mandate-date">
                      {t("directDebit.mandatesCard.form.dateOfSignature")}
                    </Label>
                    <Input
                      id="mandate-date"
                      type="date"
                      value={formDateOfSignature}
                      onChange={(ev) => setFormDateOfSignature(ev.target.value)}
                      data-testid="mandate-date-input"
                    />
                  </div>
                </div>

                <div>
                  <Label>{t("directDebit.mandatesCard.form.type")}</Label>
                  <div className="flex flex-wrap items-center gap-4 mt-1">
                    <label className="inline-flex items-center gap-2 text-sm">
                      <input
                        type="radio"
                        name="mandate-type"
                        value="CORE"
                        checked={formType === "CORE"}
                        onChange={() => setFormType("CORE")}
                        data-testid="mandate-type-core"
                      />
                      <span>{t("directDebit.mandatesCard.typeCore")}</span>
                    </label>
                    <label className="inline-flex items-center gap-2 text-sm">
                      <input
                        type="radio"
                        name="mandate-type"
                        value="B2B"
                        checked={formType === "B2B"}
                        onChange={() => setFormType("B2B")}
                        data-testid="mandate-type-b2b"
                      />
                      <span>{t("directDebit.mandatesCard.typeB2B")}</span>
                    </label>
                    <span className="text-xs text-gray-500 dark:text-gray-400">
                      {formType === "CORE"
                        ? t("directDebit.mandatesCard.form.typeCoreHelp")
                        : t("directDebit.mandatesCard.form.typeB2BHelp")}
                    </span>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <Label htmlFor="mandate-iban">
                      {t("directDebit.mandatesCard.form.iban")}
                    </Label>
                    <Input
                      id="mandate-iban"
                      type="text"
                      value={formIban}
                      onChange={(ev) => setFormIban(ev.target.value)}
                      placeholder="DE89 3704 0044 0532 0130 00"
                      data-testid="mandate-iban-input"
                    />
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                      {t("directDebit.mandatesCard.form.ibanHelp")}
                    </p>
                  </div>
                  <div>
                    <Label htmlFor="mandate-bic">
                      {t("directDebit.mandatesCard.form.bic")}
                    </Label>
                    <Input
                      id="mandate-bic"
                      type="text"
                      value={formBic}
                      onChange={(ev) => setFormBic(ev.target.value.toUpperCase())}
                      placeholder="COBADEFFXXX"
                      data-testid="mandate-bic-input"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <Label htmlFor="mandate-debitor">
                      {t("directDebit.mandatesCard.form.debitorName")}
                    </Label>
                    <Input
                      id="mandate-debitor"
                      type="text"
                      value={formDebitorName}
                      onChange={(ev) => setFormDebitorName(ev.target.value)}
                      data-testid="mandate-debitor-input"
                    />
                  </div>
                  <div>
                    <Label htmlFor="mandate-desc">
                      {t("directDebit.mandatesCard.form.description")}
                    </Label>
                    <Input
                      id="mandate-desc"
                      type="text"
                      value={formDescription}
                      onChange={(ev) => setFormDescription(ev.target.value)}
                      placeholder={t(
                        "directDebit.mandatesCard.form.descriptionPlaceholder",
                      )}
                      data-testid="mandate-description-input"
                    />
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-end gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={resetForm}
                    data-testid="mandate-cancel-button"
                  >
                    {t("directDebit.mandatesCard.form.cancel")}
                  </Button>
                  <Button
                    onClick={handleCreateMandate}
                    disabled={formSubmitting}
                    data-testid="mandate-submit-button"
                  >
                    {formSubmitting
                      ? "…"
                      : t("directDebit.mandatesCard.form.submit")}
                  </Button>
                </div>
              </div>
            )}

            {loading ? (
              <p className="text-sm text-gray-500">…</p>
            ) : mandates.length === 0 ? (
              <p
                className="text-sm text-emerald-700 dark:text-emerald-400"
                data-testid="mandates-empty"
              >
                {t("directDebit.mandatesCard.emptyState")}
              </p>
            ) : (
              <div
                className="overflow-x-auto"
                data-testid="mandates-table"
              >
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left border-b dark:border-gray-700">
                      <th className="py-2 pr-3">
                        {t("directDebit.mandatesCard.columns.customer")}
                      </th>
                      <th className="py-2 pr-3">
                        {t("directDebit.mandatesCard.columns.reference")}
                      </th>
                      <th className="py-2 pr-3">
                        {t("directDebit.mandatesCard.columns.type")}
                      </th>
                      <th className="py-2 pr-3">
                        {t("directDebit.mandatesCard.columns.iban")}
                      </th>
                      <th className="py-2 pr-3">
                        {t("directDebit.mandatesCard.columns.status")}
                      </th>
                      <th className="py-2 pr-3">
                        {t("directDebit.mandatesCard.columns.actions")}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {mandates.map((m) => (
                      <tr
                        key={m.id}
                        className="border-b dark:border-gray-700"
                        data-testid={`mandate-row-${m.id}`}
                      >
                        <td className="py-2 pr-3">
                          {m.customer?.name || "—"}
                          {m.customer?.customerNumber && (
                            <span className="ml-1 text-xs text-gray-400 font-mono">
                              {m.customer.customerNumber}
                            </span>
                          )}
                        </td>
                        <td className="py-2 pr-3 font-mono text-xs whitespace-nowrap">
                          {m.mandateReference}
                        </td>
                        <td className="py-2 pr-3">
                          <span
                            className={`inline-block px-2 py-0.5 text-xs rounded ${typeBadgeColor(m.type)}`}
                          >
                            {m.type}
                          </span>
                        </td>
                        <td className="py-2 pr-3 font-mono text-xs whitespace-nowrap">
                          {ibanMasked(m.iban)}
                        </td>
                        <td className="py-2 pr-3">
                          <span
                            className={`inline-block px-2 py-0.5 text-xs rounded ${
                              m.status === "active"
                                ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200"
                                : "bg-gray-200 text-gray-700 dark:bg-gray-700 dark:text-gray-300"
                            }`}
                          >
                            {m.status === "active"
                              ? t("directDebit.mandatesCard.statusActive")
                              : t("directDebit.mandatesCard.statusRevoked")}
                          </span>
                        </td>
                        <td className="py-2 pr-3">
                          {m.status === "active" ? (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => handleRevokeMandate(m)}
                              data-testid={`revoke-mandate-${m.id}`}
                            >
                              {t("directDebit.mandatesCard.revokeButton")}
                            </Button>
                          ) : (
                            <span className="text-xs text-gray-400">—</span>
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

        {/* Card 2 — Open invoices for direct debit */}
        <Card data-testid="open-invoices-card">
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <CardTitle>{t("directDebit.openInvoicesCard.title")}</CardTitle>
              {openInvoices.length > 0 && (
                <div className="flex items-center gap-3">
                  <span
                    className="text-sm text-gray-600 dark:text-gray-300"
                    data-testid="open-invoices-selected-count"
                  >
                    {selected.size} / {openInvoices.length}{" "}
                    {t("directDebit.openInvoicesCard.selectedCount")}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={toggleAll}
                    data-testid="open-invoices-select-all"
                  >
                    {selected.size === openInvoices.length
                      ? "—"
                      : t("payments.selectAll")}
                  </Button>
                </div>
              )}
            </div>
            <p className="text-sm text-gray-600 dark:text-gray-300 mt-2 leading-relaxed">
              {t("directDebit.openInvoicesCard.subtitle")}
            </p>
          </CardHeader>
          <CardContent>
            {loading ? (
              <p className="text-sm text-gray-500">…</p>
            ) : openInvoices.length === 0 ? (
              <p
                className="text-sm text-emerald-700 dark:text-emerald-400"
                data-testid="open-invoices-empty"
              >
                {t("directDebit.openInvoicesCard.emptyState")}
              </p>
            ) : (
              <>
                <div
                  className="overflow-x-auto"
                  data-testid="open-invoices-table"
                >
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left border-b dark:border-gray-700">
                        <th className="py-2 pr-3 w-8"></th>
                        <th className="py-2 pr-3">
                          {t("directDebit.openInvoicesCard.columns.invoiceNumber")}
                        </th>
                        <th className="py-2 pr-3">
                          {t("directDebit.openInvoicesCard.columns.customer")}
                        </th>
                        <th className="py-2 pr-3">
                          {t("directDebit.openInvoicesCard.columns.dueDate")}
                        </th>
                        <th className="py-2 pr-3 text-right">
                          {t("directDebit.openInvoicesCard.columns.amount")}
                        </th>
                        <th className="py-2 pr-3">
                          {t("directDebit.openInvoicesCard.columns.mandate")}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {openInvoices.map((inv) => (
                        <tr
                          key={inv.id}
                          className={`border-b dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer ${
                            selected.has(inv.id)
                              ? "bg-blue-50 dark:bg-blue-900/20"
                              : ""
                          }`}
                          onClick={() => toggleOne(inv.id)}
                          data-testid={`open-invoice-row-${inv.id}`}
                        >
                          <td className="py-2 pr-3">
                            <input
                              type="checkbox"
                              className="w-4 h-4"
                              checked={selected.has(inv.id)}
                              onChange={() => toggleOne(inv.id)}
                              onClick={(ev) => ev.stopPropagation()}
                              data-testid={`open-invoice-checkbox-${inv.id}`}
                            />
                          </td>
                          <td className="py-2 pr-3 font-mono text-xs whitespace-nowrap">
                            {inv.invoiceNumber || "—"}
                          </td>
                          <td className="py-2 pr-3">
                            {inv.customerName}
                            {inv.customerNumber && (
                              <span className="ml-1 text-xs text-gray-400 font-mono">
                                {inv.customerNumber}
                              </span>
                            )}
                          </td>
                          <td className="py-2 pr-3 whitespace-nowrap">
                            {fmtDateDE(inv.dueDate)}
                          </td>
                          <td className="py-2 pr-3 text-right font-mono whitespace-nowrap">
                            {fmtMoney(inv.total)} €
                          </td>
                          <td className="py-2 pr-3 font-mono text-xs whitespace-nowrap">
                            {inv.mandateReference}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Sticky-ish create-batch footer */}
                <div
                  className="mt-4 p-4 bg-gray-50 dark:bg-gray-800 rounded border border-gray-200 dark:border-gray-700"
                  data-testid="direct-debit-create-form"
                >
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3 items-end">
                    <div>
                      <Label htmlFor="direct-debit-executionDate">
                        {t("directDebit.openInvoicesCard.executionDate")}
                      </Label>
                      <Input
                        id="direct-debit-executionDate"
                        type="date"
                        value={executionDate}
                        onChange={(ev) => setExecutionDate(ev.target.value)}
                        min={todayISO()}
                        data-testid="direct-debit-execution-date-input"
                      />
                      <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                        {t("directDebit.openInvoicesCard.executionDateHelp")}
                      </p>
                    </div>
                    <div>
                      <div className="text-sm text-gray-600 dark:text-gray-300">
                        Σ{" "}
                        <span
                          className="font-mono font-bold"
                          data-testid="direct-debit-total"
                        >
                          {fmtMoney(totalSelected)} €
                        </span>
                      </div>
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                    <div className="text-sm text-gray-600 dark:text-gray-300">
                      {t("directDebit.openInvoicesCard.totalAmount", {
                        amount: fmtMoney(totalSelected),
                      })}
                    </div>
                    <Button
                      onClick={handleCreateBatch}
                      disabled={selected.size === 0 || creating}
                      data-testid="direct-debit-create-batch-button"
                    >
                      {creating
                        ? "…"
                        : `${t("directDebit.openInvoicesCard.createBatch")} (${selected.size})`}
                    </Button>
                  </div>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {/* Card 3 — Past batches */}
        <Card data-testid="batches-card">
          <CardHeader>
            <CardTitle>{t("directDebit.batchesCard.title")}</CardTitle>
          </CardHeader>
          <CardContent>
            {batches.length === 0 ? (
              <p
                className="text-sm text-gray-500 dark:text-gray-400"
                data-testid="batches-empty"
              >
                {t("directDebit.batchesCard.emptyState")}
              </p>
            ) : (
              <div
                className="overflow-x-auto"
                data-testid="batches-table"
              >
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left border-b dark:border-gray-700">
                      <th className="py-2 pr-3">
                        {t("directDebit.batchesCard.columns.date")}
                      </th>
                      <th className="py-2 pr-3">
                        {t("directDebit.batchesCard.columns.creditorId")}
                      </th>
                      <th className="py-2 pr-3">
                        {t("directDebit.batchesCard.columns.type")}
                      </th>
                      <th className="py-2 pr-3 text-right">
                        {t("directDebit.batchesCard.columns.count")}
                      </th>
                      <th className="py-2 pr-3 text-right">
                        {t("directDebit.batchesCard.columns.total")}
                      </th>
                      <th className="py-2 pr-3">
                        {t("directDebit.batchesCard.columns.status")}
                      </th>
                      <th className="py-2 pr-3"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {batches.map((b) => (
                      <tr
                        key={b.id}
                        className="border-b dark:border-gray-700"
                        data-testid={`batch-row-${b.id}`}
                      >
                        <td className="py-2 pr-3 whitespace-nowrap">
                          {fmtDateDE(b.executionDate)}
                        </td>
                        <td className="py-2 pr-3 font-mono text-xs whitespace-nowrap">
                          {b.creditorIdentifier}
                        </td>
                        <td className="py-2 pr-3">
                          <span
                            className={`inline-block px-2 py-0.5 text-xs rounded ${typeBadgeColor(b.type)}`}
                          >
                            {b.type}
                          </span>
                        </td>
                        <td className="py-2 pr-3 text-right font-mono">
                          {b.collectionCount}
                        </td>
                        <td className="py-2 pr-3 text-right font-mono whitespace-nowrap">
                          {fmtMoney(b.totalAmount)} €
                        </td>
                        <td className="py-2 pr-3">
                          <span
                            className={`inline-block px-2 py-0.5 text-xs rounded ${batchStatusColor(b.status)}`}
                          >
                            {b.status}
                          </span>
                        </td>
                        <td className="py-2 pr-3">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => handleDownloadXml(b.id)}
                            data-testid={`direct-debit-download-xml-${b.id}`}
                          >
                            {t("directDebit.batchesCard.downloadXml")}
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
      </div>
    </main>
  )
}
