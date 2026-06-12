"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import LanguageSwitcher from "@/components/LanguageSwitcher"
import { useI18n } from "@/components/useI18n"
import { apiGet, apiPost, ApiError } from "@/lib/api"

type InvoiceType = 'INV' | 'CN' | 'PI' | 'RCV'

interface Invoice {
  id: string
  invoiceNumber: string
  type: string
  customer: { name: string }
  total: string
  status: string
  issueDate: string
}

export default function InvoicesPage() {
  const router = useRouter()
  const { t, locale, getDateLocale } = useI18n()
  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [loading, setLoading] = useState(true)
  const [typeFilter, setTypeFilter] = useState<string>('')
  const [statusFilter, setStatusFilter] = useState<string>('')
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize] = useState(50)
  const [total, setTotal] = useState(0)
  const [totalPages, setTotalPages] = useState(1)
  // Multi-select for bulk actions (export, send, ...). Map<id, true> for O(1) lookup.
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkDownloading, setBulkDownloading] = useState(false)
  // Visible error when the list fetch fails. Empty string = no error.
  // The user must see this — silent console.error was making it look
  // like the page was empty when in fact the API was throttled / down.
  const [listError, setListError] = useState<string | null>(null)

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
    if (typeFilter) params.append('type', typeFilter)
    if (statusFilter) params.append('status', statusFilter)
    if (search.trim()) params.append('search', search.trim())
    if (dateFrom) params.append('dateFrom', dateFrom)
    if (dateTo) params.append('dateTo', dateTo)
    setLoading(true)
    setListError(null)
    apiGet<any>(`/api/v1/invoices?${params}`)
      .then((data) => {
        setInvoices(Array.isArray(data) ? data : (data.data || []))
        setTotal(data.total || 0)
        setTotalPages(data.totalPages || 1)
      })
      .catch((err: any) => {
        console.error('Invoices list fetch failed:', err)
        setInvoices([])
        setTotal(0)
        setTotalPages(1)
        // Map known cases to user-friendly German messages.
        const status = err?.status as number | undefined
        const raw = (err?.message || String(err) || '') as string
        if (status === 429 || /too many/i.test(raw)) {
          setListError('Zu viele Anfragen. Bitte einen Moment warten und dann erneut versuchen.')
        } else if (status === 401 || status === 403) {
          setListError('Sitzung abgelaufen. Bitte neu anmelden.')
        } else if (status === 404) {
          setListError('Rechnungen konnten nicht geladen werden (404).')
        } else if (status && status >= 500) {
          setListError(`Serverfehler (${status}). Bitte erneut versuchen.`)
        } else {
          setListError(`Fehler beim Laden: ${raw || 'Unbekannter Fehler'}`)
        }
      })
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router, typeFilter, statusFilter, page, search, dateFrom, dateTo])

  // Debounce search input
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput), 300)
    return () => clearTimeout(t)
  }, [searchInput])
  useEffect(() => {
    if (page !== 1) setPage(1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search])

  // Date range is still applied client-side because the backend doesn't
  // (yet) support date filters on /invoices. With paginated server-side
  // results, date filtering is just an extra in-memory step.
  const dateFiltered = invoices.filter((inv) => {
    if (dateFrom && inv.issueDate < dateFrom) return false
    if (dateTo && inv.issueDate > dateTo) return false
    return true
  })

  const hasActiveFilter = !!search || !!dateFrom || !!dateTo || !!statusFilter || !!typeFilter
  const clearFilters = () => {
    setSearch('')
    setSearchInput('')
    setDateFrom('')
    setDateTo('')
    setStatusFilter('')
    setTypeFilter('')
  }

  // Force German dd.mm.yyyy with leading zeros (toLocaleDateString
  // returns "5.6.2026" on some ICU versions instead of "05.06.2026",
  // which looks inconsistent in tabular lists).
  const formatDateDE = (s: string) => {
    if (!s) return ""
    const d = new Date(s)
    if (isNaN(d.getTime())) return s
    const dd = String(d.getDate()).padStart(2, "0")
    const mm = String(d.getMonth() + 1).padStart(2, "0")
    const yyyy = d.getFullYear()
    return `${dd}.${mm}.${yyyy}`
  }

  const getStatusLabel = (status: string) => {
    const labels: Record<string, string> = {
      draft: t("invoice.draft"),
      sent: t("invoice.sent"),
      paid: t("invoice.paid"),
      overdue: t("invoice.overdue"),
      cancelled: t("invoice.cancelled"),
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

  const getTypeLabel = (type: string) => {
    const labels: Record<string, string> = {
      INV: t("invoice.typeInvoice"),
      CN: t("invoice.typeCreditNote"),
      PI: t("invoice.typeProforma"),
      RCV: t("invoice.typeReceipt"),
    }
    return labels[type] || type
  }

  const getTypeColor = (type: string) => {
    const colors: Record<string, string> = {
      INV: "bg-blue-100 text-blue-700 dark:text-blue-300",
      CN: "bg-orange-100 text-orange-700 dark:text-orange-300",
      PI: "bg-purple-100 text-purple-700 dark:text-purple-300",
      RCV: "bg-green-100 text-green-700 dark:text-green-300",
    }
    return colors[type] || colors.INV
  }

  const downloadPDF = async (id: string, invoiceNumber: string) => {
    const companyId = localStorage.getItem("companyId")
    if (!companyId) return
    try {
      const { apiFetch } = await import("@/lib/api")
      const response = await apiFetch(`/api/v1/invoices/${id}/pdf?companyId=${companyId}`, { throwOnError: false })
      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        alert(data.message || `Download fehlgeschlagen (HTTP ${response.status})`)
        return
      }
      const blob = await response.blob()
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = `${invoiceNumber}.pdf`
      document.body.appendChild(a)
      a.click()
      window.URL.revokeObjectURL(url)
      document.body.removeChild(a)
    } catch (err) {
      console.error("Download fehlgeschlagen:", err)
      alert("Download fehlgeschlagen")
    }
  }

  const [sendingId, setSendingId] = useState<string | null>(null)
  const [sendStatus, setSendStatus] = useState<Record<string, { ok: boolean; message: string }>>({})

  // Bulk-download selected invoices as a single ZIP. The backend
  // returns `application/zip` with each invoice as a separate PDF
  // (or ZUGFeRD if `format === "zugferd"`), plus a `_manifest.txt`.
  const bulkDownload = async (format: "pdf" | "zugferd" = "pdf") => {
    if (selected.size === 0) return
    const companyId = localStorage.getItem("companyId")
    if (!companyId) return
    setBulkDownloading(true)
    try {
      const { apiFetch, ApiError } = await import("@/lib/api")
      const res = await apiFetch(
        `/api/v1/invoices/bulk-download?companyId=${companyId}`,
        {
          method: "POST",
          body: { invoiceIds: Array.from(selected), format },
          throwOnError: false,
        }
      )
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        const msg = Array.isArray(data.message) ? data.message.join(", ") : (data.message || `HTTP ${res.status}`)
        alert(`Bulk-Download fehlgeschlagen: ${msg}`)
        return
      }
      const blob = await res.blob()
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      const stamp = new Date().toISOString().slice(0, 10)
      a.download = `Rechnungen_${stamp}.zip`
      document.body.appendChild(a)
      a.click()
      window.URL.revokeObjectURL(url)
      document.body.removeChild(a)
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "Netzwerkfehler"
      alert(`Bulk-Download fehlgeschlagen: ${msg}`)
    } finally {
      setBulkDownloading(false)
    }
  }

  // Date-range CSV export. Calls the backend with dateFrom/dateTo (and
  // any active type/status filter) — the server picks all matching
  // invoices across all pages, not just the current view. The response
  // is a single CSV file with a UTF-8 BOM for Excel.
  const exportCsv = async () => {
    const companyId = localStorage.getItem("companyId")
    if (!companyId) return
    if (!dateFrom && !dateTo) {
      alert("Bitte zuerst einen Zeitraum (Von / Bis) wählen.")
      return
    }
    const params = new URLSearchParams({ companyId })
    if (dateFrom) params.append('dateFrom', dateFrom)
    if (dateTo) params.append('dateTo', dateTo)
    if (typeFilter) params.append('type', typeFilter)
    if (statusFilter) params.append('status', statusFilter)
    try {
      const { apiFetch, ApiError } = await import("@/lib/api")
      const res = await apiFetch(`/api/v1/invoices/export/csv?${params}`, { throwOnError: false })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        const msg = Array.isArray(data.message) ? data.message.join(", ") : (data.message || `HTTP ${res.status}`)
        alert(`CSV-Export fehlgeschlagen: ${msg}`)
        return
      }
      const blob = await res.blob()
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      // Use the server-provided filename (dateFrom_dateTo.csv) so the
      // downloaded file matches what the user selected in the date picker.
      const disp = res.headers.get('Content-Disposition') || ''
      const m = disp.match(/filename="?([^";]+)"?/)
      a.download = m?.[1] || `Rechnungen_${new Date().toISOString().slice(0,10)}.csv`
      document.body.appendChild(a)
      a.click()
      window.URL.revokeObjectURL(url)
      document.body.removeChild(a)
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "Netzwerkfehler"
      alert(`CSV-Export fehlgeschlagen: ${msg}`)
    }
  }

  // Date-range PDF/ZUGFeRD ZIP export. Same backend bulk-download
  // endpoint, but selects invoices by date instead of by explicit IDs.
  const exportDateRangeZip = async (format: "pdf" | "zugferd" = "pdf") => {
    const companyId = localStorage.getItem("companyId")
    if (!companyId) return
    if (!dateFrom && !dateTo) {
      alert("Bitte zuerst einen Zeitraum (Von / Bis) wählen.")
      return
    }
    setBulkDownloading(true)
    try {
      const { apiFetch, ApiError } = await import("@/lib/api")
      const res = await apiFetch(`/api/v1/invoices/bulk-download?companyId=${companyId}`, {
        method: "POST",
        body: {
          dateFrom: dateFrom || undefined,
          dateTo: dateTo || undefined,
          type: typeFilter || undefined,
          status: statusFilter || undefined,
          format,
        },
        throwOnError: false,
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        const msg = Array.isArray(data.message) ? data.message.join(", ") : (data.message || `HTTP ${res.status}`)
        alert(`ZIP-Export fehlgeschlagen: ${msg}`)
        return
      }
      const blob = await res.blob()
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      const stamp = new Date().toISOString().slice(0, 10)
      a.download = `Rechnungen_${dateFrom || 'alle'}_${dateTo || 'alle'}_${stamp}.zip`
      document.body.appendChild(a)
      a.click()
      window.URL.revokeObjectURL(url)
      document.body.removeChild(a)
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "Netzwerkfehler"
      alert(`ZIP-Export fehlgeschlagen: ${msg}`)
    } finally {
      setBulkDownloading(false)
    }
  }

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const toggleSelectAll = () => {
    setSelected((prev) => {
      if (prev.size === invoices.length) return new Set()
      return new Set(invoices.map((inv) => inv.id))
    })
  }

  const sendInvoiceEmail = async (id: string) => {
    const companyId = localStorage.getItem("companyId")
    const userId = localStorage.getItem("userId") || undefined
    const userEmail = localStorage.getItem("userEmail") || ""
    if (!companyId) return
    setSendingId(id)
    try {
      const data = await apiPost<any>(`/api/v1/invoices/${id}/send-email?companyId=${companyId}`, {
        ccEmail: userEmail || undefined,
        createdById: userId,
      })
      setSendStatus((s) => ({
        ...s,
        [id]: {
          ok: true,
          message: data.smtpConfigured
            ? `Gesendet an ${data.recipient}`
            : `Vorbereitet (SMTP nicht konfiguriert)`,
        },
      }))
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "Netzwerkfehler"
      setSendStatus((s) => ({ ...s, [id]: { ok: false, message: msg } }))
    } finally {
      setSendingId(null)
      // Auto-clear after 5s
      setTimeout(() => {
        setSendStatus((s) => {
          const next = { ...s }
          delete next[id]
          return next
        })
      }, 5000)
    }
  }

  return (
    <main className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <header className="bg-white dark:bg-gray-800 border-b shadow-sm">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <h1 className="text-2xl font-bold text-blue-600 dark:text-blue-400">{t("invoice.title")}</h1>
          <div className="flex gap-2 items-center">
            <LanguageSwitcher />
            <Button variant="outline" onClick={() => router.push("/dashboard")}>{t("common.back")}</Button>
            <Button onClick={() => router.push("/dashboard/invoices/create")}>{t("common2.newInvoice")}</Button>
          </div>
        </div>
      </header>

      <div className="container mx-auto px-4 py-8">
        {/* Bulk action bar — appears whenever any row is selected */}
        {selected.size > 0 && (
          <div className="bg-blue-50 border border-blue-200 rounded-lg px-4 py-3 mb-4 flex items-center justify-between flex-wrap gap-2">
            <div className="text-sm text-blue-900">
              <span className="font-semibold">{selected.size}</span>
              {" "}ausgewählt
            </div>
            <div className="flex gap-2 flex-wrap">
              <Button
                size="sm"
                onClick={() => bulkDownload("pdf")}
                disabled={bulkDownloading}
              >
                {bulkDownloading ? "…" : `⬇ ZIP (PDF) — ${selected.size}`}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => bulkDownload("zugferd")}
                disabled={bulkDownloading}
              >
                {bulkDownloading ? "…" : "⬇ ZIP (ZUGFeRD)"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setSelected(new Set())}
                disabled={bulkDownloading}
              >
                Auswahl löschen
              </Button>
            </div>
          </div>
        )}

        {/* Type Filter */}
        <div className="mb-4 flex gap-2 flex-wrap items-center">
          <Button
            size="sm"
            variant={typeFilter === '' ? 'default' : 'outline'}
            onClick={() => setTypeFilter('')}
          >
            {t("common2.all")}
          </Button>
          {(['INV', 'CN', 'PI', 'RCV'] as InvoiceType[]).map((type) => (
            <Button
              key={type}
              size="sm"
              variant={typeFilter === type ? 'default' : 'outline'}
              onClick={() => setTypeFilter(type)}
            >
              <span className={`px-1.5 py-0.5 rounded text-xs mr-1 ${getTypeColor(type)}`}>
                {type}
              </span>
              {getTypeLabel(type)}
            </Button>
          ))}
        </div>

        {/* Search + Status + Date Range */}
        <div className="mb-4 grid grid-cols-1 md:grid-cols-4 gap-2">
          <input
            type="text"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder={t("common2.searchInvoiceOrCustomer") || "Rechnung oder Kunde suchen..."}
            className="px-3 py-2 border border-gray dark:border-gray-700-300 dark:border-gray-600 rounded-md text-sm"
          />
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="px-3 py-2 border border-gray dark:border-gray-700-300 dark:border-gray-600 rounded-md text-sm"
          >
            <option value="">{t("common2.allStatuses") || "Alle Status"}</option>
            <option value="draft">{t("invoice.draft")}</option>
            <option value="sent">{t("invoice.sent")}</option>
            <option value="paid">{t("invoice.paid")}</option>
            <option value="overdue">{t("invoice.overdue")}</option>
            <option value="cancelled">{t("invoice.cancelled")}</option>
          </select>
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            placeholder={t("common2.from") || "Von"}
            className="px-3 py-2 border border-gray dark:border-gray-700-300 dark:border-gray-600 rounded-md text-sm"
          />
          <div className="flex gap-2">
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              placeholder={t("common2.to") || "Bis"}
              className="flex-1 px-3 py-2 border border-gray dark:border-gray-700-300 dark:border-gray-600 rounded-md text-sm"
            />
            {hasActiveFilter && (
              <button
                onClick={clearFilters}
                className="px-3 py-2 text-sm text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:text-gray-100"
                title={t("common2.clearFilters") || "Filter zurücksetzen"}
              >
                ×
              </button>
            )}
          </div>
        </div>

        {/* Date-range export bar — visible when a date range is set.
            Two actions: CSV (single file with all matching invoices) and
            ZIP (bundle of PDFs, also honouring the type/status filter). */}
        {(dateFrom || dateTo) && (
          <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-2 mb-3 flex items-center justify-between flex-wrap gap-2">
            <div className="text-sm text-emerald-900">
              {dateFrom && dateTo
                ? `Zeitraum: ${dateFrom} → ${dateTo}`
                : dateFrom
                ? `Ab ${dateFrom}`
                : `Bis ${dateTo}`}
              <span className="text-emerald-700 ml-2">({total} Treffer)</span>
            </div>
            <div className="flex gap-2 flex-wrap">
              <Button
                size="sm"
                variant="outline"
                onClick={exportCsv}
                disabled={total === 0}
              >
                ⬇ CSV exportieren
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => exportDateRangeZip("pdf")}
                disabled={total === 0 || bulkDownloading}
              >
                {bulkDownloading ? "…" : "⬇ ZIP (PDF)"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => exportDateRangeZip("zugferd")}
                disabled={total === 0 || bulkDownloading}
              >
                {bulkDownloading ? "…" : "ZIP (ZUGFeRD)"}
              </Button>
            </div>
          </div>
        )}

        {hasActiveFilter && (
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
            {t("common2.showingXofY") || "Zeige"} {dateFiltered.length} / {invoices.length}
          </p>
        )}

        {loading ? (
          <div className="text-center py-8">{t("common.loading")}</div>
        ) : listError ? (
          <Card className="border-red-200 bg-red-50/50">
            <CardContent className="text-center py-12">
              <p className="text-red-700 dark:text-red-300 font-medium mb-2">⚠ {listError}</p>
              <p className="text-gray-600 dark:text-gray-300 text-sm mb-4">
                Bitte prüfe deine Internetverbindung oder versuche es in einem Moment erneut.
              </p>
              <Button
                onClick={() => {
                  // Force a reload of the list by bumping the page state
                  setPage((p) => p) // no-op; the useEffect already re-runs
                  setSearch((s) => s) // force a re-render
                  // Easier: just reload the page
                  if (typeof window !== "undefined") window.location.reload()
                }}
              >
                Erneut versuchen
              </Button>
            </CardContent>
          </Card>
        ) : invoices.length === 0 ? (
          <Card>
            <CardContent className="text-center py-12">
              <p className="text-gray-500 dark:text-gray-400 mb-4">{t("invoice.noInvoices")}</p>
              <Button onClick={() => router.push("/dashboard/invoices/create")}>
                {t("invoice.createFirst")}
              </Button>
            </CardContent>
          </Card>
        ) : dateFiltered.length === 0 ? (
          <Card>
            <CardContent className="text-center py-12">
              <p className="text-gray-500 dark:text-gray-400 mb-4">
                {t("common2.noMatchingInvoices") || "Keine Rechnungen entsprechen den Filtern."}
              </p>
              {hasActiveFilter && (
                <Button variant="outline" onClick={clearFilters}>
                  {t("common2.clearFilters") || "Filter zurücksetzen"}
                </Button>
              )}
            </CardContent>
          </Card>
        ) : (
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow overflow-hidden">
            <table className="w-full">
              <thead className="bg-gray-50 dark:bg-gray-900 border-b">
                <tr>
                  <th className="px-4 py-3 w-10">
                    <input
                      type="checkbox"
                      checked={invoices.length > 0 && selected.size === invoices.length}
                      ref={(el) => {
                        if (el) el.indeterminate = selected.size > 0 && selected.size < invoices.length
                      }}
                      onChange={toggleSelectAll}
                      className="w-4 h-4 cursor-pointer"
                      aria-label="Alle auswählen"
                    />
                  </th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-gray-600 dark:text-gray-300">{t("invoice.number")}</th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-gray-600 dark:text-gray-300">{t("invoice.customer")}</th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-gray-600 dark:text-gray-300">{t("invoice.total")}</th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-gray-600 dark:text-gray-300">{t("invoice.date")}</th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-gray-600 dark:text-gray-300">{t("invoice.status")}</th>
                  <th className="px-4 py-3 text-right text-sm font-medium text-gray-600 dark:text-gray-300">{t("common.actions")}</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {dateFiltered.map((invoice) => (
                  <tr key={invoice.id} className="hover:bg-gray-50 dark:bg-gray-900">
                    <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        checked={selected.has(invoice.id)}
                        onChange={() => toggleSelect(invoice.id)}
                        className="w-4 h-4 cursor-pointer"
                        aria-label={`Rechnung ${invoice.invoiceNumber} auswählen`}
                      />
                    </td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-1 rounded text-xs font-medium ${getTypeColor(invoice.type)}`}>
                        {invoice.type}
                      </span>
                      <span className="ml-2">{invoice.invoiceNumber}</span>
                    </td>
                    <td className="px-4 py-3">{invoice.customer?.name || "-"}</td>
                    <td className="px-4 py-3">€{Number(invoice.total).toFixed(2)}</td>
                    <td className="px-4 py-3">{formatDateDE(invoice.issueDate)}</td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-1 rounded text-xs ${getStatusColor(invoice.status)}`}>
                        {getStatusLabel(invoice.status)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex flex-col items-end gap-1">
                        <div className="flex gap-2 justify-end">
                          <Button size="sm" variant="ghost" onClick={() => router.push(`/dashboard/invoices/${invoice.id}`)}>{t("common2.view")}</Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => sendInvoiceEmail(invoice.id)}
                            disabled={sendingId === invoice.id}
                          >
                            {sendingId === invoice.id
                              ? (t("common2.sending"))
                              : (t("common2.sendEmail"))}
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => downloadPDF(invoice.id, invoice.invoiceNumber)}>PDF</Button>
                        </div>
                        {sendStatus[invoice.id] && (
                          <span className={`text-xs ${sendStatus[invoice.id].ok ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}>
                            {sendStatus[invoice.id].ok ? "✓ " : "✗ "}
                            {sendStatus[invoice.id].message}
                          </span>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

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
    </main>
  )
}