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
import { apiGet, apiPost, apiFetch, ApiError } from "@/lib/api"

type Tab =
  | "invoices"
  | "plans"
  | "mahnungen"
  | "pauses"
  | "credit"
  | "emails"
  | "payments"
  | "attachments"

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

// Tier 144: one row in the email-Verlauf tab.
// Shape mirrors the backend EmailSend select —
// date, recipient, subject, template, status,
// + the linked invoice (if any) for quick pivot.
interface EmailRow {
  id: string
  subject: string | null
  recipientEmail: string
  recipientName: string | null
  templateType: string | null
  status: string
  sentAt: string | null
  bodyPreview: string | null
  createdAt: string
  invoice: { id: string; invoiceNumber: string } | null
  createdBy: { id: string; email: string } | null
}

// Tier 128: matches the VatCheckResult interface
// in backend/src/modules/vat-validation/vat-validation.service.ts.
// Status 'unreachable' is folded into the same gray
// "ungeprüft" badge as no-prior-check; the user just
// sees "we couldn't reach VIES right now, try again
// later". 'invalid' → red, 'valid' → green.
interface VatCheckResult {
  status: "valid" | "invalid" | "unreachable"
  name?: string
  address?: string
  countryCode?: string
  errorCode?: string
  errorMessage?: string
  durationMs?: number
  checkedAt?: string
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

  // Tier 128: VIES (EU VAT-ID validation) state.
  // The latest result drives the badge color next
  // to the USt-ID in the header. Run a fresh check
  // via runViesCheck() on button click; the latest
  // is also loaded on mount if the customer has
  // a vatId. The countryCode is the EU member
  // state the check returned (DE/FR/IT/...) —
  // useful because the user-supplied prefix can
  // be wrong (e.g. "GB" instead of "XI" post-Brexit).
  const [viesLatest, setViesLatest] = useState<VatCheckResult | null>(null)
  const [viesChecking, setViesChecking] = useState(false)
  const [viesError, setViesError] = useState<string | null>(null)

  // Tier 132: portal session generator. The admin
  // clicks "Portal-Login-Link generieren" → we POST
  // to /customer-portal/admin/create-session → the
  // backend creates a 30-day session + emails the
  // customer the link (NO-SMTP mode logs to stdout
  // for dev verification). The returned URL is
  // shown in a modal so the admin can copy + paste
  // it into an email / WhatsApp / phone call.
  const [portalLink, setPortalLink] = useState<{
    url: string
    email: string
    expiresAt: string
  } | null>(null)
  const [portalLinkGenerating, setPortalLinkGenerating] = useState(false)
  const [portalLinkCopied, setPortalLinkCopied] = useState(false)

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
  // Tier 144: email-Verlauf state. The Berater
  // asks "did we already send the second reminder
  // to BWA?" — this tab shows every email the
  // system has sent to this customer.
  const [emails, setEmails] = useState<EmailRow[] | null>(null)
  const [emailsLoading, setEmailsLoading] = useState(false)
  // Detail modal for a clicked email row.
  const [emailDetail, setEmailDetail] = useState<EmailRow | null>(null)
  // Tier 238: payments tab — the customer's payment
  // history (Payment rows allocated across all their
  // invoices). Fetches the /invoices/:id/payments
  // endpoint per invoice and concatenates. The real
  // Prisma field names are paymentDate + paymentMethod
  // (NOT paidAt/method — checked against schema).
  // amount is Decimal — serialised as string by Prisma.
  const [payments, setPayments] = useState<Array<{
    id: string
    invoiceId: string
    invoiceNumber: string
    amount: string
    paymentDate: string
    paymentMethod: string
    reference: string | null
    notes: string | null
  }> | null>(null)
  const [paymentsLoading, setPaymentsLoading] = useState(false)
  // Tier 238: attachments tab — files attached to
  // this customer (e.g. signed contracts, scanned
  // documents). Uses the /attachments endpoint with
  // entityType=customer. Note: backend service doesn't
  // enforce entityType whitelist on list, so this
  // returns an empty array (no customer attachments
  // exist yet). Real Prisma field is originalName/
  // mimeType/size/createdAt (NOT fileName/fileSize/
  // uploadedAt). uploadedBy is included for audit.
  const [attachments, setAttachments] = useState<Array<{
    id: string
    originalName: string
    mimeType: string
    size: number
    createdAt: string
    uploadedBy?: { id: string; email: string } | null
  }> | null>(null)
  const [attachmentsLoading, setAttachmentsLoading] = useState(false)
  // Tier 146: payment allocation wizard. The
  // admin opens a modal, enters the amount,
  // sees the proposed allocation (oldest-
  // first dry-run), then confirms. Writes
  // happen via the POST /allocate-payment
  // endpoint; the GET /allocate-payment/preview
  // endpoint returns the dry-run.
  const [allocateOpen, setAllocateOpen] = useState(false)
  const [allocateAmount, setAllocateAmount] = useState("")
  const [allocateDate, setAllocateDate] = useState(() => {
    return new Date().toISOString().slice(0, 10)
  })
  const [allocateMethod, setAllocateMethod] = useState("Überweisung")
  const [allocateReference, setAllocateReference] = useState("")
  const [allocatePreview, setAllocatePreview] = useState<{
    invoices: Array<{
      invoiceId: string
      invoiceNumber: string
      dueDate: string | null
      total: number
      alreadyPaid: number
      remaining: number
      applied: number
    }>
    unallocatedAmount: number
    totalOutstanding: number
  } | null>(null)
  const [allocateSubmitting, setAllocateSubmitting] = useState(false)
  const [allocateResult, setAllocateResult] = useState<{
    appliedCount: number
    appliedTotal: number
    unallocatedAmount: number
  } | null>(null)
  const [allocateError, setAllocateError] = useState<string | null>(null)
  // Tier 149: customer merge. The "Zusammenführen"
  // button opens this modal. The admin searches
  // for the duplicate customer, clicks it, sees
  // a preview of how many rows will move, then
  // confirms. After the merge, we route to the
  // target customer's detail page (the source
  // is gone, so /customers/<sourceId> 404s).
  const [mergeOpen, setMergeOpen] = useState(false)
  const [mergeSearch, setMergeSearch] = useState("")
  const [mergeSearchResults, setMergeSearchResults] = useState<
    Array<{ id: string; name: string; customerNumber: string | null }>
  >([])
  const [mergeSearching, setMergeSearching] = useState(false)
  const [mergeSourceId, setMergeSourceId] = useState<string | null>(null)
  const [mergePreview, setMergePreview] = useState<{
    source: { id: string; name: string; customerNumber: string | null }
    target: { id: string; name: string; customerNumber: string | null }
    counts: Record<string, number>
    mergedTags: string[]
  } | null>(null)
  const [mergeSubmitting, setMergeSubmitting] = useState(false)
  const [mergeError, setMergeError] = useState<string | null>(null)
  const [mergeDone, setMergeDone] = useState<{
    moved: Record<string, number>
    mergedTags: string[]
  } | null>(null)
  // Tier 145: internal Berater-Notizen on the
  // customer. Parallel to the invoice-internal-
  // notes UI (Tier 138). NOT visible to the
  // customer via the portal / PDF / email —
  // GoBD § 146 Abs. 4 AO compliance.
  const [internalNotes, setInternalNotes] = useState<
    {
      id: string
      body: string
      userEmail: string | null
      userId: string | null
      createdAt: string
    }[]
  >([])
  const [newInternalNote, setNewInternalNote] = useState("")
  const [addingInternalNote, setAddingInternalNote] = useState(false)
  const [deletingInternalNoteId, setDeletingInternalNoteId] = useState<string | null>(null)
  const [internalNoteError, setInternalNoteError] = useState<string | null>(null)

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

