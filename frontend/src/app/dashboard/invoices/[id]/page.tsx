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

  const formatDate = (s: string) => new Date(s).toLocaleDateString(getDateLocale())

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

  const deleteInvoice = async () => {
    if (!invoice) return
    if (!confirm(`Rechnung ${invoice.invoiceNumber} wirklich löschen? Diese Aktion kann nicht rückgängig gemacht werden.`)) return
    setDeleting(true)
    try {
      const companyId = localStorage.getItem("companyId")
      // Backend doesn't have DELETE — cancellation via PUT /:id/status with status=cancelled
      await apiPut(`/api/v1/invoices/${invoice.id}/status?companyId=${companyId}`, { status: "cancelled" })
      router.push("/dashboard/invoices")
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : `Netzwerkfehler: ${err}`
      alert(msg)
    } finally {
      setDeleting(false)
    }
  }

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
            <Button
              variant="outline"
              onClick={deleteInvoice}
              disabled={deleting}
              className="text-red-600 border-red-300 hover:bg-red-50"
            >
              {deleting ? "..." : "Löschen"}
            </Button>
          </div>
        </div>
      </header>

      <div className="container mx-auto px-4 py-8 max-w-4xl">
        {/* Customer & Invoice Info */}
        <div className="grid md:grid-cols-2 gap-8 mb-8">
          <Card>
            <CardHeader><CardTitle>Kundeninformationen</CardTitle></CardHeader>
            <CardContent>
              <div className="space-y-2">
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
                <div><div className="text-sm text-gray-500">Ausstellungsdatum</div><div>{new Date(invoice.issueDate).toLocaleDateString("de-DE")}</div></div>
                <div><div className="text-sm text-gray-500">Fälligkeitsdatum</div><div>{new Date(invoice.dueDate).toLocaleDateString("de-DE")}</div></div>
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
    </main>
  )
}