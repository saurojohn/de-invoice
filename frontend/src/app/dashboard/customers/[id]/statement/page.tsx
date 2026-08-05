"use client"

import { useEffect, useState } from "react"
import { useParams, useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { ErrorBanner } from "@/components/ui/error-banner"
import { useI18n } from "@/components/useI18n"
import { apiGet, apiPost, apiFetch, ApiError } from "@/lib/api"

interface StatementLine {
  date: string
  type: "invoice" | "credit" | "payment"
  reference: string
  description: string
  amount: number
  balance: number
  docId?: string
}

interface CustomerStatement {
  customer: {
    id: string
    name: string
    customerNumber: string | null
    address: Record<string, any>
    vatId: string | null
  }
  period: { from: string; to: string }
  openingBalance: number
  lines: StatementLine[]
  closingBalance: number
  // Tier 58: customer's running credit balance
  // (Kundenguthaben) — separate from the period
  // closingBalance. Reflects overpayments + Gutschrift
  // overages accumulated over the customer's whole
  // lifetime, less any Auszahlung / apply-to-invoice.
  creditBalance: number
  totals: {
    invoicesCount: number
    invoicesAmount: number
    paymentsCount: number
    paymentsAmount: number
    creditsCount: number
    creditsAmount: number
    openAmount: number
  }
  generatedAt: string
}

// German / English / Chinese number formats
function fmtEur(n: number, locale: string = "de-DE"): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n)
}

function fmtDateDE(d: string): string {
  const date = new Date(d)
  const day = String(date.getUTCDate()).padStart(2, "0")
  const month = String(date.getUTCMonth() + 1).padStart(2, "0")
  return `${day}.${month}.${date.getUTCFullYear()}`
}

// Default period: previous calendar month (the most common
// "monthly statement" use case in Germany).
function defaultRange(): { from: string; to: string } {
  const now = new Date()
  // First day of current month
  const firstOfThisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  // Last day of previous month
  const lastOfPrevMonth = new Date(firstOfThisMonth.getTime() - 1)
  const from = new Date(Date.UTC(lastOfPrevMonth.getUTCFullYear(), lastOfPrevMonth.getUTCMonth(), 1))
  return {
    from: from.toISOString().slice(0, 10),
    to: lastOfPrevMonth.toISOString().slice(0, 10),
  }
}

