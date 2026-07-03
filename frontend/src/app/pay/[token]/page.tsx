"use client"

// Tier 33: customer self-service payment page.
// NO authentication — the URL token IS the auth. Anyone
// with the link can mark the invoice as paid. That's the
// whole point of a self-service portal: the customer
// doesn't need to log in.
//
// The page reads the token from useParams(), calls
// GET /api/v1/portal/:token, and renders the invoice +
// company summary. The customer clicks "Als bezahlt
// markieren" to POST /api/v1/portal/:token/mark-paid.
//
// Errors:
//   - 404 (token not found / expired / used / revoked):
//     show "Link ungültig" with a friendly hint.
//   - 5xx: retry button + the error message.
//
// No SSR guard here — we're hitting a public API directly
// (no x-user-id cookie). If the API is unreachable, we
// show the error inline rather than 500-ing the page.

import { useEffect, useState } from "react"
import { useParams } from "next/navigation"

interface PortalInvoiceItem {
  description: string
  quantity: string
  unit: string | null
  unitPrice: string
  vatRate: string
}

interface PortalView {
  invoice: {
    invoiceNumber: string
    issueDate: string
    dueDate: string | null
    currency: string
    subtotal: string
    totalVat: string
    total: string
    status: string
    customerName: string
    language: string
    items: PortalInvoiceItem[]
  }
  company: {
    name: string
    address: {
      street?: string
      postalCode?: string
      city?: string
      country?: string
    }
    bankInfo: {
      bankName?: string
      iban?: string
      bic?: string
    } | null
    vatId: string | null
    taxId: string | null
    email: string | null
  } | null
  link: {
    createdAt: string
    expiresAt: string
  }
}

const LOCALE: Record<string, string> = { de: "de-DE", en: "en-US", zh: "zh-CN" }

function formatMoney(value: string, currency: string, lang: string) {
  const locale = LOCALE[lang] ?? "de-DE"
  const n = parseFloat(value)
  if (Number.isNaN(n)) return `${value} ${currency}`
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: currency || "EUR",
    }).format(n)
  } catch {
    return `${n.toFixed(2)} ${currency}`
  }
}

function formatDate(value: string | null | undefined, lang: string) {
  if (!value) return "—"
  const locale = LOCALE[lang] ?? "de-DE"
  try {
    return new Intl.DateTimeFormat(locale, {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    }).format(new Date(value))
  } catch {
    return value
  }
}

const LABEL: Record<string, Record<string, string>> = {
  de: {
    title: "Rechnung bezahlen",
    subtitle: "Kundenportal — Selbstbedienung",
    invoiceNumber: "Rechnungsnummer",
    issueDate: "Rechnungsdatum",
    dueDate: "Fällig am",
    total: "Gesamtbetrag",
    from: "Rechnung von",
    items: "Positionen",
    description: "Beschreibung",
    quantity: "Menge",
    unitPrice: "Einzelpreis",
    bankInfo: "Bankverbindung",
    markPaid: "Als bezahlt markieren",
    marked: "✓ Vielen Dank! Wir haben Ihre Zahlung registriert.",
    paidAmount: "Gezahlter Betrag",
    linkExpires: "Dieser Link ist gültig bis",
    expired: "Dieser Link ist abgelaufen.",
    invalid: "Dieser Link ist nicht (mehr) gültig.",
    contactHint: "Fragen? Antworten Sie auf die E-Mail mit dem Link.",
    loading: "Lade Rechnung …",
    errorTitle: "Fehler",
    retry: "Erneut versuchen",
  },
  en: {
    title: "Pay invoice",
    subtitle: "Customer portal — self-service",
    invoiceNumber: "Invoice number",
    issueDate: "Issue date",
    dueDate: "Due",
    total: "Total",
    from: "Invoice from",
    items: "Line items",
    description: "Description",
    quantity: "Quantity",
    unitPrice: "Unit price",
    bankInfo: "Bank details",
    markPaid: "Mark as paid",
    marked: "✓ Thank you! We have recorded your payment.",
    paidAmount: "Paid amount",
    linkExpires: "This link is valid until",
    expired: "This link has expired.",
    invalid: "This link is no longer valid.",
    contactHint: "Questions? Reply to the email with the link.",
    loading: "Loading invoice …",
    errorTitle: "Error",
    retry: "Retry",
  },
  zh: {
    title: "支付发票",
    subtitle: "客户门户 — 自助服务",
    invoiceNumber: "发票编号",
    issueDate: "发票日期",
    dueDate: "到期日",
    total: "总计",
    from: "开票方",
    items: "明细",
    description: "描述",
    quantity: "数量",
    unitPrice: "单价",
    bankInfo: "银行信息",
    markPaid: "标记已支付",
    marked: "✓ 感谢您的支付,我们已登记。",
    paidAmount: "已付金额",
    linkExpires: "本链接有效期至",
    expired: "本链接已过期。",
    invalid: "本链接已失效。",
    contactHint: "有疑问?请回复含此链接的邮件。",
    loading: "正在加载发票…",
    errorTitle: "错误",
    retry: "重试",
  },
}

