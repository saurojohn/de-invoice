"use client"

import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { SkeletonTable } from "@/components/ui/skeleton"
import { EmptyState } from "@/components/ui/empty-state"
import { ErrorBanner } from "@/components/ui/error-banner"
import { ExportCSVButton } from "@/components/ExportCSVButton"
import { VatCheckPanel } from "@/components/VatCheckPanel"
import LanguageSwitcher from "@/components/LanguageSwitcher"
import { useI18n } from "@/components/useI18n"
import { apiGet, apiPost, apiPut, apiDelete, ApiError } from "@/lib/api"

interface Customer {
  id: string
  name: string
  vatId?: string | null
  taxExempt?: boolean
  type: string
  address: { street?: string; city?: string; postalCode?: string; country?: string }
  contact?: { email?: string; phone?: string }
  paymentTerms: number
  // "active" = usable, anything else = deactivated by admin.
  // Match against the literal value, not truthiness, so an
  // accidentally-set "inactive" / "suspended" string renders
  // the same way as `status === 'inactive'`.
  status: 'active' | 'inactive' | string
  createdAt: string
  // Backend-assigned per-company sequential customer number (K-00001...).
  // Auto-generated on create if not supplied by the importer.
  customerNumber?: string | null
  // Backend-augmented fields: the most recent issueDate from any
  // invoice for this customer, plus the total invoice count.
  lastInvoiceDate?: string | null
  invoiceCount?: number
  // Tier 148: free-form tags array. The Berater
  // uses this for categorisation — "VIP",
  // "Late-payer", "Industry:Retail", etc.
  // Filtered via `?tags=VIP,B2B` (AND semantics)
  // on the backend.
  tags?: string[]
}

