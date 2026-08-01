"use client"

/**
 * Tier 61: Customer detail page (Kunden-Detailansicht).
 *
 * Top-level `/dashboard/customers/[id]` — the natural
 * drill-down from the customers list. The list cards
 * used to click → open the edit modal, which made it
 * impossible to see the customer's full activity at a
 * glance. This page replaces that flow with a real
 * detail view:
 *
 *   - Stammdaten header (name, K-Nr, type, address,
 *     contact, payment terms, credit limit)
 *   - KPI strip (open balance, overdue count, open
 *     Mahnungen, credit balance, last invoice, last
 *     payment) — fetched via the new
 *     `GET /customers/:id/summary` endpoint
 *   - Tabs: Rechnungen / Ratenpläne / Mahnungen /
 *     Gutschrift
 *   - Drill-down shortcuts to /statement and /credit
 *
 * The list page no longer opens the edit modal on
 * card click — clicking a card now navigates here. The
 * edit modal is still reachable from the "Bearbeiten"
 * button on this page.
 */

import { useEffect, useState } from "react"
import { useParams, useRouter } from "next/navigation"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { ErrorBanner } from "@/components/ui/error-banner"
import LanguageSwitcher from "@/components/LanguageSwitcher"
import { useI18n } from "@/components/useI18n"
import { apiGet, apiFetch, ApiError } from "@/lib/api"

type Tab = "invoices" | "plans" | "mahnungen" | "pauses" | "credit"

interface CustomerSummary {
  customer: {
    id: string
    name: string
    customerNumber: string | null
    type: string
    vatId: string | null
    taxExempt: boolean
    address: Record<string, any>
    contact: Record<string, any>
    paymentTerms: number
    creditLimit: number | null
    tags: string[]
    metadata: any
    createdAt: string
  }
  stats: {
    openBalance: number
    overdueCount: number
    openInvoiceCount: number
    activeInstallmentPlanCount: number
    openMahnungCount: number
    creditBalance: number
    lastInvoice: {
      id: string
      invoiceNumber: string
      issueDate: string
      total: number
      status: string
      type: string
    } | null
    lastPayment: {
      id: string
      amount: number
      paymentDate: string
      paymentMethod: string
      invoiceNumber: string
    } | null
  }
}

interface InvoiceRow {
  id: string
  invoiceNumber: string
  issueDate: string
  dueDate: string | null
  total: number
  status: string
  type: string
}

interface InstallmentPlanRow {
  id: string
  totalAmount: number
  paidAmount: number
  status: string
  startDate: string
  interval: string
  installmentCount: number
}

interface MahnungRow {
  id: string
  level: string
  daysOverdue: number
  neueFrist: string
  mahngebuehr: number
  verzugszins: number
  totalDue: number
  cancelledAt: string | null
  createdAt: string
  invoice: { invoiceNumber: string; total: number }
}

// Tier 64: Mahnungspause row from /api/v1/mahnungspausen.
// Either customerId (customer-level pause) or invoiceId
// (single-invoice pause) is set; not both, not neither.
interface MahnungspauseRow {
  id: string
  customerId: string | null
  invoiceId: string | null
  reason: string
  pausedFrom: string
  pausedUntil: string | null
  cancelledAt: string | null
  createdAt: string
  customer?: { id: string; name: string; customerNumber?: string | null } | null
  invoice?: { id: string; invoiceNumber: string; total: number | string; dueDate: string } | null
  createdBy?: { id: string; email: string } | null
}

interface CreditLedgerRow {
  id: string
  type: "overpayment" | "gutschrift" | "payout" | "apply" | "manual"
  amount: number
  balanceAfter: number
  description: string | null
  referenceType: string | null
  referenceId: string | null
  createdAt: string
}

function fmtEur(n: number, locale: string = "de-DE"): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n)
}

function fmtDateDE(d: string | null): string {
  if (!d) return "—"
  const date = new Date(d)
  const day = String(date.getUTCDate()).padStart(2, "0")
  const month = String(date.getUTCMonth() + 1).padStart(2, "0")
  return `${day}.${month}.${date.getUTCFullYear()}`
}

function getTypeLabel(type: string, t: (k: string) => string): string {
  switch (type) {
    case "INV": return t("invoice.typeInvoice") || "Rechnung"
    case "CN": return t("invoice.typeCreditNote") || "Gutschrift"
    case "PI": return t("invoice.typeProforma") || "Proforma"
    case "RCV": return t("invoice.typeReceipt") || "Quittung"
    default: return type
  }
}