  // Tier 128: load the most recent VIES check for this
  // customer (if any). Tolerates failure silently — the
  // header badge just stays hidden until the user
  // clicks "USt-ID prüfen". Re-runs on every mount and
  // when the customer id changes.
  useEffect(() => {
    if (!companyId || !id) return
    let cancelled = false
    apiGet<VatCheckResult | null>(
      `/api/v1/vat-validation/latest?companyId=${companyId}&entityType=customer&entityId=${id}`,
    )
      .then((d) => { if (!cancelled) setViesLatest(d) })
      .catch(() => { /* tolerate — no prior check is fine */ })
    return () => { cancelled = true }
  }, [companyId, id])

  /**
   * Tier 128: trigger a fresh VIES check for this
   * customer's vatId. Optimistic: set checking=true
   * and clear any prior error. The button stays
   * disabled until the call resolves. On success, the
   * returned logId is included in the badge tooltip
   * (so the user can look up the audit-trail row
   * later). On error, we show a short red message
   * inline; we don't throw a toast — VIES is a
   * non-blocking "best effort" check.
   */
  const runViesCheck = async () => {
    if (!companyId || !id || !summary?.customer.vatId || viesChecking) return
    setViesChecking(true)
    setViesError(null)
    try {
      const result = await apiPost<VatCheckResult & { logId: string }>(
        `/api/v1/vat-validation/check`,
        {
          companyId,
          entityType: "customer",
          entityId: id,
          vatId: summary.customer.vatId,
        },
      )
      setViesLatest({ ...result })
    } catch (err) {
      setViesError(err instanceof ApiError ? err.message : String(err))
    } finally {
      setViesChecking(false)
    }
  }

  /**
   * Tier 132: generate a portal-login link for this
   * customer. The backend creates a 30-day session,
   * emails the link to the customer's contact.email
   * (NO-SMTP in dev logs the URL to stdout), and
   * returns the URL. We show it in a modal so the
   * admin can copy + paste it into any channel
   * (WhatsApp, phone call, separate email).
   *
   * Bypasses the public rate-limit (the admin is
   * the trust boundary, not a random visitor).
   */
  const generatePortalLink = async () => {
    if (!companyId || !id || portalLinkGenerating) return
    setPortalLinkGenerating(true)
    setPortalLinkCopied(false)
    try {
      const result = await apiPost<{
        sent: boolean
        url: string
        email: string
        customerId: string
        expiresAt: string
      }>(
        `/api/v1/customer-portal/admin/create-session`,
        { customerId: id, companyId },
      )
      if (result.url) {
        setPortalLink({
          url: result.url,
          email: result.email,
          expiresAt: result.expiresAt,
        })
      }
    } catch (err) {
      // Reuse the VIES error pattern (inline red text
      // in the header). A toast would be nicer but
      // we don't have a global toast system on this
      // page yet.
      setViesError(err instanceof ApiError ? err.message : String(err))
    } finally {
      setPortalLinkGenerating(false)
    }
  }