export default function CustomersPage() {
  const router = useRouter()
  const { t, getDateLocale } = useI18n()
  // Read once on mount. The parent (auth wrapper) has
  // already redirected to /login if there's no company
  // here, so we treat the empty string as a no-op.
  const [companyId, setCompanyId] = useState<string>("")
  useEffect(() => {
    const cid = localStorage.getItem("companyId") || ""
    if (cid) setCompanyId(cid)
  }, [])
  const [customers, setCustomers] = useState<Customer[]>([])
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [editingCustomer, setEditingCustomer] = useState<Customer | null>(null)
  const [search, setSearch] = useState('')
  // Tier 148: tag filter. Array of picked tags
  // (AND semantics). Picked tags appear as
  // removable chips above the table.
  const [tagFilter, setTagFilter] = useState<string[]>([])
  const [page, setPage] = useState(1)
  // Tier 28: search snippets for highlighting.
  // Keyed by customer.id → snippet string with
  // <mark>...</mark> around the matched terms.
  // Populated by a separate /search/customers call
  // (the search.service.ts endpoint uses Postgres
  // tsvector + ts_headline). We re-fetch on the
  // same debounce as the regular list so the two
  // are always in sync.
  const [searchSnippets, setSearchSnippets] = useState<Record<string, string>>({})

  // Tier 20.2: batch Kontoauszug export state
  const [showBatchModal, setShowBatchModal] = useState(false)
  // Tier 134: VIES batch check modal state.
  // One state machine: 'idle' (button visible) → 'running' (spinner)
  // → 'done' (summary + per-customer list).
  const [viesBatch, setViesBatch] = useState<{
    state: 'idle' | 'running' | 'done' | 'error'
    result?: {
      total: number
      valid: number
      invalid: number
      unreachable: number
      skipped: number
      durationMs: number
      results: Array<{
        entityId: string
        entityName: string
        vatId: string
        status: 'valid' | 'invalid' | 'unreachable' | 'pending'
        cached: boolean
        errorMessage: string | null
        durationMs: number
      }>
    }
    error?: string
  }>({ state: 'idle' })
  const [showViesBatchModal, setShowViesBatchModal] = useState(false)
  const [batchFrom, setBatchFrom] = useState(() => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
  })
  const [batchTo, setBatchTo] = useState(() => {
    const d = new Date()
    const last = new Date(d.getFullYear(), d.getMonth(), 0)  // last day of prev month
    return `${last.getFullYear()}-${String(last.getMonth() + 1).padStart(2, '0')}-${String(last.getDate()).padStart(2, '0')}`
  })
  const [batchOrder, setBatchOrder] = useState<"desc" | "asc">("desc")
  const [batchLoading, setBatchLoading] = useState(false)
  const [batchError, setBatchError] = useState<string | null>(null)
  const [pageSize] = useState(50)
  const [total, setTotal] = useState(0)
  const [totalPages, setTotalPages] = useState(1)

  // Fetch (with search + pagination)
  useEffect(() => {
    const companyId = localStorage.getItem("companyId")
    if (!companyId) {
      router.push("/login")
      return
    }
    const params = new URLSearchParams({
      companyId,
      page: String(page),
      pageSize: String(pageSize),
    })
    if (search.trim()) params.append('search', search.trim())
    // Tier 148: comma-separated tag filter.
    // AND semantics — every picked tag must
    // be present on the customer.
    if (tagFilter.length > 0) params.append('tags', tagFilter.join(','))
    setLoading(true)
    apiGet<any>(`/api/v1/customers?${params}`)
      .then((data) => {
        setCustomers(Array.isArray(data) ? data : (data.data || []))
        setTotal(data.total || 0)
        setTotalPages(data.totalPages || 1)
      })
      .catch((err) => {
        console.error('Customers list fetch failed:', err)
        setCustomers([])
        setTotal(0)
        setTotalPages(1)
      })
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router, page, search, tagFilter])

  // Debounce search input so we don't fire a request on every keystroke
  const [searchInput, setSearchInput] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput), 300)
    return () => clearTimeout(t)
  }, [searchInput])
  // Reset to first page when search changes
  useEffect(() => {
    if (page !== 1) setPage(1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search])
  // Tier 28: when the user types a search query,
  // fetch the highlight snippets from the new
  // /api/v1/search/customers endpoint. The snippets
  // are merged into the customers table cells
  // below (we render the snippet HTML instead of
  // the raw name when a snippet is available for
  // that row). When the search box clears, we
  // empty the snippet map so the cells fall back
  // to the raw name.
  useEffect(() => {
    const q = search.trim()
    if (!q || !companyId) {
      setSearchSnippets({})
      return
    }
    let cancelled = false
    const t = setTimeout(() => {
      apiGet<Array<{ row: { id: string }; snippet: string }>>(
        `/api/v1/search/customers?companyId=${companyId}&q=${encodeURIComponent(q)}`,
      )
        .then((hits) => {
          if (cancelled) return
          const map: Record<string, string> = {}
          for (const h of hits) {
            if (h.snippet) map[h.row.id] = h.snippet
          }
          setSearchSnippets(map)
        })
        .catch(() => {
          // Snippet fetch is best-effort — if the
          // search endpoint is down, the list
          // still renders (just without highlights).
          if (!cancelled) setSearchSnippets({})
        })
    }, 300)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [search, companyId])
  const [nextCustomerNumber, setNextCustomerNumber] = useState<string | null>(null)
  const [form, setForm] = useState({
    name: "",
    vatId: "",
    type: "business",
    street: "",
    city: "",
    postalCode: "",
    country: "DE",
    email: "",
    phone: "",
    // New customers default to "Sofort fällig" (paymentTerms = 0).
    // Most B2B customers that go through manual approval / Net-30
    // terms can be changed at create-time; defaulting to 0 avoids
    // silently creating a customer with a 30-day window the user
    // didn't ask for.
    paymentTerms: 0,
    taxExempt: false,
  })

  // Import state
  const [showImport, setShowImport] = useState(false)
  const [importFile, setImportFile] = useState<File | null>(null)
  const [importResult, setImportResult] = useState<{
    total: number; imported: number; skipped: number
    errors: Array<{ row: number; error: string; name?: string }>
  } | null>(null)
  const [importing, setImporting] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Force German dd.mm.yyyy with leading zeros. Same as in the
  // invoices page — toLocaleDateString returns "5.6.2026" on some
  // ICU versions which is inconsistent in tabular lists.
  const formatDateDE = (s?: string | null) => {
    if (!s) return ""
    const d = new Date(s)
    if (isNaN(d.getTime())) return s
    const dd = String(d.getDate()).padStart(2, "0")
    const mm = String(d.getMonth() + 1).padStart(2, "0")
    const yyyy = d.getFullYear()
    return `${dd}.${mm}.${yyyy}`
  }

  const openModal = (customer?: Customer) => {
    if (customer) {
      setEditingCustomer(customer)
      setNextCustomerNumber(null)  // editing doesn't need the preview
      setForm({
        name: customer.name,
        vatId: customer.vatId || "",
        type: customer.type,
        street: customer.address?.street || "",
        city: customer.address?.city || "",
        postalCode: customer.address?.postalCode || "",
        country: customer.address?.country || "DE",
        email: customer.contact?.email || "",
        phone: customer.contact?.phone || "",
        paymentTerms: customer.paymentTerms,
        taxExempt: !!customer.taxExempt,
      })
    } else {
      setEditingCustomer(null)
      setForm({
        name: "",
        vatId: "",
        type: "business",
        street: "",
        city: "",
        postalCode: "",
        country: "DE",
        email: "",
        phone: "",
        // Reset path also defaults to 0 (Sofort fällig) so reopening
        // the "+ Neuer Kunde" modal after cancelling gives the same
        // fresh state as the first open.
        paymentTerms: 0,
        taxExempt: false,
      })
      // Fetch the next K-NNNNN from the server so the user can
      // see what the auto-generated number will be. Best-effort:
      // if it fails (offline / 500), the modal still works — the
      // server will assign the number on save.
      const companyId = localStorage.getItem("companyId")
      if (companyId) {
        apiGet<{ nextNumber: string; totalCustomers: number }>(
          `/customers/next-number?companyId=${encodeURIComponent(companyId)}`
        )
          .then((data) => {
            if (data?.nextNumber) setNextCustomerNumber(data.nextNumber)
          })
          .catch(() => { /* non-fatal */ })
      }
    }
    setShowModal(true)
  }

  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const companyId = localStorage.getItem("companyId")!
    setSaving(true)
    setSaveError(null)
    setSaveSuccess(null)
    const data = {
      name: form.name,
      type: form.type,
      vatId: form.vatId || null,
      taxExempt: form.taxExempt,
      address: {
        street: form.street,
        city: form.city,
        postalCode: form.postalCode,
        country: form.country,
      },
      contact: {
        email: form.email,
        phone: form.phone,
      },
      paymentTerms: form.paymentTerms,
    }

    try {
      if (editingCustomer) {
        await apiPut(`/api/v1/customers/${editingCustomer.id}?companyId=${companyId}`, data)
      } else {
        await apiPost(`/api/v1/customers?companyId=${companyId}`, data)
      }
    } catch (err) {
      // ApiError has the actual server message; other errors are network problems.
      if (err instanceof ApiError) {
        setSaveError(err.message)
      } else {
        setSaveError(`Netzwerkfehler: ${err}`)
      }
      setSaving(false)
      return
    }

    // After successful create/update, reset to page 1 with no search
    // filter so the new/edited customer is guaranteed to be visible.
    setPage(1)
    setSearch("")
    setSearchInput("")

    // Reload the list. We use page=1 (without search) to ensure the
    // freshly-created customer is on the first page.
    const params = new URLSearchParams({
      companyId,
      page: "1",
      pageSize: String(pageSize),
    })
    try {
      const data2 = await apiGet<any>(`/api/v1/customers?${params}`)
      setCustomers(Array.isArray(data2) ? data2 : (data2.data || []))
      setTotal(data2.total || 0)
      setTotalPages(data2.totalPages || 1)
    } catch (err) {
      console.error('Post-save refetch failed:', err)
    }
    setShowModal(false)
    setSaveSuccess(editingCustomer ? "Änderungen gespeichert" : "Kunde angelegt")
    // Auto-dismiss the success message after 3s
    setTimeout(() => setSaveSuccess(null), 3000)
    setSaving(false)
  }

  const handleDelete = async (customer: Customer) => {
    if (!confirm(`${t("common.delete")} — ${customer.name}?`)) return
    try {
      const companyId = localStorage.getItem("companyId")
      await apiDelete(`/api/v1/customers/${customer.id}?companyId=${companyId}`)
      setCustomers((prev) => prev.filter((c) => c.id !== customer.id))
    } catch (err) {
      if (err instanceof ApiError) {
        alert(err.message)
      } else {
        alert(`Netzwerkfehler: ${err}`)
      }
    }

  }
  // Tier 20.2: batch Kontoauszug download — generates one PDF
  // per active customer for the chosen date range, packaged
  // as a ZIP. Includes index.csv + summary.txt.
  const downloadBatch = async () => {
    const companyId = localStorage.getItem("companyId")
    if (!companyId) return
    setBatchLoading(true)
    setBatchError(null)
    try {
      const { apiFetch } = await import("@/lib/api")
      const response = await apiFetch(
        `/api/v1/customers/statements-batch?companyId=${companyId}&from=${batchFrom}&to=${batchTo}&order=${batchOrder}`,
        { throwOnError: false },
      )
      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        setBatchError(data.message || `Download fehlgeschlagen (HTTP ${response.status})`)
        return
      }
      const blob = await response.blob()
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      const fromCompact = batchFrom.replace(/-/g, "")
      const toCompact = batchTo.replace(/-/g, "")
      a.download = `Kontoauszug_Batch_${fromCompact}_${toCompact}.zip`
      document.body.appendChild(a)
      a.click()
      window.URL.revokeObjectURL(url)
      document.body.removeChild(a)
      setShowBatchModal(false)
    } catch (err: any) {
      setBatchError(`Netzwerkfehler: ${err?.message || err}`)
    } finally {
      setBatchLoading(false)
    }
  }

  /**
   * Parse a CSV file into rows of customer objects.
   * The header row determines column mapping. Headers we accept (case-insensitive,
   * German + English + a few common synonyms):
   *   name | firma | company
   *   vatId | ust | ustid | ust-id | vat
   *   type | typ
   *   street | strasse | adresse
   *   postalCode | plz | postleitzahl
   *   city | stadt | ort
   *   country | land
   *   email | e-mail | mail
   *   phone | telefon | tel
   *   paymentTerms | zahlungsfrist
   *   taxExempt | steuerbefreit
   */
  const parseCsv = (text: string): Array<Record<string, string>> => {
    // Strip BOM and normalise line endings
    const clean = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n")
    const lines = clean.split("\n").filter((l) => l.trim().length > 0)
    if (lines.length < 2) return []

    // CSV split that respects quoted fields with embedded commas/quotes.
    const splitCsvLine = (line: string): string[] => {
      const cells: string[] = []
      let cur = ""
      let inQuotes = false
      for (let i = 0; i < line.length; i++) {
        const c = line[i]
        if (c === '"') {
          if (inQuotes && line[i + 1] === '"') {
            cur += '"'
            i++
          } else {
            inQuotes = !inQuotes
          }
        } else if (c === "," && !inQuotes) {
          cells.push(cur)
          cur = ""
        } else {
          cur += c
        }
      }
      cells.push(cur)
      return cells.map((c) => c.trim())
    }

    const header = splitCsvLine(lines[0]).map((h) => h.toLowerCase())
    const col: Record<string, number> = {}
    header.forEach((h, i) => { col[h] = i })

    // Build a synonym map
    const pick = (...keys: string[]) => {
      for (const k of keys) {
        if (col[k] !== undefined) return col[k]
      }
      return -1
    }
    const nameIdx = pick("name", "firma", "company", "kunde")
    const vatIdx = pick("vatid", "ust-idnr", "ustid", "ust", "ust-id", "vat")
    const typeIdx = pick("type", "typ", "kind")
    const streetIdx = pick("street", "strasse", "adresse", "anschrift")
    const plzIdx = pick("postalcode", "plz", "postleitzahl")
    const cityIdx = pick("city", "stadt", "ort")
    const countryIdx = pick("country", "land")
    const emailIdx = pick("email", "e-mail", "mail")
    const phoneIdx = pick("phone", "telefon", "tel", "phone")
    const ptIdx = pick("paymentterms", "zahlungsfrist", "zahlungsziel")
    const teIdx = pick("taxexempt", "steuerbefreit")

    const rows: Array<Record<string, string>> = []
    for (let i = 1; i < lines.length; i++) {
      const cells = splitCsvLine(lines[i])
      if (cells.every((c) => c === "")) continue
      const row: Record<string, string> = {}
      if (nameIdx >= 0) row.name = cells[nameIdx] || ""
      if (vatIdx >= 0) row.vatId = cells[vatIdx] || ""
      if (typeIdx >= 0) row.type = cells[typeIdx] || ""
      if (streetIdx >= 0) row.street = cells[streetIdx] || ""
      if (plzIdx >= 0) row.postalCode = cells[plzIdx] || ""
      if (cityIdx >= 0) row.city = cells[cityIdx] || ""
      if (countryIdx >= 0) row.country = cells[countryIdx] || ""
      if (emailIdx >= 0) row.email = cells[emailIdx] || ""
      if (phoneIdx >= 0) row.phone = cells[phoneIdx] || ""
      if (ptIdx >= 0) row.paymentTerms = cells[ptIdx] || ""
      if (teIdx >= 0) row.taxExempt = cells[teIdx] || ""
      rows.push(row)
    }
    return rows
  }

  // Tier 134: run VIES batch check for all customers
  // with a VAT ID. Slow (1-2s per customer + 1-min
  // backend throttle) so the modal shows a spinner
  // while in flight. The user can navigate away — the
  // request keeps running server-side.
  const startViesBatch = async () => {
    if (!companyId) return
    setViesBatch({ state: 'running' })
    try {
      const data = await apiPost<{
        total: number
        valid: number
        invalid: number
        unreachable: number
        skipped: number
        durationMs: number
        results: Array<{
          entityId: string
          entityName: string
          vatId: string
          status: 'valid' | 'invalid' | 'unreachable' | 'pending'
          cached: boolean
          errorMessage: string | null
          durationMs: number
        }>
      }>('/api/v1/vat-validation/batch-check', {
        companyId,
        entityType: 'customer',
        limit: 100,
      })
      setViesBatch({ state: 'done', result: data })
    } catch (err) {
      setViesBatch({
        state: 'error',
        error: err instanceof ApiError ? err.message : String(err),
      })
    }
  }

  const closeViesBatch = () => {
    setShowViesBatchModal(false)
    // Reset to idle when re-opening
    setTimeout(() => setViesBatch({ state: 'idle' }), 200)
  }

  const handleImport = async () => {
    if (!importFile) return
    setImporting(true)
    setImportResult(null)
    try {
      const text = await importFile.text()
      const rows = parseCsv(text)
      if (rows.length === 0) {
        alert("CSV enthält keine Datenzeilen (oder Spaltenüberschriften fehlen).")
        setImporting(false)
        return
      }
      const companyId = localStorage.getItem("companyId")
      const data = await apiPost<any>(`/api/v1/customers/import?companyId=${companyId}`, { rows })
      setImportResult(data)
      // Reload list
      const params = new URLSearchParams({ companyId: companyId!, page: "1", pageSize: String(pageSize) })
      const d2 = await apiGet<any>(`/api/v1/customers?${params}`)
      setCustomers(Array.isArray(d2) ? d2 : (d2.data || []))
      setTotal(d2.total || 0)
      setTotalPages(d2.totalPages || 1)
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : `Import-Fehler: ${err}`
      alert(msg)
    } finally {
      setImporting(false)
    }
  }

  const downloadSampleCsv = () => {
    // UTF-8 BOM for Excel compatibility
    const sample = "\uFEFF" + [
      "name,vatId,type,street,postalCode,city,country,email,phone,paymentTerms,taxExempt",
      "Beispiel GmbH,DE123456789,business,Hauptstr. 1,10115,Berlin,DE,info@beispiel.de,+49 30 123456,30,false",
      "Muster AG,DE987654321,business,Musterweg 5,80331,München,DE,kontakt@muster.de,,14,false",
      "Privatperson,,individual,,,,,DE,max@privat.de,,30,false",
    ].join("\n")
    const blob = new Blob([sample], { type: "text/csv;charset=utf-8;" })
    const url = window.URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = "kunden-import-vorlage.csv"
    document.body.appendChild(a)
    a.click()
    window.URL.revokeObjectURL(url)
    document.body.removeChild(a)
  }

  const getTypeLabel = (type: string) => {
    return type === "business" ? t("customer.typeBusiness") : t("customer.typePrivate")
  }

  return (
    <main className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <header className="bg-white dark:bg-gray-800 border-b shadow-sm">
        {/* Tier 121: responsive header — same pattern
            as /dashboard/invoices. flex-wrap so the
            buttons drop to a second row on a 375px
            phone instead of clipping. */}
        <div className="container mx-auto px-3 sm:px-4 py-3 sm:py-4 flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-xl sm:text-2xl font-bold text-blue-600 dark:text-blue-400">{t("customer.title")}</h1>
          {/* Tier 134: added min-w-0 so the button
              row can actually wrap on 375px viewports.
              Without it, the intrinsic width of the
              buttons (8 items) forces the parent to
              grow past 375px, overflowing the page. */}
          <div className="flex flex-wrap gap-2 items-center min-w-0">
            <LanguageSwitcher />
            <Button size="sm" variant="outline" onClick={() => setShowImport(true)}>
              📥 Import
            </Button>
            <ExportCSVButton
              data={customers}
              filename="kunden"
              label={`${t("common2.exportCsv") || "CSV"}`}
              columns={[
                { header: "Name", accessor: (c) => c.name },
                { header: "Typ", accessor: (c) => c.type },
                { header: "USt-IDNr.", accessor: (c) => c.vatId || "" },
                { header: "Steuerbefreit", accessor: (c) => (c.taxExempt ? "Ja" : "Nein") },
                { header: "Straße", accessor: (c) => c.address?.street || "" },
                { header: "PLZ", accessor: (c) => c.address?.postalCode || "" },
                { header: "Stadt", accessor: (c) => c.address?.city || "" },
                { header: "Land", accessor: (c) => c.address?.country || "" },
                { header: "E-Mail", accessor: (c) => c.contact?.email || "" },
                { header: "Telefon", accessor: (c) => c.contact?.phone || "" },
                { header: "Zahlungsfrist (Tage)", accessor: (c) => c.paymentTerms },
              ]}
            />
            <Button variant="outline" onClick={() => router.push("/dashboard")}>{t("common.back")}</Button>
            {/* Tier 134: VIES batch check. Same UX as
                the per-customer "Jetzt prüfen" button
                on the detail page, but for every
                customer with a VAT ID at once. Slow
                (1-2s per customer) so the modal shows
                progress + summary at the end. */}
            <Button
              variant="outline"
              onClick={() => setShowViesBatchModal(true)}
              data-testid="customer-vies-batch-button"
            >
              🔍 {t("customer.vatBatchCheck") || "Alle USt-IDs prüfen"}
            </Button>
            <Button
              variant="outline"
              onClick={() => setShowBatchModal(true)}
              data-testid="customer-batch-export-button"
            >
              📦 {t("customer.batchExport")}
            </Button>
            <Button variant="outline" onClick={() => router.push("/dashboard/import?entity=customer")}>📥 Import</Button>
            <Button onClick={() => openModal()}>{t("customer.create")}</Button>
          </div>
        </div>
      </header>

      <div className="container mx-auto px-3 sm:px-4 py-4 sm:py-8">
        {/* Search input lives OUTSIDE the !loading gate below — the
            input must stay mounted (and keep focus / cursor position)
            while a fetch is in flight, otherwise the user can't
            keep typing once a search has been triggered. */}
        <div className="mb-4">
          <input
            type="text"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            data-testid="customer-search-input"
            placeholder={t("customer.searchPlaceholder") || "Name, USt-ID, Kundennummer, Stadt, PLZ suchen..."}
            className="w-full md:w-1/2 px-3 py-2 border border-gray dark:border-gray-700-300 dark:border-gray-600 rounded-md text-sm"
          />
          {/* Tier 148: tag filter chips. We surface
              the most common tags from the current
              dataset so the user can see "VIP" or
              "Late-payer" at a glance and pick one
              with a single click. Picked tags appear
              in the active-filter row below. */}
          {(() => {
            const allTags = new Map<string, number>()
            for (const c of customers) {
              for (const tag of c.tags || []) {
                allTags.set(tag, (allTags.get(tag) || 0) + 1)
              }
            }
            const sortedTags = Array.from(allTags.entries()).sort(
              (a, b) => b[1] - a[1],
            )
            if (sortedTags.length === 0) return null
            return (
              <div
                className="flex flex-wrap gap-1.5 mt-2"
                data-testid="customer-tag-suggestions"
              >
                {sortedTags.map(([tag, count]) => {
                  const active = tagFilter.includes(tag)
                  return (
                    <button
                      key={tag}
                      onClick={() => {
                        if (active) {
                          setTagFilter(tagFilter.filter((t) => t !== tag))
                        } else {
                          setTagFilter([...tagFilter, tag])
                        }
                        setPage(1)
                      }}
                      className={
                        "text-xs px-2 py-1 rounded-full border " +
                        (active
                          ? "bg-blue-600 text-white border-blue-600"
                          : "bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:bg-gray-50")
                      }
                      data-testid={`customer-tag-chip-${tag}`}
                    >
                      {tag}{" "}
                      <span
                        className={
                          active ? "text-blue-100" : "text-gray-400"
                        }
                      >
                        ({count})
                      </span>
                    </button>
                  )
                })}
              </div>
            )
          })()}
          {tagFilter.length > 0 && (
            <div
              className="flex items-center gap-2 mt-2"
              data-testid="customer-tag-filter"
            >
              <span className="text-xs text-gray-500">
                {t("customer.filterByTags") || "Filter:"}
              </span>
              {tagFilter.map((tag) => (
                <button
                  key={tag}
                  onClick={() => {
                    setTagFilter(tagFilter.filter((t) => t !== tag))
                    setPage(1)
                  }}
                  className="text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-800 hover:bg-blue-200"
                  data-testid={`customer-tag-active-${tag}`}
                >
                  {tag} ✕
                </button>
              ))}
              <button
                onClick={() => {
                  setTagFilter([])
                  setPage(1)
                }}
                className="text-xs text-gray-500 hover:text-gray-700 underline"
                data-testid="customer-tag-clear"
              >
                {t("customer.tagFilterClear") || "Alle entfernen"}
              </button>
            </div>
          )}
          {search && (
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              {customers.length} Treffer
            </p>
          )}
        </div>
        {loading ? (
          <div className="p-4">
            <SkeletonTable rows={8} cols={5} />
          </div>
        ) : !search && customers.length === 0 ? (
          // Empty state — no customers AND no search active
          <Card>
            <CardContent>
              <EmptyState
                variant="inbox"
                title={t("customer.noCustomers")}
                description={t("customer.noCustomersDesc") || "Fügen Sie Ihren ersten Kunden hinzu, um Rechnungen zu erstellen."}
                fullWidth
              />
              <div className="flex gap-2 justify-center pb-8">
                <Button onClick={() => openModal()}>{t("customer.addFirst")}</Button>
                <Button variant="outline" onClick={() => setShowImport(true)}>
                  📥 Import CSV
                </Button>
              </div>
            </CardContent>
          </Card>
        ) : customers.length === 0 ? (
          // Empty state — search yielded no results
          <Card>
            <CardContent>
              <EmptyState
                variant="search"
                title={t("customer.noMatching") || "Keine Treffer"}
                description={t("customer.noMatchingDesc") || "Versuchen Sie einen anderen Suchbegriff oder passen Sie die Filter an."}
                fullWidth
              />
              <div className="flex justify-center pb-8">
                <Button variant="outline" onClick={() => setSearchInput('')}>
                  {t("common2.clearFilters") || "Suche zurücksetzen"}
                </Button>
              </div>
            </CardContent>
          </Card>
        ) : (
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {customers.map((customer) => (
              <Card
                key={customer.id}
                className="hover:shadow-lg transition cursor-pointer relative min-w-0 overflow-hidden"
                // Tier 61: card click navigates to the new
                // detail page instead of opening the edit
                // modal. The edit modal is still reachable
                // from the detail page's "Bearbeiten" button
                // (and from a small "Edit" link in the
                // card's top-right menu).
                onClick={() => router.push(`/dashboard/customers/${customer.id}`)}
                data-testid="customer-card"
                data-customer-id={customer.id}
              >
                {/* Action buttons — stopPropagation so they don't
                    open the edit modal when clicked.
                    Tier 134: flex-wrap so the 4 emoji buttons
                    (✏️ 💰 📊 🗑) wrap to a 2nd row on 375px
                    instead of overflowing the card. The "relative"
                    wrapper keeps them positioned at the top-right
                    when the card is wide enough to fit them in
                    one row. */}
                <div className="absolute top-2 right-2 flex flex-wrap gap-1 justify-end max-w-[60%]">
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      openModal(customer)
                    }}
                    className="text-gray-400 hover:text-blue-600 dark:text-blue-400 text-xs px-2 py-1 rounded hover:bg-blue-50"
                    title={t("common.edit") || "Bearbeiten"}
                    data-testid="customer-edit-button"
                  >
                    ✏️
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      router.push(`/dashboard/customers/${customer.id}/credit`)
                    }}
                    className="text-gray-400 hover:text-blue-600 dark:text-blue-400 text-xs px-2 py-1 rounded hover:bg-blue-50"
                    title={t("credit.title") || "Kundenguthaben"}
                    data-testid="customer-credit-button"
                  >
                    💰
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      router.push(`/dashboard/customers/${customer.id}/statement`)
                    }}
                    className="text-gray-400 hover:text-blue-600 dark:text-blue-400 text-xs px-2 py-1 rounded hover:bg-blue-50"
                    title={t("statement.title")}
                    data-testid="customer-statement-button"
                  >
                    📊
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      handleDelete(customer)
                    }}
                    className="text-gray-400 hover:text-red-600 dark:text-red-400 text-xs px-2 py-1 rounded hover:bg-red-50"
                    title={t("common.delete") || "Löschen"}
                  >
                    🗑
                  </button>
                </div>
                <CardHeader>
                  <CardTitle className="flex justify-between items-center pr-6 gap-2">
                    <div className="min-w-0">
                      <div className="truncate">
                        {/* Tier 28: render the highlighted
                            snippet from the tsvector search
                            when this row has a match.
                            dangerouslySetInnerHTML is safe
                            here because the snippet comes
                            from our own backend (only wraps
                            <mark> around matched terms —
                            the regex in markTermsInText
                            strips every other character
                            from the lexeme before
                            wrapping). */}
                        {searchSnippets[customer.id] ? (
                          <span
                            dangerouslySetInnerHTML={{
                              __html: searchSnippets[customer.id],
                            }}
                            data-testid="customer-search-snippet"
                          />
                        ) : (
                          customer.name
                        )}
                      </div>
                      {customer.customerNumber && (
                        <div className="text-xs text-gray-500 dark:text-gray-400 font-normal mt-0.5">
                          {t("customer.customerNumber") || "Kundennummer"}: <span className="font-mono font-medium text-gray-700 dark:text-gray-200">{customer.customerNumber}</span>
                        </div>
                      )}
                    </div>
                    <div className="flex gap-1 shrink-0">
                      <span
                        className={`text-[10px] px-2 py-1 rounded font-medium ${
                          customer.status === "active"
                            ? "bg-emerald-100 text-emerald-700"
                            : "bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400"
                        }`}
                        title={t("customer.inactiveHint") || (customer.status === "active" ? "" : "Inaktiv")}
                      >
                        {customer.status === "active"
                          ? (t("customer.statusActive") || "Aktiv")
                          : (t("customer.statusInactive") || "Inaktiv")}
                      </span>
                      <span className="text-xs px-2 py-1 bg-gray-100 dark:bg-gray-800 rounded">{getTypeLabel(customer.type)}</span>
                    </div>
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2 text-sm">
                    {customer.vatId && <div className="text-gray-600 dark:text-gray-300">{t("customer.vatId")}: {customer.vatId}</div>}
                    {customer.taxExempt && (
                      <div className="text-xs text-orange-700 dark:text-orange-300">⚠ {t("customer.taxExempt")}</div>
                    )}
                    <div className="text-gray-600 dark:text-gray-300">
                      {customer.address?.street}, {customer.address?.postalCode} {customer.address?.city}
                    </div>
                    {customer.contact?.email && (
                      // Tier 134: break-all so long emails
                      // (e.g. tier133-customer@example.com)
                      // don't force the card to grow past
                      // the 375px viewport. Without this,
                      // grid items default to min-w-auto
                      // and the card was 411px wide.
                      <div className="text-gray-600 dark:text-gray-300 break-all">{customer.contact.email}</div>
                    )}
                    <div className="text-gray-500 dark:text-gray-400 text-xs">
                      {t("customer.paymentTerms")}: {customer.paymentTerms} {t("reminder.days")}
                    </div>
                    {/* Last invoice + total count — surfaces inactive customers
                        at a glance and helps spot customers that haven't
                        been invoiced in a long time. */}
                    <div className="pt-2 mt-2 border-t border-gray dark:border-gray-700-100 text-xs flex items-center justify-between">
                      <span className="text-gray-500 dark:text-gray-400">
                        {t("customer.lastInvoice") || "Letzte Rechnung"}:{" "}
                        {customer.lastInvoiceDate ? (
                          <span className="text-gray-900 dark:text-gray-100 font-medium">
                            {formatDateDE(customer.lastInvoiceDate)}
                          </span>
                        ) : (
                          <span className="text-orange-600">—</span>
                        )}
                      </span>
                      <span
                        className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${
                          (customer.invoiceCount || 0) > 0
                            ? "bg-emerald-100 text-emerald-700"
                            : "bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400"
                        }`}
                        title={`${customer.invoiceCount || 0} ${t("customer.invoiceCountHint") || "Rechnungen insgesamt"}`}
                      >
                        {customer.invoiceCount || 0} {(customer.invoiceCount || 0) === 1 ? "Rechnung" : "Rechnungen"}
                      </span>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {/* Pagination — appears when there's more than one page */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between mt-4 text-sm">
            <span className="text-gray-600 dark:text-gray-300">
              Seite {page} / {totalPages} ({total} gesamt)
            </span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                ← Zurück
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              >
                Weiter →
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Modal */}
      {/* Import dialog */}
      {showImport && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <Card className="w-full max-w-xl max-h-[90vh] overflow-y-auto">
            <CardHeader>
              <CardTitle>📥 Kunden aus CSV importieren</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="text-sm text-gray-600 dark:text-gray-300">
                <p>Laden Sie eine CSV-Datei mit Kunden hoch. Vorhandene Kunden
                (gleiche E-Mail) werden übersprungen, nicht überschrieben.</p>
                <p className="mt-2">
                  Spalten: <code>name, vatId, type, street, postalCode, city, country, email, phone, paymentTerms, taxExempt</code>
                </p>
              </div>

              <button
                onClick={downloadSampleCsv}
                className="text-sm text-blue-600 dark:text-blue-400 hover:underline"
              >
                📄 Beispiel-Vorlage herunterladen
              </button>

              <div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv,text/csv"
                  onChange={(e) => {
                    setImportFile(e.target.files?.[0] || null)
                    setImportResult(null)
                  }}
                  className="block w-full text-sm text-gray-700 dark:text-gray-200 file:mr-3 file:py-2 file:px-4 file:rounded file:border-0 file:bg-blue-50 file:text-blue-700 dark:text-blue-300 hover:file:bg-blue-100"
                />
                {importFile && (
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                    Ausgewählt: {importFile.name} ({(importFile.size / 1024).toFixed(1)} KB)
                  </p>
                )}
              </div>

              {importResult && (
                <div
                  className={`p-3 rounded text-sm border ${
                    importResult.errors.length === 0
                      ? "bg-emerald-50 border-emerald-200 text-emerald-800"
                      : "bg-amber-50 border-amber-200 text-amber-800"
                  }`}
                >
                  <div className="font-medium">
                    ✓ {importResult.imported} importiert,{" "}
                    ⊘ {importResult.skipped} übersprungen (existieren bereits)
                  </div>
                  {importResult.errors.length > 0 && (
                    <div className="mt-2 text-xs">
                      <strong>Fehler ({importResult.errors.length}):</strong>
                      <ul className="list-disc list-inside mt-1 max-h-32 overflow-y-auto">
                        {importResult.errors.map((e, i) => (
                          <li key={i}>
                            Zeile {e.row}
                            {e.name ? ` (${e.name})` : ""}: {e.error}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}

              <div className="flex gap-2 pt-2">
                <Button
                  type="button"
                  variant="outline"
                  className="flex-1"
                  onClick={() => {
                    setShowImport(false)
                    setImportFile(null)
                    setImportResult(null)
                  }}
                >
                  {t("common.cancel")}
                </Button>
                <Button
                  type="button"
                  className="flex-1"
                  onClick={handleImport}
                  disabled={!importFile || importing}
                >
                  {importing ? "Wird importiert…" : "Import starten"}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {showModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <Card className="w-full max-w-lg max-h-[90vh] overflow-y-auto">
            <CardHeader>
              <CardTitle>{editingCustomer ? t("customer.edit") : t("customer.create")}</CardTitle>
              {!editingCustomer && nextCustomerNumber && (
                <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                  {t("customer.nextCustomerNumber") || "Nächste Kundennummer"}:{" "}
                  <span className="font-mono font-medium text-gray-700 dark:text-gray-200">{nextCustomerNumber}</span>
                </p>
              )}
              {editingCustomer && (
                <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                  {t("customer.customerNumber") || "Kundennummer"}:{" "}
                  <span className="font-mono font-medium text-gray-700 dark:text-gray-200">
                    {editingCustomer.customerNumber || "—"}
                  </span>
                </p>
              )}
            </CardHeader>
            <CardContent>
              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium mb-1">{t("customer.name")} *</label>
                  <Input
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    placeholder={t("settings.placeholderCompanyName")}
                    required
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium mb-1">{t("customer.vatId")}</label>
                    <Input
                      value={form.vatId}
                      onChange={(e) => setForm({ ...form, vatId: e.target.value })}
                      placeholder="DE123456789"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1">{t("customer.type")}</label>
                    <select
                      className="w-full h-10 border rounded-md px-3"
                      value={form.type}
                      onChange={(e) => setForm({ ...form, type: e.target.value })}
                    >
                      <option value="business">{t("customer.typeBusiness")}</option>
                      <option value="individual">{t("customer.typePrivate")}</option>
                    </select>
                  </div>
                </div>
                {/* VIES VAT-ID verification panel.
                    Only shown in EDIT mode because the
                    API needs the customer's id (verify
                    is per-row, not per-VAT-string). The
                    panel auto-reloads latest+history when
                    the user changes vatId in the form, so
                    it stays in sync with the field above. */}
                {editingCustomer && companyId && (
                  <VatCheckPanel
                    companyId={companyId}
                    entityType="customer"
                    entityId={editingCustomer.id}
                    vatId={form.vatId}
                    labels={{
                      title: t("customer.vatCheckTitle") || "USt-ID-Prüfung (VIES)",
                      check: t("customer.vatCheckNow") || "Jetzt prüfen",
                      checking: t("customer.vatChecking") || "Prüfe…",
                      noVat:
                        t("customer.vatCheckNoVat") ||
                        "Keine USt-ID hinterlegt. Tragen Sie oben eine USt-ID ein, um die VIES-Prüfung zu aktivieren.",
                      statusNone: t("customer.vatStatusNone") || "Noch nicht geprüft",
                      statusValid: t("customer.vatStatusValid") || "Gültig",
                      statusInvalid: t("customer.vatStatusInvalid") || "Ungültig",
                      statusUnreachable:
                        t("customer.vatStatusUnreachable") || "VIES nicht erreichbar",
                      statusPending: t("customer.vatStatusPending") || "Warte auf Ergebnis",
                      cached: t("customer.vatCached") || "aus Cache",
                      fresh: t("customer.vatFresh") || "frisch geprüft",
                      history: t("customer.vatHistory") || "Verlauf",
                      noHistory: t("customer.vatNoHistory") || "Keine Prüfungen bisher",
                      errorPrefix: t("customer.vatErrorPrefix") || "Fehler",
                      checkedAt: t("customer.vatCheckedAt") || "Geprüft am",
                      duration: t("customer.vatDuration") || "Dauer",
                    }}
                  />
                )}
                <div>
                  <label className="block text-sm font-medium mb-1">{t("customer.street")}</label>
                  <Input
                    value={form.street}
                    onChange={(e) => setForm({ ...form, street: e.target.value })}
                    placeholder="Musterstraße 123"
                  />
                </div>
                <div className="grid grid-cols-3 gap-4">
                  <div>
                    <label className="block text-sm font-medium mb-1">{t("customer.postalCode")}</label>
                    <Input
                      value={form.postalCode}
                      onChange={(e) => setForm({ ...form, postalCode: e.target.value })}
                      placeholder="12345"
                    />
                  </div>
                  <div className="col-span-2">
                    <label className="block text-sm font-medium mb-1">{t("customer.city")}</label>
                    <Input
                      value={form.city}
                      onChange={(e) => setForm({ ...form, city: e.target.value })}
                      placeholder={t("settings.placeholderCity")}
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">{t("customer.country")}</label>
                  <Input
                    value={form.country}
                    onChange={(e) => setForm({ ...form, country: e.target.value })}
                    placeholder={t("customer.countryPlaceholder")}
                  />
                </div>

                {/* taxExempt + paymentTerms side-by-side */}
                <div className="grid grid-cols-2 gap-4">
                  <label className="flex items-center gap-2 text-sm h-10">
                    <input
                      type="checkbox"
                      checked={form.taxExempt}
                      onChange={(e) => setForm({ ...form, taxExempt: e.target.checked })}
                      className="w-4 h-4"
                    />
                    {t("customer.taxExempt") || "Steuerbefreit"}
                  </label>
                  <div>
                    <label className="block text-sm font-medium mb-1">
                      {t("customer.paymentTerms")}
                    </label>
                    <select
                      className="w-full h-10 border rounded-md px-3"
                      value={form.paymentTerms}
                      onChange={(e) =>
                        setForm({ ...form, paymentTerms: Number(e.target.value) })
                      }
                    >
                      <option value={0}>{t("paymentTerm.immediate")}</option>
                      <option value={7}>{t("paymentTerm.days7")}</option>
                      <option value={14}>{t("paymentTerm.days14")}</option>
                      <option value={30}>{t("paymentTerm.days30")}</option>
                      <option value={60}>{t("paymentTerm.days60")}</option>
                    </select>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium mb-1">{t("customer.email")}</label>
                    <Input
                      type="email"
                      value={form.email}
                      onChange={(e) => setForm({ ...form, email: e.target.value })}
                      placeholder="info@example.de"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1">{t("customer.phone")}</label>
                    <Input
                      value={form.phone}
                      onChange={(e) => setForm({ ...form, phone: e.target.value })}
                      placeholder="+49 123 456789"
                    />
                  </div>
                 </div>

                 {/* Inline error / success feedback inside the modal */}
                 {saveError && (
                   <div
                     className="bg-red-50 border border-red-200 text-red-800 px-3 py-2 rounded text-sm"
                     role="alert"
                   >
                     ⚠ {saveError}
                   </div>
                 )}

                 <div className="flex gap-4 pt-4">
                   <Button
                     type="button"
                     variant="outline"
                     className="flex-1"
                     onClick={() => {
                       setShowModal(false)
                       setSaveError(null)
                     }}
                     disabled={saving}
                   >
                     {t("common.cancel")}
                   </Button>
                   <Button type="submit" className="flex-1" disabled={saving}>
                     {saving ? "…" : (editingCustomer ? t("common.save") : t("common.create"))}
                   </Button>
                 </div>
               </form>
             </CardContent>
           </Card>
         </div>
       )}

        {/* Page-level success toast — appears after a successful create/update */}
        {saveSuccess && (
          <div className="fixed bottom-6 right-6 bg-emerald-50 border border-emerald-200 text-emerald-800 px-4 py-3 rounded-lg shadow-lg z-50">
            ✓ {saveSuccess}
          </div>
        )}

        {/* Tier 20.2: batch Kontoauszug export modal */}
        {showBatchModal && (
          <div
            className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50"
            onClick={() => !batchLoading && setShowBatchModal(false)}
            data-testid="batch-export-modal"
          >
            <div
              className="bg-white rounded-lg shadow-xl p-6 w-full max-w-md"
              onClick={(e) => e.stopPropagation()}
            >
              <h2 className="text-xl font-semibold mb-2">
                📦 {t("customer.batchExportTitle")}
              </h2>
              <p className="text-sm text-gray-600 mb-4">
                {t("customer.batchExportSubtitle")}
              </p>

              <div className="space-y-3 mb-4">
                <div>
                  <label className="block text-sm font-medium mb-1">
                    {t("statement.from")}
                  </label>
                  <input
                    type="date"
                    value={batchFrom}
                    onChange={(e) => setBatchFrom(e.target.value)}
                    data-testid="batch-from-input"
                    className="w-full border rounded px-2 py-1"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">
                    {t("statement.to")}
                  </label>
                  <input
                    type="date"
                    value={batchTo}
                    onChange={(e) => setBatchTo(e.target.value)}
                    data-testid="batch-to-input"
                    className="w-full border rounded px-2 py-1"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">
                    {t("statement.type")}
                  </label>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setBatchOrder("desc")}
                      className={
                        "flex-1 px-3 py-1 text-sm rounded border " +
                        (batchOrder === "desc"
                          ? "bg-blue-600 text-white border-blue-600"
                          : "bg-white text-gray-700 border-gray-300 hover:bg-gray-50")
                      }
                      data-testid="batch-order-desc"
                    >
                      ↓ {t("statement.orderNewestFirst")}
                    </button>
                    <button
                      type="button"
                      onClick={() => setBatchOrder("asc")}
                      className={
                        "flex-1 px-3 py-1 text-sm rounded border " +
                        (batchOrder === "asc"
                          ? "bg-blue-600 text-white border-blue-600"
                          : "bg-white text-gray-700 border-gray-300 hover:bg-gray-50")
                      }
                      data-testid="batch-order-asc"
                    >
                      ↑ {t("statement.orderOldestFirst")}
                    </button>
                  </div>
                </div>
              </div>

              {batchError && (
                <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-800 rounded text-sm">
                  {batchError}
                </div>
              )}

              <div className="flex gap-2 justify-end">
                <Button
                  variant="outline"
                  onClick={() => setShowBatchModal(false)}
                  disabled={batchLoading}
                >
                  {t("common.cancel") || "Abbrechen"}
                </Button>
                <Button
                  onClick={downloadBatch}
                  disabled={batchLoading}
                  data-testid="batch-export-confirm"
                >
                  {batchLoading ? "..." : `📦 ${t("customer.batchExport")}`}
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* Tier 134: VIES batch check modal. State machine:
              - idle:    "Start" button
              - running: spinner + note (VIES is slow)
              - done:    summary tiles + scrollable result list
              - error:   error message */}
        {showViesBatchModal && (
          <div
            className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4"
            onClick={() => viesBatch.state !== 'running' && closeViesBatch()}
            data-testid="vies-batch-modal"
          >
            <div
              className="bg-white rounded-lg shadow-xl p-6 w-full max-w-2xl max-h-[90vh] flex flex-col"
              onClick={(e) => e.stopPropagation()}
            >
              <h2 className="text-lg font-semibold mb-1">
                🔍 {t("customer.vatBatchCheckTitle") || "Alle USt-IDs prüfen (VIES)"}
              </h2>
              <p className="text-sm text-gray-600 mb-4">
                {t("customer.vatBatchCheckDesc") ||
                  "Validiert jede USt-ID mit dem VIES-System. 1-2 Sekunden pro Kunde — bei 50 Kunden ca. 1-2 Minuten."}
              </p>

              {viesBatch.state === 'idle' && (
                <div className="flex justify-end gap-2">
                  <Button variant="outline" onClick={closeViesBatch}>
                    {t("common.cancel") || "Abbrechen"}
                  </Button>
                  <Button
                    onClick={startViesBatch}
                    data-testid="vies-batch-start"
                  >
                    ▶ {t("customer.vatBatchCheckStart") || "Prüfung starten"}
                  </Button>
                </div>
              )}

              {viesBatch.state === 'running' && (
                <div className="py-8 flex flex-col items-center" data-testid="vies-batch-running">
                  <div className="animate-spin rounded-full h-12 w-12 border-4 border-blue-200 border-t-blue-600 mb-4" />
                  <p className="text-sm text-gray-700">
                    {t("customer.vatBatchRunning") ||
                      "Prüfung läuft… bitte warten."}
                  </p>
                </div>
              )}

              {viesBatch.state === 'error' && (
                <div
                  className="mb-4 p-3 bg-red-50 border border-red-200 text-red-800 rounded text-sm"
                  data-testid="vies-batch-error"
                >
                  {viesBatch.error}
                </div>
              )}

              {viesBatch.state === 'done' && viesBatch.result && (
                <div className="flex-1 overflow-y-auto" data-testid="vies-batch-done">
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
                    <div className="bg-emerald-50 border border-emerald-200 rounded p-2 text-center">
                      <div className="text-2xl font-bold text-emerald-700" data-testid="vies-batch-valid-count">
                        {viesBatch.result.valid}
                      </div>
                      <div className="text-xs text-emerald-700">
                        {t("customer.vatStatusValid") || "Gültig"}
                      </div>
                    </div>
                    <div className="bg-red-50 border border-red-200 rounded p-2 text-center">
                      <div className="text-2xl font-bold text-red-700" data-testid="vies-batch-invalid-count">
                        {viesBatch.result.invalid}
                      </div>
                      <div className="text-xs text-red-700">
                        {t("customer.vatStatusInvalid") || "Ungültig"}
                      </div>
                    </div>
                    <div className="bg-amber-50 border border-amber-200 rounded p-2 text-center">
                      <div className="text-2xl font-bold text-amber-700">
                        {viesBatch.result.unreachable}
                      </div>
                      <div className="text-xs text-amber-700">
                        {t("customer.vatStatusUnreachable") || "Nicht erreichbar"}
                      </div>
                    </div>
                    <div className="bg-gray-50 border border-gray-200 rounded p-2 text-center">
                      <div className="text-2xl font-bold text-gray-700">
                        {viesBatch.result.total}
                      </div>
                      <div className="text-xs text-gray-700">
                        {t("customer.vatBatchTotal") || "Geprüft"}
                      </div>
                    </div>
                  </div>
                  <p className="text-xs text-gray-500 mb-2">
                    {t("customer.vatBatchDuration") || "Dauer"}:{" "}
                    {(viesBatch.result.durationMs / 1000).toFixed(1)}s ·{" "}
                    {viesBatch.result.results.filter((r) => r.cached).length}{" "}
                    {t("customer.vatCached") || "aus Cache"}
                  </p>
                  <div className="overflow-x-auto max-h-72 border rounded">
                    <table className="w-full text-sm" data-testid="vies-batch-results-table">
                      <thead className="bg-gray-50 sticky top-0">
                        <tr>
                          <th className="text-left px-3 py-2 font-medium">
                            {t("customer.name") || "Name"}
                          </th>
                          <th className="text-left px-3 py-2 font-medium">
                            {t("customer.vatId") || "USt-ID"}
                          </th>
                          <th className="text-left px-3 py-2 font-medium">
                            {t("customer.colStatus") || "Status"}
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {viesBatch.result.results.map((r) => (
                          <tr
                            key={r.entityId}
                            className="border-t border-gray-100"
                            data-testid={`vies-batch-row-${r.entityId}`}
                          >
                            <td className="px-3 py-2">
                              <a
                                href={`/dashboard/customers/${r.entityId}`}
                                className="text-blue-600 hover:underline"
                              >
                                {r.entityName}
                              </a>
                            </td>
                            <td className="px-3 py-2 font-mono text-xs">
                              {r.vatId}
                            </td>
                            <td className="px-3 py-2">
                              <span
                                className={
                                  r.status === 'valid'
                                    ? 'text-emerald-700 font-medium'
                                    : r.status === 'unreachable'
                                    ? 'text-amber-700'
                                    : 'text-red-700 font-medium'
                                }
                              >
                                {r.status === 'valid'
                                  ? t("customer.vatStatusValid") || "Gültig"
                                  : r.status === 'unreachable'
                                  ? t("customer.vatStatusUnreachable") || "Nicht erreichbar"
                                  : t("customer.vatStatusInvalid") || "Ungültig"}
                                {r.cached && (
                                  <span className="ml-1 text-xs text-gray-400">
                                    ({t("customer.vatCached") || "Cache"})
                                  </span>
                                )}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="flex justify-end mt-4">
                    <Button onClick={closeViesBatch} data-testid="vies-batch-close">
                      {t("common.close") || "Schließen"}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </main>
  )
}
