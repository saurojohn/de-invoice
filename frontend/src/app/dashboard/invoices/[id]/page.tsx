"use client"

import { useEffect, useState } from "react"
import { useRouter, useParams } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { useI18n } from "@/components/useI18n"
import { apiGet, apiPost, apiPut, apiDelete, apiFetch, ApiError } from "@/lib/api"
import { substitute } from "@/lib/substitute"
import PdfSignaturePanel from "@/components/PdfSignaturePanel"

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
  deliveryDate?: string
  currency: string
  subtotal: string
  totalVat: string
  total: string
  notes: string
  customer: { name: string; address: any; vatId: string; contact?: { email?: string; phone?: string } | null }
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
  // Tier 51: the (optional) Ratenplan attached to
  // this invoice. `null` = invoice is paid in one
  // lump, no plan. The plan carries per-Rate
  // status that drives the Raten schedule below.
  const [installmentPlan, setInstallmentPlan] = useState<any | null>(null)
  const [showPlanModal, setShowPlanModal] = useState(false)
  // Tier 65: Auto-Ratenplan suggestion payload. The
  // suggestion endpoint checks amount >= threshold,
  // existing plan, customer active plan, etc. and
  // returns pre-filled defaults for the modal. The
  // banner is only rendered when `suggestion.eligible`
  // is true. We tolerate failure on this fetch (the
  // banner just doesn't show) — the modal is the
  // primary UX path.
  const [ratensplanSuggestion, setRatenplanSuggestion] =
    useState<any | null>(null)
  // Tier 65: separate modal for the "Ratenplan
  // anbieten?" banner flow. Distinct from the
  // existing `showPlanModal` (which edits an
  // existing plan's Raten). When the user clicks
  // "Ratenplan erstellen" on the banner, we
  // pre-fill planForm from `ratensplanSuggestion.defaults`
  // and open this modal.
  const [showSuggestModal, setShowSuggestModal] = useState(false)
  const [suggestSaving, setSuggestSaving] = useState(false)
  const [suggestError, setSuggestError] = useState<string | null>(null)
  const [suggestForm, setSuggestForm] = useState({
    installmentCount: 3,
    intervalDays: 30,
    firstDueDate: "",
    notes: "",
    autoPause: true,
  })
  const [planSaving, setPlanSaving] = useState(false)
  const [planError, setPlanError] = useState<string | null>(null)
  const [planForm, setPlanForm] = useState({
    installmentCount: '3',
    intervalDays: '30',
    firstDueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10),
    notes: '',
  })
  // Per-Rate "als bezahlt markieren" — Betrag input
  // stored as a map of installmentId → string so the
  // user can type partial payments per Rate.
  const [payRateAmount, setPayRateAmount] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [sendResult, setSendResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [statusChanging, setStatusChanging] = useState(false)
  const [deleting, setDeleting] = useState(false)
  // Tier 33: customer self-service portal link.
  // The admin clicks "Zahlungslink erstellen" → the
  // backend mints a PaymentLink row with a 32-byte hex
  // token + +30d expiry. We display the URL so the
  // admin can copy + paste it into the email body or
  // send it via the existing send-email modal.
  const [portalLink, setPortalLink] = useState<{
    url: string
    expiresAt: string
    reused: boolean
  } | null>(null)
  const [portalLinkGenerating, setPortalLinkGenerating] = useState(false)
  const [portalLinkError, setPortalLinkError] = useState<string | null>(null)
  const [portalLinkCopied, setPortalLinkCopied] = useState(false)
  // Tier 138: internal team notes. Loaded on mount
  // and re-fetched after add/delete. Empty for
  // invoices with no notes yet.
  const [internalNotes, setInternalNotes] = useState<
    Array<{
      id: string
      body: string
      userId: string | null
      userEmail: string | null
      createdAt: string
    }>
  >([])
  const [newNote, setNewNote] = useState("")
  const [addingNote, setAddingNote] = useState(false)
  const [deletingNoteId, setDeletingNoteId] = useState<string | null>(null)
  const [internalNoteError, setInternalNoteError] = useState<string | null>(null)
  // Tier 140: invoice Belege (attachments). Reuses
  // the /api/v1/attachments endpoint with
  // entityType='invoice'; the /:id/attachments
  // list proxy on the invoice controller returns
  // them filtered to this invoice.
  const [invoiceAttachments, setInvoiceAttachments] = useState<
    Array<{
      id: string
      originalName: string
      mimeType: string
      size: number
      createdAt: string
      uploadedById: string | null
      uploadedBy: { id: string; email: string } | null
    }>
  >([])
  const [uploadingAttachment, setUploadingAttachment] = useState(false)
  const [deletingAttachmentId, setDeletingAttachmentId] = useState<string | null>(null)
  const [attachmentError, setAttachmentError] = useState<string | null>(null)
  const [showPayForm, setShowPayForm] = useState(false)
  // Tier 53: Gutschrift modal state. `cnAmount` is
  // the partial refund value (we always pass a flat
  // amount to the backend — it generates a single
  // "Erstattung" line on the CN). For full refund
  // the user can clear the field; the backend then
  // mirrors the original lines.
  const [showCnModal, setShowCnModal] = useState(false)
  const [cnAmount, setCnAmount] = useState<string>("")
  const [cnReason, setCnReason] = useState<string>("")
  const [cnSaving, setCnSaving] = useState(false)
  const [cnError, setCnError] = useState<string | null>(null)
  const [payForm, setPayForm] = useState({
    amount: '',
    paymentDate: new Date().toISOString().split("T")[0],
    paymentMethod: "bank_transfer",
    reference: '',
    notes: '',
  })
  const [paySaving, setPaySaving] = useState(false)

  // ─── Email send modal ────────────────────────────────────────────
  // Opens on click of "Per E-Mail senden". The user can:
  //   - pick a locale (de / en / zh) — the template re-renders
  //   - override the recipient (form pre-fills from
  //     customer.contact.email)
  //   - add additional CC addresses
  //   - edit the subject and body (the user-overrides replace
  //     the rendered template)
  // The form's submit calls /invoices/:id/send-email with the
  // appropriate override fields.
  const [showEmailModal, setShowEmailModal] = useState(false)
  const [emailLang, setEmailLang] = useState<"de" | "en" | "zh">("de")
  const [emailTo, setEmailTo] = useState("")
  const [emailExtraCc, setEmailExtraCc] = useState("")
  const [emailSubject, setEmailSubject] = useState("")
  const [emailBody, setEmailBody] = useState("")
  // Tracks whether the user has touched the subject/body — once
  // they do, the template re-render on language change is
  // skipped for that field (we don't want to clobber their edits).
  const [subjectTouched, setSubjectTouched] = useState(false)
  const [bodyTouched, setBodyTouched] = useState(false)

  useEffect(() => {
    const companyId = localStorage.getItem("companyId")
    if (!companyId) {
      router.push("/login")
      return
    }

    Promise.all([
      apiGet<any>(`/api/v1/invoices/${params.id}?companyId=${companyId}`),
      apiGet<any[]>(`/api/v1/invoices/${params.id}/payments?companyId=${companyId}`),
      // Tier 51: try fetching the Ratenplan. The
      // /by-invoice/:id endpoint returns the (one)
      // plan attached to this invoice or null — no
      // need to scan every active plan.
      apiGet<any>(
        `/api/v1/installment-plans/by-invoice/${params.id}?companyId=${companyId}`,
      ).catch(() => null),
      // Tier 138: internal team notes. Catch so a
      // brand-new invoice (no notes yet) doesn't
      // blow up the page if the endpoint is missing
      // for any reason.
      apiGet<any[]>(`/api/v1/invoices/${params.id}/internal-notes?companyId=${companyId}`)
        .catch(() => []),
      // Tier 140: invoice Belege. Same defensive
      // .catch — a brand-new invoice has no
      // attachments.
      apiGet<any[]>(`/api/v1/invoices/${params.id}/attachments?companyId=${companyId}`)
        .catch(() => []),
      // Tier 65: auto-Ratenplan suggestion. We catch
      // the error so a missing endpoint (e.g. before
      // a backend restart completes) doesn't break
      // the page — the banner just doesn't render.
      apiGet<any>(
        `/api/v1/installment-plans/suggestion/${params.id}?companyId=${companyId}`,
      ).catch(() => null),
    ]).then(([inv, pmts, plan, sug, notes, atts]) => {
      setInvoice(inv)
      setPayments(Array.isArray(pmts) ? pmts : [])
      setInstallmentPlan(plan)
      setRatenplanSuggestion(sug)
      setInternalNotes(Array.isArray(notes) ? notes : [])
      setInvoiceAttachments(Array.isArray(atts) ? atts : [])
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

  // Tier 138: add a new internal team note.
  // The backend returns the saved note (with id
  // + createdAt) so we can prepend it to the
  // list without a round-trip fetch.
  const addInternalNote = async () => {
    if (!invoice || !newNote.trim()) return
    const companyId = localStorage.getItem("companyId")
    if (!companyId) return
    setAddingNote(true)
    setInternalNoteError(null)
    try {
      const created = await apiPost<{
        id: string
        body: string
        userId: string | null
        userEmail: string | null
        createdAt: string
      }>(
        `/api/v1/invoices/${invoice.id}/internal-notes?companyId=${companyId}`,
        { body: newNote },
      )
      setInternalNotes([created, ...internalNotes])
      setNewNote("")
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err)
      setInternalNoteError(msg)
    } finally {
      setAddingNote(false)
    }
  }

  // Tier 138: delete one note. Backend enforces
  // "only author or admin can delete" — a 403
  // here means someone else wrote this note.
  const deleteInternalNote = async (noteId: string) => {
    if (!invoice) return
    if (!confirm("Diese interne Notiz wirklich löschen?")) return
    const companyId = localStorage.getItem("companyId")
    if (!companyId) return
    setDeletingNoteId(noteId)
    try {
      await apiDelete(
        `/api/v1/invoices/${invoice.id}/internal-notes/${noteId}?companyId=${companyId}`,
      )
      setInternalNotes(internalNotes.filter((n) => n.id !== noteId))
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err)
      alert(msg)
    } finally {
      setDeletingNoteId(null)
    }
  }

  // Tier 140: upload a new Beleg to this invoice.
  // The upload goes through the generic
  // /api/v1/attachments endpoint with
  // entityType='invoice' + entityId=invoiceId. The
  // server pipeline (storage → OCR → content-hash
  // → DB row) is the same as expenses / vouchers,
  // so a PDF gets its fulltext extracted in the
  // background and the audit trail (hash + uploader
  // + timestamp) is in the same shape as every
  // other Beleg.
  const uploadInvoiceAttachment = async (
    e: React.ChangeEvent<HTMLInputElement>,
  ) => {
    if (!invoice) return
    const file = e.target.files?.[0]
    if (!file) return
    const companyId = localStorage.getItem("companyId")
    const userId = localStorage.getItem("userId")
    if (!companyId) return
    // Reset the input so picking the same file
    // twice still triggers onChange.
    e.target.value = ""
    if (file.size > 10 * 1024 * 1024) {
      setAttachmentError("Datei zu groß (max. 10MB).")
      return
    }
    setUploadingAttachment(true)
    setAttachmentError(null)
    try {
      const fd = new FormData()
      fd.append("file", file)
      fd.append("companyId", companyId)
      fd.append("entityType", "invoice")
      fd.append("entityId", invoice.id)
      if (userId) fd.append("uploadedById", userId)
      const apiBase = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001"
      const res = await fetch(`${apiBase}/api/v1/attachments`, {
        method: "POST",
        headers: {
          "x-user-id": userId || "",
          "x-company-id": companyId,
        },
        body: fd,
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        const msg = Array.isArray(data.message)
          ? data.message.join(", ")
          : data.message || `HTTP ${res.status}`
        throw new Error(msg)
      }
      const created = await res.json()
      setInvoiceAttachments([...invoiceAttachments, created])
    } catch (err) {
      setAttachmentError(
        err instanceof Error ? err.message : String(err),
      )
    } finally {
      setUploadingAttachment(false)
    }
  }

  const deleteInvoiceAttachment = async (attachmentId: string) => {
    if (!invoice) return
    if (!confirm("Diesen Beleg wirklich löschen?")) return
    const companyId = localStorage.getItem("companyId")
    if (!companyId) return
    setDeletingAttachmentId(attachmentId)
    try {
      await apiDelete(
        `/api/v1/invoices/${invoice.id}/attachments/${attachmentId}?companyId=${companyId}`,
      )
      setInvoiceAttachments(
        invoiceAttachments.filter((a) => a.id !== attachmentId),
      )
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err)
      alert(msg)
    } finally {
      setDeletingAttachmentId(null)
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
      draft: "bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-200",
      sent: "bg-blue-100 text-blue-700 dark:text-blue-300",
      paid: "bg-green-100 text-green-700 dark:text-green-300",
      overdue: "bg-red-100 text-red-700 dark:text-red-300",
      cancelled: "bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400",
    }
    return colors[status] || colors.draft
  }

  const getVatLabel = (rate: string) => {
    const r = parseFloat(rate)
    if (r === 0.19) return "19%"
    if (r === 0.07) return "7%"
    return "0%"
  }

  // Helper: format a number as currency in the given locale
  // (used by the email template preview to keep server /
  // client formatting identical — we want the user to see
  // exactly what the recipient will see).
  const fmtAmountForEmail = (n: number, currency: string, lang: "de" | "en" | "zh"): string => {
    try {
      const locale = lang === "de" ? "de-DE" : lang === "en" ? "en-US" : "zh-CN"
      return new Intl.NumberFormat(locale, { style: "currency", currency }).format(n)
    } catch {
      return `${n.toFixed(2)} ${currency}`
    }
  }
  const fmtDateForEmail = (s: string | null | undefined, lang: "de" | "en" | "zh"): string => {
    if (!s) return "—"
    try {
      const locale = lang === "de" ? "de-DE" : lang === "en" ? "en-US" : "zh-CN"
      return new Intl.DateTimeFormat(locale, {
        day: "2-digit", month: "2-digit", year: "numeric",
      }).format(new Date(s))
    } catch {
      return s
    }
  }

  // Canonical email templates for all 3 locales. The backend
  // uses the same strings (see backend/src/modules/mail/
  // templates/invoice-email.template.ts) so the form preview
  // and the actually-sent text are byte-identical. The
  // messages/*.json 'billingEmail' namespace is for the
  // page-level i18n (button labels, modal title), not the
  // email body itself.
  const TEMPLATE_FALLBACK: Record<"de" | "en" | "zh", { subject: string; body: string }> = {
    de: {
      subject: "Rechnung {invoiceNumber} von {companyName}",
      body:
        "{salutation} {customerName},\n\n" +
        "anbei erhalten Sie die Rechnung {invoiceNumber} über {amount}.\n\n" +
        "Bitte begleichen Sie den Betrag bis zum {dueDate}.\n\n" +
        "Die Rechnung finden Sie im Anhang als PDF.\n\n" +
        "Mit freundlichen Grüßen\n{companyName}",
    },
    en: {
      subject: "Invoice {invoiceNumber} from {companyName}",
      body:
        "{salutation} {customerName},\n\n" +
        "Please find attached invoice {invoiceNumber} for {amount}.\n\n" +
        "The amount is due by {dueDate}.\n\n" +
        "The invoice is attached as a PDF.\n\n" +
        "Kind regards,\n{companyName}",
    },
    zh: {
      subject: "发票 {invoiceNumber} 来自 {companyName}",
      body:
        "{salutation}{customerName}:\n\n" +
        "随信附上发票 {invoiceNumber},金额 {amount}。\n\n" +
        "请于 {dueDate} 前支付。\n\n" +
        "发票以 PDF 格式附在邮件中。\n\n" +
        "此致\n敬礼\n\n" +
        "{companyName}",
    },
  }

  // Tier 33: portal link generation. POST the invoice
  // id + the page origin (window.location.origin) so
  // the returned URL has the right base for "copy link"
  // UX. The backend is idempotent — calling this twice
  // returns the same link.
  const generatePortalLink = async () => {
    if (!invoice) return
    const companyId =
      localStorage.getItem("companyId") || ""
    if (!companyId) return
    setPortalLinkGenerating(true)
    setPortalLinkError(null)
    setPortalLinkCopied(false)
    try {
      const { apiFetch, ApiError } = await import("@/lib/api")
      const res = await apiFetch(
        `/api/v1/invoices/${invoice.id}/generate-payment-link?companyId=${companyId}`,
        {
          method: "POST",
          body: { origin: window.location.origin },
        },
      )
      // apiFetch returns the Response — we read the
      // body manually. Throwing on non-2xx lets the
      // catch block surface ApiError.
      if (!res.ok) {
        const txt = await res.text().catch(() => "")
        throw new Error(`${res.status} ${res.statusText} ${txt}`)
      }
      const data = (await res.json()) as {
        url: string
        expiresAt: string
        reused?: boolean
      }
      setPortalLink({
        url: data.url,
        expiresAt: data.expiresAt,
        reused: data.reused ?? false,
      })
    } catch (err) {
      const msg =
        err instanceof ApiError ? err.message : "Unbekannter Fehler"
      setPortalLinkError(msg)
    } finally {
      setPortalLinkGenerating(false)
    }
  }

  const copyPortalLink = async () => {
    if (!portalLink) return
    try {
      await navigator.clipboard.writeText(portalLink.url)
      setPortalLinkCopied(true)
      setTimeout(() => setPortalLinkCopied(false), 2000)
    } catch {
      // Clipboard API can be blocked on http:// origins
      // (Firefox + some Safari configs). Fall back to a
      // hidden select+copy via temporary textarea.
      try {
        const ta = document.createElement("textarea")
        ta.value = portalLink.url
        ta.style.position = "fixed"
        ta.style.opacity = "0"
        document.body.appendChild(ta)
        ta.select()
        document.execCommand("copy")
        document.body.removeChild(ta)
        setPortalLinkCopied(true)
        setTimeout(() => setPortalLinkCopied(false), 2000)
      } catch {
        // give up — the user can still manually select
        // the URL from the readonly input we show.
      }
    }
  }

  // Tier 63: "Wiederkehrend machen" — convert this
  // invoice into a recurring template. The user
  // clicks the button, we fetch the prefill payload
  // from the backend, stash it in sessionStorage,
  // and route to the recurring-invoices page which
  // reads the stash and opens the create modal
  // pre-populated. sessionStorage (not localStorage)
  // because the prefill is single-use: a stale
  // prefill from a previous click shouldn't bleed
  // into a fresh page-load.
  const [converting, setConverting] = useState(false)
  const [convertError, setConvertError] = useState<string | null>(null)

  // Tier 64: per-invoice Mahnungspause. Shown only
  // when the invoice is overdue (status='sent' or
  // 'overdue' + past dueDate). The button opens a
  // tiny modal asking for reason + pausedUntil.
  // We don't pre-check the existing active pause
  // here — clicking the button when a pause is
  // already active is a 400 from the backend
  // (which the modal surfaces inline).
  const [showInvoicePauseModal, setShowInvoicePauseModal] =
    useState(false)
  const [invoicePauseSaving, setInvoicePauseSaving] = useState(false)
  const [invoicePauseError, setInvoicePauseError] = useState<
    string | null
  >(null)
  const [invoicePauseForm, setInvoicePauseForm] = useState({
    reason: "",
    pausedUntil: "",
  })

  const convertToRecurring = async () => {
    if (!invoice) return
    setConvertError(null)
    setConverting(true)
    try {
      const companyId =
        typeof window !== "undefined"
          ? localStorage.getItem("companyId")
          : null
      if (!companyId) {
        setConvertError("Kein Unternehmen ausgewählt")
        setConverting(false)
        return
      }
      const prefill = await apiGet<any>(
        `/api/v1/recurring-invoices/from-invoice/${invoice.id}?companyId=${companyId}`,
      )
      sessionStorage.setItem(
        "recurring-prefill",
        JSON.stringify(prefill),
      )
      router.push("/dashboard/recurring-invoices?prefill=1")
    } catch (e: any) {
      const msg = e?.message || "Konvertierung fehlgeschlagen"
      setConvertError(msg)
    } finally {
      setConverting(false)
    }
  }

  const openEmailModal = () => {
    if (!invoice) return
    // Pre-fill from the customer's email and the German
    // template as the starting point (German is the
    // page-level locale; the form lets the user switch).
    const lang: "de" | "en" | "zh" = "de"
    const tpl = TEMPLATE_FALLBACK[lang]
    const amount = fmtAmountForEmail(
      parseFloat(invoice.total || "0"),
      invoice.currency || "EUR",
      lang,
    )
    const dueDate = fmtDateForEmail(invoice.dueDate, lang)
    const salutation = invoice.customer.name ? "Sehr geehrte/r" : ""
    const vars: Record<string, string> = {
      invoiceNumber: invoice.invoiceNumber,
      customerName: invoice.customer.name || "",
      amount,
      dueDate,
      companyName: invoice.company?.name || "",
      salutation,
    }
    setEmailLang(lang)
    setEmailTo(invoice.customer.contact?.email || "")
    setEmailExtraCc("")
    setEmailSubject(substitute(tpl.subject, vars))
    setEmailBody(substitute(tpl.body, vars))
    setSubjectTouched(false)
    setBodyTouched(false)
    setShowEmailModal(true)
    setSendResult(null)
  }

  // Re-render the template when the user changes the
  // language — but only for fields they haven't edited.
  // If they HAVE edited, we keep their text and only
  // change the locale (the body text stays in the user's
  // chosen language; we don't try to translate it).
  const onEmailLangChange = (lang: "de" | "en" | "zh") => {
    setEmailLang(lang)
    const tpl = TEMPLATE_FALLBACK[lang]
    const amount = fmtAmountForEmail(
      parseFloat(invoice?.total || "0"),
      invoice?.currency || "EUR",
      lang,
    )
    const dueDate = fmtDateForEmail(invoice?.dueDate, lang)
    const salutation = invoice?.customer.name
      ? (lang === "de" ? "Sehr geehrte/r" : lang === "en" ? "Dear" : "尊敬的")
      : ""
    const vars: Record<string, string> = {
      invoiceNumber: invoice?.invoiceNumber || "",
      customerName: invoice?.customer.name || "",
      amount,
      dueDate,
      companyName: invoice?.company?.name || "",
      salutation,
    }
    if (!subjectTouched) setEmailSubject(substitute(tpl.subject, vars))
    if (!bodyTouched) setEmailBody(substitute(tpl.body, vars))
  }

  // Send the email with the form values. Closes the modal
  // on success.
  const confirmSendEmail = async () => {
    if (!invoice) return
    setSending(true)
    setSendResult(null)
    try {
      const companyId = localStorage.getItem("companyId")
      const userId = localStorage.getItem("userId") || undefined
      const userEmail = localStorage.getItem("userEmail") || ""
      if (!companyId) return
      // Parse extra CC: comma-separated list.
      const extraCc = emailExtraCc
        .split(/[,;\n]/)
        .map((s) => s.trim())
        .filter(Boolean)
      const data = await apiPost<any>(
        `/api/v1/invoices/${invoice.id}/send-email?companyId=${companyId}`,
        {
          ccEmail: userEmail || undefined,
          extraCc: extraCc.length ? extraCc : undefined,
          overrideTo: emailTo || undefined,
          overrideSubject: subjectTouched ? emailSubject : undefined,
          overrideBody: bodyTouched ? emailBody : undefined,
          language: emailLang,
          createdById: userId,
        },
      )
      setSendResult({
        ok: true,
        message: data.smtpConfigured
          ? `E-Mail an ${data.recipient} gesendet${data.cc?.length ? ` (CC: ${data.cc.join(", ")})` : ""}`
          : `E-Mail vorbereitet (SMTP nicht konfiguriert — Server-Log prüfen)`,
      })
      setShowEmailModal(false)
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
      // Append a cache-busting timestamp to the PDF URL.
      // Without this, the browser can serve a stale PDF from
      // its HTTP cache (Chrome caches GET responses with
      // Cache-Control: max-age or Last-Modified by default,
      // and NestJS often returns a Last-Modified header that
      // the browser then uses to validate cached responses).
      // The user reported "I printed the invoice and don't
      // see the new layout" multiple times — the fix is to
      // make every PDF request a fresh one.
      const cacheBust = `t=${Date.now()}`
      const response = await apiFetch(
        `/api/v1/invoices/${invoice.id}/pdf?companyId=${companyId}&${cacheBust}`,
        { throwOnError: false }
      )
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
    <main className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <header className="bg-white dark:bg-gray-800 border-b shadow-sm">
        {/* Tier 121: flex-wrap + responsive padding. The
            header has 3+ controls (back, invoice #,
            status dropdown) — on a 375px phone they
            stack vertically instead of clipping. */}
        <div className="container mx-auto px-3 sm:px-4 py-3 sm:py-4 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2 sm:gap-4">
            <Button size="sm" variant="outline" onClick={() => router.push("/dashboard/invoices")}>Zurück</Button>
            <h1 className="text-xl sm:text-2xl font-bold text-blue-600 dark:text-blue-400">{invoice.invoiceNumber}</h1>
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
          <div className="flex gap-2 items-center flex-wrap">
            <Button variant="outline" onClick={openEmailModal} disabled={sending}>
              {sending ? "Wird gesendet..." : "Per E-Mail senden"}
            </Button>
            {/* Tier 33: payment link for the customer portal.
                First click mints the link via the backend.
                Subsequent clicks show the same URL (the
                backend returns reused=true — same idem-
                potent behaviour). */}
            <Button
              variant="outline"
              onClick={generatePortalLink}
              disabled={portalLinkGenerating}
              data-testid="invoice-portal-link-button"
            >
              {portalLinkGenerating
                ? "Erstelle Link..."
                : "Zahlungslink anzeigen"}
            </Button>
            {sendResult && (
              <span
                className={`text-sm ${sendResult.ok ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}
              >
                {sendResult.ok ? "✓" : "✗"} {sendResult.message}
              </span>
            )}
            <Button
              variant="outline"
              onClick={downloadXRechnung}
              data-testid="invoice-download-xrechnung"
            >
              XRechnung herunterladen
            </Button>
            <Button
              variant="outline"
              onClick={downloadZUGFeRD}
              data-testid="invoice-download-zugferd"
            >
              ZUGFeRD herunterladen
            </Button>
            <Button
              onClick={downloadPDF}
              data-testid="invoice-download-pdf"
            >
              PDF herunterladen
            </Button>
            {/* Edit + Hard-delete are only allowed on the invoice's
                issueDate. For past-date invoices the backend returns
                403 — we hide the buttons and show a hint pointing
                the user at "Stornieren" via the status dropdown. */}
            {isToday && (
              <>
                <Button
                  variant="outline"
                  onClick={() => router.push(`/dashboard/invoices/create?id=${invoice.id}`)}
                  className="text-blue-600 dark:text-blue-400 border-blue-300 dark:border-blue-700 hover:bg-blue-50"
                >
                  Bearbeiten
                </Button>
                <Button
                  variant="outline"
                  onClick={deleteInvoice}
                  disabled={deleting}
                  className="text-red-600 dark:text-red-400 border-red-300 dark:border-red-700 hover:bg-red-50"
                >
                  {deleting ? "..." : "Löschen"}
                </Button>
              </>
            )}
            {!isToday && invoice && (
              <span
                className="text-xs text-gray-500 dark:text-gray-400"
                title="Diese Rechnung ist eingefroren. Nur der Status kann noch geändert werden (Stornieren etc.)."
              >
                Eingefroren (Status änderbar)
              </span>
            )}
          </div>
        </div>
      </header>

      <div className="container mx-auto px-3 sm:px-4 py-4 sm:py-8 max-w-4xl">
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
                <div className="text-2xl font-bold text-gray-900 dark:text-gray-100">{invoice.company.name}</div>
                {invoice.company.legalName && invoice.company.legalName !== invoice.company.name && (
                  <div className="text-gray-600 dark:text-gray-300 text-xs">{invoice.company.legalName}</div>
                )}
                {invoice.company.address?.street && (
                  <div className="text-gray-700 dark:text-gray-200">{invoice.company.address.street}</div>
                )}
                {(invoice.company.address?.postalCode || invoice.company.address?.city) && (
                  <div className="text-gray-700 dark:text-gray-200">
                    {invoice.company.address.postalCode} {invoice.company.address.city}
                  </div>
                )}
                {invoice.company.address?.country && (
                  <div className="text-gray-700 dark:text-gray-200">{invoice.company.address.country}</div>
                )}
                <div className="mt-2 text-xs text-gray-500 dark:text-gray-400 space-x-2">
                  {invoice.company.vatId && <span>UST-IDNr.: {invoice.company.vatId}</span>}
                  {invoice.company.taxId && <span>· Steuernr.: {invoice.company.taxId}</span>}
                </div>
                {(invoice.company.email || invoice.company.phone) && (
                  <div className="text-xs text-gray-500 dark:text-gray-400 space-x-2">
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
          {/* Tier 126: min-w-0 so the grid item can shrink
              below its content's intrinsic min-width. The
              sender address line uses whitespace-nowrap +
              text-ellipsis, which gives the Card a
              ~415px min-width on a 375px phone (the
              address "SH Leder GmbH · Otto-Hahn..." is
              long). Without min-w-0, the grid column
              forces the whole page to overflow. */}
          <Card className="min-w-0">
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
                <div className="-mt-1 text-xs font-normal tracking-normal text-gray-500 dark:text-gray-400 whitespace-nowrap overflow-hidden text-ellipsis">
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
                {invoice.customer?.vatId && <div className="text-gray-600 dark:text-gray-300">UST-IDNr.: {invoice.customer.vatId}</div>}
                {invoice.customer?.address && (
                  <div className="text-gray-600 dark:text-gray-300">
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
                <div><div className="text-sm text-gray-500 dark:text-gray-400">Ausstellungsdatum</div><div>{formatDate(invoice.issueDate)}</div></div>
                <div><div className="text-sm text-gray-500 dark:text-gray-400">Fälligkeitsdatum</div><div>{formatDate(invoice.dueDate)}</div></div>
                {invoice.deliveryDate && (
                  <div><div className="text-sm text-gray-500 dark:text-gray-400">Liefertermin</div><div>{formatDate(invoice.deliveryDate)}</div></div>
                )}
                <div><div className="text-sm text-gray-500 dark:text-gray-400">Rechnungsart</div><div>{invoice.type}</div></div>
                <div><div className="text-sm text-gray-500 dark:text-gray-400">Währung</div><div>{invoice.currency}</div></div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Tier 72: PDF signature panel (GoBD § 146) */}
        <div className="mb-6">
          <PdfSignaturePanel invoiceId={String(params?.id || '')} />
        </div>

        {/* Items Table */}
        <Card className="mb-8">
          <CardHeader><CardTitle>Positionen</CardTitle></CardHeader>
          <CardContent className="p-0">
            {/* Tier 121: overflow-x-auto + min-width so the
                line-items table scrolls horizontally on
                a phone instead of pushing the card out
                of bounds. The min-w-[640px] gives the
                columns enough room to be readable. */}
            <div className="overflow-x-auto">
            <table className="w-full min-w-[640px]">
              <thead className="bg-gray-50 dark:bg-gray-900 border-b">
                <tr>
                  <th className="px-4 py-3 text-left text-sm font-medium text-gray-600 dark:text-gray-300">Beschreibung</th>
                  <th className="px-4 py-3 text-center text-sm font-medium text-gray-600 dark:text-gray-300">Menge</th>
                  <th className="px-4 py-3 text-right text-sm font-medium text-gray-600 dark:text-gray-300">Einzelpreis</th>
                  <th className="px-4 py-3 text-right text-sm font-medium text-gray-600 dark:text-gray-300">MwSt</th>
                  <th className="px-4 py-3 text-right text-sm font-medium text-gray-600 dark:text-gray-300">Netto</th>
                  <th className="px-4 py-3 text-right text-sm font-medium text-gray-600 dark:text-gray-300">Steuer</th>
                  <th className="px-4 py-3 text-right text-sm font-medium text-gray-600 dark:text-gray-300">Brutto</th>
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
            </div>
          </CardContent>
        </Card>

        {/* Totals */}
        <div className="flex justify-end">
          <Card className="w-80">
            <CardContent className="space-y-3">
              <div className="flex justify-between"><span className="text-gray-600 dark:text-gray-300">Zwischensumme (Netto):</span><span>€{parseFloat(invoice.subtotal).toFixed(2)}</span></div>
              <div className="flex justify-between"><span className="text-gray-600 dark:text-gray-300">Umsatzsteuer:</span><span>€{parseFloat(invoice.totalVat).toFixed(2)}</span></div>
              <div className="flex justify-between text-xl font-bold border-t pt-3"><span>Gesamtbetrag:</span><span className="text-blue-600 dark:text-blue-400">€{parseFloat(invoice.total).toFixed(2)}</span></div>
              <div className="flex justify-between text-sm pt-1"><span className="text-green-700 dark:text-green-300">Bezahlt:</span><span className="text-green-700 dark:text-green-300">€{totalPaid.toFixed(2)}</span></div>
              <div className={`flex justify-between text-sm font-semibold ${outstanding > 0.01 ? "text-red-600 dark:text-red-400" : "text-green-700 dark:text-green-300"}`}>
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
            <div className="flex flex-wrap gap-2">
              {/* Tier 53: Gutschrift (credit note) button.
                  Only on INV-typed invoices (not CN) that
                  aren't cancelled. Opens a tiny modal
                  asking for the refund amount + reason;
                  backend creates a CN with negative
                  total + a synthetic Payment on this
                  invoice. */}
              {invoice.type !== "CN" &&
                invoice.status !== "cancelled" && (
                  <Button
                    size="sm"
                    variant="outline"
                    data-testid="credit-note-button"
                    onClick={() => {
                      setShowPayForm(false)
                      setCnReason("")
                      setCnAmount(
                        Math.max(
                          0,
                          Number(invoice.total) -
                            payments.reduce(
                              (s, p) => s + Number(p.amount),
                              0,
                            ),
                        ).toFixed(2),
                      )
                      setShowCnModal(true)
                    }}
                    className="border-orange-300 dark:border-orange-700 text-orange-700 dark:text-orange-300"
                  >
                    {t("invoice.creditNote") || "Gutschrift"}
                  </Button>
                )}
              {/* Tier 63: "Wiederkehrend" button. Converts
                  this invoice into a recurring template
                  (prefill via /from-invoice/:id, then
                  router.push to the recurring page with
                  ?prefill=1). Hidden on CN (credit notes
                  don't make sense as recurring sources) and
                  on cancelled invoices. The handler is
                  `converting` to disable the button while
                  the prefill fetch is in flight. */}
              {invoice.type !== "CN" &&
                invoice.status !== "cancelled" && (
                  <Button
                    size="sm"
                    variant="outline"
                    data-testid="make-recurring-button"
                    onClick={convertToRecurring}
                    disabled={converting}
                    className="border-purple-300 dark:border-purple-700 text-purple-700 dark:text-purple-300"
                    title={
                      t("invoice.makeRecurringTitle") ||
                      "Aus dieser Rechnung eine Abo-Vorlage erstellen"
                    }
                  >
                    {converting
                      ? "..."
                      : t("invoice.makeRecurring") || "Wiederkehrend"}
                  </Button>
                )}
              {/* Tier 64: "Mahnung pausieren" button.
                  Shown only on sent / overdue invoices
                  (not drafts, not cancelled, not credit
                  notes). Opens a modal that POSTs
                  /api/v1/mahnungspausen with this
                  invoice's id. The pause is per-invoice;
                  a customer-level pause can be set from
                  the customer detail page. */}
              {(invoice.status === "sent" || invoice.status === "overdue") && (
                <Button
                  size="sm"
                  variant="outline"
                  data-testid="pause-invoice-button"
                  onClick={() => {
                    setInvoicePauseError(null)
                    setInvoicePauseForm({ reason: "", pausedUntil: "" })
                    setShowInvoicePauseModal(true)
                  }}
                  className="border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-300"
                  title={
                    t("invoice.pauseInvoiceTitle") ||
                    "Mahnung für diese Rechnung pausieren"
                  }
                >
                  ⏸ {t("invoice.pauseInvoice") || "Mahnung pausieren"}
                </Button>
              )}
              {convertError && (
                <span
                  className="text-sm text-red-600 dark:text-red-400"
                  data-testid="make-recurring-error"
                >
                  {convertError}
                </span>
              )}
              {invoice.type !== "CN" &&
                invoice.status !== "cancelled" && (
                  <Button
                    size="sm"
                    onClick={() => setShowPayForm(!showPayForm)}
                    variant={showPayForm ? "outline" : "default"}
                  >
                    {showPayForm ? "×" : "+ Zahlung erfassen"}
                  </Button>
                )}
            </div>
          </CardHeader>
          {showPayForm && (
            <CardContent className="bg-gray-50 dark:bg-gray-900 border-t">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">Betrag (€) *</label>
                  <Input
                    type="number"
                    step="0.01"
                    value={payForm.amount}
                    onChange={(e) => setPayForm({ ...payForm, amount: e.target.value })}
                    placeholder={outstanding > 0 ? `Offen: ${outstanding.toFixed(2)}` : "0.00"}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">Zahldatum *</label>
                  <Input
                    type="date"
                    value={payForm.paymentDate}
                    onChange={(e) => setPayForm({ ...payForm, paymentDate: e.target.value })}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">Zahlungsweg *</label>
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
                  <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">Referenz (optional)</label>
                  <Input
                    value={payForm.reference}
                    onChange={(e) => setPayForm({ ...payForm, reference: e.target.value })}
                    placeholder="z.B. Kontoauszug-Nr., Transaktions-ID"
                  />
                </div>
                <div className="md:col-span-2">
                  <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">Notizen (optional)</label>
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
            <CardContent className="text-center text-sm text-gray-500 dark:text-gray-400 py-4">
              Noch keine Zahlungen erfasst.
            </CardContent>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
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
                    <tr key={p.id} className="border-b hover:bg-gray-50 dark:bg-gray-900">
                      <td className="px-4 py-2">{formatDate(p.paymentDate)}</td>
                      <td className="px-4 py-2">{paymentMethodLabel(p.paymentMethod)}</td>
                      <td className="px-4 py-2 text-gray-600 dark:text-gray-300">{p.reference || "—"}</td>
                      <td className="px-4 py-2 text-right font-medium">€{Number(p.amount).toFixed(2)}</td>
                      <td className="px-4 py-2 text-right">
                        <button
                          onClick={() => deletePayment(p.id)}
                          className="text-red-600 dark:text-red-400 hover:underline text-xs"
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

        {/* Tier 65: Auto-Ratenplan banner. Shown when
            the suggestion endpoint says the invoice
            is eligible (amount >= threshold, no
            existing plan, no customer active plan).
            The banner disappears once the user creates
            the plan (we re-fetch the suggestion after
            a successful create). The banner is muted
            (not loud) because the user just opened
            this page for a different reason — they
            shouldn't feel ambushed. */}
        {ratensplanSuggestion?.eligible && !installmentPlan && (
          <div
            className="mt-6 p-4 rounded-lg border border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/30 flex items-start justify-between gap-4"
            data-testid="ratensplan-suggest-banner"
          >
            <div>
              <p className="font-medium text-sm text-amber-900 dark:text-amber-200">
                ⏰ {t("invoice.ratensplanSuggestTitle") || "Ratenplan anbieten?"}
              </p>
              <p className="text-xs text-amber-700 dark:text-amber-300 mt-1">
                {(
                  t("invoice.ratensplanSuggestDesc") ||
                  "Diese Rechnung über {amount} liegt über dem Schwellenwert von {threshold} EUR. Sie können dem Kunden einen Ratenplan anbieten."
                )
                  .replace(
                    "{amount}",
                    Number(invoice?.total || 0).toFixed(2) +
                      " " +
                      (invoice?.currency || "EUR"),
                  )
                  .replace("{threshold}", ratensplanSuggestion.threshold)}
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setSuggestError(null)
                // Pre-fill the form from the
                // suggestion defaults. The backend
                // already computed firstDueDate =
                // today + 14 days; we keep that
                // unless the user wants to change it.
                if (ratensplanSuggestion?.defaults) {
                  setSuggestForm({
                    installmentCount:
                      ratensplanSuggestion.defaults.installmentCount,
                    intervalDays:
                      ratensplanSuggestion.defaults.intervalDays,
                    firstDueDate:
                      ratensplanSuggestion.defaults.firstDueDate,
                    notes: ratensplanSuggestion.defaults.notes || "",
                    autoPause: true,
                  })
                }
                setShowSuggestModal(true)
              }}
              data-testid="ratensplan-suggest-button"
              className="border-amber-400 dark:border-amber-600 text-amber-700 dark:text-amber-300"
            >
              {t("invoice.ratensplanSuggestButton") ||
                "Ratenplan erstellen"}
            </Button>
          </div>
        )}

        {/* Tier 51: Ratenzahlung (installment plan). Shows
            the schedule (N Raten with their due dates +
            status) when a Ratenplan is attached; otherwise
            offers a one-click "Ratenplan anlegen" button.
            Each Rate carries its own pay button so the
            Berater can mark individual Raten as paid when
            a bank import comes in for a partial amount. */}
        <Card className="mt-6" data-testid="installment-plan-card">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>
              {t("installmentPlan.title") || "Ratenplan"}
              {installmentPlan && (
                <span className="ml-2 text-xs font-normal text-gray-500 dark:text-gray-400">
                  ({installmentPlan.installments.length}{" "}
                  {t("installmentPlan.rates") || "Raten"})
                </span>
              )}
            </CardTitle>
            {!installmentPlan &&
              invoice.type !== "CN" &&
              invoice.status !== "cancelled" && (
                <Button
                  size="sm"
                  variant="outline"
                  data-testid="installment-plan-create-button"
                  onClick={() => {
                    setPlanError(null)
                    setShowPlanModal(true)
                  }}
                >
                  + {t("installmentPlan.create") || "Ratenplan anlegen"}
                </Button>
              )}
          </CardHeader>
          <CardContent>
            {!installmentPlan ? (
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {t("installmentPlan.empty") ||
                  "Noch kein Ratenplan — klicke „Ratenplan anlegen\", um diese Rechnung in Teilbeträgen zu verwalten."}
              </p>
            ) : (
              <div>
                <div className="flex items-center gap-3 mb-3 text-sm">
                  <span className="text-gray-500 dark:text-gray-400">
                    {t("installmentPlan.total") || "Gesamtbetrag"}:
                  </span>
                  <span className="font-mono font-medium">
                    {Number(installmentPlan.totalAmount).toFixed(2)} €
                  </span>
                  <span className="text-gray-400">·</span>
                  <span className="text-gray-500 dark:text-gray-400">
                    {t("installmentPlan.interval") || "Intervall"}:
                  </span>
                  <span>{installmentPlan.intervalDays} Tage</span>
                  <span className="text-gray-400">·</span>
                  <span
                    className={`text-xs px-2 py-0.5 rounded ${
                      installmentPlan.status === "active"
                        ? "bg-blue-100 text-blue-800"
                        : installmentPlan.status === "completed"
                        ? "bg-emerald-100 text-emerald-800"
                        : "bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-200"
                    }`}
                  >
                    {installmentPlan.status === "active"
                      ? t("installmentPlan.statusActive") || "aktiv"
                      : installmentPlan.status === "completed"
                      ? t("installmentPlan.statusCompleted") ||
                        "abgeschlossen"
                      : t("installmentPlan.statusCancelled") || "storniert"}
                  </span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[640px] text-sm">
                  <thead>
                    <tr className="text-left text-xs uppercase text-gray-500 dark:text-gray-400 border-b">
                      <th className="py-2 pr-2 w-10">#</th>
                      <th className="py-2 pr-2">
                        {t("installmentPlan.dueDate") || "Fällig"}
                      </th>
                      <th className="py-2 pr-2 text-right">
                        {t("installmentPlan.amount") || "Betrag"}
                      </th>
                      <th className="py-2 pr-2 text-right">
                        {t("installmentPlan.paid") || "Bezahlt"}
                      </th>
                      <th className="py-2 pr-2">
                        {t("installmentPlan.status") || "Status"}
                      </th>
                      <th className="py-2 pr-2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {installmentPlan.installments.map((inst: any) => (
                      <tr
                        key={inst.id}
                        className="border-b"
                        data-testid="installment-row"
                      >
                        <td className="py-2 pr-2 font-mono">
                          {inst.sequenceNumber}
                        </td>
                        <td className="py-2 pr-2">
                          {formatDate(inst.dueDate)}
                        </td>
                        <td className="py-2 pr-2 text-right font-mono">
                          {Number(inst.amount).toFixed(2)} €
                        </td>
                        <td className="py-2 pr-2 text-right font-mono">
                          {Number(inst.paidAmount).toFixed(2)} €
                        </td>
                        <td className="py-2 pr-2">
                          <span
                            className={`text-xs px-2 py-0.5 rounded ${
                              inst.status === "paid"
                                ? "bg-emerald-100 text-emerald-800"
                                : inst.status === "partial"
                                ? "bg-amber-100 text-amber-800"
                                : inst.status === "overdue"
                                ? "bg-red-100 text-red-800"
                                : inst.status === "cancelled"
                                ? "bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-200"
                                : "bg-blue-100 text-blue-800"
                            }`}
                          >
                            {inst.status === "paid"
                              ? t("installmentPlan.paid") || "bezahlt"
                              : inst.status === "partial"
                              ? t("installmentPlan.partial") || "teilbezahlt"
                              : inst.status === "overdue"
                              ? t("installmentPlan.overdue") || "überfällig"
                              : inst.status === "cancelled"
                              ? t("installmentPlan.statusCancelled") ||
                                "storniert"
                              : t("installmentPlan.open") || "offen"}
                          </span>
                        </td>
                        <td className="py-2 pr-2">
                          {inst.status !== "paid" &&
                            inst.status !== "cancelled" && (
                              <div className="flex gap-1 items-center">
                                <input
                                  type="number"
                                  step="0.01"
                                  placeholder={(
                                    Number(inst.amount) -
                                      Number(inst.paidAmount)
                                  ).toFixed(2)}
                                  value={payRateAmount[inst.id] || ""}
                                  onChange={(e) =>
                                    setPayRateAmount({
                                      ...payRateAmount,
                                      [inst.id]: e.target.value,
                                    })
                                  }
                                  className="w-24 border rounded px-1 py-0.5 text-right font-mono text-xs"
                                  data-testid="installment-pay-amount"
                                />
                                <Button
                                  size="sm"
                                  variant="outline"
                                  data-testid="installment-pay-button"
                                  onClick={async () => {
                                    const remaining =
                                      Number(inst.amount) -
                                      Number(inst.paidAmount)
                                    const amt =
                                      payRateAmount[inst.id] ??
                                      remaining.toFixed(2)
                                    if (!amt || Number(amt) <= 0) return
                                    try {
                                      const updated = await apiPost<any>(
                                        `/api/v1/installment-plans/${installmentPlan.id}/installments/${inst.id}/pay?companyId=${localStorage.getItem("companyId") || ""}`,
                                        { amount: Number(amt) },
                                      )
                                      setInstallmentPlan(updated)
                                      setPayRateAmount({
                                        ...payRateAmount,
                                        [inst.id]: "",
                                      })
                                    } catch (e: any) {
                                      alert(
                                        e?.message || "Fehler beim Speichern",
                                      )
                                    }
                                  }}
                                >
                                  ✓
                                </Button>
                              </div>
                            )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
                {installmentPlan.status === "active" && (
                  <div className="mt-3 flex justify-end">
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-red-700 dark:text-red-300 border-red-300 dark:border-red-700"
                      data-testid="installment-cancel-button"
                      onClick={async () => {
                        if (
                          !confirm(
                            t("installmentPlan.confirmCancel") ||
                              "Ratenplan wirklich stornieren? Alle offenen Raten werden auf storniert gesetzt.",
                          )
                        ) {
                          return
                        }
                        try {
                          await apiDelete<any>(
                            `/api/v1/installment-plans/${installmentPlan.id}?companyId=${localStorage.getItem("companyId") || ""}`,
                          )
                          // refresh plan
                          const updated = await apiGet<any>(
                            `/api/v1/installment-plans/${installmentPlan.id}?companyId=${localStorage.getItem("companyId") || ""}`,
                          )
                          setInstallmentPlan(updated)
                        } catch (e: any) {
                          alert(
                            e?.message || "Fehler beim Stornieren",
                          )
                        }
                      }}
                    >
                      {t("installmentPlan.cancel") || "Ratenplan stornieren"}
                    </Button>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Notes */}
        {invoice.notes && (
          <Card className="mt-8">
            <CardHeader><CardTitle>Bemerkungen</CardTitle></CardHeader>
             <CardContent><p className="text-gray-600 dark:text-gray-300 whitespace-pre-wrap">{invoice.notes}</p></CardContent>
           </Card>
         )}

        {/* Tier 140: Belege (attachments) for this
            invoice. PDF / JPG / PNG, max 10MB each.
            Common use: a signed delivery note, a
            customer-side credit-note scan, a
            payment-receipt screenshot, a GoBD §147
            AO "Sonstige Belege" attachment. Reuses
            the /api/v1/attachments endpoint with
            entityType='invoice' so the storage +
            OCR + content-hash pipeline is shared
            with expenses / vouchers / berater-notes.
            Click any row's 📥 to download. */}
        <Card className="mt-8" data-testid="invoice-attachments-card">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              📎 {t("invoice.attachments") || "Belege"}
              {invoiceAttachments.length > 0 && (
                <span className="text-xs font-normal text-gray-500 dark:text-gray-400">
                  ({invoiceAttachments.length})
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2 mb-3" data-testid="invoice-attachments-list">
              {invoiceAttachments.length === 0 ? (
                <p className="text-sm text-gray-400 italic">
                  {t("invoice.attachmentsEmpty") || "Noch keine Belege hochgeladen."}
                </p>
              ) : (
                invoiceAttachments.map((a) => (
                  <div
                    key={a.id}
                    className="flex items-center gap-2 border border-gray-200 dark:border-gray-700 rounded p-2"
                    data-testid={`invoice-attachment-${a.id}`}
                  >
                    <span className="text-lg">
                      {a.mimeType?.startsWith("image/") ? "🖼" : a.mimeType === "application/pdf" ? "📄" : "📎"}
                    </span>
                    <div className="flex-1 min-w-0">
                      <a
                        href={`/api/v1/attachments/${a.id}/file?companyId=${localStorage.getItem("companyId") || ""}&download=1`}
                        className="text-sm font-medium text-blue-600 dark:text-blue-400 hover:underline truncate block"
                        data-testid={`invoice-attachment-download-${a.id}`}
                        title={a.originalName}
                      >
                        {a.originalName}
                      </a>
                      <div className="text-xs text-gray-500">
                        {Math.round((a.size || 0) / 1024)} KB ·{" "}
                        {a.uploadedBy?.email || (a.uploadedById || "").slice(0, 8)} ·{" "}
                        {new Date(a.createdAt).toLocaleString("de-DE", {
                          day: "2-digit",
                          month: "2-digit",
                          year: "numeric",
                        })}
                      </div>
                    </div>
                    <button
                      onClick={() => deleteInvoiceAttachment(a.id)}
                      disabled={deletingAttachmentId === a.id}
                      className="text-xs text-red-600 dark:text-red-400 hover:underline disabled:opacity-50 shrink-0"
                      data-testid={`invoice-attachment-delete-${a.id}`}
                      title={t("common.delete") || "Löschen"}
                    >
                      {deletingAttachmentId === a.id ? "…" : "🗑"}
                    </button>
                  </div>
                ))
              )}
            </div>
            <div>
              <label
                className="text-xs font-medium text-gray-600 dark:text-gray-300 cursor-pointer hover:underline"
                data-testid="invoice-attachment-upload-label"
              >
                📎 {t("invoice.attachmentUpload") || "Beleg hochladen (PDF, JPG, PNG — max 10MB)"}
                <input
                  type="file"
                  accept="application/pdf,image/jpeg,image/png,image/gif,image/webp"
                  onChange={uploadInvoiceAttachment}
                  disabled={uploadingAttachment}
                  className="hidden"
                  data-testid="invoice-attachment-upload-input"
                />
              </label>
              {uploadingAttachment && (
                <p className="text-xs text-gray-500 mt-1" data-testid="invoice-attachment-uploading">
                  {t("common.uploading") || "Wird hochgeladen…"}
                </p>
              )}
              {attachmentError && (
                <p className="text-xs text-red-600 mt-1" data-testid="invoice-attachment-error">
                  {attachmentError}
                </p>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Tier 138: Internal team notes. Distinct from
            the customer-facing Bemerkungen above —
            these never appear in the PDF, the customer
            portal, or the email body. GoBD § 146 Abs. 4
            AO requires innerbetriebliche Aufzeichnungen
            to be clearly separated from the invoice
            data the customer sees. The lock icon in
            the header makes the visibility distinction
            obvious. */}
        <Card className="mt-8" data-testid="invoice-internal-notes-card">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              🔒 {t("invoice.internalNotes") || "Interne Notizen"}
              <span className="text-xs font-normal text-gray-500 dark:text-gray-400">
                {t("invoice.internalNotesHint") ||
                  "(nur für Ihr Team — erscheint nicht auf der Rechnung)"}
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2 mb-3" data-testid="invoice-internal-notes-list">
              {internalNotes.length === 0 ? (
                <p className="text-sm text-gray-400 italic">
                  {t("invoice.internalNotesEmpty") || "Noch keine internen Notizen."}
                </p>
              ) : (
                internalNotes.map((n) => (
                  <div
                    key={n.id}
                    className="flex items-start gap-2 border border-gray-200 dark:border-gray-700 rounded p-2 bg-amber-50/40 dark:bg-amber-900/10"
                    data-testid={`invoice-internal-note-${n.id}`}
                  >
                    <div className="flex-1">
                      <div className="text-xs text-gray-500 dark:text-gray-400 flex items-center gap-1">
                        <span className="font-medium text-gray-700 dark:text-gray-300">
                          {n.userEmail || (n.userId ? n.userId.slice(0, 8) : "—")}
                        </span>
                        <span>·</span>
                        <span>
                          {new Date(n.createdAt).toLocaleString("de-DE", {
                            day: "2-digit",
                            month: "2-digit",
                            year: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </span>
                      </div>
                      <p className="text-sm whitespace-pre-wrap mt-1">{n.body}</p>
                    </div>
                    <button
                      onClick={() => deleteInternalNote(n.id)}
                      disabled={deletingNoteId === n.id}
                      className="text-xs text-red-600 dark:text-red-400 hover:underline disabled:opacity-50 shrink-0"
                      data-testid={`invoice-internal-note-delete-${n.id}`}
                      title={t("common.delete") || "Löschen"}
                    >
                      {deletingNoteId === n.id ? "…" : "🗑"}
                    </button>
                  </div>
                ))
              )}
            </div>
            <div className="flex gap-2">
              <textarea
                value={newNote}
                onChange={(e) => setNewNote(e.target.value)}
                placeholder={
                  t("invoice.internalNotesPlaceholder") ||
                  "z.B. 'Mahnung am 12.07. versendet, warte auf Rückzahlung'"
                }
                maxLength={2000}
                className="flex-1 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded text-sm bg-white dark:bg-gray-800 min-h-[60px]"
                data-testid="invoice-internal-note-input"
              />
              <Button
                onClick={addInternalNote}
                disabled={addingNote || !newNote.trim()}
                data-testid="invoice-internal-note-add"
                variant="outline"
              >
                {addingNote ? "…" : `+ ${t("invoice.internalNotesAdd") || "Notiz"}`}
              </Button>
            </div>
            {internalNoteError && (
              <p className="text-xs text-red-600 mt-1" data-testid="invoice-internal-note-error">
                {internalNoteError}
              </p>
            )}
          </CardContent>
        </Card>

      {/* Tier 33: portal-link disclosure block. Renders
          below the main button row when the admin has
          clicked "Zahlungslink anzeigen" at least once.
          The URL is a readonly input + copy button;
          we don't show a modal — disclosure is enough
          for this single-field action. */}
      {(portalLink || portalLinkError) && (
        <div
          className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-4 py-3 mb-4"
          data-testid="invoice-portal-link-panel"
        >
          {portalLink && (
            <div className="space-y-2">
              <div className="text-sm">
                <span className="font-semibold">
                  {portalLink.reused
                    ? "Aktiver Zahlungslink:"
                    : "Zahlungslink erstellt:"}
                </span>{" "}
                <span className="text-gray-500">
                  gültig bis{" "}
                  {new Date(portalLink.expiresAt).toLocaleDateString("de-DE")}
                </span>
              </div>
              <div className="flex gap-2">
                <input
                  type="text"
                  readOnly
                  value={portalLink.url}
                  data-testid="invoice-portal-link-url"
                  className="flex-1 border rounded px-2 py-1 text-xs font-mono bg-gray-50 dark:bg-gray-900"
                  onClick={(e) => (e.target as HTMLInputElement).select()}
                />
                <Button
                  size="sm"
                  onClick={copyPortalLink}
                  data-testid="invoice-portal-link-copy"
                >
                  {portalLinkCopied ? "✓ Kopiert" : "Kopieren"}
                </Button>
              </div>
            </div>
          )}
          {portalLinkError && (
            <div
              className="text-sm text-red-600"
              data-testid="invoice-portal-link-error"
            >
              ✗ {portalLinkError}
            </div>
          )}
        </div>
      )}

      {/* Email send modal — opens on click of "Per E-Mail senden".
          The user can change locale (de/en/zh), override the
          recipient, add CC, and edit the subject/body. The
          backend uses the same template strings, so the preview
          text is what the recipient will see. */}
      {showEmailModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <Card className="w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <CardHeader>
              <CardTitle>
                Rechnung per E-Mail senden — {invoice?.invoiceNumber}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {/* Language picker — switching re-renders the
                    template for fields the user hasn't touched. */}
                <div>
                  <label className="block text-sm font-medium mb-1 text-gray-700 dark:text-gray-300">
                    Sprache
                  </label>
                  <div className="flex gap-2">
                    {(["de", "en", "zh"] as const).map((l) => (
                      <button
                        key={l}
                        type="button"
                        onClick={() => onEmailLangChange(l)}
                        className={`px-3 py-1 text-sm rounded border ${
                          emailLang === l
                            ? "bg-blue-600 text-white border-blue-600"
                            : "bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700"
                        }`}
                      >
                        {l === "de" ? "Deutsch" : l === "en" ? "English" : "中文"}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Recipient — pre-filled from
                    customer.contact.email. Override allowed
                    (e.g. send to the accounting dept
                    instead of the main contact). */}
                <div>
                  <label className="block text-sm font-medium mb-1 text-gray-700 dark:text-gray-300">
                    An (Empfänger)
                  </label>
                  <Input
                    type="email"
                    value={emailTo}
                    onChange={(e) => setEmailTo(e.target.value)}
                    placeholder="kunde@firma.de"
                  />
                </div>

                {/* Additional CC — comma/semicolon/newline
                    separated. The logged-in user is auto-CC'd
                    on the server (via the existing ccEmail
                    param), so this is for OTHER recipients
                    like an accounting mailbox. */}
                <div>
                  <label className="block text-sm font-medium mb-1 text-gray-700 dark:text-gray-300">
                    CC (zusätzlich, durch Komma getrennt)
                  </label>
                  <Input
                    type="text"
                    value={emailExtraCc}
                    onChange={(e) => setEmailExtraCc(e.target.value)}
                    placeholder="buchhaltung@firma.de, ceo@firma.de"
                  />
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                    Sie selbst erhalten automatisch eine Kopie.
                  </p>
                </div>

                {/* Subject — pre-filled with the rendered
                    template subject for the chosen locale.
                    Editing marks it "touched" so a future
                    locale change won't clobber the edit. */}
                <div>
                  <label className="block text-sm font-medium mb-1 text-gray-700 dark:text-gray-300">
                    Betreff
                  </label>
                  <Input
                    type="text"
                    value={emailSubject}
                    onChange={(e) => {
                      setEmailSubject(e.target.value)
                      setSubjectTouched(true)
                    }}
                  />
                  {subjectTouched && (
                    <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
                      Manuell bearbeitet — wird nicht durch Vorlage überschrieben.
                    </p>
                  )}
                </div>

                {/* Body — multi-line textarea. Same touched-
                    semantics as the subject. */}
                <div>
                  <label className="block text-sm font-medium mb-1 text-gray-700 dark:text-gray-300">
                    Nachricht
                  </label>
                  <textarea
                    value={emailBody}
                    onChange={(e) => {
                      setEmailBody(e.target.value)
                      setBodyTouched(true)
                    }}
                    rows={10}
                    className="w-full border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 rounded px-3 py-2 text-sm font-mono"
                  />
                  {bodyTouched && (
                    <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
                      Manuell bearbeitet — wird nicht durch Vorlage überschrieben.
                    </p>
                  )}
                </div>

                {/* Attachment notice — the PDF is generated
                    server-side and attached automatically. */}
                <div className="text-sm text-gray-600 dark:text-gray-400 bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded p-3">
                  Anhang: <span className="font-mono">{invoice?.invoiceNumber}.pdf</span> (wird automatisch vom Server angehängt)
                </div>

                {/* Action buttons */}
                <div className="flex justify-end gap-2 pt-2">
                  <Button
                    variant="outline"
                    onClick={() => setShowEmailModal(false)}
                    disabled={sending}
                  >
                    Abbrechen
                  </Button>
                  <Button
                    onClick={confirmSendEmail}
                    disabled={sending || !emailTo.trim()}
                  >
                    {sending ? "Wird gesendet..." : "Senden"}
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Tier 51: Create-Ratenplan modal. Four fields
          (count, totalAmount, firstDueDate, intervalDays)
          + a notes line. The amount defaults to the
          outstanding invoice total (€ 1.234,56 style
          already formatted). Submitting POSTs to
          /installment-plans. */}
      {showPlanModal && invoice && (
        <div
          className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4"
          data-testid="installment-plan-modal"
        >
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl w-full max-w-md p-6">
            <h2 className="text-xl font-bold text-gray-900 dark:text-gray-100 mb-2">
              {t("installmentPlan.createTitle") || "Ratenplan anlegen"}
            </h2>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
              {t("installmentPlan.createHint") ||
                "Diese Rechnung in mehrere Teilbeträge aufteilen. Jede Rate bekommt ein eigenes Fälligkeitsdatum."}
            </p>

            {planError && (
              <div
                className="p-3 mb-3 bg-red-50 border border-red-200 text-red-800 rounded text-sm"
                data-testid="installment-plan-error"
              >
                ✗ {planError}
              </div>
            )}

            <div className="grid grid-cols-2 gap-3 mb-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">
                  {t("installmentPlan.count") || "Anzahl Raten"} *
                </label>
                <Input
                  type="number"
                  min="2"
                  max="120"
                  value={planForm.installmentCount}
                  onChange={(e) =>
                    setPlanForm({
                      ...planForm,
                      installmentCount: e.target.value,
                    })
                  }
                  data-testid="installment-plan-count"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">
                  {t("installmentPlan.interval") || "Intervall (Tage)"}
                </label>
                <Input
                  type="number"
                  min="1"
                  max="365"
                  value={planForm.intervalDays}
                  onChange={(e) =>
                    setPlanForm({
                      ...planForm,
                      intervalDays: e.target.value,
                    })
                  }
                  data-testid="installment-plan-interval"
                />
              </div>
            </div>
            <div className="mb-3">
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">
                {t("installmentPlan.total") || "Gesamtbetrag (€)"} *
              </label>
              <Input
                type="number"
                step="0.01"
                defaultValue={Number(invoice.total).toFixed(2)}
                onChange={(e) => {
                  // store in planForm via spread of dynamic key
                  ;(planForm as any).totalAmount = e.target.value
                }}
                data-testid="installment-plan-amount"
              />
            </div>
            <div className="mb-3">
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">
                {t("installmentPlan.firstDue") || "Erste Fälligkeit"} *
              </label>
              <Input
                type="date"
                value={planForm.firstDueDate}
                onChange={(e) =>
                  setPlanForm({
                    ...planForm,
                    firstDueDate: e.target.value,
                  })
                }
                data-testid="installment-plan-first-due"
              />
            </div>
            <div className="mb-4">
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">
                {t("installmentPlan.notes") || "Notiz (optional)"}
              </label>
              <Input
                type="text"
                value={planForm.notes}
                onChange={(e) =>
                  setPlanForm({ ...planForm, notes: e.target.value })
                }
                data-testid="installment-plan-notes"
              />
            </div>

            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  setShowPlanModal(false)
                  setPlanError(null)
                }}
                disabled={planSaving}
              >
                {t("common.cancel") || "Abbrechen"}
              </Button>
              <Button
                data-testid="installment-plan-submit"
                onClick={async () => {
                  setPlanError(null)
                  const count = Number(planForm.installmentCount)
                  if (!count || count < 2) {
                    setPlanError("Mindestens 2 Raten erforderlich")
                    return
                  }
                  const totalAmount = Number(
                    (planForm as any).totalAmount ??
                      Number(invoice.total).toFixed(2),
                  )
                  if (!totalAmount || totalAmount <= 0) {
                    setPlanError("Betrag muss > 0 sein")
                    return
                  }
                  setPlanSaving(true)
                  try {
                    const plan = await apiPost<any>(
                      `/api/v1/installment-plans?companyId=${localStorage.getItem("companyId") || ""}`,
                      {
                        invoiceId: invoice.id,
                        installmentCount: count,
                        totalAmount,
                        firstDueDate: new Date(planForm.firstDueDate)
                          .toISOString(),
                        intervalDays: Number(planForm.intervalDays) || 30,
                        notes: planForm.notes || undefined,
                      },
                    )
                    setInstallmentPlan(plan)
                    setShowPlanModal(false)
                  } catch (e: any) {
                    setPlanError(
                      e?.message || "Fehler beim Anlegen",
                    )
                  } finally {
                    setPlanSaving(false)
                  }
                }}
                disabled={planSaving}
              >
                {planSaving
                  ? "…"
                  : t("installmentPlan.create") || "Anlegen"}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Tier 53: Gutschrift (credit note) modal.
          Two inputs: refund amount (pre-filled with
          the open balance) + reason. Submitting POSTs
          to /invoices/:id/credit-note. The backend
          creates the CN and navigates the user to
          the CN's detail page so they can see the
          result + send it. */}
      {showCnModal && invoice && (
        <div
          className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4"
          data-testid="credit-note-modal"
        >
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl w-full max-w-md p-6">
            <h2 className="text-xl font-bold text-gray-900 dark:text-gray-100 mb-2">
              {t("invoice.creditNote") || "Gutschrift erstellen"}
            </h2>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
              {t("invoice.creditNoteHint") ||
                "Erstattet einen Teil oder den vollen Betrag dieser Rechnung. Die Gutschrift erhält eine eigene Rechnungsnummer und reduziert den offenen Saldo."}
            </p>

            {cnError && (
              <div
                className="p-3 mb-3 bg-red-50 border border-red-200 text-red-800 rounded text-sm"
                data-testid="credit-note-error"
              >
                ✗ {cnError}
              </div>
            )}

            <div className="mb-3">
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">
                {t("invoice.creditNoteAmount") || "Erstattungsbetrag (€)"} *
              </label>
              <Input
                type="number"
                step="0.01"
                min="0"
                value={cnAmount}
                onChange={(e) => setCnAmount(e.target.value)}
                data-testid="credit-note-amount"
              />
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                {t("invoice.creditNoteAmountHint") ||
                  "Leer lassen für volle Erstattung — alle Positionen der Originalrechnung werden 1:1 übernommen."}
              </p>
            </div>
            <div className="mb-4">
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">
                {t("invoice.creditNoteReason") || "Grund (optional)"}
              </label>
              <Input
                type="text"
                value={cnReason}
                onChange={(e) => setCnReason(e.target.value)}
                placeholder={t("invoice.creditNoteReasonPlaceholder") ||
                  "z.B. 3 von 10 Positionen nicht geliefert"}
                data-testid="credit-note-reason"
              />
            </div>

            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  setShowCnModal(false)
                  setCnError(null)
                }}
                disabled={cnSaving}
              >
                {t("common.cancel") || "Abbrechen"}
              </Button>
              <Button
                data-testid="credit-note-submit"
                onClick={async () => {
                  setCnError(null)
                  setCnSaving(true)
                  try {
                    const payload: {
                      amount?: number
                      reason?: string
                    } = {}
                    if (cnAmount && Number(cnAmount) > 0) {
                      payload.amount = Number(cnAmount)
                    }
                    if (cnReason.trim()) {
                      payload.reason = cnReason.trim()
                    }
                    const cn = await apiPost<any>(
                      `/api/v1/invoices/${invoice.id}/credit-note?companyId=${localStorage.getItem("companyId") || ""}`,
                      payload,
                    )
                    setShowCnModal(false)
                    // Navigate to the new CN's detail
                    // page so the user sees the result
                    // + can email it.
                    router.push(
                      `/dashboard/invoices/${cn.id}?companyId=${localStorage.getItem("companyId") || ""}`,
                    )
                  } catch (e: any) {
                    setCnError(
                      e?.message || "Fehler beim Erstellen",
                    )
                  } finally {
                    setCnSaving(false)
                  }
                }}
                disabled={cnSaving}
              >
                {cnSaving
                  ? "…"
                  : t("invoice.creditNote") || "Gutschrift erstellen"}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Tier 64: invoice-level Mahnungspause modal.
          Posts to /api/v1/mahnungspausen with this
          invoice's id. pausedUntil is optional
          (NULL = open-ended). On success we refresh
          the invoice fetch so the "Mahnung pausieren"
          button hides (the paused status is reflected
          by the fact the invoice no longer shows up
          in /reminders/overdue). */}
      {showInvoicePauseModal && (
        <div
          className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4"
          data-testid="invoice-pause-modal"
          onClick={() => setShowInvoicePauseModal(false)}
        >
          <div
            className="bg-white dark:bg-gray-800 rounded-lg p-6 w-full max-w-md shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-medium mb-3">
              {t("invoice.pauseInvoiceModalTitle") ||
                "Mahnung für diese Rechnung pausieren"}
            </h3>
            <p className="text-xs text-gray-500 mb-4">
              {t("invoice.pauseInvoiceModalSubtitle") ||
                "Die Rechnung wird aus der Mahnliste ausgeblendet, bis die Pause endet. Andere Rechnungen des Kunden sind davon nicht betroffen."}
            </p>
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium mb-1">
                  {t("invoice.pauseReason") || "Grund"} *
                </label>
                <Input
                  value={invoicePauseForm.reason}
                  onChange={(e) =>
                    setInvoicePauseForm({
                      ...invoicePauseForm,
                      reason: e.target.value,
                    })
                  }
                  placeholder={
                    t("invoice.pauseReasonPlaceholder") ||
                    "z.B. Forderung bestritten"
                  }
                  data-testid="invoice-pause-reason-input"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">
                  {t("invoice.pauseUntil") ||
                    "Bis (optional, leer = unbefristet)"}
                </label>
                <Input
                  type="date"
                  value={invoicePauseForm.pausedUntil}
                  onChange={(e) =>
                    setInvoicePauseForm({
                      ...invoicePauseForm,
                      pausedUntil: e.target.value,
                    })
                  }
                  data-testid="invoice-pause-until-input"
                />
              </div>
              {invoicePauseError && (
                <p
                  className="text-sm text-red-600"
                  data-testid="invoice-pause-error"
                >
                  {invoicePauseError}
                </p>
              )}
            </div>
            <div className="flex gap-2 justify-end mt-5">
              <Button
                variant="outline"
                onClick={() => setShowInvoicePauseModal(false)}
                disabled={invoicePauseSaving}
              >
                {t("common.cancel") || "Abbrechen"}
              </Button>
              <Button
                onClick={async () => {
                  if (!invoicePauseForm.reason.trim()) {
                    setInvoicePauseError(
                      t("invoice.pauseReasonRequired") ||
                        "Grund ist erforderlich",
                    )
                    return
                  }
                  setInvoicePauseSaving(true)
                  setInvoicePauseError(null)
                  try {
                    // Use apiFetch (with throwOnError:
                    // false) so the 400 response from
                    // the backend (validation error)
                    // doesn't throw — we want to show
                    // the server's message inline.
                    // apiFetch prepends API_BASE so
                    // the URL hits the backend
                    // directly (the Next.js dev
                    // server has no rewrite for
                    // /api/v1/mahnungspausen).
                    const res = await apiFetch(
                      `/api/v1/mahnungspausen?companyId=${localStorage.getItem("companyId") || ""}`,
                      {
                        method: "POST",
                        throwOnError: false,
                        body: {
                          invoiceId: invoice.id,
                          reason: invoicePauseForm.reason,
                          pausedUntil: invoicePauseForm.pausedUntil
                            ? new Date(
                                invoicePauseForm.pausedUntil,
                              ).toISOString()
                            : null,
                        },
                      },
                    )
                    if (!res.ok) {
                      const err = await res.json().catch(() => ({}))
                      throw new Error(
                        err.message || `HTTP ${res.status}`,
                      )
                    }
                    setShowInvoicePauseModal(false)
                  } catch (e: any) {
                    setInvoicePauseError(
                      e?.message || "Fehler",
                    )
                  } finally {
                    setInvoicePauseSaving(false)
                  }
                }}
                disabled={invoicePauseSaving}
                data-testid="invoice-pause-submit"
              >
                {invoicePauseSaving
                  ? "..."
                  : t("invoice.pauseAdd") || "Pause anlegen"}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Tier 65: Auto-Ratenplan create modal. Opens
          from the banner button. Pre-filled with the
          suggestion defaults. On submit, POSTs to
          /installment-plans/from-invoice which creates
          the plan AND auto-pauses the customer's
          Mahnung in a single transaction. We refresh
          the invoice detail on success (so the
          Ratenplan card updates and the banner
          disappears). */}
      {showSuggestModal && invoice && ratensplanSuggestion && (
        <div
          className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4"
          data-testid="ratensplan-suggest-modal"
          onClick={() => !suggestSaving && setShowSuggestModal(false)}
        >
          <div
            className="bg-white dark:bg-gray-800 rounded-lg p-6 w-full max-w-md shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-medium mb-1">
              {t("invoice.ratensplanModalTitle") ||
                "Ratenplan aus Rechnung erstellen"}
            </h3>
            <p className="text-xs text-gray-500 mb-4">
              {t("invoice.ratensplanModalSubtitle") ||
                "Die Mahnung für diesen Kunden wird automatisch pausiert, solange der Ratenplan läuft."}
            </p>
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium mb-1">
                  {t("invoice.ratensplanInstallmentCount") || "Anzahl Raten"}
                </label>
                <Input
                  type="number"
                  min={2}
                  max={120}
                  value={String(suggestForm.installmentCount)}
                  onChange={(e) =>
                    setSuggestForm({
                      ...suggestForm,
                      installmentCount: Number(e.target.value || 0),
                    })
                  }
                  data-testid="ratensplan-modal-count"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">
                  {t("invoice.ratensplanIntervalDays") || "Intervall (Tage)"}
                </label>
                <Input
                  type="number"
                  min={1}
                  max={365}
                  value={String(suggestForm.intervalDays)}
                  onChange={(e) =>
                    setSuggestForm({
                      ...suggestForm,
                      intervalDays: Number(e.target.value || 0),
                    })
                  }
                  data-testid="ratensplan-modal-interval"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">
                  {t("invoice.ratensplanFirstDueDate") || "Erste Fälligkeit"}
                </label>
                <Input
                  type="date"
                  value={suggestForm.firstDueDate}
                  onChange={(e) =>
                    setSuggestForm({
                      ...suggestForm,
                      firstDueDate: e.target.value,
                    })
                  }
                  data-testid="ratensplan-modal-first-due"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">
                  {t("invoice.ratensplanNotes") || "Notizen (optional)"}
                </label>
                <Input
                  value={suggestForm.notes}
                  onChange={(e) =>
                    setSuggestForm({
                      ...suggestForm,
                      notes: e.target.value,
                    })
                  }
                  data-testid="ratensplan-modal-notes"
                />
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={suggestForm.autoPause}
                  onChange={(e) =>
                    setSuggestForm({
                      ...suggestForm,
                      autoPause: e.target.checked,
                    })
                  }
                  data-testid="ratensplan-modal-auto-pause"
                />
                {t("invoice.ratensplanAutoPause") ||
                  "Mahnung automatisch pausieren"}
              </label>
              {suggestError && (
                <p
                  className="text-sm text-red-600"
                  data-testid="ratensplan-modal-error"
                >
                  {suggestError}
                </p>
              )}
            </div>
            <div className="flex gap-2 justify-end mt-5">
              <Button
                variant="outline"
                onClick={() => setShowSuggestModal(false)}
                disabled={suggestSaving}
              >
                {t("common.cancel") || "Abbrechen"}
              </Button>
              <Button
                onClick={async () => {
                  setSuggestSaving(true)
                  setSuggestError(null)
                  try {
                    // Combined endpoint: creates the
                    // plan AND auto-pauses the customer.
                    const res = await apiFetch(
                      `/api/v1/installment-plans/from-invoice?companyId=${localStorage.getItem("companyId") || ""}`,
                      {
                        method: "POST",
                        throwOnError: false,
                        body: {
                          invoiceId: invoice.id,
                          installmentCount: suggestForm.installmentCount,
                          firstDueDate: suggestForm.firstDueDate,
                          intervalDays: suggestForm.intervalDays,
                          notes: suggestForm.notes,
                          autoPause: suggestForm.autoPause,
                        },
                      },
                    )
                    if (!res.ok) {
                      const err = await res.json().catch(() => ({}))
                      throw new Error(
                        err.message || `HTTP ${res.status}`,
                      )
                    }
                    const plan = await res.json()
                    setShowSuggestModal(false)
                    setInstallmentPlan(plan)
                    setRatenplanSuggestion(null) // hide banner
                  } catch (e: any) {
                    setSuggestError(
                      e?.message ||
                        t("common.error") ||
                        "Fehler",
                    )
                  } finally {
                    setSuggestSaving(false)
                  }
                }}
                disabled={suggestSaving}
                data-testid="ratensplan-modal-submit"
              >
                {suggestSaving
                  ? "..."
                  : t("invoice.ratensplanCreate") || "Ratenplan anlegen"}
              </Button>
            </div>
          </div>
        </div>
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