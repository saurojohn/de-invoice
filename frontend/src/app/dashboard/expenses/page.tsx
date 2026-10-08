"use client"

import { useEffect, useState, useCallback, useMemo } from "react"
import { useRouter } from "next/navigation"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import LanguageSwitcher from "@/components/LanguageSwitcher"
import { useI18n } from "@/components/useI18n"
import { apiGet, apiFetch, apiPost } from "@/lib/api"
import { ReceiptsPanel } from "@/components/ReceiptsPanel"
import { EInvoiceDialog } from "@/components/EInvoiceDialog"
import { BLANK_EXPENSE, ExpenseEditForm } from "@/components/ExpenseEditForm"

// Expense = Eingangsrechnung (vendor bill). The list
// page is the Berater's overview of all incoming
// supplier invoices: who, when, how much, paid?
// Each row carries a paymentState hint that the
// backend computes by string-matching the
// [expense:<id>] tag in linked Vouchers:
//   - "offen"     no linked voucher
//   - "bezahlt"   linked voucher referenceType=Expense
//   - "storniert" linked voucher referenceType=VoucherReversal
interface Expense {
  id: string
  invoiceNumber: string | null
  description: string
  invoiceDate: string
  netAmount: string
  vatAmount: string
  grossAmount: string
  vatRate: string
  // Tier 581: the VAT lines of an invoice with several rates (empty otherwise)
  taxLines?: Array<{ vatRate: string; netAmount: string; vatAmount: string }>
  status: string
  category: string | null
  isIntraEU: boolean
  isReverseCharge: boolean
  supplier: { id: string; name: string; vatId: string | null } | null
  // The server-enriched audit pivot. Null when the
  // Expense has no associated Voucher yet.
  paymentState: "offen" | "bezahlt" | "storniert"
  linkedVoucher: {
    id: string
    voucherNumber: string
    referenceType: string
  } | null
  // Tier 447: why a paid expense / AfA row can no longer be changed.
  lockReason?: string | null
}

interface Supplier {
  id: string
  name: string
  vatId: string | null
}