export default function PayByTokenPage() {
  const params = useParams()
  const token = (params?.token as string) || ""
  const [view, setView] = useState<PortalView | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<{
    kind: "not-found" | "network" | "other"
    message: string
  } | null>(null)
  const [marking, setMarking] = useState(false)
  const [markResult, setMarkResult] = useState<{
    alreadyPaid: boolean
    paidAt?: string
    amount?: string
  } | null>(null)

  const langFromInvoice =
    view?.invoice.language?.slice(0, 2) || "de"
  const supportedLang = ["de", "en", "zh"].includes(langFromInvoice)
    ? (langFromInvoice as "de" | "en" | "zh")
    : "de"
  const labels = LABEL[supportedLang] ?? LABEL.de

  const loadPortal = async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL || ""}/api/v1/portal/${encodeURIComponent(token)}`,
        {
          // Public route — no x-user-id cookie required.
          cache: "no-store",
        },
      )
      if (res.status === 404) {
        setError({ kind: "not-found", message: labels.invalid })
        setView(null)
        return
      }
      if (!res.ok) {
        const txt = await res.text().catch(() => "")
        throw new Error(`${res.status} ${res.statusText} ${txt}`)
      }
      const data = (await res.json()) as PortalView
      setView(data)
    } catch (e: any) {
      setError({
        kind: "network",
        message: e?.message || labels.errorTitle,
      })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (token) loadPortal()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  const markPaid = async () => {
    setMarking(true)
    try {
      const res = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL || ""}/api/v1/portal/${encodeURIComponent(token)}/mark-paid`,
        { method: "POST" },
      )
      if (!res.ok) {
        const txt = await res.text().catch(() => "")
        throw new Error(`${res.status} ${res.statusText} ${txt}`)
      }
      const data = await res.json()
      setMarkResult({
        alreadyPaid: !!data.alreadyPaid,
        paidAt: data.paidAt,
        amount: data.amount,
      })
    } catch (e: any) {
      setError({
        kind: "other",
        message: e?.message || labels.errorTitle,
      })
    } finally {
      setMarking(false)
    }
  }

  if (!token) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="text-center">{labels.invalid}</div>
      </div>
    )
  }

  if (loading && !view) {
    return (
      <div
        className="min-h-screen flex items-center justify-center p-4"
        data-testid="pay-loading"
      >
        <div className="text-center text-gray-500">{labels.loading}</div>
      </div>
    )
  }

  if (error && !view) {
    return (
      <div
        className="min-h-screen flex items-center justify-center p-4"
        data-testid="pay-error"
      >
        <div className="max-w-md text-center">
          <h1 className="text-2xl font-semibold mb-3">
            {error.kind === "not-found" ? labels.invalid : labels.errorTitle}
          </h1>
          <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">
            {error.message}
          </p>
          {error.kind !== "not-found" && (
            <button
              onClick={loadPortal}
              className="px-4 py-2 border rounded hover:bg-gray-100 dark:hover:bg-gray-700"
              data-testid="pay-retry"
            >
              {labels.retry}
            </button>
          )}
        </div>
      </div>
    )
  }

  if (!view) return null

  const { invoice, company, link } = view

  return (
    <div
      className="min-h-screen bg-gray-50 dark:bg-gray-900 py-12 px-4"
      data-testid="pay-portal-page"
    >
      <div className="max-w-2xl mx-auto">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-semibold text-gray-900 dark:text-gray-100">
            {labels.title}
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            {labels.subtitle}
          </p>
        </div>

        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6 space-y-6">
          {/* Header: company + invoice meta */}
          <div className="border-b border-gray-100 dark:border-gray-700 pb-4">
            {company && (
              <div className="text-sm text-gray-700 dark:text-gray-300">
                <div className="font-semibold text-base">
                  {company.name}
                </div>
                {company.address?.street && <div>{company.address.street}</div>}
                {(company.address?.postalCode || company.address?.city) && (
                  <div>
                    {company.address?.postalCode} {company.address?.city}
                  </div>
                )}
                {company.address?.country && (
                  <div>{company.address.country}</div>
                )}
                {company.vatId && (
                  <div className="text-xs text-gray-500 mt-1">
                    {supportedLang === "en" ? "VAT ID" : supportedLang === "zh" ? "增值税号" : "USt-ID"}: {company.vatId}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
            <div>
              <div className="text-gray-500">
                {labels.invoiceNumber}
              </div>
              <div
                className="font-mono"
                data-testid="pay-invoice-number"
              >
                {invoice.invoiceNumber}
              </div>
            </div>
            <div>
              <div className="text-gray-500">{labels.issueDate}</div>
              <div>{formatDate(invoice.issueDate, supportedLang)}</div>
            </div>
            <div>
              <div className="text-gray-500">{labels.dueDate}</div>
              <div>{formatDate(invoice.dueDate, supportedLang)}</div>
            </div>
            <div>
              <div className="text-gray-500">{labels.total}</div>
              <div
                className="text-2xl font-semibold"
                data-testid="pay-total"
              >
                {formatMoney(invoice.total, invoice.currency, supportedLang)}
              </div>
            </div>
          </div>

          {/* Items */}
          <div>
            <h2 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              {labels.items}
            </h2>
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-gray-500 uppercase">
                <tr>
                  <th className="py-1">{labels.description}</th>
                  <th className="py-1 text-right">{labels.quantity}</th>
                  <th className="py-1 text-right">{labels.unitPrice}</th>
                </tr>
              </thead>
              <tbody>
                {invoice.items.map((it, i) => (
                  <tr key={i} className="border-t border-gray-100 dark:border-gray-700">
                    <td className="py-2">{it.description}</td>
                    <td className="py-2 text-right font-mono">
                      {it.quantity} {it.unit || ""}
                    </td>
                    <td className="py-2 text-right font-mono">
                      {formatMoney(it.unitPrice, invoice.currency, supportedLang)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Bank info */}
          {company?.bankInfo && (company.bankInfo.iban || company.bankInfo.bankName) && (
            <div className="border-t border-gray-100 dark:border-gray-700 pt-4 text-sm">
              <h2 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                {labels.bankInfo}
              </h2>
              <div className="text-gray-700 dark:text-gray-300 space-y-1">
                {company.bankInfo.bankName && (
                  <div>{company.bankInfo.bankName}</div>
                )}
                {company.bankInfo.iban && (
                  <div className="font-mono text-xs">{company.bankInfo.iban}</div>
                )}
                {company.bankInfo.bic && (
                  <div className="font-mono text-xs">BIC: {company.bankInfo.bic}</div>
                )}
              </div>
            </div>
          )}

          {/* Mark as paid or already-paid confirmation */}
          <div className="border-t border-gray-100 dark:border-gray-700 pt-4">
            {markResult ? (
              <div
                className="p-3 bg-emerald-50 dark:bg-emerald-900/30 text-emerald-800 dark:text-emerald-200 rounded text-sm"
                data-testid="pay-marked"
              >
                {labels.marked}
                {markResult.amount && (
                  <span className="block mt-1 text-xs">
                    {labels.paidAmount}:{" "}
                    {formatMoney(markResult.amount, invoice.currency, supportedLang)}
                  </span>
                )}
              </div>
            ) : (
              <div className="flex justify-end">
                <button
                  onClick={markPaid}
                  disabled={marking}
                  className="px-6 py-2 bg-emerald-600 text-white rounded hover:bg-emerald-700 disabled:opacity-50"
                  data-testid="pay-mark-paid"
                >
                  {marking ? "…" : labels.markPaid}
                </button>
              </div>
            )}
          </div>

          <div className="text-xs text-gray-400 text-center">
            {labels.linkExpires}{" "}
            {formatDate(link.expiresAt, supportedLang)}
          </div>
        </div>

        {company?.email && (
          <div className="text-center text-xs text-gray-500 mt-4">
            {labels.contactHint} <span className="font-mono">{company.email}</span>
          </div>
        )}
      </div>
    </div>
  )
}