export default function CustomerStatementPage() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const { t } = useI18n()

  const [companyId, setCompanyId] = useState<string | null>(null)
  const [customerName, setCustomerName] = useState<string>("")
  const initial = defaultRange()
  const [from, setFrom] = useState(initial.from)
  const [to, setTo] = useState(initial.to)
  // Display order. Default DESC = newest first (customer's
  // natural reading order — see latest activity at the top).
  // ASC is the accountant's chronological paper-trail view.
  const [order, setOrder] = useState<"desc" | "asc">("desc")

  const [statement, setStatement] = useState<CustomerStatement | null>(null)
  const [loading, setLoading] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const cid = localStorage.getItem("companyId")
    if (!cid) {
      router.push("/dashboard/login")
      return
    }
    setCompanyId(cid)

    // Best-effort: load customer name from /customers list
    // cache so the header isn't blank while the JSON loads.
    apiGet<{ data: Array<{ id: string; name: string }> }>(
      `/api/v1/customers?companyId=${cid}&take=200`
    )
      .then((res) => {
        const c = res.data.find((x) => x.id === id)
        if (c) setCustomerName(c.name)
      })
      .catch(() => { /* non-fatal */ })
  }, [id, router])

  const fetchStatement = async () => {
    if (!companyId) return
    setLoading(true)
    setError(null)
    try {
      const data = await apiGet<CustomerStatement>(
        `/api/v1/customers/${id}/statement?companyId=${companyId}&from=${from}&to=${to}&order=${order}`
      )
      setStatement(data)
    } catch (e: any) {
      if (e instanceof ApiError) {
        setError(e.message)
      } else {
        setError(String(e?.message || e))
      }
    } finally {
      setLoading(false)
    }
  }

  const downloadPDF = async () => {
    if (!companyId) return
    setDownloading(true)
    try {
      const res = await apiFetch(
        `/api/v1/customers/${id}/statement.pdf?companyId=${companyId}&from=${from}&to=${to}&order=${order}`,
        { throwOnError: false }
      )
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        alert(data.message || `Download fehlgeschlagen (HTTP ${res.status})`)
        return
      }
      const blob = await res.blob()
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      const num = statement?.customer.customerNumber || id.slice(0, 8)
      a.download = `Kontoauszug_${num}_${from}_${to}.pdf`
      document.body.appendChild(a)
      a.click()
      window.URL.revokeObjectURL(url)
      document.body.removeChild(a)
    } catch (err) {
      console.error("Download fehlgeschlagen:", err)
      alert("Download fehlgeschlagen")
    } finally {
      setDownloading(false)
    }
  }

  // Tier 154: send the statement by email.
  // Same period as the displayed statement.
  // We don't gate on `statement` being present
  // (the user might want to email a different
  // range — they just changed the inputs).
  // We DO require a customerId to be in the URL
  // — the parent page already gates on that.
  const [sendingEmail, setSendingEmail] = useState(false)
  const [emailResult, setEmailResult] = useState<{
    kind: "ok" | "err"
    msg: string
  } | null>(null)
  const sendByEmail = async () => {
    if (!companyId) return
    setSendingEmail(true)
    setEmailResult(null)
    try {
      const res = await apiPost<{
        success: boolean
        emailSendId: string
        recipientEmail: string
        period: { from: string; to: string }
        smtpConfigured: boolean
      }>(
        `/api/v1/customers/${id}/statement.email`,
        {
          companyId,
          from,
          to,
          order,
        },
      )
      // SMTP not configured → console transport
      // (dev fallback). The email is recorded
      // but not actually sent. We surface this
      // as a soft success + a hint.
      const hint = res.smtpConfigured
        ? ""
        : " (SMTP not configured — logged to console)"
      setEmailResult({
        kind: "ok",
        msg:
          (t("statement.emailSent") || "Statement sent to {recipient}.").replace(
            "{recipient}",
            res.recipientEmail,
          ) + hint,
      })
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? err.message
          : String((err as any)?.message || err)
      // "Kunde hat keine E-Mail-Adresse" is the
      // common case — use a friendlier copy.
      const isNoEmail = /keine e-mail|email address/i.test(msg)
      setEmailResult({
        kind: "err",
        msg: isNoEmail
          ? t("statement.emailNoRecipient") ||
            "No email address on file for this customer."
          : (t("statement.emailSendError") || "Statement could not be sent: {error}").replace(
              "{error}",
              msg,
            ),
      })
    } finally {
      setSendingEmail(false)
    }
  }

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold">{t("statement.title")}</h1>
          {customerName && (
            <p className="text-gray-600 mt-1" data-testid="statement-customer-name">
              {customerName}
            </p>
          )}
        </div>
        <Button
          variant="outline"
          onClick={() => router.push("/dashboard/customers")}
          data-testid="statement-back-button"
        >
          ← {t("common.back")}
        </Button>
      </div>

      <Card className="mb-4">
        <CardHeader>
          <CardTitle>{t("statement.period")}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-3 items-end">
            <div>
              <label className="block text-sm font-medium mb-1">
                {t("statement.from")}
              </label>
              <Input
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                data-testid="statement-from-input"
                className="w-44"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">
                {t("statement.to")}
              </label>
              <Input
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                data-testid="statement-to-input"
                className="w-44"
              />
            </div>
            <div
              className="flex items-center gap-1 ml-2"
              data-testid="statement-order-toggle"
            >
              <button
                type="button"
                onClick={() => setOrder("desc")}
                className={
                  "px-2 py-1 text-xs rounded border " +
                  (order === "desc"
                    ? "bg-blue-600 text-white border-blue-600"
                    : "bg-white text-gray-700 border-gray-300 hover:bg-gray-50")
                }
                data-testid="statement-order-desc"
                title={t("statement.orderDescHint")}
              >
                ↓ {t("statement.orderNewestFirst")}
              </button>
              <button
                type="button"
                onClick={() => setOrder("asc")}
                className={
                  "px-2 py-1 text-xs rounded border " +
                  (order === "asc"
                    ? "bg-blue-600 text-white border-blue-600"
                    : "bg-white text-gray-700 border-gray-300 hover:bg-gray-50")
                }
                data-testid="statement-order-asc"
                title={t("statement.orderAscHint")}
              >
                ↑ {t("statement.orderOldestFirst")}
              </button>
            </div>
            <Button
              onClick={fetchStatement}
              disabled={loading}
              data-testid="statement-generate-button"
            >
              {loading ? t("common.loading") : t("statement.generate")}
            </Button>
            <Button
              variant="outline"
              onClick={downloadPDF}
              disabled={!statement || downloading}
              data-testid="statement-download-pdf-button"
            >
              {downloading ? "..." : t("statement.downloadPdf")}
            </Button>
            {/* Tier 154: send the same period to
                the customer's contact.email. We
                don't require `statement` to be
                loaded — the user may have just
                changed the range and wants to
                email a fresh one. The button is
                disabled only while a send is in
                flight. */}
            <Button
              variant="outline"
              onClick={sendByEmail}
              disabled={sendingEmail}
              data-testid="statement-send-email-button"
            >
              {sendingEmail
                ? (t("statement.sendingEmail") || "Sending…")
                : "📧 " + (t("statement.sendEmail") || "Per E-Mail senden")}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Tier 154: inline result banner for the
          email send. Green on success, red on
          failure. Cleared on the next send. */}
      {emailResult && (
        <div
          className={
            "mb-4 p-3 rounded text-sm border " +
            (emailResult.kind === "ok"
              ? "bg-green-50 border-green-200 text-green-800 dark:bg-green-900/30 dark:border-green-700 dark:text-green-200"
              : "bg-red-50 border-red-200 text-red-800 dark:bg-red-900/30 dark:border-red-700 dark:text-red-200")
          }
          data-testid={
            emailResult.kind === "ok"
              ? "statement-email-sent-ok"
              : "statement-email-sent-error"
          }
        >
          {emailResult.kind === "ok" ? "✓ " : "✗ "}
          {emailResult.msg}
        </div>
      )}

      {error && <ErrorBanner title={t("common.error") || "Fehler"} message={error} />}

      {statement && (
        <Card data-testid="statement-result">
          <CardHeader>
            <CardTitle>
              {fmtDateDE(statement.period.from)} – {fmtDateDE(statement.period.to)}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {/* Opening + closing balance */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
              <div className="border rounded p-3">
                <div className="text-sm text-gray-500">
                  {t("statement.openingBalance")}
                </div>
                <div className="text-xl font-mono" data-testid="statement-opening">
                  {fmtEur(statement.openingBalance)}
                </div>
              </div>
              <div className="border rounded p-3">
                <div className="text-sm text-gray-500">
                  {t("statement.totals")}
                </div>
                <div className="text-sm font-mono mt-1">
                  {t("statement.invoices")}: {fmtEur(statement.totals.invoicesAmount)}
                </div>
                <div className="text-sm font-mono">
                  {t("statement.payments")}: {fmtEur(statement.totals.paymentsAmount)}
                </div>
                <div className="text-sm font-mono">
                  {t("statement.credits")}: {fmtEur(statement.totals.creditsAmount)}
                </div>
              </div>
              <div
                className={
                  "border rounded p-3 " +
                  (statement.closingBalance > 0
                    ? "border-red-300 bg-red-50"
                    : statement.closingBalance < 0
                      ? "border-green-300 bg-green-50"
                      : "")
                }
              >
                <div className="text-sm text-gray-500">
                  {t("statement.closingBalance")}
                </div>
                <div
                  className="text-xl font-mono font-bold"
                  data-testid="statement-closing"
                >
                  {fmtEur(statement.closingBalance)}
                </div>
                {statement.closingBalance < 0 && (
                  <div className="text-xs text-green-700 mt-1">
                    {t("statement.overpaidNote")}
                  </div>
                )}
              </div>
            </div>

            {/* Tier 58: Kundenguthaben badge. The period
                closingBalance above reflects open invoices
                inside the statement's date range. The
                creditBalance is a separate running total
                that lives outside the period — overpayments
                + Gutschrift overages accumulated over the
                customer's whole lifetime, less any
                Auszahlung / apply-to-invoice. Render only
                when non-zero so a clean customer doesn't
                get a noisy empty badge. */}
            {Math.abs(statement.creditBalance) > 0.005 && (
              <div
                className={
                  "mt-3 border rounded p-3 " +
                  (statement.creditBalance > 0
                    ? "border-blue-300 bg-blue-50"
                    : "border-orange-300 bg-orange-50")
                }
                data-testid="statement-credit-balance"
              >
                <div className="text-sm text-gray-500">
                  {t("statement.creditBalance")}
                </div>
                <div className="text-xl font-mono font-bold">
                  {fmtEur(statement.creditBalance)}
                </div>
                <div className="text-xs text-gray-600 mt-1">
                  {statement.creditBalance > 0
                    ? t("statement.creditBalancePositiveNote")
                    : t("statement.creditBalanceNegativeNote")}
                </div>
                <button
                  onClick={() => router.push(`/dashboard/customers/${id}/credit`)}
                  className="mt-2 text-xs text-blue-700 hover:underline"
                  data-testid="statement-credit-link"
                >
                  → {t("credit.ledgerTitle") || "Guthaben-Verlauf"}
                </button>
              </div>
            )}

            {/* Line items table */}
            {statement.lines.length === 0 ? (
              <div className="text-center text-gray-500 py-8" data-testid="statement-empty">
                {t("statement.noLines")}
              </div>
            ) : (
              <table className="w-full text-sm" data-testid="statement-lines-table">
                <thead className="border-b-2">
                  <tr className="text-left">
                    <th className="py-1 px-2">{t("statement.date")}</th>
                    <th className="py-1 px-2">{t("statement.type")}</th>
                    <th className="py-1 px-2">{t("statement.reference")}</th>
                    <th className="py-1 px-2 text-right">{t("statement.amount")}</th>
                    <th className="py-1 px-2 text-right">{t("statement.balance")}</th>
                  </tr>
                </thead>
                <tbody>
                  {statement.lines.map((line, i) => (
                    <tr
                      key={`${line.date}-${i}`}
                      className="border-b hover:bg-gray-50"
                      data-testid="statement-line"
                      data-line-type={line.type}
                    >
                      <td className="py-1 px-2 font-mono text-xs">
                        {fmtDateDE(line.date)}
                      </td>
                      <td className="py-1 px-2">
                        <span
                          className={
                            "inline-block px-2 py-0.5 rounded text-xs " +
                            (line.type === "invoice"
                              ? "bg-blue-100 text-blue-800"
                              : line.type === "credit"
                                ? "bg-orange-100 text-orange-800"
                                : "bg-green-100 text-green-800")
                          }
                        >
                          {t("statement.type_" + line.type)}
                        </span>
                      </td>
                      <td className="py-1 px-2 font-mono text-xs">
                        {line.reference}
                      </td>
                      <td
                        className={
                          "py-1 px-2 text-right font-mono " +
                          (line.amount < 0 ? "text-green-700" : "")
                        }
                        data-testid="statement-line-amount"
                      >
                        {fmtEur(line.amount)}
                      </td>
                      <td className="py-1 px-2 text-right font-mono font-semibold">
                        {fmtEur(line.balance)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}