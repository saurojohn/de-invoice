"use client"

import { useEffect, useState } from "react"
import { useRouter, useParams } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { useI18n } from "@/components/useI18n"
import { apiGet, apiPost, apiPut, apiDelete, ApiError } from "@/lib/api"

interface InvoiceItem {
  description: string
  quantity: string
  unit: string
  unitPrice: string
  vatRate: string
  netAmount: string
  vatAmount: string
  grossAmount: string
}

interface Invoice {
  id: string
  invoiceNumber: string
  status: string
  type: string
  issueDate: string
  dueDate: string
  currency: string
  subtotal: string
  totalVat: string
  total: string
  notes: string
  customer: { name: string; address: any; vatId: string }
  // Sender letterhead (the company that issued the invoice) — used by
  // the on-screen and browser-print header card. Returned by
  // GET /invoices/:id since we added `include: { company: true }`
  // to invoice.service.findOne.
  company?: {
    name: string
    legalName?: string
    taxId?: string
    vatId?: string
    email?: string
    phone?: string
    logoPath?: string
    address?: { street?: string; postalCode?: string; city?: string; country?: string }
    bankInfo?: { bankName?: string; iban?: string; bic?: string }
  }
  items: InvoiceItem[]
  payments: { amount: string; paymentDate: string; paymentMethod: string }[]
}

interface Payment {
  id: string
  amount: string
  currency: string
  paymentDate: string
  paymentMethod: string
  reference: string | null
  notes: string | null
  receiptNumber: string | null
  createdAt: string
}