// All filters live in the URL implicitly (no router
// push needed for v1 — the dashboard re-fetches on
// every change).
export default function ExpensesPage() {
  const router = useRouter()
  const { t, locale, getDateLocale } = useI18n()  // all used by format helpers below
  const [items, setItems] = useState<Expense[]>([])
  const [loading, setLoading] = useState(true)
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [search, setSearch] = useState("")
  const [debouncedSearch, setDebouncedSearch] = useState("")
  const [supplierId, setSupplierId] = useState("")
  const [state, setState] = useState<"" | "offen" | "bezahlt" | "storniert">("")
  // Receipt count cache — keyed by expenseId, populated
  // lazily on first render of the table so the column
  // shows a paperclip + count without making the list
  // endpoint return nested attachments.
  const [receiptCounts, setReceiptCounts] = useState<Record<string, number>>({})
  // Detail modal — which expense's receipts we're
  // looking at, if any. Null = modal closed.
  const [detailExpense, setDetailExpense] = useState<Expense | null>(null)
  // Tier 605: a supplier invoice entered by hand. The page could scan, read an
  // e-invoice and import a CSV — but not simply take one down.
  const [creating, setCreating] = useState(false)
  // Tier 573: an incoming e-invoice — a file being imported, or the one kept
  // with an expense being looked at.
  const [eInvoice, setEInvoice] = useState<
    null | { kind: "import"; file: File } | { kind: "view"; expenseId: string }
  >(null)
  // whether the expense in the detail modal has an e-invoice among its receipts
  const [detailHasEInvoice, setDetailHasEInvoice] = useState(false)
  useEffect(() => {
    setDetailHasEInvoice(false)
    if (!detailExpense) return
    const companyId = localStorage.getItem("companyId") || ""
    let stale = false
    apiGet(`/api/v1/expenses/${detailExpense.id}/e-invoice?companyId=${companyId}`)
      .then((d) => {
        if (!stale) setDetailHasEInvoice(!!d?.eInvoice)
      })
      .catch(() => undefined)
    return () => {
      stale = true
    }
  }, [detailExpense])
  // Tier 29: OCR prefill modal. State shape:
  //   null              → modal closed
  //   { step: 'loading' → upload in flight
  //     data?: {...}   → OCR returned, user edits
  //     error?: string  → upload or OCR failed
  //   { step: 'preview', data: {...} } → user reviewing
  //   { step: 'saving', data: {...} }  → POSTing /expenses
  //   { step: 'done', expenseId: string } → reload list, close
  // We collapse to a discriminated union so the
  // disabled state for the confirm button is obvious.
  const [ocr, setOcr] = useState<
    | null
    | { step: "loading" }
    | {
        step: "preview"
        data: {
          supplierName: string | null
          supplierVatId: string | null
          supplierIban: string | null
          supplierBic: string | null
          invoiceNumber: string | null
          invoiceDate: string | null
          netAmount: number | null
          vatRate: number | null
          vatAmount: number | null
          grossAmount: number | null
          rawText: string
        }
        // Editable copies (the user can correct OCR noise)
        editable: {
          supplierName: string
          invoiceNumber: string
          invoiceDate: string
          netAmount: string
          vatRate: string
          vatAmount: string
          grossAmount: string
          description: string
        }
        matchedSupplierId: string | null
        matchedBy: string | null
        // Tier 574: the scan itself — kept with the expense once it is created
        file: File
      }
    | { step: "saving" }
    | { step: "error"; message: string }
  >(null)

  // 200ms debounce on the search input
  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(search), 200)
    return () => clearTimeout(id)
  }, [search])

  const loadSuppliers = useCallback(async () => {
    const companyId = localStorage.getItem("companyId")
    if (!companyId) return
    try {
      const data = await apiGet(`/api/v1/suppliers?companyId=${companyId}`)
      setSuppliers(Array.isArray(data) ? data : [])
    } catch (e) {
      console.error("suppliers load failed", e)
    }
  }, [])

  const load = useCallback(async () => {
    const companyId = localStorage.getItem("companyId")
    if (!companyId) {
      router.push("/login")
      return
    }
    setLoading(true)
    const params = new URLSearchParams({ companyId })
    if (debouncedSearch) params.set("search", debouncedSearch)
    if (supplierId) params.set("supplierId", supplierId)
    // The Expense.status filter is "booked|deductible|blocked"
    // (the GoBD state of the row). The paymentState filter
    // is computed by the server and exposed as a different
    // field. We don't have a server-side filter for
    // paymentState yet — it filters client-side below.
    try {
      const data = await apiGet(`/api/v1/expenses?${params.toString()}`)
      // Tier 178: backend now returns {data, total} to
      // match /invoices, /customers, /products. Fall
      // back to the array shape (Tier 178-back-compat)
      // if a stale backend hasn't been restarted.
      if (Array.isArray(data)) {
        setItems(data)
        // No total in the old shape — keep our local
        // count (was `items.length`).
      } else if (data && Array.isArray(data.data)) {
        setItems(data.data)
        // If a total field is present, surface it via
        // the parent's count line. (The parent doesn't
        // currently render a count; this is for a future
        // tier that adds one.)
      } else {
        setItems([])
      }
    } catch (e) {
      console.error("expenses load failed", e)
      setItems([])
    } finally {
      setLoading(false)
    }
  }, [router, debouncedSearch, supplierId])

  // Fetch attachment counts for the currently-visible
  // expenses. The /attachments endpoint takes one
  // entityId at a time, so we fire N parallel
  // requests — fine for a list page (typical N is
  // 10-50). The response is cached in receiptCounts
  // so re-renders don't refetch.
  const refreshReceiptCounts = useCallback(async () => {
    const companyId = localStorage.getItem("companyId")
    if (!companyId) return
    const ids = items.map((e) => e.id)
    if (ids.length === 0) return
    const results = await Promise.all(
      ids.map(async (id) => {
        try {
          const list = await apiGet<any[]>(
            `/api/v1/attachments?companyId=${companyId}&entityType=expense&entityId=${id}`,
          )
          return [id, Array.isArray(list) ? list.length : 0] as const
        } catch {
          return [id, 0] as const
        }
      }),
    )
    setReceiptCounts(Object.fromEntries(results))
  }, [items])

  useEffect(() => {
    if (items.length > 0) refreshReceiptCounts()
  }, [items]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    load()
  }, [load])
  useEffect(() => {
    loadSuppliers()
  }, [loadSuppliers])

  // Client-side filter on the server-computed
  // paymentState (no server filter for it yet). Could
  // be pushed server-side later, but for the typical
  // 100-500 expense list per company the in-memory
  // pass is fine.
  const filtered = useMemo(() => {
    if (!state) return items
    return items.filter((e) => e.paymentState === state)
  }, [items, state])

  // Aggregates strip at the top — like the Voucher
  // journal's Soll/Haben summary. Helps the Berater
  // spot totals at a glance.
  const aggregates = useMemo(() => {
    let net = 0
    let vat = 0
    let gross = 0
    let offen = 0
    let bezahlt = 0
    let storniert = 0
    for (const e of filtered) {
      net += parseFloat(e.netAmount || "0")
      vat += parseFloat(e.vatAmount || "0")
      gross += parseFloat(e.grossAmount || "0")
      if (e.paymentState === "offen") offen += 1
      else if (e.paymentState === "bezahlt") bezahlt += 1
      else if (e.paymentState === "storniert") storniert += 1
    }
    return { net, vat, gross, offen, bezahlt, storniert }
  }, [filtered])

  const formatDate = (s: string) =>
    new Date(s).toLocaleDateString(getDateLocale())

  const formatCurrency = (amount: string) => {
    const n = parseFloat(amount || "0")
    const intlLocale = locale === "de" ? "de-DE" : "en-US"
    return new Intl.NumberFormat(intlLocale, {
      style: "currency",
      currency: "EUR",
    }).format(n)
  }

  const stateBadge = (s: Expense["paymentState"]) => {
    if (s === "offen")
      return (
        <Badge className="bg-yellow-100 text-yellow-800">
          {t("expenses.stateOffen")}
        </Badge>
      )
    if (s === "bezahlt")
      return (
        <Badge className="bg-green-100 text-green-700 dark:text-green-300">
          {t("expenses.stateBezahlt")}
        </Badge>
      )
    return (
      <Badge className="bg-red-100 text-red-700 dark:text-red-300">
        {t("expenses.stateStorniert")}
      </Badge>
    )
  }

  return (
    <main className="min-h-screen bg-gray-50 dark:bg-gray-900 p-3 sm:p-6">
      <div className="max-w-7xl mx-auto">
        <div className="flex flex-wrap justify-between items-center gap-2 mb-6">
          <div>
            <h1 className="text-xl sm:text-2xl font-bold text-gray-900 dark:text-gray-100">
              {t("expenses.title")}
            </h1>
            <p className="text-sm text-gray-600 dark:text-gray-300 mt-1">
              {t("expenses.subtitle")}
            </p>
          </div>
          <div className="flex flex-wrap gap-2 items-center">
            <LanguageSwitcher />
            <button
              onClick={() => router.push("/dashboard")}
              className="px-3 py-1 text-sm border rounded hover:bg-gray-100 dark:hover:bg-gray-700"
            >
              {t("common.back")}
            </button>
            {/* Tier 29: upload a scan (image / PDF).
                The hidden <input> captures the file
                and fires the change handler that
                POSTs to /api/v1/ocr/scan. The label
                wraps the visible button so a click
                anywhere on the button opens the
                system file picker. */}
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="px-3 py-1 text-sm border rounded bg-blue-600 text-white hover:bg-blue-700"
              data-testid="expense-create-button"
            >
              {t("expenses.newExpense")}
            </button>
            <button
              onClick={() => {
                const inp = document.getElementById(
                  "expense-ocr-input",
                ) as HTMLInputElement | null
                inp?.click()
              }}
              className="px-3 py-1 text-sm border rounded hover:bg-gray-100 dark:hover:bg-gray-700"
              data-testid="expense-ocr-upload-button"
            >
              📷 {t("expenses.scanUpload") || "Scan hochladen"}
            </button>
            <input
              id="expense-ocr-input"
              type="file"
              accept="image/*,application/pdf,.xml,application/xml,text/xml"
              className="hidden"
              data-testid="expense-ocr-file-input"
              onChange={async (e) => {
                const inp = e.currentTarget
                const file = inp.files?.[0]
                if (!file) return
                const companyId =
                  localStorage.getItem("companyId") || ""
                if (!companyId) return
                // Tier 573: an XML is an e-invoice; a PDF may carry one
                // (ZUGFeRD / Factur-X) — then the invoice is read, not scanned.
                const isXml = /\.xml$/i.test(file.name) || /xml/.test(file.type)
                if (isXml) {
                  inp.value = ""
                  setEInvoice({ kind: "import", file })
                  return
                }
                setOcr({ step: "loading" })
                if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) {
                  try {
                    const probe = new FormData()
                    probe.append("file", file)
                    const res = await apiFetch(
                      `/api/v1/expenses/e-invoice/preview?companyId=${companyId}`,
                      { method: "POST", body: probe, throwOnError: false },
                    )
                    if (res.ok && (await res.json()).eInvoice) {
                      inp.value = ""
                      setOcr(null)
                      setEInvoice({ kind: "import", file })
                      return
                    }
                  } catch {
                    // not decidable — treat it as a scan
                  }
                }
                try {
                  const fd = new FormData()
                  fd.append("file", file)
                  // Tier 574: through apiFetch (session cookie, active company) like
                  // every other request — these were raw fetch() calls.
                  const res = await apiFetch(
                    `/api/v1/ocr/scan?companyId=${companyId}`,
                    { method: "POST", body: fd },
                  )
                  const data = await res.json()
                  // Is the supplier known? Only asked here (lookupOnly): a
                  // new supplier is created when the expense is, with the
                  // name as the user left it — not before anything is
                  // confirmed.
                  const msBody = await apiPost(
                    `/api/v1/ocr/match-supplier?companyId=${companyId}`,
                    {
                      vatId: data.supplierVatId || "",
                      name: data.supplierName || "",
                      lookupOnly: true,
                    },
                  ).catch(() => ({ supplierId: null, matchedBy: null }))
                  setOcr({
                    step: "preview",
                    data,
                    editable: {
                      supplierName:
                        data.supplierName || "",
                      invoiceNumber:
                        data.invoiceNumber || "",
                      invoiceDate:
                        // The OCR returns dates in
                        // German dd.mm.yyyy format,
                        // but <input type="date">
                        // requires ISO yyyy-MM-dd.
                        // Convert here so the input
                        // accepts the value AND the
                        // POST sends a valid date.
                        (data.invoiceDate &&
                        /^\d{2}\.\d{2}\.\d{4}$/.test(
                          data.invoiceDate,
                        )
                          ? data.invoiceDate
                              .split(".")
                              .reverse()
                              .join("-")
                          : "") ||
                        new Date()
                          .toISOString()
                          .slice(0, 10),
                      netAmount:
                        data.netAmount != null
                          ? String(data.netAmount)
                          : "",
                      vatRate:
                        data.vatRate != null
                          ? String(data.vatRate * 100)
                          : "19",
                      vatAmount:
                        data.vatAmount != null
                          ? String(data.vatAmount)
                          : "",
                      grossAmount:
                        data.grossAmount != null
                          ? String(data.grossAmount)
                          : "",
                      description:
                        data.supplierName
                          ? `${data.supplierName} — Rechnung ${data.invoiceNumber || ""}`
                          : "OCR import",
                    },
                    matchedSupplierId: msBody.supplierId,
                    matchedBy: msBody.matchedBy,
                    file,
                  })
                } catch (err: any) {
                  setOcr({
                    step: "error",
                    message: err?.message || "Unbekannter Fehler",
                  })
                } finally {
                  // Clear the file input so the
                  // same file can be re-picked.
                  inp.value = ""
                }
              }}
            />
            <button
              onClick={() => {
                const inp = document.getElementById(
                  "expense-einvoice-input",
                ) as HTMLInputElement | null
                inp?.click()
              }}
              className="px-3 py-1 text-sm border rounded hover:bg-gray-100 dark:hover:bg-gray-700"
              data-testid="expense-einvoice-upload-button"
            >
              🧾 {t("eInvoice.upload")}
            </button>
            <input
              id="expense-einvoice-input"
              type="file"
              accept=".xml,.pdf,application/xml,text/xml,application/pdf"
              className="hidden"
              data-testid="expense-einvoice-file-input"
              onChange={(e) => {
                const file = e.currentTarget.files?.[0]
                e.currentTarget.value = ""
                if (file) setEInvoice({ kind: "import", file })
              }}
            />
            <button
              onClick={() => router.push("/dashboard/import?entity=expense")}
              className="px-3 py-1 text-sm border rounded hover:bg-gray-100 dark:hover:bg-gray-700"
            >
              📥 Import
            </button>
          </div>
        </div>

        <Card className="mb-4">
          <CardContent className="pt-6">
            <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
              <input
                type="text"
                placeholder={t("expenses.searchPlaceholder")}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="border rounded px-3 py-2 text-sm"
                data-testid="expense-search-input"
              />
              <select
                value={supplierId}
                onChange={(e) => setSupplierId(e.target.value)}
                className="border rounded px-3 py-2 text-sm"
              >
                <option value="">{t("expenses.allSuppliers")}</option>
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              <select
                value={state}
                onChange={(e) =>
                  setState(
                    e.target.value as "" | "offen" | "bezahlt" | "storniert",
                  )
                }
                className="border rounded px-3 py-2 text-sm"
              >
                <option value="">{t("expenses.allStates")}</option>
                <option value="offen">{t("expenses.stateOffen")}</option>
                <option value="bezahlt">
                  {t("expenses.stateBezahlt")}
                </option>
                <option value="storniert">
                  {t("expenses.stateStorniert")}
                </option>
              </select>
              <button
                onClick={() => {
                  setSearch("")
                  setSupplierId("")
                  setState("")
                }}
                className="px-3 py-2 text-sm border rounded hover:bg-gray-100 dark:hover:bg-gray-700"
              >
                {t("common.reset")}
              </button>
            </div>
          </CardContent>
        </Card>

        {/* Aggregates strip */}
        <div className="grid grid-cols-2 md:grid-cols-6 gap-3 mb-4">
          <div className="bg-white dark:bg-gray-800 rounded-lg border p-3">
            <div className="text-xs text-gray-500 dark:text-gray-400 uppercase">Offen</div>
            <div className="text-lg font-bold mt-1 font-mono text-yellow-700 dark:text-yellow-300">
              {aggregates.offen}
            </div>
          </div>
          <div className="bg-white dark:bg-gray-800 rounded-lg border p-3">
            <div className="text-xs text-gray-500 dark:text-gray-400 uppercase">Bezahlt</div>
            <div className="text-lg font-bold mt-1 font-mono text-green-700 dark:text-green-300">
              {aggregates.bezahlt}
            </div>
          </div>
          <div className="bg-white dark:bg-gray-800 rounded-lg border p-3">
            <div className="text-xs text-gray-500 dark:text-gray-400 uppercase">Storniert</div>
            <div className="text-lg font-bold mt-1 font-mono text-red-700 dark:text-red-300">
              {aggregates.storniert}
            </div>
          </div>
          <div className="bg-white dark:bg-gray-800 rounded-lg border p-3">
            <div className="text-xs text-gray-500 dark:text-gray-400 uppercase">Σ Netto</div>
            <div className="text-lg font-bold mt-1 font-mono">
              {formatCurrency(aggregates.net.toFixed(2))}
            </div>
          </div>
          <div className="bg-white dark:bg-gray-800 rounded-lg border p-3">
            <div className="text-xs text-gray-500 dark:text-gray-400 uppercase">Σ Vorsteuer</div>
            <div className="text-lg font-bold mt-1 font-mono">
              {formatCurrency(aggregates.vat.toFixed(2))}
            </div>
          </div>
          <div className="bg-white dark:bg-gray-800 rounded-lg border p-3">
            <div className="text-xs text-gray-500 dark:text-gray-400 uppercase">Σ Brutto</div>
            <div className="text-lg font-bold mt-1 font-mono">
              {formatCurrency(aggregates.gross.toFixed(2))}
            </div>
          </div>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>
              {t("expenses.title")} — {filtered.length}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="space-y-4">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="h-12 bg-gray-100 dark:bg-gray-800 rounded animate-pulse" />
                ))}
              </div>
            ) : filtered.length === 0 ? (
              <div className="text-center py-12 text-gray-500 dark:text-gray-400">
                {t("expenses.empty")}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px]">
                  <thead>
                    <tr className="border-b">
                      <th className="text-left py-3 px-4 text-sm font-medium text-gray-500 dark:text-gray-400">
                        {t("expenses.invoiceDate")}
                      </th>
                      <th className="text-left py-3 px-4 text-sm font-medium text-gray-500 dark:text-gray-400">
                        {t("expenses.invoiceNumber")}
                      </th>
                      <th className="text-left py-3 px-4 text-sm font-medium text-gray-500 dark:text-gray-400">
                        {t("expenses.supplier")}
                      </th>
                      <th className="text-left py-3 px-4 text-sm font-medium text-gray-500 dark:text-gray-400">
                        Beschreibung
                      </th>
                      <th className="text-right py-3 px-4 text-sm font-medium text-gray-500 dark:text-gray-400">
                        {t("expenses.net")}
                      </th>
                      <th className="text-right py-3 px-4 text-sm font-medium text-gray-500 dark:text-gray-400">
                        {t("expenses.vat")}
                      </th>
                      <th className="text-right py-3 px-4 text-sm font-medium text-gray-500 dark:text-gray-400">
                        {t("expenses.gross")}
                      </th>
                      <th className="text-center py-3 px-4 text-sm font-medium text-gray-500 dark:text-gray-400">
                        Status
                      </th>
                      <th className="text-left py-3 px-4 text-sm font-medium text-gray-500 dark:text-gray-400">
                        {t("expenses.linkedVoucher")}
                      </th>
                      <th className="text-center py-3 px-4 text-sm font-medium text-gray-500 dark:text-gray-400">
                        {t("expenses.receiptsShort")}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((e) => (
                      <tr
                        key={e.id}
                        className="border-b hover:bg-gray-50 dark:bg-gray-900"
                        data-testid="expense-row"
                        data-expense-id={e.id}
                      >
                        <td className="py-3 px-4 text-sm">
                          {formatDate(e.invoiceDate)}
                        </td>
                        <td className="py-3 px-4 text-sm font-mono">
                          {e.invoiceNumber || "—"}
                        </td>
                        <td className="py-3 px-4 text-sm">
                          {e.supplier?.name || "—"}
                        </td>
                        <td className="py-3 px-4 text-sm text-gray-700 dark:text-gray-200">
                          {e.description}
                        </td>
                        <td className="py-3 px-4 text-sm text-right font-mono">
                          {formatCurrency(e.netAmount)}
                        </td>
                        <td className="py-3 px-4 text-sm text-right font-mono">
                          {formatCurrency(e.vatAmount)}
                          {(e.taxLines?.length ?? 0) > 1 && (
                            <div className="text-xs text-gray-500 dark:text-gray-400" data-testid="expense-rates" title={t("expenses.severalRates")}>
                              {e.taxLines!.map((l) => `${(Number(l.vatRate) * 100).toLocaleString("de-DE")} %`).join(" / ")}
                            </div>
                          )}
                        </td>
                        <td className="py-3 px-4 text-sm text-right font-mono font-bold">
                          {formatCurrency(e.grossAmount)}
                        </td>
                        <td className="py-3 px-4 text-center">
                          {stateBadge(e.paymentState)}
                        </td>
                        <td className="py-3 px-4 text-sm">
                          {e.linkedVoucher ? (
                            <button
                              onClick={() =>
                                router.push(
                                  `/dashboard/accounting/vouchers/${e.linkedVoucher!.id}`,
                                )
                              }
                              className={
                                "font-mono text-xs underline " +
                                (e.linkedVoucher.referenceType ===
                                "VoucherReversal"
                                  ? "text-red-700 dark:text-red-300"
                                  : "text-blue-700 dark:text-blue-300")
                              }
                            >
                              {e.linkedVoucher.voucherNumber}
                            </button>
                          ) : (
                            <span className="text-gray-400">
                              {t("expenses.noVoucher")}
                            </span>
                          )}
                        </td>
                        <td className="py-3 px-4 text-center">
                          {(() => {
                            const count = receiptCounts[e.id] ?? 0
                            return (
                              <button
                                onClick={() => setDetailExpense(e)}
                                data-testid={`expense-open-${e.id}`}
                                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs ${
                                  count > 0
                                    ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300 hover:bg-emerald-200 dark:hover:bg-emerald-900/50"
                                    : "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700"
                                }`}
                                title={t("expenses.attachmentCount").replace(
                                  "{count}",
                                  String(count),
                                )}
                              >
                                <span>📎</span>
                                <span>{count}</span>
                              </button>
                            )
                          })()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Receipts modal — opens on click of the
          📎 count badge in the row. Shows the
          ReceiptsPanel component, scoped to the
          selected expense. onChange refreshes the
          receiptCounts cache so the badge stays
          in sync after upload / delete. */}
      {creating && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50" data-testid="expense-create-modal">
          <Card className="w-full max-w-3xl max-h-[90vh] overflow-y-auto">
            <CardContent className="pt-6">
              <ExpenseEditForm
                create
                expense={BLANK_EXPENSE}
                suppliers={suppliers}
                onSaved={() => {
                  setCreating(false)
                  load()
                }}
              />
              <div className="flex justify-end">
                <Button variant="outline" size="sm" onClick={() => setCreating(false)} data-testid="expense-create-cancel">
                  {t("common.cancel")}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
      {detailExpense && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <Card className="w-full max-w-3xl max-h-[90vh] overflow-y-auto">
            <CardHeader>
              <CardTitle>
                {t("expenses.modalTitle")} — {detailExpense.invoiceNumber || detailExpense.id.slice(0, 8)}
              </CardTitle>
              <div className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                {detailExpense.supplier?.name || "—"} ·{" "}
                <span className="font-mono">{detailExpense.grossAmount} €</span>
              </div>
            </CardHeader>
            <CardContent>
              <ExpenseEditForm
                expense={detailExpense}
                suppliers={suppliers}
                onSaved={() => {
                  setDetailExpense(null)
                  load()
                }}
              />
              {detailHasEInvoice && (
                <div className="mt-4">
                  <Button
                    variant="outline"
                    onClick={() => setEInvoice({ kind: "view", expenseId: detailExpense.id })}
                    data-testid="expense-einvoice-view-button"
                  >
                    🧾 {t("eInvoice.show")}
                  </Button>
                </div>
              )}
              <ReceiptsPanel
                companyId={localStorage.getItem("companyId") || ""}
                entityType="expense"
                entityId={detailExpense.id}
                onChange={refreshReceiptCounts}
              />
              <div className="mt-4 flex justify-end">
                <Button variant="outline" onClick={() => setDetailExpense(null)}>
                  {t("common.close")}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Tier 29: OCR prefill modal. Shows
          when ocr state is non-null. Three
          states:
          - loading: small spinner overlay
          - preview: editable form fields +
            confirm/cancel buttons
          - error:   message + retry
          The confirm button POSTs the standard
          /api/v1/expenses endpoint with the
          (possibly edited) fields — the OCR
          pipeline is upstream of the create
          flow. */}
      {eInvoice && (
        <EInvoiceDialog
          mode={eInvoice}
          onClose={() => setEInvoice(null)}
          onImported={() => {
            load()
            loadSuppliers()
          }}
        />
      )}

      {ocr && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
          data-testid="ocr-modal"
        >
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-2xl w-full mx-4 max-h-[90vh] overflow-y-auto">
            <div className="p-6">
              {ocr.step === "loading" && (
                <div
                  className="flex flex-col items-center gap-3 py-12"
                  data-testid="ocr-loading"
                >
                  <div className="animate-spin h-8 w-8 border-2 border-blue-500 border-t-transparent rounded-full" />
                  <p className="text-sm text-gray-600 dark:text-gray-300">
                    {t("expenses.ocrAnalyzing") ||
                      "Scan wird analysiert…"}
                  </p>
                </div>
              )}
              {ocr.step === "error" && (
                <div data-testid="ocr-error">
                  <h3 className="text-lg font-semibold mb-2 text-red-700">
                    {t("expenses.ocrError") || "Fehler bei der Erkennung"}
                  </h3>
                  <p className="text-sm text-gray-700 dark:text-gray-300 mb-4">
                    {ocr.message}
                  </p>
                  <div className="flex justify-end gap-2">
                    <Button
                      variant="outline"
                      onClick={() => setOcr(null)}
                    >
                      {t("common.close")}
                    </Button>
                  </div>
                </div>
              )}
              {ocr.step === "preview" && (
                <div data-testid="ocr-preview">
                  <h3 className="text-lg font-semibold mb-1">
                    {t("expenses.ocrPreview") ||
                      "Erkannte Daten prüfen"}
                  </h3>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
                    {ocr.matchedBy === "vatId" &&
                      (t("expenses.ocrMatchedByVatId") ||
                        "✓ Lieferant per USt-ID erkannt")}
                    {ocr.matchedBy === "name" &&
                      (t("expenses.ocrMatchedByName") ||
                        "✓ Lieferant per Name erkannt")}
                    {ocr.matchedBy === "created" &&
                      (t("expenses.ocrCreatedNew") ||
                        "+ Neuer Lieferant angelegt")}
                    {/* Tier 574: nothing is created before the confirmation */}
                    {ocr.matchedBy === null &&
                      (ocr.editable.supplierName.trim() || ocr.data.supplierVatId
                        ? t("expenses.ocrWillCreate")
                        : t("expenses.ocrNoSupplierMatch") ||
                          "⚠ Kein Lieferant zugeordnet")}
                  </p>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
                    <div>
                      <label className="block text-xs font-medium mb-1">
                        {t("expenses.ocrSupplier") || "Lieferant"}
                      </label>
                      <input
                        type="text"
                        className="w-full border rounded px-2 py-1 text-sm"
                        value={ocr.editable.supplierName}
                        onChange={(e) =>
                          setOcr({
                            ...ocr,
                            editable: {
                              ...ocr.editable,
                              supplierName: e.target.value,
                            },
                          })
                        }
                        data-testid="ocr-field-supplier"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium mb-1">
                        {t("expenses.ocrInvoiceNumber") || "Rechnungsnummer"}
                      </label>
                      <input
                        type="text"
                        className="w-full border rounded px-2 py-1 text-sm"
                        value={ocr.editable.invoiceNumber}
                        onChange={(e) =>
                          setOcr({
                            ...ocr,
                            editable: {
                              ...ocr.editable,
                              invoiceNumber: e.target.value,
                            },
                          })
                        }
                        data-testid="ocr-field-invoice-number"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium mb-1">
                        {t("expenses.ocrInvoiceDate") || "Rechnungsdatum"}
                      </label>
                      <input
                        type="date"
                        className="w-full border rounded px-2 py-1 text-sm"
                        value={ocr.editable.invoiceDate}
                        onChange={(e) =>
                          setOcr({
                            ...ocr,
                            editable: {
                              ...ocr.editable,
                              invoiceDate: e.target.value,
                            },
                          })
                        }
                        data-testid="ocr-field-date"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium mb-1">
                        {t("expenses.ocrGross") || "Brutto (€)"}
                      </label>
                      <input
                        type="number"
                        step="0.01"
                        className="w-full border rounded px-2 py-1 text-sm"
                        value={ocr.editable.grossAmount}
                        onChange={(e) =>
                          setOcr({
                            ...ocr,
                            editable: {
                              ...ocr.editable,
                              grossAmount: e.target.value,
                            },
                          })
                        }
                        data-testid="ocr-field-gross"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium mb-1">
                        {t("expenses.ocrNet") || "Netto (€)"}
                      </label>
                      <input
                        type="number"
                        step="0.01"
                        className="w-full border rounded px-2 py-1 text-sm"
                        value={ocr.editable.netAmount}
                        onChange={(e) =>
                          setOcr({
                            ...ocr,
                            editable: {
                              ...ocr.editable,
                              netAmount: e.target.value,
                            },
                          })
                        }
                        data-testid="ocr-field-net"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium mb-1">
                        {t("expenses.ocrVat") || "USt %"}
                      </label>
                      <input
                        type="number"
                        step="0.01"
                        className="w-full border rounded px-2 py-1 text-sm"
                        value={ocr.editable.vatRate}
                        onChange={(e) =>
                          setOcr({
                            ...ocr,
                            editable: {
                              ...ocr.editable,
                              vatRate: e.target.value,
                            },
                          })
                        }
                        data-testid="ocr-field-vat-rate"
                      />
                    </div>
                  </div>
                  <details className="mb-4">
                    <summary className="text-xs text-gray-500 dark:text-gray-400 cursor-pointer">
                      {t("expenses.ocrShowRawText") ||
                        "OCR Rohtext anzeigen"}
                    </summary>
                    <pre
                      className="mt-2 text-xs bg-gray-50 dark:bg-gray-900 p-2 rounded overflow-x-auto whitespace-pre-wrap"
                      data-testid="ocr-raw-text"
                    >
                      {ocr.data.rawText}
                    </pre>
                  </details>
                  <div className="flex justify-end gap-2">
                    <Button
                      variant="outline"
                      onClick={() => setOcr(null)}
                    >
                      {t("common.cancel")}
                    </Button>
                    <Button
                      onClick={async () => {
                        const companyId =
                          localStorage.getItem("companyId") || ""
                        if (!companyId) return
                        const picked = ocr
                        setOcr({ step: "saving" })
                        try {
                          // Tier 574: the supplier is created now, on
                          // confirmation, under the name as edited.
                          let supplierId = picked.matchedSupplierId
                          const supplierName = picked.editable.supplierName.trim()
                          if (!supplierId && (supplierName || picked.data.supplierVatId)) {
                            const made = await apiPost(
                              `/api/v1/ocr/match-supplier?companyId=${companyId}`,
                              { vatId: picked.data.supplierVatId || "", name: supplierName },
                            )
                            supplierId = made.supplierId
                          }
                          const created = await apiPost(
                            `/api/v1/expenses?companyId=${companyId}`,
                            {
                              description:
                                picked.editable.description ||
                                [supplierName, picked.editable.invoiceNumber]
                                  .filter(Boolean)
                                  .join(" — ") ||
                                "OCR-Scan",
                              invoiceDate: picked.editable.invoiceDate,
                              ...(picked.editable.invoiceNumber
                                ? { invoiceNumber: picked.editable.invoiceNumber }
                                : {}),
                              ...(supplierId ? { supplierId } : {}),
                              netAmount: parseFloat(picked.editable.netAmount),
                              vatRate: parseFloat(picked.editable.vatRate) / 100,
                              vatAmount: parseFloat(picked.editable.vatAmount),
                              grossAmount: parseFloat(picked.editable.grossAmount),
                            },
                          )
                          // The scan is the Beleg: it is kept with the
                          // expense (it used to be read and thrown away).
                          const beleg = new FormData()
                          beleg.append("file", picked.file)
                          beleg.append("companyId", companyId)
                          beleg.append("entityType", "expense")
                          beleg.append("entityId", created.id)
                          try {
                            await apiFetch("/api/v1/attachments", { method: "POST", body: beleg })
                          } catch (attachErr: any) {
                            // the expense exists; say that its Beleg is missing
                            await load()
                            setOcr({
                              step: "error",
                              message: `${t("expenses.ocrScanNotKept")} ${attachErr?.message || ""}`,
                            })
                            return
                          }
                          setOcr(null)
                          // Refresh the list to show
                          // the new row.
                          await load()
                        } catch (err: any) {
                          setOcr({
                            step: "error",
                            message: err?.message || "Unbekannter Fehler",
                          })
                        }
                      }}
                      data-testid="ocr-confirm-button"
                    >
                      {t("expenses.ocrConfirm") || "Expense anlegen"}
                    </Button>
                  </div>
                </div>
              )}
              {ocr.step === "saving" && (
                <div
                  className="flex flex-col items-center gap-3 py-12"
                  data-testid="ocr-saving"
                >
                  <div className="animate-spin h-8 w-8 border-2 border-blue-500 border-t-transparent rounded-full" />
                  <p className="text-sm text-gray-600 dark:text-gray-300">
                    {t("expenses.ocrSaving") ||
                      "Expense wird gespeichert…"}
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </main>
  )
}
