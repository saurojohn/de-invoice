"use client"

/**
 * Tier 131: customer portal main page.
 *
 * Public — no admin auth. Reads `?token=…` from the
 * URL and calls GET /customer-portal/invoices. Shows:
 *   - Customer name + customer number + address
 *   - Summary tiles (open / overdue / paid totals)
 *   - Invoice list table (number, date, due, total, status)
 *   - "Download PDF" button per row
 *   - "Mark as paid" button for non-paid rows
 *
 * Token comes from the URL (not localStorage) so the
 * customer can bookmark the page and come back later
 * (until the 30-day session expires).
 */
import { Suspense, useEffect, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { apiGet, apiPost, ApiError } from "@/lib/api"
import { useI18n } from "@/components/useI18n"

interface PortalCustomer {
  id: string
  name: string
  customerNumber: string | null
  type: string
  address: any
}

interface PortalInvoice {
  id: string
  invoiceNumber: string
  issueDate: string
  dueDate: string
  total: string
  currency: string
  status: string
  type: string
  daysOverdue: number
}

interface PortalSummary {
  totalOpen: number
  totalOverdue: number
  totalPaid: number
  currency: string
  invoiceCount: number
}

interface PortalData {
  customer: PortalCustomer
  invoices: PortalInvoice[]
  summary: PortalSummary
  session: { expiresAt: string; lastUsedAt: string | null }
}

function fmtEur(n: number, currency: string = "EUR"): string {
  try {
    return new Intl.NumberFormat("de-DE", {
      style: "currency",
      currency,
    }).format(n)
  } catch {
    return `${n.toFixed(2)} ${currency}`
  }
}

function fmtDate(iso: string): string {
  if (!iso) return "—"
  try {
    return new Intl.DateTimeFormat("de-DE", {
      day: "2-digit", month: "2-digit", year: "numeric",
    }).format(new Date(iso))
  } catch {
    return iso.slice(0, 10)
  }
}

function statusBadge(status: string, daysOverdue: number, t: any) {
  if (status === "paid") {
    return <span className="px-2 py-0.5 rounded text-xs bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300">{t("portal.statusPaid") || "Bezahlt"}</span>
  }
  if (status === "cancelled") {
    return <span className="px-2 py-0.5 rounded text-xs bg-gray-200 text-gray-700 dark:bg-gray-700 dark:text-gray-300">{t("portal.statusCancelled") || "Storniert"}</span>
  }
  if (daysOverdue > 0) {
    return <span className="px-2 py-0.5 rounded text-xs bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300">{t("portal.statusOverdue") || "Überfällig"} ({daysOverdue} {t("portal.days") || "Tage"})</span>
  }
  if (status === "draft") {
    return <span className="px-2 py-0.5 rounded text-xs bg-gray-200 text-gray-700 dark:bg-gray-700 dark:text-gray-300">{t("portal.statusDraft") || "Entwurf"}</span>
  }
  return <span className="px-2 py-0.5 rounded text-xs bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300">{t("portal.statusOpen") || "Offen"}</span>
}

function PortalPageInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { t } = useI18n()
  const token = searchParams.get("token") || ""
  const [data, setData] = useState<PortalData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyInvoiceId, setBusyInvoiceId] = useState<string | null>(null)

  useEffect(() => {
    if (!token) {
      setError(t("portal.missingToken") || "Kein Token in der URL. Bitte fordern Sie einen neuen Login-Link an.")
      setLoading(false)
      return
    }
    let cancelled = false
    apiGet<PortalData>(`/api/v1/customer-portal/invoices?token=${encodeURIComponent(token)}`)
      .then((d) => { if (!cancelled) { setData(d); setLoading(false) } })
      .catch((err) => {
        if (cancelled) return
        if (err instanceof ApiError && err.status === 401) {
          setError(t("portal.expiredLink") || "Ihr Login-Link ist abgelaufen oder ungültig. Bitte fordern Sie einen neuen an.")
        } else {
          setError(err instanceof ApiError ? err.message : String(err))
        }
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [token, t])

  const downloadPdf = (invoiceId: string) => {
    if (!token) return
    // The PDF endpoint sets Content-Disposition: inline.
    // We want an actual download — open in a new tab
    // and let the browser handle the save dialog (most
    // browsers will respect the inline disposition +
    // filename parameter for a download).
    window.open(
      `/api/v1/customer-portal/invoice/${invoiceId}/pdf?token=${encodeURIComponent(token)}`,
      "_blank",
    )
  }

  const markPaid = async (invoiceId: string) => {
    if (!token || busyInvoiceId) return
    if (!confirm(t("portal.markPaidConfirm") || "Diese Rechnung als bezahlt markieren?")) return
    setBusyInvoiceId(invoiceId)
    try {
      await apiPost(
        `/api/v1/customer-portal/invoice/${invoiceId}/mark-paid?token=${encodeURIComponent(token)}`,
      )
      // Re-fetch to update the list
      const d = await apiGet<PortalData>(`/api/v1/customer-portal/invoices?token=${encodeURIComponent(token)}`)
      setData(d)
    } catch (err) {
      alert(err instanceof ApiError ? err.message : String(err))
    } finally {
      setBusyInvoiceId(null)
    }
  }

  if (loading) {
    return (
      <main className="min-h-screen bg-gray-50 dark:bg-gray-900 flex items-center justify-center">
        <p className="text-gray-500 dark:text-gray-400" data-testid="portal-loading">⏳</p>
      </main>
    )
  }

  if (error || !data) {
    return (
      <main className="min-h-screen bg-gradient-to-b from-gray-50 to-gray-100 dark:from-gray-900 dark:to-gray-800 flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-white dark:bg-gray-800 shadow-lg rounded-lg p-8 text-center">
          <div className="text-4xl mb-3">🔗</div>
          <h1 className="text-xl font-bold mb-3 text-gray-900 dark:text-gray-100">
            {t("portal.linkInvalid") || "Link ungültig"}
          </h1>
          <p className="text-sm text-gray-600 dark:text-gray-400 mb-6" data-testid="portal-error">
            {error}
          </p>
          <button
            onClick={() => router.push("/portal/login")}
            className="bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-md px-4 py-2 text-sm"
            data-testid="portal-back-to-login"
          >
            {t("portal.requestNew") || "Neuen Login-Link anfordern"}
          </button>
        </div>
      </main>
    )
  }

  const { customer, invoices, summary } = data
  const address = customer.address || {}
  const fullAddress = [address.street, [address.postalCode, address.city].filter(Boolean).join(" "), address.country]
    .filter(Boolean)
    .join(", ")

  return (
    <main className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <header className="bg-white dark:bg-gray-800 border-b shadow-sm">
        <div className="container mx-auto px-3 sm:px-4 py-3 sm:py-4 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="text-xl sm:text-2xl font-bold text-gray-900 dark:text-gray-100" data-testid="portal-customer-name">
              {customer.name}
            </h1>
            {customer.customerNumber && (
              <p className="text-xs text-gray-500 dark:text-gray-400 font-mono mt-0.5">
                {customer.customerNumber}
              </p>
            )}
            {fullAddress && (
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{fullAddress}</p>
            )}
          </div>
          <div className="text-right">
            <button
              onClick={() => router.push("/portal/login")}
              className="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 underline"
            >
              {t("portal.logout") || "Abmelden"}
            </button>
          </div>
        </div>
      </header>

      <div className="container mx-auto px-3 sm:px-4 py-4 sm:py-8">
        {/* Summary tiles */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6" data-testid="portal-summary">
          <div className="bg-white dark:bg-gray-800 rounded-lg p-4 shadow-sm border border-gray-200 dark:border-gray-700">
            <p className="text-xs text-gray-500 dark:text-gray-400 uppercase">
              {t("portal.openBalance") || "Offener Saldo"}
            </p>
            <p className="text-2xl font-bold mt-1 text-gray-900 dark:text-gray-100">
              {fmtEur(summary.totalOpen, summary.currency)}
            </p>
            <p className="text-xs text-gray-400 mt-1">
              {summary.invoiceCount} {t("portal.invoices") || "Rechnungen"}
            </p>
          </div>
          <div className="bg-white dark:bg-gray-800 rounded-lg p-4 shadow-sm border border-gray-200 dark:border-gray-700">
            <p className="text-xs text-gray-500 dark:text-gray-400 uppercase">
              {t("portal.overdue") || "Überfällig"}
            </p>
            <p className={`text-2xl font-bold mt-1 ${summary.totalOverdue > 0 ? "text-red-600 dark:text-red-400" : "text-gray-900 dark:text-gray-100"}`}>
              {fmtEur(summary.totalOverdue, summary.currency)}
            </p>
          </div>
          <div className="bg-white dark:bg-gray-800 rounded-lg p-4 shadow-sm border border-gray-200 dark:border-gray-700">
            <p className="text-xs text-gray-500 dark:text-gray-400 uppercase">
              {t("portal.paidYTD") || "Bezahlt (Gesamt)"}
            </p>
            <p className="text-2xl font-bold mt-1 text-emerald-700 dark:text-emerald-400">
              {fmtEur(summary.totalPaid, summary.currency)}
            </p>
          </div>
        </div>

        {/* Invoice list */}
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm" data-testid="portal-invoice-table">
            <thead className="bg-gray-50 dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-300">
                  {t("portal.colNumber") || "Nr."}
                </th>
                <th className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-300">
                  {t("portal.colDate") || "Datum"}
                </th>
                <th className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-300">
                  {t("portal.colDue") || "Fällig"}
                </th>
                <th className="text-right px-4 py-3 font-medium text-gray-600 dark:text-gray-300">
                  {t("portal.colAmount") || "Betrag"}
                </th>
                <th className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-300">
                  {t("portal.colStatus") || "Status"}
                </th>
                <th className="text-right px-4 py-3 font-medium text-gray-600 dark:text-gray-300">
                  {t("portal.colActions") || "Aktionen"}
                </th>
              </tr>
            </thead>
            <tbody>
              {invoices.length === 0 ? (
                <tr>
                  <td colSpan={6} className="text-center py-8 text-gray-500">
                    {t("portal.noInvoices") || "Noch keine Rechnungen."}
                  </td>
                </tr>
              ) : (
                invoices.map((inv) => (
                  <tr
                    key={inv.id}
                    className="border-b border-gray-100 dark:border-gray-700 last:border-b-0"
                    data-testid={`portal-invoice-row-${inv.invoiceNumber}`}
                  >
                    <td className="px-4 py-3 font-mono">
                      {/* Tier 133: clickable invoice number
                          links to the detail page with the
                          session token. The user can also
                          just download the PDF or mark-paid
                          from the row directly — these are
                          quick actions. The detail view is
                          for the full breakdown (line items
                          + payment history). */}
                      <a
                        href={`/portal/invoice/${inv.id}?token=${encodeURIComponent(token)}`}
                        className="text-blue-600 dark:text-blue-400 hover:underline"
                        data-testid={`portal-invoice-link-${inv.invoiceNumber}`}
                      >
                        {inv.invoiceNumber}
                      </a>
                    </td>
                    <td className="px-4 py-3">{fmtDate(inv.issueDate)}</td>
                    <td className="px-4 py-3">
                      {fmtDate(inv.dueDate)}
                      {inv.daysOverdue > 0 && (
                        <span className="ml-2 text-xs text-red-600 dark:text-red-400 font-medium">
                          (+{inv.daysOverdue})
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right font-medium">
                      {fmtEur(Number(inv.total), inv.currency)}
                    </td>
                    <td className="px-4 py-3">{statusBadge(inv.status, inv.daysOverdue, t)}</td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex gap-2 justify-end flex-wrap">
                        <button
                          onClick={() => downloadPdf(inv.id)}
                          className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
                          data-testid={`portal-pdf-button-${inv.invoiceNumber}`}
                        >
                          📄 {t("portal.pdf") || "PDF"}
                        </button>
                        {inv.status !== "paid" && inv.status !== "cancelled" && (
                          <button
                            onClick={() => markPaid(inv.id)}
                            disabled={busyInvoiceId === inv.id}
                            className="text-xs text-emerald-600 dark:text-emerald-400 hover:underline disabled:opacity-50"
                            data-testid={`portal-markpaid-button-${inv.invoiceNumber}`}
                          >
                            {busyInvoiceId === inv.id
                              ? "⏳"
                              : `✓ ${t("portal.markPaid") || "Bezahlt"}`}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  )
}

export default function PortalPage() {
  return (
    <Suspense fallback={
      <main className="min-h-screen bg-gray-50 dark:bg-gray-900 flex items-center justify-center">
        <p className="text-gray-500 dark:text-gray-400">⏳</p>
      </main>
    }>
      <PortalPageInner />
    </Suspense>
  )
}
