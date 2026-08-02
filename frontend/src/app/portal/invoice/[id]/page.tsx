"use client"

/**
 * Tier 133: customer portal invoice detail page.
 *
 * Public — no admin auth. Reads `?token=…` from the
 * URL and calls GET /customer-portal/invoice/:id to
 * load the full invoice (line items + payments).
 *
 * Renders:
 *   - Header: invoice number, type badge, status badge,
 *     issue / due dates, "days overdue" hint
 *   - 3 summary tiles: Total / Bezahlt / Verbleibend
 *   - Line items table (Beschreibung / Menge / Einzelpreis
 *     / MwSt / Netto / Brutto)
 *   - Payment history (Datum / Betrag / Methode)
 *   - "Zurück zur Übersicht" link
 *   - "PDF herunterladen" + "Als bezahlt markieren"
 *     buttons (the mark-paid flow is the same as the
 *     list page; clicking it refreshes the data so
 *     the payment shows up in the history)
 *
 * Token comes from the URL (not localStorage) so the
 * customer can bookmark the page.
 */
import { Suspense, useEffect, useState } from "react"
import { useParams, useRouter, useSearchParams } from "next/navigation"
import { apiGet, apiPost, ApiError } from "@/lib/api"
import { useI18n } from "@/components/useI18n"

interface PortalInvoiceDetail {
  id: string
  invoiceNumber: string
  type: string
  status: string
  issueDate: string
  dueDate: string
  subtotal: string
  totalVat: string
  total: string
  currency: string
  notes: string | null
  items: Array<{
    id: string
    description: string
    quantity: string | number
    unit: string | null
    unitPrice: string | number
    vatRate: string | number
    netAmount: string | number
    vatAmount: string | number
    grossAmount: string | number
  }>
  payments: Array<{
    id: string
    amount: string | number
    currency: string
    paymentDate: string
    paymentMethod: string
    reference: string | null
    notes: string | null
  }>
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
    return <span className="px-2 py-0.5 rounded text-xs bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300" data-testid="portal-invoice-status">{t("portal.statusPaid") || "Bezahlt"}</span>
  }
  if (status === "cancelled") {
    return <span className="px-2 py-0.5 rounded text-xs bg-gray-200 text-gray-700 dark:bg-gray-700 dark:text-gray-300">{t("portal.statusCancelled") || "Storniert"}</span>
  }
  if (daysOverdue > 0) {
    return <span className="px-2 py-0.5 rounded text-xs bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300">{t("portal.statusOverdue") || "Überfällig"} ({daysOverdue} {t("portal.days") || "Tage"})</span>
  }
  return <span className="px-2 py-0.5 rounded text-xs bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300">{t("portal.statusOpen") || "Offen"}</span>
}

function PortalInvoiceDetailInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const params = useParams<{ id: string }>()
  const { t } = useI18n()
  const token = searchParams.get("token") || ""
  const invoiceId = params?.id || ""
  const [inv, setInv] = useState<PortalInvoiceDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!token || !invoiceId) {
      setError(t("portal.missingToken") || "Kein Token in der URL. Bitte fordern Sie einen neuen Login-Link an.")
      setLoading(false)
      return
    }
    let cancelled = false
    apiGet<PortalInvoiceDetail>(
      `/api/v1/customer-portal/invoice/${encodeURIComponent(invoiceId)}?token=${encodeURIComponent(token)}`,
    )
      .then((d) => { if (!cancelled) { setInv(d); setLoading(false) } })
      .catch((err) => {
        if (cancelled) return
        if (err instanceof ApiError && err.status === 401) {
          setError(t("portal.expiredLink") || "Ihr Login-Link ist abgelaufen oder ungültig. Bitte fordern Sie einen neuen an.")
        } else if (err instanceof ApiError && err.status === 404) {
          setError(t("portal.invoiceNotFound") || "Diese Rechnung gehört nicht zu Ihrem Konto.")
        } else {
          setError(err instanceof ApiError ? err.message : String(err))
        }
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [token, invoiceId, t])

  const downloadPdf = () => {
    if (!token || !invoiceId) return
    window.open(
      `/api/v1/customer-portal/invoice/${invoiceId}/pdf?token=${encodeURIComponent(token)}`,
      "_blank",
    )
  }

  const markPaid = async () => {
    if (!token || !invoiceId || busy) return
    if (!confirm(t("portal.markPaidConfirm") || "Diese Rechnung als bezahlt markieren?")) return
    setBusy(true)
    try {
      await apiPost(
        `/api/v1/customer-portal/invoice/${invoiceId}/mark-paid?token=${encodeURIComponent(token)}`,
      )
      // Re-fetch the detail so the payment shows in history
      const d = await apiGet<PortalInvoiceDetail>(
        `/api/v1/customer-portal/invoice/${encodeURIComponent(invoiceId)}?token=${encodeURIComponent(token)}`,
      )
      setInv(d)
    } catch (err) {
      alert(err instanceof ApiError ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  if (loading) {
    return (
      <main className="min-h-screen bg-gray-50 dark:bg-gray-900 flex items-center justify-center">
        <p className="text-gray-500 dark:text-gray-400" data-testid="portal-loading">⏳</p>
      </main>
    )
  }

  if (error || !inv) {
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
            onClick={() => router.push(token ? `/portal?token=${encodeURIComponent(token)}` : "/portal/login")}
            className="bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-md px-4 py-2 text-sm"
            data-testid="portal-back-to-list"
          >
            {t("portal.requestNew") || "Neuen Login-Link anfordern"}
          </button>
        </div>
      </main>
    )
  }

  // Compute summary
  const totalPaid = inv.payments.reduce((s, p) => s + Number(p.amount), 0)
  const totalNum = Number(inv.total)
  const remaining = Math.max(0, totalNum - totalPaid)
  const dueDate = inv.dueDate ? new Date(inv.dueDate) : null
  const daysOverdue =
    dueDate && dueDate < new Date() && inv.status !== "paid" && inv.status !== "cancelled"
      ? Math.floor((Date.now() - dueDate.getTime()) / 86_400_000)
      : 0
  const typeLabel = inv.type === "CN" ? (t("portal.creditNote") || "Gutschrift") : (t("portal.invoice") || "Rechnung")

  return (
    <main className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <header className="bg-white dark:bg-gray-800 border-b shadow-sm">
        <div className="container mx-auto px-3 sm:px-4 py-3 sm:py-4">
          <button
            onClick={() => router.push(`/portal?token=${encodeURIComponent(token)}`)}
            className="text-xs text-blue-600 dark:text-blue-400 hover:underline mb-2 inline-block"
            data-testid="portal-back-to-overview"
          >
            ← {t("portal.backToOverview") || "Zurück zur Übersicht"}
          </button>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-xl sm:text-2xl font-bold text-gray-900 dark:text-gray-100" data-testid="portal-invoice-number">
              {typeLabel} {inv.invoiceNumber}
            </h1>
            {statusBadge(inv.status, daysOverdue, t)}
            {daysOverdue > 0 && (
              <span className="text-sm text-red-600 dark:text-red-400 font-medium">
                ({daysOverdue} {t("portal.daysOverdue") || "Tage überfällig"})
              </span>
            )}
          </div>
          <div className="text-xs text-gray-500 dark:text-gray-400 mt-1 flex flex-wrap gap-x-4">
            <span>{t("portal.issueDate") || "Rechnungsdatum"}: {fmtDate(inv.issueDate)}</span>
            <span>{t("portal.dueDate") || "Fällig"}: {fmtDate(inv.dueDate)}</span>
          </div>
        </div>
      </header>

      <div className="container mx-auto px-3 sm:px-4 py-4 sm:py-8">
        {/* Summary tiles */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6" data-testid="portal-invoice-summary">
          <div className="bg-white dark:bg-gray-800 rounded-lg p-4 shadow-sm border border-gray-200 dark:border-gray-700">
            <p className="text-xs text-gray-500 dark:text-gray-400 uppercase">
              {t("portal.total") || "Gesamtbetrag"}
            </p>
            <p className="text-2xl font-bold mt-1 text-gray-900 dark:text-gray-100">
              {fmtEur(totalNum, inv.currency)}
            </p>
          </div>
          <div className="bg-white dark:bg-gray-800 rounded-lg p-4 shadow-sm border border-gray-200 dark:border-gray-700">
            <p className="text-xs text-gray-500 dark:text-gray-400 uppercase">
              {t("portal.paidAlready") || "Bereits bezahlt"}
            </p>
            <p className="text-2xl font-bold mt-1 text-emerald-700 dark:text-emerald-400">
              {fmtEur(totalPaid, inv.currency)}
            </p>
          </div>
          <div className="bg-white dark:bg-gray-800 rounded-lg p-4 shadow-sm border border-gray-200 dark:border-gray-700">
            <p className="text-xs text-gray-500 dark:text-gray-400 uppercase">
              {t("portal.remaining") || "Verbleibend"}
            </p>
            <p className={`text-2xl font-bold mt-1 ${remaining > 0 ? "text-amber-700 dark:text-amber-400" : "text-emerald-700 dark:text-emerald-400"}`}>
              {fmtEur(remaining, inv.currency)}
            </p>
          </div>
        </div>

        {/* Line items */}
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 mb-6 overflow-x-auto">
          <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700">
            <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300 uppercase">
              {t("portal.lineItems") || "Positionen"}
            </h2>
          </div>
          <table className="w-full min-w-[640px] text-sm" data-testid="portal-invoice-items-table">
            <thead className="bg-gray-50 dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-300">
                  {t("portal.colDescription") || "Beschreibung"}
                </th>
                <th className="text-right px-4 py-3 font-medium text-gray-600 dark:text-gray-300">
                  {t("portal.colQty") || "Menge"}
                </th>
                <th className="text-right px-4 py-3 font-medium text-gray-600 dark:text-gray-300">
                  {t("portal.colUnitPrice") || "Einzelpreis"}
                </th>
                <th className="text-right px-4 py-3 font-medium text-gray-600 dark:text-gray-300">
                  {t("portal.colVat") || "MwSt"}
                </th>
                <th className="text-right px-4 py-3 font-medium text-gray-600 dark:text-gray-300">
                  {t("portal.colNet") || "Netto"}
                </th>
                <th className="text-right px-4 py-3 font-medium text-gray-600 dark:text-gray-300">
                  {t("portal.colGross") || "Brutto"}
                </th>
              </tr>
            </thead>
            <tbody>
              {inv.items.map((it) => (
                <tr key={it.id} className="border-b border-gray-100 dark:border-gray-700 last:border-b-0" data-testid={`portal-item-row-${it.id}`}>
                  <td className="px-4 py-3">
                    <div className="font-medium">{it.description}</div>
                    {it.unit && <div className="text-xs text-gray-400 mt-0.5">{it.unit}</div>}
                  </td>
                  <td className="px-4 py-3 text-right font-mono">{Number(it.quantity).toLocaleString("de-DE")}</td>
                  <td className="px-4 py-3 text-right font-mono">{fmtEur(Number(it.unitPrice), inv.currency)}</td>
                  <td className="px-4 py-3 text-right font-mono">
                    {(Number(it.vatRate) * 100).toFixed(0)}%
                  </td>
                  <td className="px-4 py-3 text-right font-mono">{fmtEur(Number(it.netAmount), inv.currency)}</td>
                  <td className="px-4 py-3 text-right font-mono font-medium">{fmtEur(Number(it.grossAmount), inv.currency)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-gray-300 dark:border-gray-600">
                <td colSpan={4} className="px-4 py-3 text-right text-sm text-gray-600 dark:text-gray-300">
                  {t("portal.subtotal") || "Zwischensumme"}:
                </td>
                <td className="px-4 py-3 text-right font-mono">{fmtEur(Number(inv.subtotal), inv.currency)}</td>
                <td className="px-4 py-3 text-right font-mono font-medium">{fmtEur(Number(inv.total), inv.currency)}</td>
              </tr>
            </tfoot>
          </table>
        </div>

        {/* Notes */}
        {inv.notes && (
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-4 mb-6 text-sm">
            <p className="text-xs font-semibold text-gray-700 dark:text-gray-300 uppercase mb-1">
              {t("portal.notes") || "Notizen"}
            </p>
            <p className="text-gray-700 dark:text-gray-300 whitespace-pre-wrap">{inv.notes}</p>
          </div>
        )}

        {/* Payment history */}
        {inv.payments.length > 0 && (
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 mb-6 overflow-x-auto">
            <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700">
              <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300 uppercase">
                {t("portal.paymentHistory") || "Zahlungshistorie"}
              </h2>
            </div>
            <table className="w-full text-sm" data-testid="portal-payment-history">
              <thead className="bg-gray-50 dark:bg-gray-900">
                <tr>
                  <th className="text-left px-4 py-2 font-medium text-gray-600 dark:text-gray-300">
                    {t("portal.colDate") || "Datum"}
                  </th>
                  <th className="text-left px-4 py-2 font-medium text-gray-600 dark:text-gray-300">
                    {t("portal.colMethod") || "Methode"}
                  </th>
                  <th className="text-left px-4 py-2 font-medium text-gray-600 dark:text-gray-300">
                    {t("portal.colReference") || "Referenz"}
                  </th>
                  <th className="text-right px-4 py-2 font-medium text-gray-600 dark:text-gray-300">
                    {t("portal.colAmount") || "Betrag"}
                  </th>
                </tr>
              </thead>
              <tbody>
                {inv.payments.map((p) => (
                  <tr key={p.id} className="border-b border-gray-100 dark:border-gray-700 last:border-b-0" data-testid={`portal-payment-row-${p.id}`}>
                    <td className="px-4 py-2">{fmtDate(p.paymentDate)}</td>
                    <td className="px-4 py-2">{p.paymentMethod}</td>
                    <td className="px-4 py-2 text-gray-500 dark:text-gray-400">{p.reference || "—"}</td>
                    <td className="px-4 py-2 text-right font-mono font-medium">{fmtEur(Number(p.amount), p.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Action bar */}
        <div className="flex gap-2 justify-end flex-wrap">
          <button
            onClick={downloadPdf}
            className="text-sm bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300 font-medium rounded-md px-4 py-2"
            data-testid="portal-invoice-pdf-button"
          >
            📄 {t("portal.pdf") || "PDF herunterladen"}
          </button>
          {inv.status !== "paid" && inv.status !== "cancelled" && (
            <button
              onClick={markPaid}
              disabled={busy}
              className="text-sm bg-emerald-600 hover:bg-emerald-700 text-white font-medium rounded-md px-4 py-2 disabled:opacity-50"
              data-testid="portal-invoice-markpaid-button"
            >
              {busy
                ? "⏳"
                : `✓ ${t("portal.markPaid") || "Als bezahlt markieren"}`}
            </button>
          )}
        </div>
      </div>
    </main>
  )
}

export default function PortalInvoiceDetailPage() {
  return (
    <Suspense fallback={
      <main className="min-h-screen bg-gray-50 dark:bg-gray-900 flex items-center justify-center">
        <p className="text-gray-500 dark:text-gray-400">⏳</p>
      </main>
    }>
      <PortalInvoiceDetailInner />
    </Suspense>
  )
}