export default function InvoiceDetailPage() {
  const router = useRouter()
  const params = useParams()
  const { t, getDateLocale } = useI18n()
  const [invoice, setInvoice] = useState<Invoice | null>(null)
  const [payments, setPayments] = useState<Payment[]>([])
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [sendResult, setSendResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [statusChanging, setStatusChanging] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [showPayForm, setShowPayForm] = useState(false)
  const [payForm, setPayForm] = useState({
    amount: '',
    paymentDate: new Date().toISOString().split("T")[0],
    paymentMethod: "bank_transfer",
    reference: '',
    notes: '',
  })
  const [paySaving, setPaySaving] = useState(false)

  useEffect(() => {
    const companyId = localStorage.getItem("companyId")
    if (!companyId) {
      router.push("/login")
      return
    }

    Promise.all([
      apiGet<any>(`/api/v1/invoices/${params.id}?companyId=${companyId}`),
      apiGet<any[]>(`/api/v1/invoices/${params.id}/payments?companyId=${companyId}`),
    ]).then(([inv, pmts]) => {
      setInvoice(inv)
      setPayments(Array.isArray(pmts) ? pmts : [])
    }).catch((err) => {
      console.error('Invoice detail load failed:', err)
    }).finally(() => setLoading(false))
  }, [params.id, router])

  // Auto-fill the payment form with the outstanding amount
  useEffect(() => {
    if (!invoice || !showPayForm) return
    const total = Number(invoice.total) || 0
    const paid = payments.reduce((s, p) => s + Number(p.amount), 0)
    const outstanding = Math.max(0, total - paid)
    if (!payForm.amount && outstanding > 0) {
      setPayForm((f) => ({ ...f, amount: outstanding.toFixed(2) }))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showPayForm, invoice, payments])

  const submitPayment = async () => {
    if (!invoice) return
    if (!payForm.amount || !payForm.paymentDate || !payForm.paymentMethod) {
      alert("Betrag, Datum und Zahlungsweg sind erforderlich")
      return
    }
    setPaySaving(true)
    try {
      const companyId = localStorage.getItem("companyId")
      await apiPost(`/api/v1/invoices/${invoice.id}/payments?companyId=${companyId}`, {
        amount: Number(payForm.amount),
        paymentDate: payForm.paymentDate,
        paymentMethod: payForm.paymentMethod,
        reference: payForm.reference || undefined,
        notes: payForm.notes || undefined,
      })
      // Refresh both invoice (status may have changed) and payments
      const [inv, pmts] = await Promise.all([
        apiGet<any>(`/api/v1/invoices/${invoice.id}?companyId=${companyId}`),
        apiGet<any[]>(`/api/v1/invoices/${invoice.id}/payments?companyId=${companyId}`),
      ])
      setInvoice(inv)
      setPayments(Array.isArray(pmts) ? pmts : [])
      setShowPayForm(false)
      setPayForm({ amount: '', paymentDate: new Date().toISOString().split("T")[0], paymentMethod: "bank_transfer", reference: '', notes: '' })
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : `Netzwerkfehler: ${err}`
      alert(msg)
    } finally {
      setPaySaving(false)
    }
  }

  const deletePayment = async (paymentId: string) => {
    if (!invoice) return
    if (!confirm("Zahlung wirklich löschen?")) return
    try {
      const companyId = localStorage.getItem("companyId")
      await apiDelete(`/api/v1/invoices/${invoice.id}/payments/${paymentId}?companyId=${companyId}`)
      // Refresh
      const [inv, pmts] = await Promise.all([
        apiGet<any>(`/api/v1/invoices/${invoice.id}?companyId=${companyId}`),
        apiGet<any[]>(`/api/v1/invoices/${invoice.id}/payments?companyId=${companyId}`),
      ])
      setInvoice(inv)
      setPayments(Array.isArray(pmts) ? pmts : [])
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : `Netzwerkfehler: ${err}`
      alert(msg)
    }
  }

  const formatDate = (s: string) => {
    if (!s) return ""
    const d = new Date(s)
    if (isNaN(d.getTime())) return s
    // Force dd.mm.yyyy with leading zeros — `toLocaleDateString` returns
    // "6.6.2026" on some ICU versions, which looks inconsistent next to
    // the list page (which always zero-pads via formatDateDE).
    const dd = String(d.getDate()).padStart(2, "0")
    const mm = String(d.getMonth() + 1).padStart(2, "0")
    const yyyy = d.getFullYear()
    return `${dd}.${mm}.${yyyy}`
  }

  // Date-only compare (ignores time-of-day). Used to gate edit /
  // hard-delete on "invoice was created today".
  const isSameDayDE = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()

  const paymentMethodLabel = (m: string) => {
    const labels: Record<string, string> = {
      bank_transfer: "Überweisung",
      cash: "Bargeld",
      card: "Karte",
      paypal: "PayPal",
      sepa: "SEPA-Lastschrift",
      other: "Sonstiges",
    }
    return labels[m] || m
  }

  const totalPaid = payments.reduce((s, p) => s + Number(p.amount), 0)
  const outstanding = invoice ? Math.max(0, Number(invoice.total) - totalPaid) : 0

  const getStatusLabel = (status: string) => {
    const labels: Record<string, string> = {
      draft: "Entwurf",
      sent: "Versendet",
      paid: "Bezahlt",
      overdue: "Überfällig",
      cancelled: "Storniert",
    }
    return labels[status] || status
  }

  const getStatusColor = (status: string) => {
    const colors: Record<string, string> = {
      draft: "bg-gray-100 text-gray-700",
      sent: "bg-blue-100 text-blue-700",
      paid: "bg-green-100 text-green-700",
      overdue: "bg-red-100 text-red-700",
      cancelled: "bg-gray-100 text-gray-500",
    }
    return colors[status] || colors.draft
  }

  const getVatLabel = (rate: string) => {
    const r = parseFloat(rate)
    if (r === 0.19) return "19%"
    if (r === 0.07) return "7%"
    return "0%"
  }

  const sendViaEmail = async () => {
    if (!invoice) return
    setSending(true)
    setSendResult(null)

    try {
      const companyId = localStorage.getItem("companyId")
      const userId = localStorage.getItem("userId") || undefined
      const userEmail = localStorage.getItem("userEmail") || ""
      if (!companyId) return

      // Fully automated: backend sends the email via SMTP with PDF attached.
      // We pass the logged-in user's email as CC so they get a copy automatically.
      const data = await apiPost<any>(`/api/v1/invoices/${invoice.id}/send-email?companyId=${companyId}`, {
        ccEmail: userEmail || undefined,
        createdById: userId,
      })
      setSendResult({
        ok: true,
        message: data.smtpConfigured
          ? `E-Mail an ${data.recipient} gesendet${data.cc?.length ? ` (CC: ${data.cc.join(", ")})` : ""}`
          : `E-Mail vorbereitet (SMTP nicht konfiguriert — Server-Log prüfen)`,
      })
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "Netzwerkfehler"
      setSendResult({ ok: false, message: msg })
    } finally {
      setSending(false)
    }
  }

  const downloadPDF = async () => {
    const companyId = localStorage.getItem("companyId")
    if (!companyId || !invoice) return

    try {
      const { apiFetch } = await import("@/lib/api")
      const response = await apiFetch(`/api/v1/invoices/${invoice.id}/pdf?companyId=${companyId}`, { throwOnError: false })
      const blob = await response.blob()
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = `${invoice.invoiceNumber}.pdf`
      document.body.appendChild(a)
      a.click()
      window.URL.revokeObjectURL(url)
      document.body.removeChild(a)
    } catch (err) {
      console.error("Download fehlgeschlagen:", err)
    }
  }

  const downloadXRechnung = async () => {
    const companyId = localStorage.getItem("companyId")
    if (!companyId || !invoice) return

    try {
      const { apiFetch } = await import("@/lib/api")
      const response = await apiFetch(`/api/v1/invoices/${invoice.id}/xrechnung?companyId=${companyId}`, { throwOnError: false })
      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        alert(data.message || `XRechnung Download fehlgeschlagen (HTTP ${response.status})`)
        return
      }
      const blob = await response.blob()
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = `${invoice.invoiceNumber}_xrechnung.xml`
      document.body.appendChild(a)
      a.click()
      window.URL.revokeObjectURL(url)
      document.body.removeChild(a)
    } catch (err) {
      console.error("XRechnung Download fehlgeschlagen:", err)
      alert("XRechnung Download fehlgeschlagen")
    }
  }

  const downloadZUGFeRD = async () => {
    const companyId = localStorage.getItem("companyId")
    if (!companyId || !invoice) return

    try {
      const { apiFetch } = await import("@/lib/api")
      const response = await apiFetch(`/api/v1/invoices/${invoice.id}/zugferd?companyId=${companyId}`, { throwOnError: false })
      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        alert(data.message || `ZUGFeRD Download fehlgeschlagen (HTTP ${response.status})`)
        return
      }
      const blob = await response.blob()
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = `${invoice.invoiceNumber}_ZUGFeRD.pdf`
      document.body.appendChild(a)
      a.click()
      window.URL.revokeObjectURL(url)
      document.body.removeChild(a)
    } catch (err) {
      console.error("ZUGFeRD Download fehlgeschlagen:", err)
      alert("ZUGFeRD Download fehlgeschlagen")
    }
  }

  const changeStatus = async (newStatus: string) => {
    if (!invoice || invoice.status === newStatus) return
    if (!confirm(`Status auf "${getStatusLabel(newStatus)}" setzen?`)) return
    setStatusChanging(true)
    try {
      const companyId = localStorage.getItem("companyId")
      await apiPut(`/api/v1/invoices/${invoice.id}/status?companyId=${companyId}`, { status: newStatus })
      setInvoice({ ...invoice, status: newStatus })
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : `Netzwerkfehler: ${err}`
      alert(msg)
    } finally {
      setStatusChanging(false)
    }
  }

  // Hard delete. Only allowed on the issueDate (same-day rule on
  // the backend). For past-date invoices the backend returns 403;
  // we surface that to the user and direct them to "Stornieren"
  // (status = cancelled) via the status dropdown instead.
  const deleteInvoice = async () => {
    if (!invoice) return
    if (!confirm(`Rechnung ${invoice.invoiceNumber} wirklich löschen? Diese Aktion kann nicht rückgängig gemacht werden. Bezahlungen und Positionen werden ebenfalls entfernt.`)) return
    setDeleting(true)
    try {
      const companyId = localStorage.getItem("companyId")
      await apiDelete(`/api/v1/invoices/${invoice.id}?companyId=${companyId}`)
      router.push("/dashboard/invoices")
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : `Netzwerkfehler: ${err}`
      alert(msg)
    } finally {
      setDeleting(false)
    }
  }

  // Same-day check: today == invoice.issueDate (date-only compare).
  // Both edit and hard-delete require it.
  const isToday = invoice
    ? isSameDayDE(new Date(invoice.issueDate), new Date())
    : false

  if (loading) return <div className="p-8 text-center">Laden...</div>
  if (!invoice) return <div className="p-8 text-center">Rechnung nicht gefunden</div>

  return (
    <main className="min-h-screen bg-gray-50">
      <header className="bg-white border-b shadow-sm">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Button variant="outline" onClick={() => router.push("/dashboard/invoices")}>Zurück</Button>
            <h1 className="text-2xl font-bold text-blue-600">{invoice.invoiceNumber}</h1>
            {/* Status as a quick-change dropdown — invoice state moves
                through draft → sent → paid (or overdue/cancelled). */}
            <select
              value={invoice.status}
              disabled={statusChanging}
              onChange={(e) => changeStatus(e.target.value)}
              className={`text-sm rounded-full px-3 py-1 border-0 ${getStatusColor(invoice.status)} cursor-pointer`}
              style={{ fontWeight: 500 }}
            >
              <option value="draft">{getStatusLabel("draft")}</option>
              <option value="sent">{getStatusLabel("sent")}</option>
              <option value="paid">{getStatusLabel("paid")}</option>
              <option value="overdue">{getStatusLabel("overdue")}</option>
              <option value="cancelled">{getStatusLabel("cancelled")}</option>
            </select>
          </div>
          <div className="flex gap-2 items-center">
            <Button variant="outline" onClick={sendViaEmail} disabled={sending}>
              {sending ? "Wird gesendet..." : "Per E-Mail senden"}
            </Button>
            {sendResult && (
              <span
                className={`text-sm ${sendResult.ok ? "text-green-600" : "text-red-600"}`}
              >
                {sendResult.ok ? "✓" : "✗"} {sendResult.message}
              </span>
            )}
            <Button variant="outline" onClick={downloadXRechnung}>
              XRechnung herunterladen
            </Button>
            <Button variant="outline" onClick={downloadZUGFeRD}>
              ZUGFeRD herunterladen
            </Button>
            <Button onClick={downloadPDF}>PDF herunterladen</Button>
            {/* Edit + Hard-delete are only allowed on the invoice's
                issueDate. For past-date invoices the backend returns
                403 — we hide the buttons and show a hint pointing
                the user at "Stornieren" via the status dropdown. */}
            {isToday && (
              <>
                <Button
                  variant="outline"
                  onClick={() => router.push(`/dashboard/invoices/create?id=${invoice.id}`)}
                  className="text-blue-600 border-blue-300 hover:bg-blue-50"
                >
                  Bearbeiten
                </Button>
                <Button
                  variant="outline"
                  onClick={deleteInvoice}
                  disabled={deleting}
                  className="text-red-600 border-red-300 hover:bg-red-50"
                >
                  {deleting ? "..." : "Löschen"}
                </Button>
              </>
            )}
            {!isToday && invoice && (
              <span
                className="text-xs text-gray-500"
                title="Diese Rechnung ist eingefroren. Nur der Status kann noch geändert werden (Stornieren etc.)."
              >
                Eingefroren (Status änderbar)
              </span>
            )}
          </div>
        </div>
      </header>

      <div className="container mx-auto px-4 py-8 max-w-4xl">
        {/* Sender letterhead (header card). Shown both on screen and
            in browser print. Mirrors the PDF's v5 header block:
              - Logo + Company info share the same top row.
                Logo is centered in the LEFT half, company name +
                address sit in the top-RIGHT corner, right-aligned.
                (User: "公司名和地址都放到右上角和 logo 同一排")
              - The middle row holds the customer address (left,
                left-aligned) + the RECHNUNG title (right, right-
                aligned). The customer's address lives where the
                company name USED to be — that's the "window
                envelope" position.
                (User: "客户的 Rechnungsadresse 往上拉放到之前公司
                名这一排，设置靠左边")
            In print we drop the outer Card chrome and rely on the
            @media print rule at the bottom of this file. */}
        {invoice.company && (
          <div className="mb-6 print:mb-4">
            {/* Top row: logo (left half, centered) + company info
                (right half, right-aligned). items-end keeps both
                blocks vertically anchored to the row's baseline
                even when one is taller than the other. */}
            <div className="flex items-end justify-between gap-4">
              {/* Logo: left half, centered within the left half. */}
              {invoice.company.logoPath ? (
                <div className="w-1/2 flex justify-center">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`/images/${invoice.company.logoPath}`}
                    alt={invoice.company.name}
                    className="h-[68px] w-auto object-contain print:hidden"
                    onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none" }}
                  />
                </div>
              ) : (
                <div className="w-1/2" />
              )}
              {/* Company info: right half, right-aligned. */}
              <div className="w-1/2 text-right text-sm leading-relaxed">
                <div className="text-2xl font-bold text-gray-900">{invoice.company.name}</div>
                {invoice.company.legalName && invoice.company.legalName !== invoice.company.name && (
                  <div className="text-gray-600 text-xs">{invoice.company.legalName}</div>
                )}
                {invoice.company.address?.street && (
                  <div className="text-gray-700">{invoice.company.address.street}</div>
                )}
                {(invoice.company.address?.postalCode || invoice.company.address?.city) && (
                  <div className="text-gray-700">
                    {invoice.company.address.postalCode} {invoice.company.address.city}
                  </div>
                )}
                {invoice.company.address?.country && (
                  <div className="text-gray-700">{invoice.company.address.country}</div>
                )}
                <div className="mt-2 text-xs text-gray-500 space-x-2">
                  {invoice.company.vatId && <span>UST-IDNr.: {invoice.company.vatId}</span>}
                  {invoice.company.taxId && <span>· Steuernr.: {invoice.company.taxId}</span>}
                </div>
                {(invoice.company.email || invoice.company.phone) && (
                  <div className="text-xs text-gray-500 space-x-2">
                    {invoice.company.email && <span>{invoice.company.email}</span>}
                    {invoice.company.phone && <span>· {invoice.company.phone}</span>}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Customer & Invoice Info — left card's header now shows the
            SENDER (own company) name + address instead of the generic
            "Kundeninformationen" label, mirroring the PDF change.
            Customer name + address inside is bumped from text-sm
            (14px) to text-base (16px) — +14% close to the +10% the
            user asked for; we pick a Tailwind class instead of an
            arbitrary [15px] value to stay in the design system. */}
        <div className="grid md:grid-cols-2 gap-8 mb-8">
          <Card>
            <CardHeader>
              <CardTitle>
                {invoice.company?.name || "Kundeninformationen"}
              </CardTitle>
              {invoice.company?.address && (
                // Single-line sender info (Absenderzeile) at 50% of the
                // letterhead's text-2xl (24px) — so text-xs (12px) is
                // exactly the half-size the user asked for. Used as the
                // return-address line above the customer address for
                // window envelopes. Format mirrors the PDF:
                // "Name · Straße · PLZ Ort · Land". One line only,
                // whitespace-nowrap so it never wraps mid-address.
                <div className="-mt-1 text-xs font-normal tracking-normal text-gray-500 whitespace-nowrap overflow-hidden text-ellipsis">
                  {[
                    invoice.company.name,
                    invoice.company.address.street,
                    `${invoice.company.address.postalCode} ${invoice.company.address.city}`.trim(),
                    invoice.company.address.country,
                  ].filter(Boolean).join(" · ")}
                </div>
              )}
            </CardHeader>
            <CardContent>
              <div className="space-y-2 text-base">
                <div className="font-medium">{invoice.customer?.name}</div>
                {invoice.customer?.vatId && <div className="text-gray-600">UST-IDNr.: {invoice.customer.vatId}</div>}
                {invoice.customer?.address && (
                  <div className="text-gray-600">
                    {invoice.customer.address.street}<br />
                    {invoice.customer.address.postalCode} {invoice.customer.address.city}
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Rechnungsinformationen</CardTitle></CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-4">
                <div><div className="text-sm text-gray-500">Ausstellungsdatum</div><div>{formatDate(invoice.issueDate)}</div></div>
                <div><div className="text-sm text-gray-500">Fälligkeitsdatum</div><div>{formatDate(invoice.dueDate)}</div></div>
                <div><div className="text-sm text-gray-500">Rechnungsart</div><div>{invoice.type}</div></div>
                <div><div className="text-sm text-gray-500">Währung</div><div>{invoice.currency}</div></div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Items Table */}
        <Card className="mb-8">
          <CardHeader><CardTitle>Positionen</CardTitle></CardHeader>
          <CardContent className="p-0">
            <table className="w-full">
              <thead className="bg-gray-50 border-b">
                <tr>
                  <th className="px-4 py-3 text-left text-sm font-medium text-gray-600">Beschreibung</th>
                  <th className="px-4 py-3 text-center text-sm font-medium text-gray-600">Menge</th>
                  <th className="px-4 py-3 text-right text-sm font-medium text-gray-600">Einzelpreis</th>
                  <th className="px-4 py-3 text-right text-sm font-medium text-gray-600">MwSt</th>
                  <th className="px-4 py-3 text-right text-sm font-medium text-gray-600">Netto</th>
                  <th className="px-4 py-3 text-right text-sm font-medium text-gray-600">Steuer</th>
                  <th className="px-4 py-3 text-right text-sm font-medium text-gray-600">Brutto</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {invoice.items?.map((item, idx) => (
                  <tr key={idx}>
                    <td className="px-4 py-3">{item.description}</td>
                    <td className="px-4 py-3 text-center">{item.quantity} {item.unit}</td>
                    <td className="px-4 py-3 text-right">€{parseFloat(item.unitPrice).toFixed(2)}</td>
                    <td className="px-4 py-3 text-right">{getVatLabel(item.vatRate)}</td>
                    <td className="px-4 py-3 text-right">€{parseFloat(item.netAmount).toFixed(2)}</td>
                    <td className="px-4 py-3 text-right">€{parseFloat(item.vatAmount).toFixed(2)}</td>
                    <td className="px-4 py-3 text-right font-medium">€{parseFloat(item.grossAmount).toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>

        {/* Totals */}
        <div className="flex justify-end">
          <Card className="w-80">
            <CardContent className="space-y-3">
              <div className="flex justify-between"><span className="text-gray-600">Zwischensumme (Netto):</span><span>€{parseFloat(invoice.subtotal).toFixed(2)}</span></div>
              <div className="flex justify-between"><span className="text-gray-600">Umsatzsteuer:</span><span>€{parseFloat(invoice.totalVat).toFixed(2)}</span></div>
              <div className="flex justify-between text-xl font-bold border-t pt-3"><span>Gesamtbetrag:</span><span className="text-blue-600">€{parseFloat(invoice.total).toFixed(2)}</span></div>
              <div className="flex justify-between text-sm pt-1"><span className="text-green-700">Bezahlt:</span><span className="text-green-700">€{totalPaid.toFixed(2)}</span></div>
              <div className={`flex justify-between text-sm font-semibold ${outstanding > 0.01 ? "text-red-600" : "text-green-700"}`}>
                <span>{outstanding > 0.01 ? "Offen:" : "Vollständig bezahlt ✓"}</span>
                <span>€{outstanding.toFixed(2)}</span>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Payments */}
        <Card className="mt-6">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>Zahlungen ({payments.length})</CardTitle>
            {invoice.type !== "CN" && invoice.status !== "cancelled" && (
              <Button
                size="sm"
                onClick={() => setShowPayForm(!showPayForm)}
                variant={showPayForm ? "outline" : "default"}
              >
                {showPayForm ? "×" : "+ Zahlung erfassen"}
              </Button>
            )}
          </CardHeader>
          {showPayForm && (
            <CardContent className="bg-gray-50 border-t">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Betrag (€) *</label>
                  <Input
                    type="number"
                    step="0.01"
                    value={payForm.amount}
                    onChange={(e) => setPayForm({ ...payForm, amount: e.target.value })}
                    placeholder={outstanding > 0 ? `Offen: ${outstanding.toFixed(2)}` : "0.00"}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Zahldatum *</label>
                  <Input
                    type="date"
                    value={payForm.paymentDate}
                    onChange={(e) => setPayForm({ ...payForm, paymentDate: e.target.value })}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Zahlungsweg *</label>
                  <select
                    value={payForm.paymentMethod}
                    onChange={(e) => setPayForm({ ...payForm, paymentMethod: e.target.value })}
                    className="w-full px-3 py-1.5 border rounded text-sm"
                  >
                    <option value="bank_transfer">Überweisung</option>
                    <option value="cash">Bargeld</option>
                    <option value="card">Karte</option>
                    <option value="paypal">PayPal</option>
                    <option value="sepa">SEPA-Lastschrift</option>
                    <option value="other">Sonstiges</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Referenz (optional)</label>
                  <Input
                    value={payForm.reference}
                    onChange={(e) => setPayForm({ ...payForm, reference: e.target.value })}
                    placeholder="z.B. Kontoauszug-Nr., Transaktions-ID"
                  />
                </div>
                <div className="md:col-span-2">
                  <label className="block text-xs font-medium text-gray-600 mb-1">Notizen (optional)</label>
                  <Input
                    value={payForm.notes}
                    onChange={(e) => setPayForm({ ...payForm, notes: e.target.value })}
                    placeholder="z.B. Teilzahlung, Skonto abgezogen"
                  />
                </div>
              </div>
              <div className="mt-3 flex justify-end gap-2">
                <Button variant="outline" size="sm" onClick={() => setShowPayForm(false)}>×</Button>
                <Button size="sm" onClick={submitPayment} disabled={paySaving}>
                  {paySaving ? "…" : "✓ Speichern"}
                </Button>
              </div>
            </CardContent>
          )}
          {payments.length === 0 ? (
            <CardContent className="text-center text-sm text-gray-500 py-4">
              Noch keine Zahlungen erfasst.
            </CardContent>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="text-left px-4 py-2 font-medium">Datum</th>
                    <th className="text-left px-4 py-2 font-medium">Zahlungsweg</th>
                    <th className="text-left px-4 py-2 font-medium">Referenz</th>
                    <th className="text-right px-4 py-2 font-medium">Betrag</th>
                    <th className="text-right px-4 py-2 font-medium">Aktion</th>
                  </tr>
                </thead>
                <tbody>
                  {payments.map((p) => (
                    <tr key={p.id} className="border-b hover:bg-gray-50">
                      <td className="px-4 py-2">{formatDate(p.paymentDate)}</td>
                      <td className="px-4 py-2">{paymentMethodLabel(p.paymentMethod)}</td>
                      <td className="px-4 py-2 text-gray-600">{p.reference || "—"}</td>
                      <td className="px-4 py-2 text-right font-medium">€{Number(p.amount).toFixed(2)}</td>
                      <td className="px-4 py-2 text-right">
                        <button
                          onClick={() => deletePayment(p.id)}
                          className="text-red-600 hover:underline text-xs"
                        >
                          Löschen
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {/* Notes */}
        {invoice.notes && (
          <Card className="mt-8">
            <CardHeader><CardTitle>Bemerkungen</CardTitle></CardHeader>
            <CardContent><p className="text-gray-600 whitespace-pre-wrap">{invoice.notes}</p></CardContent>
          </Card>
        )}
      </div>

      {/* Browser-print styles. We DO NOT print the action header
          (buttons + status dropdown), and we strip the page's gray
          background and card shadows so the output looks like the
          downloaded PDF rather than a UI screenshot. The letterhead
          block above is the only sender info shown in print. */}
      <style>{`
        @media print {
          html, body { background: #fff !important; }
          body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          /* Hide the top action header (back, status, buttons) */
          header { display: none !important; }
          /* Remove card chrome and shadows for a paper-like look */
          .shadow-sm, .shadow-md, .shadow-lg, .shadow { box-shadow: none !important; }
          /* Background tones and rounded corners on cards add visual
             noise on paper; flatten them. */
          [class*="rounded-"] { border-radius: 0 !important; }
          /* White page background; no max-width gutter */
          main { background: #fff !important; }
          .container { max-width: 100% !important; padding: 0 !important; }
          /* Slightly tighter spacing */
          .print\\:mb-4 { margin-bottom: 1rem !important; }
          /* Avoid page breaks inside critical blocks */
          table, tr, td, th { page-break-inside: avoid; }
        }
      `}</style>
    </main>
  )
}