  const copyPortalLink = async () => {
    if (!portalLink?.url) return
    try {
      await navigator.clipboard.writeText(portalLink.url)
      setPortalLinkCopied(true)
      setTimeout(() => setPortalLinkCopied(false), 3000)
    } catch {
      // Clipboard API can be blocked (older browsers,
      // insecure contexts). Fall back to a manual
      // select-and-copy prompt.
      window.prompt("Bitte den Link manuell kopieren:", portalLink.url)
    }
  }

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
    // Tier 144: email-Verlauf. Lazy-load the same
    // way as the other tabs — only on first open,
    // and only if the user actually navigates there.
    if (tab === "emails" && emails === null && !emailsLoading) {
      setEmailsLoading(true)
      apiGet<{ rows: EmailRow[]; total: number }>(
        `/api/v1/customers/${id}/emails?companyId=${companyId}&take=200`,
      )
        .then((d) => setEmails(d.rows))
        .catch((err) => console.error("emails load failed:", err))
        .finally(() => setEmailsLoading(false))
    }
    // Tier 238: Zahlungen (payments) tab. Walks all
    // the customer's invoices, fetches each one's
    // payments, and concatenates. The /invoices/:id/
    // payments endpoint doesn't have a customerId
    // filter, so we use the invoice list as the index.
    if (tab === "payments" && payments === null && !paymentsLoading) {
      setPaymentsLoading(true)
      // First load the customer's invoices. Note the
      // envelope shape: { data: InvoiceRow[], total }.
      // The /invoices list endpoint is paginated.
      apiGet<{ data: InvoiceRow[] }>(
        `/api/v1/invoices?companyId=${companyId}&customerId=${id}&pageSize=200`,
      )
        .then(async (resp) => {
          const invList = resp.data || []
          // Then fetch payments for each. Sequential
          // (not Promise.all) to keep the network
          // gentle — a customer with 200 invoices
          // would otherwise fire 200 simultaneous
          // requests. Soft-fail per-invoice so a
          // single 404 doesn't break the whole tab.
          const allPayments: any[] = []
          for (const inv of invList) {
            try {
              const pays = await apiGet<any[]>(
                `/api/v1/invoices/${inv.id}/payments?companyId=${companyId}`,
              )
              for (const p of pays) {
                allPayments.push({
                  ...p,
                  invoiceNumber: inv.invoiceNumber,
                })
              }
            } catch {
              // ignore per-invoice failure
            }
          }
          // Sort by paymentDate desc (newest first) —
          // the real Prisma field, NOT paidAt.
          allPayments.sort((a, b) =>
            new Date(b.paymentDate).getTime() -
            new Date(a.paymentDate).getTime(),
          )
          setPayments(allPayments)
        })
        .catch((err) => console.error("payments load failed:", err))
        .finally(() => setPaymentsLoading(false))
    }
    // Tier 238: Dokumente (attachments) tab. Fetches
    // attachments scoped to the customer entity.
    // Soft-fail — a 404 (no attachments module for
    // this tenant) shouldn't break the page. The
    // backend controller's list endpoint doesn't
    // enforce entityType whitelist, but the upload
    // endpoint does (no 'customer' allowed). So in
    // practice this returns an empty array — the
    // tab is wired up and ready for when customer
    // attachments are enabled.
    if (tab === "attachments" && attachments === null && !attachmentsLoading) {
      setAttachmentsLoading(true)
      apiGet<any[]>(
        `/api/v1/attachments?companyId=${companyId}&entityType=customer&entityId=${id}`,
      )
        .then((d) => setAttachments(Array.isArray(d) ? d : []))
        .catch((err) => {
          console.error("attachments load failed:", err)
          setAttachments([])
        })
        .finally(() => setAttachmentsLoading(false))
    }
  }, [tab, companyId, id, invoices, plans, mahnungen, creditLedger, invoicesLoading, plansLoading, mahnungenLoading, creditLoading, emails, emailsLoading, payments, attachments])

  // Tier 145: load internal notes on mount. The
  // notes card is always visible (not behind a
  // tab), so we always fetch on first render.
  // Same pattern as the invoice-detail page.
  useEffect(() => {
    if (!companyId || !id) return
    apiGet<any[]>(`/api/v1/customers/${id}/internal-notes?companyId=${companyId}`)
      .then((notes) => setInternalNotes(Array.isArray(notes) ? notes : []))
      .catch((err) => console.error("internal notes load failed:", err))
  }, [companyId, id])

  // Tier 149: search for the merge-target
  // customer. 300ms debounce so we don't
  // refetch on every keystroke.
  useEffect(() => {
    if (!mergeOpen || !mergeSearch.trim() || !companyId) {
      setMergeSearchResults([])
      return
    }
    const t = setTimeout(() => {
      setMergeSearching(true)
      apiGet<{ data: Array<{ id: string; name: string; customerNumber: string | null }> }>(
        `/api/v1/customers?companyId=${companyId}&search=${encodeURIComponent(mergeSearch.trim())}&pageSize=10`,
      )
        .then((d) => {
          // Filter out the current customer —
          // can't merge into self.
          const filtered = (d.data || []).filter((c) => c.id !== id)
          setMergeSearchResults(filtered)
        })
        .catch((err) => console.error("merge search failed:", err))
        .finally(() => setMergeSearching(false))
    }, 300)
    return () => clearTimeout(t)
  }, [mergeSearch, mergeOpen, companyId, id])

  const addInternalNote = async () => {
    const trimmed = newInternalNote.trim()
    if (!trimmed || !companyId) return
    setAddingInternalNote(true)
    setInternalNoteError(null)
    try {
      const { apiPost, ApiError } = await import("@/lib/api")
      const created = await apiPost<any>(
        `/api/v1/customers/${id}/internal-notes?companyId=${companyId}`,
        { body: trimmed },
      )
      setInternalNotes([created, ...internalNotes])
      setNewInternalNote("")
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "Fehler"
      setInternalNoteError(msg)
    } finally {
      setAddingInternalNote(false)
    }
  }

  const deleteInternalNote = async (noteId: string) => {
    if (!companyId) return
    setDeletingInternalNoteId(noteId)
    try {
      const { apiDelete, ApiError } = await import("@/lib/api")
      await apiDelete(
        `/api/v1/customers/${id}/internal-notes/${noteId}?companyId=${companyId}`,
      )
      setInternalNotes(internalNotes.filter((n) => n.id !== noteId))
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "Fehler"
      setInternalNoteError(msg)
    } finally {
      setDeletingInternalNoteId(null)
    }
  }

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
          {/* Tier 128: VIES USt-ID verify button + result badge.
              The badge color is driven by the most recent check:
                green  = valid (status=valid)
                red    = invalid (status=invalid)
                gray   = unchecked (no prior check)
                blue   = currently checking
              Clicking the button POSTs to /vat-validation/check
              and refreshes the latest result. The history is
              shown via the customer-update-existing
              <ViesHistoryPanel/> below the header. */}
          {customer.vatId && (
            <div className="mt-2 flex items-center gap-2 text-sm">
              <button
                type="button"
                onClick={runViesCheck}
                disabled={viesChecking}
                data-testid="vies-verify-button"
                className={`px-3 py-1 rounded border text-xs font-medium transition-colors ${
                  viesChecking
                    ? "bg-blue-50 dark:bg-blue-900/30 border-blue-300 text-blue-700 dark:text-blue-300 cursor-wait"
                    : "bg-white dark:bg-gray-800 border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
                }`}
              >
                {viesChecking
                  ? (t("customer.vatChecking") || "Prüfe…")
                  : (t("customer.vatCheckNow") || "USt-ID prüfen")}
              </button>
              {/* Result badge — shows the last known status */}
              {viesLatest && (
                <span
                  data-testid="vies-result-badge"
                  className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${
                    viesLatest.status === "valid"
                      ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300"
                      : viesLatest.status === "invalid"
                      ? "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300"
                      : "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300"
                  }`}
                  title={viesLatest.errorMessage || ""}
                >
                  {viesLatest.status === "valid"
                    ? `✓ ${t("customer.vatStatusValid") || "Gültig"}`
                    : viesLatest.status === "invalid"
                    ? `✗ ${t("customer.vatStatusInvalid") || "Ungültig"}`
                    : `? ${t("customer.vatStatusUnreachable") || "VIES nicht erreichbar"}`}
                  {viesLatest.countryCode && (
                    <span className="font-mono opacity-75">({viesLatest.countryCode})</span>
                  )}
                </span>
              )}
              {viesError && (
                <span className="text-xs text-red-600 dark:text-red-400">
                  {viesError}
                </span>
              )}
            </div>
          )}
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
          {/* Tier 132: generate a portal-login link for
              this customer. The backend creates a 30-day
              session + emails the link (NO-SMTP in dev
              logs to stdout). We show the URL in a modal
              so the admin can copy + paste it into any
              channel. The button is disabled if the
              customer has no email on file. */}
          <Button
            variant="outline"
            onClick={generatePortalLink}
            disabled={portalLinkGenerating || !(customer as any).contact?.email}
            data-testid="customer-portal-generate-button"
            title={
              (customer as any).contact?.email
                ? (t("customer.portalLinkTooltip") ||
                    "Erzeugt einen 30-Tage Login-Link zum Kundenportal und sendet ihn an den Kunden")
                : (t("customer.portalLinkNoEmail") ||
                    "Kunde hat keine E-Mail-Adresse hinterlegt")
            }
          >
            {portalLinkGenerating
              ? "⏳"
              : `🔗 ${t("customer.portalLink") || "Portal-Login-Link"}`}
          </Button>
          <Button
            onClick={() => router.push(`/dashboard/customers/${id}/statement`)}
            data-testid="customer-detail-statement"
          >
            📊 {t("statement.title") || "Kontoauszug"}
          </Button>
          <Button
            onClick={() => setAllocateOpen(true)}
            data-testid="customer-detail-allocate-payment"
            variant="outline"
            className="border-emerald-300 text-emerald-700 hover:bg-emerald-50"
          >
            💰 {t("customerDetail.allocatePayment") || "Zahlung zuordnen"}
          </Button>
          <Button
            onClick={() => setMergeOpen(true)}
            data-testid="customer-detail-merge"
            variant="outline"
            className="border-amber-300 text-amber-700 hover:bg-amber-50"
          >
            🔀 {t("customerDetail.mergeBtn") || "Zusammenführen"}
          </Button>
        </div>
      </header>

      {/* KPI strip */}
      <div
        className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-7 gap-3 mb-6"
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
        {/* Tier 159: credit-limit utilization. Only
            renders when the customer has a non-NULL
            creditLimit (the schema field defaults to
            NULL, so most customers won't have one).
            The progress bar is clamped at 100% even
            when utilization exceeds 100% — the badge
            + the red colour already convey the
            "over-limit" state, the bar just needs to
            show the visual cap. */}
        {customer.creditLimit != null && customer.creditLimit > 0 && (() => {
          const limit = customer.creditLimit
          const open = stats.openBalance
          const utilization = (open / limit) * 100
          const clampedPct = Math.min(utilization, 100)
          // Three buckets: ok (<80%) / warning (80-100%)
          // / over (>100%). The colour is the same as
          // the dashboard widget so the operator has
          // one mental model.
          const bucket: 'ok' | 'warning' | 'over' =
            open > limit ? 'over' : utilization >= 80 ? 'warning' : 'ok'
          const bucketColor =
            bucket === 'over'
              ? 'text-red-700 dark:text-red-400'
              : bucket === 'warning'
                ? 'text-amber-700 dark:text-amber-400'
                : 'text-emerald-700 dark:text-emerald-400'
          const barColor =
            bucket === 'over'
              ? 'bg-red-500'
              : bucket === 'warning'
                ? 'bg-amber-500'
                : 'bg-emerald-500'
          return (
            <Card data-testid="kpi-credit-limit" data-bucket={bucket}>
              <CardContent className="pt-4">
                <p className="text-xs text-gray-500">
                  {t("customerDetail.creditLimit") || "Kreditlimit"}
                </p>
                <p
                  className={"text-xl font-mono font-bold " + bucketColor}
                  data-testid="kpi-credit-limit-pct"
                >
                  {Math.round(utilization * 10) / 10}%
                </p>
                <p className="text-xs text-gray-400">
                  {fmtEur(open)} / {fmtEur(limit)}
                </p>
                <div className="mt-2 h-1.5 w-full bg-gray-200 dark:bg-gray-700 rounded overflow-hidden">
                  <div
                    className={"h-full " + barColor}
                    style={{ width: clampedPct + "%" }}
                    data-testid="kpi-credit-limit-bar"
                  />
                </div>
              </CardContent>
            </Card>
          )
        })()}
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
        <button
          role="tab"
          onClick={() => setTab("emails")}
          className={
            "px-4 py-2 text-sm font-medium border-b-2 " +
            (tab === "emails"
              ? "border-blue-600 text-blue-700"
              : "border-transparent text-gray-500 hover:text-gray-700")
          }
          data-testid="tab-emails"
        >
          📧 {t("customerDetail.tabEmails") || "E-Mail-Verlauf"}
          {emails && emails.length > 0 && (
            <span className="ml-1 text-xs px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-700">
              {emails.length}
            </span>
          )}
        </button>
        <button
          role="tab"
          onClick={() => setTab("payments")}
          className={
            "px-4 py-2 text-sm font-medium border-b-2 " +
            (tab === "payments"
              ? "border-blue-600 text-blue-700"
              : "border-transparent text-gray-500 hover:text-gray-700")
          }
          data-testid="tab-payments"
        >
          💶 {t("customerDetail.tabPayments") || "Zahlungen"}
          {payments && payments.length > 0 && (
            <span
              className="ml-1 text-xs px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-800"
              data-testid="tab-payments-count"
            >
              {payments.length}
            </span>
          )}
        </button>
        <button
          role="tab"
          onClick={() => setTab("attachments")}
          className={
            "px-4 py-2 text-sm font-medium border-b-2 " +
            (tab === "attachments"
              ? "border-blue-600 text-blue-700"
              : "border-transparent text-gray-500 hover:text-gray-700")
          }
          data-testid="tab-attachments"
        >
          📎 {t("customerDetail.tabAttachments") || "Dokumente"}
          {attachments && attachments.length > 0 && (
            <span className="ml-1 text-xs px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-700">
              {attachments.length}
            </span>
          )}
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

      {/* Tier 144: email-Verlauf. The Berater's
          primary use case: "did we already send
          the second reminder to BWA?" — every
          email the system has ever sent to this
          customer is here, with status + body
          preview. Click a row to see the full
          body in a modal. */}
      {tab === "emails" && (
        <Card>
          <CardContent className="pt-6">
            {emailsLoading && (
              <p className="text-gray-500">{t("common.loading") || "Lädt..."}</p>
            )}
            {emails && emails.length === 0 && (
              <p
                className="text-center text-gray-500 py-8"
                data-testid="tab-emails-empty"
              >
                {t("customerDetail.noEmails") ||
                  "Noch keine E-Mails an diesen Kunden versendet."}
              </p>
            )}
            {emails && emails.length > 0 && (
              <div className="overflow-x-auto">
                <table
                  className="w-full min-w-[640px] text-sm"
                  data-testid="tab-emails-table"
                >
                  <thead>
                    <tr className="border-b border-gray-200 dark:border-gray-700">
                      <th className="text-left px-2 py-2 text-xs font-medium text-gray-500">
                        {t("customerDetail.emailColDate") || "Datum"}
                      </th>
                      <th className="text-left px-2 py-2 text-xs font-medium text-gray-500">
                        {t("customerDetail.emailColSubject") || "Betreff"}
                      </th>
                      <th className="text-left px-2 py-2 text-xs font-medium text-gray-500">
                        {t("customerDetail.emailColTemplate") || "Vorlage"}
                      </th>
                      <th className="text-left px-2 py-2 text-xs font-medium text-gray-500">
                        {t("customerDetail.emailColInvoice") || "Rechnung"}
                      </th>
                      <th className="text-left px-2 py-2 text-xs font-medium text-gray-500">
                        {t("customerDetail.emailColStatus") || "Status"}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {emails.map((e) => (
                      <tr
                        key={e.id}
                        className="border-b border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer"
                        onClick={() => setEmailDetail(e)}
                        data-testid="tab-emails-row"
                      >
                        <td className="px-2 py-2 text-gray-700 dark:text-gray-300 whitespace-nowrap">
                          {fmtDateDE(e.sentAt || e.createdAt)}
                        </td>
                        <td className="px-2 py-2 text-gray-900 dark:text-gray-100">
                          {e.subject || "—"}
                        </td>
                        <td className="px-2 py-2 text-gray-600 dark:text-gray-400 text-xs">
                          {e.templateType || "—"}
                        </td>
                        <td className="px-2 py-2 text-blue-700 dark:text-blue-400 text-xs">
                          {e.invoice ? e.invoice.invoiceNumber : "—"}
                        </td>
                        <td className="px-2 py-2">
                          <span
                            className={
                              "text-xs px-1.5 py-0.5 rounded-full " +
                              (e.status === "opened"
                                ? "bg-green-100 text-green-800"
                                : e.status === "bounced" || e.status === "failed"
                                  ? "bg-red-100 text-red-800"
                                  : "bg-gray-100 text-gray-700")
                            }
                          >
                            {e.status}
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

      {/* Tier 238: Zahlungen (payments) tab. Shows a
          single table of every payment recorded
          against any of the customer's invoices
          (oldest payment bottom, newest top). The
          data is fetched by walking the customer's
          invoices and pulling their payment lists,
          so a customer with N invoices triggers N
          requests — sequential to keep the network
          gentle. Each row shows invoice number (link),
          payment date, amount, payment method, and
          an optional reference / notes. Empty state
          when the customer has no payments yet. */}
      {tab === "payments" && (
        <Card>
          <CardContent className="pt-6">
            {paymentsLoading && (
              <p
                className="text-gray-500"
                data-testid="tab-payments-loading"
              >
                {t("common.loading") || "Lädt..."}
              </p>
            )}
            {payments && payments.length === 0 && (
              <p
                className="text-center text-gray-500 py-8"
                data-testid="tab-payments-empty"
              >
                {t("customerDetail.noPayments") ||
                  "Noch keine Zahlungen erfasst."}
              </p>
            )}
            {payments && payments.length > 0 && (
              <>
                <div className="mb-3 text-sm text-gray-600 dark:text-gray-400">
                  {t("customerDetail.paymentsTotal") ||
                    "Gesamtbetrag aller Zahlungen"}:{" "}
                  <span
                    className="font-mono font-semibold text-emerald-700 dark:text-emerald-400"
                    data-testid="tab-payments-sum"
                  >
                    {fmtEur(
                      payments.reduce(
                        (acc, p) => acc + Number(p.amount || 0),
                        0,
                      ),
                    )}
                  </span>{" "}
                  ({payments.length})
                </div>
                <div className="overflow-x-auto">
                  <table
                    className="w-full min-w-[640px] text-sm"
                    data-testid="tab-payments-table"
                  >
                    <thead>
                      <tr className="border-b border-gray-200 dark:border-gray-700">
                        <th className="text-left px-2 py-2 text-xs font-medium text-gray-500">
                          {t("customerDetail.paymentsColDate") || "Datum"}
                        </th>
                        <th className="text-left px-2 py-2 text-xs font-medium text-gray-500">
                          {t("customerDetail.paymentsColInvoice") ||
                            "Rechnung"}
                        </th>
                        <th className="text-right px-2 py-2 text-xs font-medium text-gray-500">
                          {t("customerDetail.paymentsColAmount") ||
                            "Betrag"}
                        </th>
                        <th className="text-left px-2 py-2 text-xs font-medium text-gray-500">
                          {t("customerDetail.paymentsColMethod") ||
                            "Zahlungsweg"}
                        </th>
                        <th className="text-left px-2 py-2 text-xs font-medium text-gray-500">
                          {t("customerDetail.paymentsColReference") ||
                            "Referenz"}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {payments.map((p) => (
                        <tr
                          key={p.id}
                          className="border-b border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800"
                          data-testid="tab-payments-row"
                        >
                          <td className="px-2 py-2 text-gray-700 dark:text-gray-300 whitespace-nowrap">
                            {fmtDateDE(p.paymentDate)}
                          </td>
                          <td className="px-2 py-2 text-blue-700 dark:text-blue-400 font-mono text-xs">
                            {p.invoiceNumber}
                          </td>
                          <td className="px-2 py-2 text-right font-mono text-emerald-700 dark:text-emerald-400">
                            {fmtEur(Number(p.amount))}
                          </td>
                          <td className="px-2 py-2 text-gray-700 dark:text-gray-300 text-xs">
                            {p.paymentMethod || "—"}
                          </td>
                          <td className="px-2 py-2 text-gray-500 dark:text-gray-400 text-xs">
                            {p.reference || p.notes || "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}

      {/* Tier 238: Dokumente (attachments) tab. The
          backend Attachment model supports entityType
          'expense' | 'voucher' | 'berater-note' |
          'invoice' — 'customer' is NOT in the upload
          whitelist, so this list will be empty in
          practice. The tab is wired up and ready for
          when customer attachments are enabled (the
          list endpoint doesn't enforce the whitelist,
          only the upload does — so a 200 with [] is
          the expected response). The UI shows an
          informative empty state explaining this. */}
      {tab === "attachments" && (
        <Card>
          <CardContent className="pt-6">
            {attachmentsLoading && (
              <p
                className="text-gray-500"
                data-testid="tab-attachments-loading"
              >
                {t("common.loading") || "Lädt..."}
              </p>
            )}
            {attachments && attachments.length === 0 && (
              <div
                className="text-center text-gray-500 py-8 space-y-2"
                data-testid="tab-attachments-empty"
              >
                <p className="text-2xl">📎</p>
                <p>
                  {t("customerDetail.noAttachments") ||
                    "Noch keine Dokumente hinterlegt."}
                </p>
                <p className="text-xs text-gray-400">
                  {t("customerDetail.attachmentsHint") ||
                    "Verträge, Scans und gescannte Belege können hier abgelegt werden."}
                </p>
              </div>
            )}
            {attachments && attachments.length > 0 && (
              <div className="overflow-x-auto">
                <table
                  className="w-full min-w-[640px] text-sm"
                  data-testid="tab-attachments-table"
                >
                  <thead>
                    <tr className="border-b border-gray-200 dark:border-gray-700">
                      <th className="text-left px-2 py-2 text-xs font-medium text-gray-500">
                        {t("customerDetail.attachmentsColName") || "Datei"}
                      </th>
                      <th className="text-left px-2 py-2 text-xs font-medium text-gray-500">
                        {t("customerDetail.attachmentsColType") || "Typ"}
                      </th>
                      <th className="text-right px-2 py-2 text-xs font-medium text-gray-500">
                        {t("customerDetail.attachmentsColSize") || "Größe"}
                      </th>
                      <th className="text-left px-2 py-2 text-xs font-medium text-gray-500">
                        {t("customerDetail.attachmentsColUploadedBy") ||
                          "Hochgeladen von"}
                      </th>
                      <th className="text-left px-2 py-2 text-xs font-medium text-gray-500">
                        {t("customerDetail.attachmentsColDate") || "Datum"}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {attachments.map((a) => (
                      <tr
                        key={a.id}
                        className="border-b border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800"
                        data-testid="tab-attachments-row"
                      >
                        <td className="px-2 py-2 text-gray-900 dark:text-gray-100">
                          <a
                            href={`/api/v1/attachments/${a.id}/file?companyId=${companyId}`}
                            target="_blank"
                            rel="noreferrer"
                            className="text-blue-700 dark:text-blue-400 hover:underline"
                          >
                            {a.originalName}
                          </a>
                        </td>
                        <td className="px-2 py-2 text-gray-600 dark:text-gray-400 text-xs">
                          {a.mimeType}
                        </td>
                        <td className="px-2 py-2 text-right font-mono text-gray-700 dark:text-gray-300">
                          {a.size < 1024
                            ? `${a.size} B`
                            : a.size < 1024 * 1024
                              ? `${(a.size / 1024).toFixed(1)} KB`
                              : `${(a.size / 1024 / 1024).toFixed(1)} MB`}
                        </td>
                        <td className="px-2 py-2 text-gray-500 dark:text-gray-400 text-xs">
                          {a.uploadedBy?.email || "—"}
                        </td>
                        <td className="px-2 py-2 text-gray-700 dark:text-gray-300 text-xs whitespace-nowrap">
                          {fmtDateDE(a.createdAt)}
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

      {/* Tier 144: email detail modal. Shows the
          full body preview (the EmailSend row
          stores a truncated version of the body
          — long enough for the Berater to see
          "yes, this is the right email" but not
          the full multi-paragraph text). The
          modal also shows recipient, sent-at,
          template type, and a link to the linked
          invoice (if any). */}
      {emailDetail && (
        <div
          className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50"
          data-testid="email-detail-modal"
          onClick={() => setEmailDetail(null)}
        >
          <div
            className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-2xl w-full max-h-[80vh] overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-6 py-4 border-b flex items-center justify-between">
              <h3 className="font-semibold text-lg">
                {t("customerDetail.emailDetailTitle") || "E-Mail-Details"}
              </h3>
              <button
                className="text-gray-400 hover:text-gray-600 text-xl"
                onClick={() => setEmailDetail(null)}
                aria-label="Schließen"
                data-testid="email-detail-close"
              >
                ✕
              </button>
            </div>
            <div className="px-6 py-4 overflow-y-auto flex-1 space-y-3 text-sm">
              <div>
                <span className="text-gray-500">
                  {t("customerDetail.emailDetailRecipient") || "Empfänger"}:
                </span>{" "}
                <span className="font-mono" data-testid="email-detail-recipient">
                  {emailDetail.recipientEmail}
                </span>
              </div>
              <div>
                <span className="text-gray-500">
                  {t("customerDetail.emailDetailSentAt") || "Gesendet"}:
                </span>{" "}
                {fmtDateDE(emailDetail.sentAt || emailDetail.createdAt)}
              </div>
              <div>
                <span className="text-gray-500">
                  {t("customerDetail.emailDetailSubject") || "Betreff"}:
                </span>{" "}
                <span className="font-medium" data-testid="email-detail-subject">
                  {emailDetail.subject || "—"}
                </span>
              </div>
              <div>
                <span className="text-gray-500">
                  {t("customerDetail.emailDetailTemplate") || "Vorlage"}:
                </span>{" "}
                <span className="font-mono text-xs">
                  {emailDetail.templateType || "—"}
                </span>
              </div>
              {emailDetail.invoice && (
                <div>
                  <span className="text-gray-500">
                    {t("customerDetail.emailDetailInvoice") || "Rechnung"}:
                  </span>{" "}
                  <a
                    href={`/dashboard/invoices/${emailDetail.invoice.id}`}
                    className="text-blue-600 hover:underline"
                    data-testid="email-detail-invoice"
                  >
                    {emailDetail.invoice.invoiceNumber}
                  </a>
                </div>
              )}
              <div className="pt-2 border-t">
                <div className="text-gray-500 mb-1">
                  {t("customerDetail.emailDetailBody") || "Vorschau"}:
                </div>
                <pre
                  className="whitespace-pre-wrap text-xs text-gray-800 dark:text-gray-200 font-sans"
                  data-testid="email-detail-body"
                >
                  {emailDetail.bodyPreview || "(kein Inhalt)"}
                </pre>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Tier 146: payment allocation modal.
          Two-step flow:
            1. user enters amount / date / method
            2. system shows the proposed allocation
               (oldest first by dueDate) as a
               preview table
            3. user clicks Bestätigen
            4. POST writes the Payment rows
          The preview step is a dry-run — no
          Payment rows are created until the user
          clicks Bestätigen. */}
      {allocateOpen && (
        <div
          className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50"
          data-testid="allocate-modal"
          onClick={() => setAllocateOpen(false)}
        >
          <div
            className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-2xl w-full max-h-[85vh] overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-6 py-4 border-b flex items-center justify-between">
              <h3 className="font-semibold text-lg">
                💰 {t("customerDetail.allocateTitle") || "Zahlung zuordnen"}
              </h3>
              <button
                className="text-gray-400 hover:text-gray-600 text-xl"
                onClick={() => {
                  setAllocateOpen(false)
                  setAllocatePreview(null)
                  setAllocateResult(null)
                  setAllocateError(null)
                }}
                data-testid="allocate-close"
                aria-label="Schließen"
              >
                ✕
              </button>
            </div>
            <div className="px-6 py-4 overflow-y-auto flex-1 space-y-3 text-sm">
              {!allocateResult && (
                <>
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">
                      {t("customerDetail.allocateAmount") || "Betrag"} (€)
                    </label>
                    <input
                      type="number"
                      step="0.01"
                      min="0.01"
                      value={allocateAmount}
                      onChange={(e) => setAllocateAmount(e.target.value)}
                      data-testid="allocate-amount"
                      className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded text-sm"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-xs font-medium text-gray-500 mb-1">
                        {t("customerDetail.allocateDate") || "Zahldatum"}
                      </label>
                      <input
                        type="date"
                        value={allocateDate}
                        onChange={(e) => setAllocateDate(e.target.value)}
                        data-testid="allocate-date"
                        className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-500 mb-1">
                        {t("customerDetail.allocateMethod") || "Zahlweg"}
                      </label>
                      <select
                        value={allocateMethod}
                        onChange={(e) => setAllocateMethod(e.target.value)}
                        data-testid="allocate-method"
                        className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded text-sm"
                      >
                        <option value="Überweisung">Überweisung</option>
                        <option value="SEPA-Lastschrift">SEPA-Lastschrift</option>
                        <option value="Bargeld">Bargeld</option>
                        <option value="Verrechnung">Verrechnung</option>
                        <option value="Sonstiges">Sonstiges</option>
                      </select>
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">
                      {t("customerDetail.allocateReference") ||
                        "Referenz (optional)"}
                    </label>
                    <input
                      type="text"
                      value={allocateReference}
                      onChange={(e) => setAllocateReference(e.target.value)}
                      placeholder="z.B. SEPA-Mandat, Kontoauszug-Nr."
                      data-testid="allocate-reference"
                      className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded text-sm"
                    />
                  </div>
                  <div className="flex gap-2 pt-2">
                    <Button
                      onClick={async () => {
                        const amount = parseFloat(allocateAmount)
                        if (!amount || amount <= 0) {
                          setAllocateError("Betrag muss > 0 sein")
                          return
                        }
                        setAllocateError(null)
                        setAllocatePreview(null)
                        try {
                          const { apiGet, ApiError } = await import("@/lib/api")
                          const data = await apiGet<any>(
                            `/api/v1/customers/${id}/allocate-payment/preview?companyId=${companyId}&amount=${amount}`,
                          )
                          setAllocatePreview(data)
                        } catch (err) {
                          const msg = err instanceof ApiError ? err.message : "Fehler"
                          setAllocateError(msg)
                        }
                      }}
                      data-testid="allocate-preview-btn"
                    >
                      🔍 {t("customerDetail.allocatePreviewBtn") || "Vorschau"}
                    </Button>
                  </div>
                  {allocateError && (
                    <p
                      className="text-xs text-red-600"
                      data-testid="allocate-error"
                    >
                      {allocateError}
                    </p>
                  )}
                </>
              )}

              {allocatePreview && !allocateResult && (
                <div data-testid="allocate-preview">
                  <h4 className="text-sm font-medium mb-2">
                    {t("customerDetail.allocatePreviewTitle") ||
                      "Vorgeschlagene Zuordnung (älteste zuerst):"}
                  </h4>
                  <table className="w-full text-xs mb-3">
                    <thead>
                      <tr className="border-b border-gray-200 dark:border-gray-700">
                        <th className="text-left py-1">Rechnung</th>
                        <th className="text-right py-1">Offen</th>
                        <th className="text-right py-1">Anwendung</th>
                      </tr>
                    </thead>
                    <tbody>
                      {allocatePreview.invoices.map((inv) => (
                        <tr
                          key={inv.invoiceId}
                          className="border-b border-gray-100 dark:border-gray-800"
                        >
                          <td className="py-1 font-mono">{inv.invoiceNumber}</td>
                          <td className="text-right py-1">
                            {fmtEur(inv.remaining)} €
                          </td>
                          <td
                            className="text-right py-1 font-semibold text-emerald-700"
                            data-testid={`allocate-apply-${inv.invoiceId}`}
                          >
                            {fmtEur(inv.applied)} €
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="flex justify-between text-xs border-t pt-2">
                    <span>
                      {t("customerDetail.allocateUnallocated") ||
                        "Nicht zugeordnet:"}
                    </span>
                    <span
                      className={
                        allocatePreview.unallocatedAmount > 0
                          ? "font-semibold text-amber-700"
                          : "font-semibold text-emerald-700"
                      }
                      data-testid="allocate-unallocated"
                    >
                      {fmtEur(allocatePreview.unallocatedAmount)} €
                    </span>
                  </div>
                </div>
              )}

              {allocateResult && (
                <div
                  className="p-3 bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 rounded text-sm"
                  data-testid="allocate-result"
                >
                  <p className="font-medium text-emerald-800 dark:text-emerald-200">
                    ✓{" "}
                    {t("customerDetail.allocateSuccess") ||
                      "Zahlung zugeordnet."}
                  </p>
                  <p className="text-xs mt-1 text-emerald-700 dark:text-emerald-300">
                    {t("customerDetail.allocateSuccessCount") ||
                      "{count} Rechnungen bezahlt, {total} € angewendet"
                        .replace("{count}", String(allocateResult.appliedCount))
                        .replace("{total}", fmtEur(allocateResult.appliedTotal))}
                    {allocateResult.unallocatedAmount > 0 && (
                      <span className="block mt-1 text-amber-700">
                        (
                        {(t("customerDetail.allocateUnallocated") ||
                          "Nicht zugeordnet:") +
                          " " +
                          fmtEur(allocateResult.unallocatedAmount) +
                          " €"}
                        )
                      </span>
                    )}
                  </p>
                </div>
              )}
            </div>
            {allocatePreview && !allocateResult && (
              <div className="px-6 py-4 border-t flex justify-end gap-2">
                <Button
                  variant="outline"
                  onClick={() => setAllocatePreview(null)}
                  data-testid="allocate-back"
                >
                  ← {t("common.back") || "Zurück"}
                </Button>
                <Button
                  onClick={async () => {
                    setAllocateSubmitting(true)
                    setAllocateError(null)
                    try {
                      const { apiPost, ApiError } = await import("@/lib/api")
                      const data = await apiPost<any>(
                        `/api/v1/customers/${id}/allocate-payment?companyId=${companyId}`,
                        {
                          amount: parseFloat(allocateAmount),
                          paymentDate: allocateDate,
                          paymentMethod: allocateMethod,
                          reference: allocateReference || undefined,
                        },
                      )
                      setAllocateResult({
                        appliedCount: data.appliedCount,
                        appliedTotal: data.appliedTotal,
                        unallocatedAmount: data.unallocatedAmount,
                      })
                      setAllocatePreview(null)
                    } catch (err) {
                      const msg = err instanceof ApiError ? err.message : "Fehler"
                      setAllocateError(msg)
                    } finally {
                      setAllocateSubmitting(false)
                    }
                  }}
                  disabled={allocateSubmitting}
                  data-testid="allocate-confirm"
                >
                  {allocateSubmitting
                    ? "…"
                    : `✓ ${t("customerDetail.allocateConfirm") || "Zuordnung bestätigen"}`}
                </Button>
              </div>
            )}
            {allocateResult && (
              <div className="px-6 py-4 border-t flex justify-end">
                <Button
                  onClick={() => {
                    setAllocateOpen(false)
                    setAllocateResult(null)
                    setAllocatePreview(null)
                    setAllocateAmount("")
                    setAllocateReference("")
                    // Reload the invoices list so the
                    // "Bezahlt" status updates are
                    // visible.
                    setInvoices(null)
                  }}
                  data-testid="allocate-done"
                >
                  {t("common.close") || "Schließen"}
                </Button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Tier 149: customer merge modal.
          Two-step flow: search for the duplicate
          (source), see the preview counts, then
          confirm. After success we route to the
          target customer's page — the source is
          gone, so reloading the source URL would
          404. */}
      {mergeOpen && (
        <div
          className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50"
          data-testid="merge-modal"
          onClick={() => {
            if (mergeSubmitting) return
            setMergeOpen(false)
            setMergeSearch("")
            setMergeSearchResults([])
            setMergeSourceId(null)
            setMergePreview(null)
            setMergeError(null)
            setMergeDone(null)
          }}
        >
          <div
            className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-2xl w-full max-h-[85vh] overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-6 py-4 border-b flex items-center justify-between">
              <h3 className="font-semibold text-lg">
                🔀 {t("customerDetail.mergeTitle") || "Kunden zusammenführen"}
              </h3>
              <button
                className="text-gray-400 hover:text-gray-600 text-xl"
                onClick={() => {
                  if (mergeSubmitting) return
                  setMergeOpen(false)
                  setMergeSearch("")
                  setMergeSearchResults([])
                  setMergeSourceId(null)
                  setMergePreview(null)
                  setMergeError(null)
                  setMergeDone(null)
                }}
                data-testid="merge-close"
                aria-label="Schließen"
              >
                ✕
              </button>
            </div>
            <div className="px-6 py-4 overflow-y-auto flex-1 space-y-3 text-sm">
              {!mergeDone && (
                <>
                  <p className="text-xs text-gray-500">
                    {t("customerDetail.mergeIntro") ||
                      "Wähle den Duplikat-Kunden aus. Alle Rechnungen, Recurring-Vorlagen, Mahnungen, SEPA-Mandate usw. werden auf diesen Kunden übertragen. Der Duplikat-Kunde wird gelöscht."}
                  </p>
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">
                      {t("customerDetail.mergeSourceLabel") || "Duplikat (Quelle)"}
                    </label>
                    <input
                      type="text"
                      value={mergeSearch}
                      onChange={(e) => setMergeSearch(e.target.value)}
                      placeholder={
                        t("customerDetail.mergeSourcePlaceholder") ||
                        "Kunden suchen..."
                      }
                      data-testid="merge-search-input"
                      className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded text-sm"
                    />
                    {mergeSearching && (
                      <p className="text-xs text-gray-500 mt-1">Suche läuft…</p>
                    )}
                    {mergeSearchResults.length > 0 && (
                      <div
                        className="border border-gray-200 dark:border-gray-700 rounded mt-1 max-h-40 overflow-y-auto"
                        data-testid="merge-search-results"
                      >
                        {mergeSearchResults.map((c) => (
                          <button
                            key={c.id}
                            onClick={async () => {
                              setMergeSourceId(c.id)
                              setMergePreview(null)
                              setMergeError(null)
                              try {
                                const { apiPost, ApiError } = await import(
                                  "@/lib/api"
                                )
                                const data = await apiPost<any>(
                                  `/api/v1/customers/merge/preview?companyId=${companyId}`,
                                  { sourceId: c.id, targetId: id },
                                )
                                setMergePreview(data)
                              } catch (err) {
                                const msg =
                                  err instanceof ApiError ? err.message : "Fehler"
                                setMergeError(msg)
                              }
                            }}
                            className={
                              "block w-full text-left px-3 py-2 text-sm hover:bg-blue-50 dark:hover:bg-blue-900/30 " +
                              (mergeSourceId === c.id
                                ? "bg-blue-100 dark:bg-blue-900/40"
                                : "")
                            }
                            data-testid={`merge-source-${c.id}`}
                          >
                            <div className="font-medium">{c.name}</div>
                            {c.customerNumber && (
                              <div className="text-xs text-gray-500">
                                {c.customerNumber}
                              </div>
                            )}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  {mergePreview && (
                    <div
                      className="p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 rounded text-xs"
                      data-testid="merge-preview"
                    >
                      <p className="font-semibold text-amber-900 dark:text-amber-200 mb-2">
                        {t("customerDetail.mergePreviewTitle") ||
                          "Vorschau — diese Daten werden verschoben:"}
                      </p>
                      <ul className="space-y-0.5 text-amber-900 dark:text-amber-200">
                        {Object.entries(mergePreview.counts).map(([key, count]) =>
                          Number(count) > 0 ? (
                            <li key={key} className="flex justify-between">
                              <span>{key}</span>
                              <span className="font-mono font-semibold">
                                {String(count)}
                              </span>
                            </li>
                          ) : null,
                        )}
                      </ul>
                      {mergePreview.mergedTags.length > 0 && (
                        <p className="mt-2">
                          {t("customerDetail.mergePreviewTags") ||
                            "Zusammengeführte Tags:"}{" "}
                          <span className="font-mono">
                            {mergePreview.mergedTags.join(", ")}
                          </span>
                        </p>
                      )}
                    </div>
                  )}

                  {mergeError && (
                    <p
                      className="text-xs text-red-600"
                      data-testid="merge-error"
                    >
                      {mergeError}
                    </p>
                  )}
                </>
              )}

              {mergeDone && (
                <div
                  className="p-3 bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 rounded text-sm"
                  data-testid="merge-done"
                >
                  <p className="font-medium text-emerald-800 dark:text-emerald-200">
                    ✓ {t("customerDetail.mergeSuccess") || "Zusammenführung erfolgreich."}
                  </p>
                  <p className="text-xs mt-1 text-emerald-700 dark:text-emerald-300">
                    {Object.entries(mergeDone.moved)
                      .filter(([, count]) => Number(count) > 0)
                      .map(([key, count]) => `${key}: ${String(count)}`)
                      .join(" · ") || "(keine Daten verschoben)"}
                  </p>
                </div>
              )}
            </div>
            {!mergeDone && (
              <div className="px-6 py-4 border-t flex justify-end gap-2">
                <Button
                  variant="outline"
                  onClick={() => {
                    setMergeOpen(false)
                    setMergeSearch("")
                    setMergeSearchResults([])
                    setMergeSourceId(null)
                    setMergePreview(null)
                    setMergeError(null)
                  }}
                  data-testid="merge-cancel"
                  disabled={mergeSubmitting}
                >
                  {t("common.cancel") || "Abbrechen"}
                </Button>
                <Button
                  onClick={async () => {
                    if (!mergeSourceId) return
                    setMergeSubmitting(true)
                    setMergeError(null)
                    try {
                      const { apiPost, ApiError } = await import("@/lib/api")
                      const data = await apiPost<any>(
                        `/api/v1/customers/merge?companyId=${companyId}`,
                        { sourceId: mergeSourceId, targetId: id },
                      )
                      setMergeDone({
                        moved: data.moved,
                        mergedTags: data.mergedTags,
                      })
                    } catch (err) {
                      const msg = err instanceof ApiError ? err.message : "Fehler"
                      setMergeError(msg)
                    } finally {
                      setMergeSubmitting(false)
                    }
                  }}
                  disabled={!mergeSourceId || mergeSubmitting}
                  data-testid="merge-confirm"
                  className="bg-amber-600 hover:bg-amber-700 text-white"
                >
                  {mergeSubmitting
                    ? "…"
                    : `🔀 ${t("customerDetail.mergeConfirm") || "Zusammenführen"}`}
                </Button>
              </div>
            )}
            {mergeDone && (
              <div className="px-6 py-4 border-t flex justify-end">
                <Button
                  onClick={() => {
                    // Route to the target customer's
                    // page — the source is gone, so
                    // the current URL would 404 on
                    // reload.
                    router.push(`/dashboard/customers/${id}`)
                  }}
                  data-testid="merge-redirect"
                >
                  {t("common.close") || "Schließen"}
                </Button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Tier 145: internal Berater-Notizen on the
          customer. Parallel to the invoice-internal-
          notes card (Tier 138). Same GoBD § 146 Abs. 4
          AO compliance angle: internal communication
          between Berater + admin that the customer
          must NEVER see. Goes into a separate table
          (NOT a field on Customer) so the visibility
          boundary is enforced at the data layer.
          The lock icon in the header makes the
          distinction obvious. */}
      <Card className="mt-8" data-testid="customer-internal-notes-card">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            🔒 {t("customerDetail.internalNotes") || "Interne Notizen"}
            <span className="text-xs font-normal text-gray-500 dark:text-gray-400">
              {t("customerDetail.internalNotesHint") ||
                "(nur für Ihr Team — erscheint nicht im Kundenportal)"}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div
            className="space-y-2 mb-3"
            data-testid="customer-internal-notes-list"
          >
            {internalNotes.length === 0 ? (
              <p className="text-sm text-gray-400 italic">
                {t("customerDetail.internalNotesEmpty") ||
                  "Noch keine internen Notizen."}
              </p>
            ) : (
              internalNotes.map((n) => (
                <div
                  key={n.id}
                  className="flex items-start gap-2 border border-gray-200 dark:border-gray-700 rounded p-2 bg-amber-50/40 dark:bg-amber-900/10"
                  data-testid={`customer-internal-note-${n.id}`}
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
                    disabled={deletingInternalNoteId === n.id}
                    className="text-xs text-red-600 dark:text-red-400 hover:underline disabled:opacity-50 shrink-0"
                    data-testid={`customer-internal-note-delete-${n.id}`}
                    title={t("common.delete") || "Löschen"}
                  >
                    {deletingInternalNoteId === n.id ? "…" : "🗑"}
                  </button>
                </div>
              ))
            )}
          </div>
          <div className="flex gap-2">
            <textarea
              value={newInternalNote}
              onChange={(e) => setNewInternalNote(e.target.value)}
              placeholder={
                t("customerDetail.internalNotesPlaceholder") ||
                "z.B. 'Kunde hat am 12.07. angerufen, wartet auf 2. Mahnung'"
              }
              maxLength={2000}
              className="flex-1 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded text-sm bg-white dark:bg-gray-800 min-h-[60px]"
              data-testid="customer-internal-note-input"
            />
            <Button
              onClick={addInternalNote}
              disabled={addingInternalNote || !newInternalNote.trim()}
              data-testid="customer-internal-note-add"
              variant="outline"
            >
              {addingInternalNote
                ? "…"
                : `+ ${t("customerDetail.internalNotesAdd") || "Notiz"}`}
            </Button>
          </div>
          {internalNoteError && (
            <p
              className="text-xs text-red-600 mt-1"
              data-testid="customer-internal-note-error"
            >
              {internalNoteError}
            </p>
          )}
        </CardContent>
      </Card>

      {/* Tier 132: portal-link modal. Shows the
          generated URL + Copy button + the recipient
          email + the expiry. The Copy button flips
          to "Kopiert!" for 3 seconds after success
          (using portalLinkCopied state). */}
      {portalLink && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50"
          onClick={() => setPortalLink(null)}
          data-testid="customer-portal-modal-backdrop"
        >
          <div
            className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-md w-full p-6"
            onClick={(e) => e.stopPropagation()}
            data-testid="customer-portal-modal"
          >
            <h3 className="text-lg font-bold text-gray-900 dark:text-gray-100 mb-2">
              🔗 {t("customer.portalLinkModalTitle") || "Portal-Login-Link"}
            </h3>
            <p className="text-sm text-gray-600 dark:text-gray-400 mb-3">
              {t("customer.portalLinkModalDesc") ||
                "Der Link wurde per E-Mail an den Kunden gesendet (NO-SMTP in Dev: nur Log). Du kannst ihn hier auch manuell kopieren:"}
            </p>
            <div className="bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded p-2 text-xs font-mono break-all mb-3">
              {portalLink.url}
            </div>
            <div className="text-xs text-gray-500 dark:text-gray-400 mb-4 space-y-0.5">
              <p>
                <strong>Empfänger:</strong> {portalLink.email}
              </p>
              <p>
                <strong>{t("customer.portalLinkExpires") || "Gültig bis"}:</strong>{" "}
                {new Date(portalLink.expiresAt).toLocaleDateString("de-DE")}
              </p>
            </div>
            <div className="flex gap-2 justify-end flex-wrap">
              <Button
                variant="outline"
                onClick={() => setPortalLink(null)}
                data-testid="customer-portal-modal-close"
              >
                {t("common.close") || "Schließen"}
              </Button>
              <Button
                onClick={copyPortalLink}
                data-testid="customer-portal-modal-copy"
              >
                {portalLinkCopied
                  ? `✓ ${t("customer.portalLinkCopied") || "Kopiert!"}`
                  : `📋 ${t("customer.portalLinkCopy") || "Link kopieren"}`}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
