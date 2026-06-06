"use client"

import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { ExportCSVButton } from "@/components/ExportCSVButton"
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
  createdAt: string
  // Backend-assigned per-company sequential customer number (K-00001...).
  // Auto-generated on create if not supplied by the importer.
  customerNumber?: string | null
  // Backend-augmented fields: the most recent issueDate from any
  // invoice for this customer, plus the total invoice count.
  lastInvoiceDate?: string | null
  invoiceCount?: number
}

export default function CustomersPage() {
  const router = useRouter()
  const { t, getDateLocale } = useI18n()
  const [customers, setCustomers] = useState<Customer[]>([])
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [editingCustomer, setEditingCustomer] = useState<Customer | null>(null)
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
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
  }, [router, page, search])

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
    paymentTerms: 30,
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
        paymentTerms: 30,
        taxExempt: false,
      })
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
    <main className="min-h-screen bg-gray-50">
      <header className="bg-white border-b shadow-sm">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <h1 className="text-2xl font-bold text-blue-600">{t("customer.title")}</h1>
          <div className="flex gap-2 items-center">
            <LanguageSwitcher />
            <Button variant="outline" onClick={() => setShowImport(true)}>
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
            <Button onClick={() => openModal()}>{t("customer.create")}</Button>
          </div>
        </div>
      </header>

      <div className="container mx-auto px-4 py-8">
        {!loading && (
          <div className="mb-4">
            <input
              type="text"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder={t("customer.searchPlaceholder") || "Name, USt-ID, Stadt, PLZ suchen..."}
              className="w-full md:w-1/2 px-3 py-2 border border-gray-300 rounded-md text-sm"
            />
            {search && (
              <p className="text-xs text-gray-500 mt-1">
                {customers.length} Treffer
              </p>
            )}
          </div>
        )}
        {loading ? (
          <div className="text-center py-8">{t("common.loading")}</div>
        ) : !search && customers.length === 0 ? (
          // Empty state — no customers AND no search active
          <Card>
            <CardContent className="text-center py-12">
              <p className="text-gray-500 mb-4">{t("customer.noCustomers")}</p>
              <div className="flex gap-2 justify-center">
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
            <CardContent className="text-center py-12">
              <p className="text-gray-500 mb-4">{t("customer.noMatching") || "Keine Kunden entsprechen der Suche."}</p>
              <Button variant="outline" onClick={() => setSearchInput('')}>
                {t("common2.clearFilters") || "Suche zurücksetzen"}
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {customers.map((customer) => (
              <Card
                key={customer.id}
                className="hover:shadow-lg transition cursor-pointer relative"
                onClick={() => openModal(customer)}
              >
                {/* Delete button — stopPropagation so the card click doesn't open the modal */}
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    handleDelete(customer)
                  }}
                  className="absolute top-2 right-2 text-gray-400 hover:text-red-600 text-xs px-2 py-1 rounded hover:bg-red-50"
                  title={t("common.delete") || "Löschen"}
                >
                  🗑
                </button>
                <CardHeader>
                  <CardTitle className="flex justify-between items-center pr-6 gap-2">
                    <div className="min-w-0">
                      <div className="truncate">{customer.name}</div>
                      {customer.customerNumber && (
                        <div className="text-xs text-gray-500 font-normal mt-0.5">
                          {t("customer.customerNumber") || "Kundennummer"}: <span className="font-mono font-medium text-gray-700">{customer.customerNumber}</span>
                        </div>
                      )}
                    </div>
                    <div className="flex gap-1 shrink-0">
                      <span
                        className={`text-[10px] px-2 py-1 rounded font-medium ${
                          customer.isActive
                            ? "bg-emerald-100 text-emerald-700"
                            : "bg-gray-100 text-gray-500"
                        }`}
                        title={t("customer.inactiveHint") || (customer.isActive ? "" : "Inaktiv")}
                      >
                        {customer.isActive
                          ? (t("customer.statusActive") || "Aktiv")
                          : (t("customer.statusInactive") || "Inaktiv")}
                      </span>
                      <span className="text-xs px-2 py-1 bg-gray-100 rounded">{getTypeLabel(customer.type)}</span>
                    </div>
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2 text-sm">
                    {customer.vatId && <div className="text-gray-600">{t("customer.vatId")}: {customer.vatId}</div>}
                    {customer.taxExempt && (
                      <div className="text-xs text-orange-700">⚠ {t("customer.taxExempt")}</div>
                    )}
                    <div className="text-gray-600">
                      {customer.address?.street}, {customer.address?.postalCode} {customer.address?.city}
                    </div>
                    {customer.contact?.email && (
                      <div className="text-gray-600">{customer.contact.email}</div>
                    )}
                    <div className="text-gray-500 text-xs">
                      {t("customer.paymentTerms")}: {customer.paymentTerms} {t("reminder.days")}
                    </div>
                    {/* Last invoice + total count — surfaces inactive customers
                        at a glance and helps spot customers that haven't
                        been invoiced in a long time. */}
                    <div className="pt-2 mt-2 border-t border-gray-100 text-xs flex items-center justify-between">
                      <span className="text-gray-500">
                        {t("customer.lastInvoice") || "Letzte Rechnung"}:{" "}
                        {customer.lastInvoiceDate ? (
                          <span className="text-gray-900 font-medium">
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
                            : "bg-gray-100 text-gray-500"
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
            <span className="text-gray-600">
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
              <div className="text-sm text-gray-600">
                <p>Laden Sie eine CSV-Datei mit Kunden hoch. Vorhandene Kunden
                (gleiche E-Mail) werden übersprungen, nicht überschrieben.</p>
                <p className="mt-2">
                  Spalten: <code>name, vatId, type, street, postalCode, city, country, email, phone, paymentTerms, taxExempt</code>
                </p>
              </div>

              <button
                onClick={downloadSampleCsv}
                className="text-sm text-blue-600 hover:underline"
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
                  className="block w-full text-sm text-gray-700 file:mr-3 file:py-2 file:px-4 file:rounded file:border-0 file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100"
                />
                {importFile && (
                  <p className="text-xs text-gray-500 mt-1">
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
     </main>
  )
}