function getStatusLabel(status: string, t: (k: string) => string): string {
  switch (status) {
    case "draft": return t("invoice.statusDraft") || "Entwurf"
    case "sent": return t("invoice.statusSent") || "Versendet"
    case "paid": return t("invoice.statusPaid") || "Bezahlt"
    case "overdue": return t("invoice.statusOverdue") || "Überfällig"
    case "cancelled": return t("invoice.statusCancelled") || "Storniert"
    case "active": return t("installmentPlan.statusActive") || "Aktiv"
    case "completed": return t("installmentPlan.statusCompleted") || "Abgeschlossen"
    case "cancelled_plan": return t("installmentPlan.statusCancelled") || "Storniert"
    default: return status
  }
}

const TYPE_LABEL: Record<string, string> = {
  overpayment: "Überzahlung",
  gutschrift: "Gutschrift-Überschuss",
  payout: "Auszahlung",
  apply: "Verrechnung",
  manual: "Manuelle Korrektur",
}

export default function CustomerDetailPage() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const { t, locale, getDateLocale } = useI18n()

  const [companyId, setCompanyId] = useState<string | null>(null)
  const [summary, setSummary] = useState<CustomerSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>("invoices")

  // Tab data — lazy-loaded on first tab activation.
  // Each tab keeps its own loading flag so the user can
  // switch back without re-fetching.
  const [invoices, setInvoices] = useState<InvoiceRow[] | null>(null)
  const [invoicesLoading, setInvoicesLoading] = useState(false)
  const [plans, setPlans] = useState<InstallmentPlanRow[] | null>(null)
  const [plansLoading, setPlansLoading] = useState(false)
  const [mahnungen, setMahnungen] = useState<MahnungRow[] | null>(null)
  const [mahnungenLoading, setMahnungenLoading] = useState(false)
  // Tier 64: Mahnungspause state for the "pauses" tab.
  const [pauses, setPauses] = useState<MahnungspauseRow[] | null>(null)
  const [pausesLoading, setPausesLoading] = useState(false)
  const [showPauseModal, setShowPauseModal] = useState(false)
  const [pauseSaving, setPauseSaving] = useState(false)
  const [pauseError, setPauseError] = useState<string | null>(null)
  const [pauseForm, setPauseForm] = useState({
    reason: "",
    pausedUntil: "",
  })
  const [creditLedger, setCreditLedger] = useState<CreditLedgerRow[] | null>(null)
  const [creditLoading, setCreditLoading] = useState(false)

  useEffect(() => {
    const stored = typeof window !== "undefined" ? localStorage.getItem("companyId") : null
    if (stored) setCompanyId(stored)
  }, [])

  // Fetch the summary (KPI strip + Stammdaten header).
  useEffect(() => {
    if (!companyId || !id) return
    let cancelled = false
    setLoading(true)
    setError(null)
    apiGet<CustomerSummary>(`/api/v1/customers/${id}/summary?companyId=${companyId}`)
      .then((d) => { if (!cancelled) setSummary(d) })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof ApiError ? err.message : String(err))
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [companyId, id])

  // Lazy-load tab data on first activation.
  useEffect(() => {
    if (!companyId || !id) return
    if (tab === "invoices" && invoices === null && !invoicesLoading) {
      setInvoicesLoading(true)
      apiGet<{ data: InvoiceRow[] }>(
        `/api/v1/invoices?companyId=${companyId}&customerId=${id}&pageSize=50`,
      )
        .then((d) => setInvoices(d.data || []))
        .catch((err) => console.error("invoices load failed:", err))
        .finally(() => setInvoicesLoading(false))
    }
    if (tab === "plans" && plans === null && !plansLoading) {
      setPlansLoading(true)
      apiGet<InstallmentPlanRow[]>(
        `/api/v1/installment-plans/for-customer/${id}?companyId=${companyId}`,
      )
        .then((d) => setPlans(d))
        .catch((err) => console.error("plans load failed:", err))
        .finally(() => setPlansLoading(false))
    }
    if (tab === "mahnungen" && mahnungen === null && !mahnungenLoading) {
      setMahnungenLoading(true)
      apiGet<{ mahnungen: MahnungRow[] }>(
        `/api/v1/reminders/mahnungen?companyId=${companyId}&customerId=${id}&status=all`,
      )
        .then((d) => setMahnungen(d.mahnungen || []))
        .catch((err) => console.error("mahnungen load failed:", err))
        .finally(() => setMahnungenLoading(false))
    }
    // Tier 64: fetch the customer's Mahnungspausen
    // (active + cancelled) when the tab is opened.
    // Same lazy-fetch pattern as the other tabs.
    if (tab === "pauses" && pauses === null && !pausesLoading) {
      setPausesLoading(true)
      apiGet<MahnungspauseRow[]>(
        `/api/v1/mahnungspausen?companyId=${companyId}&customerId=${id}`,
      )
        .then((d) => setPauses(d))
        .catch((err) => console.error("pauses load failed:", err))
        .finally(() => setPausesLoading(false))
    }
    if (tab === "credit" && creditLedger === null && !creditLoading) {
      setCreditLoading(true)
      apiGet<CreditLedgerRow[]>(
        `/api/v1/customers/${id}/credit-ledger?companyId=${companyId}`,
      )
        .then((d) => setCreditLedger(d))
        .catch((err) => console.error("credit ledger load failed:", err))
        .finally(() => setCreditLoading(false))
    }
  }, [tab, companyId, id, invoices, plans, mahnungen, creditLedger, invoicesLoading, plansLoading, mahnungenLoading, creditLoading])

  if (!companyId) {
    return (
      <div className="container mx-auto p-8">
        <p className="text-gray-500">{t("common.loading") || "Lädt..."}</p>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="container mx-auto p-8">
        <p className="text-gray-500">{t("common.loading") || "Lädt..."}</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="container mx-auto p-8">
        <ErrorBanner title={t("common.error") || "Fehler"} message={error} />
        <Button
          variant="outline"
          onClick={() => router.push("/dashboard/customers")}
          className="mt-4"
        >
          ← {t("common.back") || "Zurück"}
        </Button>
      </div>
    )
  }

  if (!summary) return null
  const { customer, stats } = summary

  // Address formatting (street, postalCode city, country)
  const address = customer.address || {}
  const fullAddress = [
    address.street,
    [address.postalCode, address.city].filter(Boolean).join(" "),
    address.country,
  ].filter(Boolean).join(", ")

  return (
    <div className="container mx-auto p-4 md:p-8">
      {/* Header — Tier 126: flex-wrap so the 5 right-side
          controls (3 lang + Zurück + Kontoauszug) drop
          to a second row on 375px phones. */}
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1
            className="text-2xl md:text-3xl font-bold"
            data-testid="customer-detail-title"
          >
            {customer.name}
            {customer.customerNumber && (
              <span className="ml-3 text-base font-normal text-gray-500 font-mono">
                {customer.customerNumber}
              </span>
            )}
          </h1>
          <p className="text-gray-500 dark:text-gray-400 mt-1 text-sm">
            {getTypeLabel(customer.type, t)} · {t("customer.paymentTerms") || "Zahlungsziel"}: {customer.paymentTerms} {t("reminder.days")}
            {customer.vatId && (
              <span className="ml-3 font-mono">USt-ID: {customer.vatId}</span>
            )}
            {customer.taxExempt && (
              <span className="ml-3 text-orange-700">⚠ Steuerbefreit</span>
            )}
          </p>
          {fullAddress && (
            <p className="text-gray-600 dark:text-gray-300 mt-1 text-sm">
              {fullAddress}
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <LanguageSwitcher />
          <Button
            variant="outline"
            onClick={() => router.push("/dashboard/customers")}
            data-testid="customer-detail-back"
          >
            ← {t("common.back") || "Zurück"}
          </Button>
          <Button
            onClick={() => router.push(`/dashboard/customers/${id}/statement`)}
            data-testid="customer-detail-statement"
          >
            📊 {t("statement.title") || "Kontoauszug"}
          </Button>
        </div>
      </header>

      {/* KPI strip */}
      <div
        className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 mb-6"
        data-testid="customer-detail-kpi-strip"
      >
        <Card>
          <CardContent className="pt-4">
            <p className="text-xs text-gray-500">{t("customerDetail.openBalance") || "Offener Saldo"}</p>
            <p
              className={
                "text-xl font-mono font-bold " +
                (stats.openBalance > 0 ? "text-red-700" : "text-emerald-700")
              }
              data-testid="kpi-open-balance"
            >
              {fmtEur(stats.openBalance)}
            </p>
            <p className="text-xs text-gray-400">
              {stats.openInvoiceCount} {t("customerDetail.openInvoices") || "offene Rechnungen"}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <p className="text-xs text-gray-500">{t("customerDetail.overdueCount") || "Überfällig"}</p>
            <p
              className={
                "text-xl font-mono font-bold " +
                (stats.overdueCount > 0 ? "text-red-700" : "text-gray-400")
              }
              data-testid="kpi-overdue"
            >
              {stats.overdueCount}
            </p>
            <p className="text-xs text-gray-400">
              {t("customerDetail.invoices") || "Rechnungen"}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <p className="text-xs text-gray-500">{t("customerDetail.openMahnungen") || "Offene Mahnungen"}</p>
            <p
              className={
                "text-xl font-mono font-bold " +
                (stats.openMahnungCount > 0 ? "text-red-700" : "text-emerald-700")
              }
              data-testid="kpi-mahnungen"
            >
              {stats.openMahnungCount}
            </p>
            <p className="text-xs text-gray-400">
              {t("customerDetail.mahnungen") || "Mahnungen"}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <p className="text-xs text-gray-500">{t("customerDetail.creditBalance") || "Kundenguthaben"}</p>
            <p
              className={
                "text-xl font-mono font-bold " +
                (stats.creditBalance > 0 ? "text-blue-700" : "text-gray-400")
              }
              data-testid="kpi-credit"
            >
              {fmtEur(stats.creditBalance)}
            </p>
            <p className="text-xs text-gray-400">
              {t("customerDetail.balanceLabel") || "Saldo"}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <p className="text-xs text-gray-500">{t("customerDetail.activePlans") || "Aktive Ratenpläne"}</p>
            <p
              className="text-xl font-mono font-bold"
              data-testid="kpi-plans"
            >
              {stats.activeInstallmentPlanCount}
            </p>
            <p className="text-xs text-gray-400">
              {t("customerDetail.installmentPlans") || "Ratenpläne"}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <p className="text-xs text-gray-500">{t("customerDetail.lastInvoice") || "Letzte Rechnung"}</p>
            <p
              className="text-sm font-mono font-medium"
              data-testid="kpi-last-invoice"
            >
              {stats.lastInvoice ? stats.lastInvoice.invoiceNumber : "—"}
            </p>
            <p className="text-xs text-gray-400">
              {stats.lastInvoice ? fmtDateDE(stats.lastInvoice.issueDate) : ""}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Tabs */}
      <div
        className="border-b border-gray-200 dark:border-gray-700 mb-4 flex gap-2 overflow-x-auto"
        role="tablist"
      >
        <button
          role="tab"
          onClick={() => setTab("invoices")}
          className={
            "px-4 py-2 text-sm font-medium border-b-2 " +
            (tab === "invoices"
              ? "border-blue-600 text-blue-700"
              : "border-transparent text-gray-500 hover:text-gray-700")
          }
          data-testid="tab-invoices"
        >
          📄 {t("customerDetail.tabInvoices") || "Rechnungen"}
        </button>
        <button
          role="tab"
          onClick={() => setTab("plans")}
          className={
            "px-4 py-2 text-sm font-medium border-b-2 " +
            (tab === "plans"
              ? "border-blue-600 text-blue-700"
              : "border-transparent text-gray-500 hover:text-gray-700")
          }
          data-testid="tab-plans"
        >
          📅 {t("customerDetail.tabPlans") || "Ratenpläne"}
          {stats.activeInstallmentPlanCount > 0 && (
            <span className="ml-1 text-xs px-1.5 py-0.5 rounded-full bg-blue-100 text-blue-800">
              {stats.activeInstallmentPlanCount}
            </span>
          )}
        </button>
        <button
          role="tab"
          onClick={() => setTab("mahnungen")}
          className={
            "px-4 py-2 text-sm font-medium border-b-2 " +
            (tab === "mahnungen"
              ? "border-blue-600 text-blue-700"
              : "border-transparent text-gray-500 hover:text-gray-700")
          }
          data-testid="tab-mahnungen"
        >
          ⚠ {t("customerDetail.tabMahnungen") || "Mahnungen"}
          {stats.openMahnungCount > 0 && (
            <span className="ml-1 text-xs px-1.5 py-0.5 rounded-full bg-red-100 text-red-800">
              {stats.openMahnungCount}
            </span>
          )}
        </button>
        <button
          role="tab"
          onClick={() => setTab("pauses")}
          className={
            "px-4 py-2 text-sm font-medium border-b-2 " +
            (tab === "pauses"
              ? "border-blue-600 text-blue-700"
              : "border-transparent text-gray-500 hover:text-gray-700")
          }
          data-testid="tab-pauses"
        >
          ⏸ {t("customerDetail.tabPauses") || "Mahnungspausen"}
          {pauses && pauses.filter((p) => !p.cancelledAt).length > 0 && (
            <span
              className="ml-1 text-xs px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-800"
              data-testid="tab-pauses-count"
            >
              {pauses.filter((p) => !p.cancelledAt).length}
            </span>
          )}
        </button>
        <button
          role="tab"
          onClick={() => setTab("credit")}
          className={
            "px-4 py-2 text-sm font-medium border-b-2 " +
            (tab === "credit"
              ? "border-blue-600 text-blue-700"
              : "border-transparent text-gray-500 hover:text-gray-700")
          }
          data-testid="tab-credit"
        >
          💰 {t("customerDetail.tabCredit") || "Guthaben"}
        </button>
        <Link
          href={`/dashboard/customers/${id}/credit`}
          className="ml-auto px-4 py-2 text-sm font-medium text-gray-500 hover:text-blue-700"
          data-testid="tab-credit-full"
        >
          → {t("customerDetail.openFullLedger") || "Vollständiger Verlauf"}
        </Link>
      </div>

      {/* Tab content */}
      {tab === "invoices" && (
        <Card>
          <CardContent className="pt-6">
            {invoicesLoading && (
              <p className="text-gray-500">{t("common.loading") || "Lädt..."}</p>
            )}
            {invoices && invoices.length === 0 && (
              <p
                className="text-center text-gray-500 py-8"
                data-testid="tab-invoices-empty"
              >
                {t("invoice.noInvoices") || "Keine Rechnungen"}
              </p>
            )}
            {invoices && invoices.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-sm" data-testid="tab-invoices-table">
                  <thead className="border-b-2">
                    <tr className="text-left text-gray-500">
                      <th className="py-2 font-medium">{t("invoice.number") || "Nr."}</th>
                      <th className="py-2 font-medium">{t("invoice.date") || "Datum"}</th>
                      <th className="py-2 font-medium">{t("invoice.dueDate") || "Fällig"}</th>
                      <th className="py-2 font-medium">{t("customerDetail.type") || "Art"}</th>
                      <th className="py-2 font-medium text-right">{t("invoice.total") || "Betrag"}</th>
                      <th className="py-2 font-medium">{t("customerDetail.status") || "Status"}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {invoices.map((inv) => (
                      <tr
                        key={inv.id}
                        className="border-b hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer"
                        onClick={() => router.push(`/dashboard/invoices/${inv.id}`)}
                        data-testid="tab-invoices-row"
                      >
                        <td className="py-2 font-mono">{inv.invoiceNumber}</td>
                        <td className="py-2">{fmtDateDE(inv.issueDate)}</td>
                        <td className="py-2">{fmtDateDE(inv.dueDate)}</td>
                        <td className="py-2 text-gray-600">{getTypeLabel(inv.type, t)}</td>
                        <td className="py-2 text-right font-mono">{fmtEur(inv.total)}</td>
                        <td className="py-2">
                          <span
                            className={
                              "text-[10px] px-2 py-0.5 rounded font-medium " +
                              (inv.status === "paid"
                                ? "bg-emerald-100 text-emerald-800"
                                : inv.status === "overdue"
                                  ? "bg-red-100 text-red-800"
                                  : inv.status === "sent"
                                    ? "bg-blue-100 text-blue-800"
                                    : "bg-gray-100 text-gray-700")
                            }
                          >
                            {getStatusLabel(inv.status, t)}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {tab === "plans" && (
        <Card>
          <CardContent className="pt-6">
            {plansLoading && <p className="text-gray-500">{t("common.loading") || "Lädt..."}</p>}
            {plans && plans.length === 0 && (
              <p
                className="text-center text-gray-500 py-8"
                data-testid="tab-plans-empty"
              >
                {t("customerDetail.noPlans") || "Keine Ratenpläne"}
              </p>
            )}
            {plans && plans.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-sm" data-testid="tab-plans-table">
                  <thead className="border-b-2">
                    <tr className="text-left text-gray-500">
                      <th className="py-2 font-medium">{t("customerDetail.interval") || "Intervall"}</th>
                      <th className="py-2 font-medium">{t("customerDetail.startDate") || "Start"}</th>
                      <th className="py-2 font-medium text-right">{t("customerDetail.total") || "Gesamt"}</th>
                      <th className="py-2 font-medium text-right">{t("customerDetail.paid") || "Bezahlt"}</th>
                      <th className="py-2 font-medium">{t("customerDetail.status") || "Status"}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {plans.map((p) => (
                      <tr
                        key={p.id}
                        className="border-b hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer"
                        onClick={() => router.push(`/dashboard/installment-plans`)}
                        data-testid="tab-plans-row"
                      >
                        <td className="py-2">{p.interval} × {p.installmentCount}</td>
                        <td className="py-2">{fmtDateDE(p.startDate)}</td>
                        <td className="py-2 text-right font-mono">{fmtEur(p.totalAmount)}</td>
                        <td className="py-2 text-right font-mono">{fmtEur(p.paidAmount)}</td>
                        <td className="py-2">
                          <span
                            className={
                              "text-[10px] px-2 py-0.5 rounded font-medium " +
                              (p.status === "active"
                                ? "bg-blue-100 text-blue-800"
                                : p.status === "completed"
                                  ? "bg-emerald-100 text-emerald-800"
                                  : "bg-gray-100 text-gray-700")
                            }
                          >
                            {getStatusLabel(p.status, t)}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {tab === "mahnungen" && (
        <Card>
          <CardContent className="pt-6">
            {mahnungenLoading && <p className="text-gray-500">{t("common.loading") || "Lädt..."}</p>}
            {mahnungen && mahnungen.length === 0 && (
              <p
                className="text-center text-gray-500 py-8"
                data-testid="tab-mahnungen-empty"
              >
                {t("customerDetail.noMahnungen") || "Keine Mahnungen"}
              </p>
            )}
            {mahnungen && mahnungen.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-sm" data-testid="tab-mahnungen-table">
                  <thead className="border-b-2">
                    <tr className="text-left text-gray-500">
                      <th className="py-2 font-medium">{t("customerDetail.invoice") || "Rechnung"}</th>
                      <th className="py-2 font-medium">{t("mahnung.level") || "Stufe"}</th>
                      <th className="py-2 font-medium text-right">{t("mahnung.daysOverdue") || "Tage überf."}</th>
                      <th className="py-2 font-medium">{t("mahnung.neueFrist") || "Neue Frist"}</th>
                      <th className="py-2 font-medium text-right">{t("mahnung.totalDue") || "Gesamt"}</th>
                      <th className="py-2 font-medium">{t("customerDetail.status") || "Status"}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {mahnungen.map((m) => (
                      <tr
                        key={m.id}
                        className="border-b hover:bg-gray-50 dark:hover:bg-gray-800"
                        data-testid="tab-mahnungen-row"
                      >
                        <td className="py-2 font-mono">{m.invoice.invoiceNumber}</td>
                        <td className="py-2">
                          {m.level === "first" ? "1." : m.level === "second" ? "2." : "Letzte"}
                        </td>
                        <td className="py-2 text-right font-mono">{m.daysOverdue}</td>
                        <td className="py-2">{fmtDateDE(m.neueFrist)}</td>
                        <td className="py-2 text-right font-mono">
                          {fmtEur(Number(m.totalDue))}
                        </td>
                        <td className="py-2">
                          {m.cancelledAt ? (
                            <span className="text-[10px] px-2 py-0.5 rounded font-medium bg-gray-100 text-gray-700">
                              {t("mahnung.statusCancelled") || "Storniert"}
                            </span>
                          ) : (
                            <span className="text-[10px] px-2 py-0.5 rounded font-medium bg-red-100 text-red-800">
                              {t("mahnung.statusOpen") || "Offen"}
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
      )}

      {/* Tier 64: Mahnungspausen tab. Lists every
          pause (active + cancelled) for this customer
          with a "Pause hinzufügen" button to open
          the create modal. Active pauses show in
          amber, cancelled in muted gray. The modal
          posts to /api/v1/mahnungspausen with
          customerId=this customer's id; pausedUntil
          is optional (NULL = open-ended). The list
          reloads on success. */}
      {tab === "pauses" && (
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-medium">
                {t("customerDetail.pausesTitle") || "Mahnungspausen"}
              </h3>
              <Button
                size="sm"
                onClick={() => {
                  setPauseError(null)
                  setPauseForm({ reason: "", pausedUntil: "" })
                  setShowPauseModal(true)
                }}
                data-testid="customer-pause-new-button"
              >
                + {t("customerDetail.pauseNew") || "Pause hinzufügen"}
              </Button>
            </div>
            {pausesLoading && (
              <p className="text-gray-500">{t("common.loading") || "Lädt..."}</p>
            )}
            {pauses && pauses.length === 0 && (
              <p
                className="text-center text-gray-500 py-8"
                data-testid="customer-pauses-empty"
              >
                {t("customerDetail.pausesEmpty") ||
                  "Keine Mahnungspausen für diesen Kunden."}
              </p>
            )}
            {pauses && pauses.length > 0 && (
              <div className="space-y-2" data-testid="customer-pauses-list">
                {pauses.map((p) => {
                  const isActive = !p.cancelledAt
                  const isOpenEnded = !p.pausedUntil
                  const fromShort = p.pausedFrom.slice(0, 10)
                  const untilShort = isOpenEnded
                    ? "∞"
                    : p.pausedUntil!.slice(0, 10)
                  return (
                    <div
                      key={p.id}
                      data-testid="customer-pause-row"
                      data-pause-active={isActive ? "true" : "false"}
                      className={`p-3 rounded border ${
                        isActive
                          ? "border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/30"
                          : "border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-900 opacity-70"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1">
                          <p className="text-sm font-medium">
                            {p.reason}
                          </p>
                          <p className="text-xs text-gray-500 mt-1">
                            {fromShort} → {untilShort}
                            {isOpenEnded && (
                              <span className="ml-2 italic">
                                {t("customerDetail.pauseOpenEnded") ||
                                  "(unbefristet)"}
                              </span>
                            )}
                            {p.cancelledAt && (
                              <span className="ml-2 text-red-600">
                                {t("customerDetail.pauseCancelled") ||
                                  "(beendet)"}
                              </span>
                            )}
                          </p>
                          {p.createdBy && (
                            <p className="text-xs text-gray-400 mt-1">
                              {t("customerDetail.pauseCreatedBy") ||
                                "Erstellt von"}{" "}
                              {p.createdBy.email}
                            </p>
                          )}
                        </div>
                        {isActive && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={async () => {
                              try {
                                await apiFetch(
                                  `/api/v1/mahnungspausen/${p.id}?companyId=${companyId}`,
                                  { method: "DELETE" },
                                )
                                // Reload list
                                setPauses(null)
                                setPausesLoading(true)
                                const d = await apiGet<MahnungspauseRow[]>(
                                  `/api/v1/mahnungspausen?companyId=${companyId}&customerId=${id}`,
                                )
                                setPauses(d)
                              } catch (e) {
                                console.error("pause cancel failed:", e)
                              } finally {
                                setPausesLoading(false)
                              }
                            }}
                            data-testid="customer-pause-cancel-button"
                            className="text-red-600 dark:text-red-400 border-red-300 dark:border-red-700"
                          >
                            {t("customerDetail.pauseCancel") ||
                              "Beenden"}
                          </Button>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
            {showPauseModal && (
              <div
                className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4"
                data-testid="customer-pause-modal"
                onClick={() => setShowPauseModal(false)}
              >
                <div
                  className="bg-white dark:bg-gray-800 rounded-lg p-6 w-full max-w-md shadow-xl"
                  onClick={(e) => e.stopPropagation()}
                >
                  <h3 className="text-lg font-medium mb-3">
                    {t("customerDetail.pauseModalTitle") ||
                      "Mahnungspause hinzufügen"}
                  </h3>
                  <p className="text-xs text-gray-500 mb-4">
                    {t("customerDetail.pauseModalSubtitle") ||
                      "Diese Pause gilt für alle Rechnungen des Kunden. Über die Rechnungs-Detailseite kann auch eine einzelne Rechnung pausiert werden."}
                  </p>
                  <div className="space-y-3">
                    <div>
                      <label className="block text-sm font-medium mb-1">
                        {t("customerDetail.pauseReason") || "Grund"} *
                      </label>
                      <Input
                        value={pauseForm.reason}
                        onChange={(e) =>
                          setPauseForm({ ...pauseForm, reason: e.target.value })
                        }
                        placeholder={
                          t("customerDetail.pauseReasonPlaceholder") ||
                          "z.B. Ratenplan aktiv"
                        }
                        data-testid="customer-pause-reason-input"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-1">
                        {t("customerDetail.pauseUntil") ||
                          "Bis (optional, leer = unbefristet)"}
                      </label>
                      <Input
                        type="date"
                        value={pauseForm.pausedUntil}
                        onChange={(e) =>
                          setPauseForm({
                            ...pauseForm,
                            pausedUntil: e.target.value,
                          })
                        }
                        data-testid="customer-pause-until-input"
                      />
                    </div>
                    {pauseError && (
                      <p
                        className="text-sm text-red-600"
                        data-testid="customer-pause-error"
                      >
                        {pauseError}
                      </p>
                    )}
                  </div>
                  <div className="flex gap-2 justify-end mt-5">
                    <Button
                      variant="outline"
                      onClick={() => setShowPauseModal(false)}
                      disabled={pauseSaving}
                    >
                      {t("common.cancel") || "Abbrechen"}
                    </Button>
                    <Button
                      onClick={async () => {
                        if (!pauseForm.reason.trim()) {
                          setPauseError(
                            t("customerDetail.pauseReasonRequired") ||
                              "Grund ist erforderlich",
                          )
                          return
                        }
                        setPauseSaving(true)
                        setPauseError(null)
                        try {
                          // Use apiFetch here so the 400
                          // response from the backend
                          // (validation error) doesn't
                          // throw — we want to show the
                          // server's message inline.
                          // apiFetch prepends API_BASE so
                          // the URL hits the backend
                          // directly (the Next.js dev
                          // server has no rewrite for
                          // /api/v1/mahnungspausen).
                          const res = await apiFetch(
                            `/api/v1/mahnungspausen?companyId=${companyId}`,
                            {
                              method: "POST",
                              throwOnError: false,
                              body: {
                                customerId: id,
                                reason: pauseForm.reason,
                                pausedUntil: pauseForm.pausedUntil
                                  ? new Date(
                                      pauseForm.pausedUntil,
                                    ).toISOString()
                                  : null,
                              },
                            },
                          )
                          if (!res.ok) {
                            const err = await res.json().catch(() => ({}))
                            throw new Error(
                              err.message ||
                                `HTTP ${res.status}`,
                            )
                          }
                          setShowPauseModal(false)
                          // Reload the list
                          setPauses(null)
                          setPausesLoading(true)
                          const d = await apiGet<MahnungspauseRow[]>(
                            `/api/v1/mahnungspausen?companyId=${companyId}&customerId=${id}`,
                          )
                          setPauses(d)
                        } catch (e: any) {
                          setPauseError(
                            e?.message ||
                              t("common.error") ||
                              "Fehler",
                          )
                        } finally {
                          setPauseSaving(false)
                        }
                      }}
                      disabled={pauseSaving}
                      data-testid="customer-pause-submit"
                    >
                      {pauseSaving
                        ? t("common.saving") || "Speichern..."
                        : t("customerDetail.pauseAdd") || "Pause anlegen"}
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {tab === "credit" && (
        <Card>
          <CardContent className="pt-6">
            {creditLoading && <p className="text-gray-500">{t("common.loading") || "Lädt..."}</p>}
            {creditLedger && creditLedger.length === 0 && (
              <p
                className="text-center text-gray-500 py-8"
                data-testid="tab-credit-empty"
              >
                {t("customerDetail.noCreditLedger") || "Kein Guthaben-Verlauf"}
              </p>
            )}
            {creditLedger && creditLedger.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-sm" data-testid="tab-credit-table">
                  <thead className="border-b-2">
                    <tr className="text-left text-gray-500">
                      <th className="py-2 font-medium">{t("credit.colDate") || "Datum"}</th>
                      <th className="py-2 font-medium">{t("credit.colType") || "Art"}</th>
                      <th className="py-2 font-medium">{t("credit.colDescription") || "Beschreibung"}</th>
                      <th className="py-2 font-medium text-right">{t("credit.colAmount") || "Betrag"}</th>
                      <th className="py-2 font-medium text-right">{t("credit.colBalanceAfter") || "Saldo"}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {creditLedger.map((row) => (
                      <tr
                        key={row.id}
                        className="border-b hover:bg-gray-50 dark:hover:bg-gray-800"
                        data-testid="tab-credit-row"
                      >
                        <td className="py-2 whitespace-nowrap">{fmtDateDE(row.createdAt)}</td>
                        <td className="py-2">
                          <span
                            className={
                              "text-[10px] px-2 py-0.5 rounded font-medium " +
                              (row.amount > 0 ? "bg-blue-100 text-blue-800" : "bg-amber-100 text-amber-800")
                            }
                          >
                            {TYPE_LABEL[row.type] || row.type}
                          </span>
                        </td>
                        <td className="py-2 text-gray-600 dark:text-gray-300">
                          {row.description || "—"}
                        </td>
                        <td
                          className={
                            "py-2 text-right font-mono " +
                            (row.amount > 0 ? "text-blue-700" : "text-amber-700")
                          }
                        >
                          {row.amount > 0 ? "+" : ""}{fmtEur(row.amount)}
                        </td>
                        <td className="py-2 text-right font-mono font-medium">
                          {fmtEur(row.balanceAfter)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
