"use client"

import { useEffect, useState, useCallback, useMemo } from "react"
import { useRouter } from "next/navigation"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import LanguageSwitcher from "@/components/LanguageSwitcher"
import { useI18n } from "@/components/useI18n"
import { apiGet } from "@/lib/api"
import { ReceiptsPanel } from "@/components/ReceiptsPanel"

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
  const { t, locale, getDateLocale } = useI18n()
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
              accept="image/*,application/pdf"
              className="hidden"
              data-testid="expense-ocr-file-input"
              onChange={async (e) => {
                const inp = e.currentTarget
                const file = inp.files?.[0]
                if (!file) return
                const companyId =
                  localStorage.getItem("companyId") || ""
                if (!companyId) return
                setOcr({ step: "loading" })
                try {
                  const fd = new FormData()
                  fd.append("file", file)
                  const url = `${process.env.NEXT_PUBLIC_API_URL || ""}/api/v1/ocr/scan?companyId=${companyId}`
                  const res = await fetch(url,
                    {
                      method: "POST",
                      headers: {
                        "x-user-id":
                          localStorage.getItem("userId") || "",
                        "x-company-id": companyId,
                      },
                      body: fd,
                    },
                  )
                  if (!res.ok) {
                    const txt = await res.text()
                    throw new Error(
                      `${res.status} ${res.statusText} — ${txt}`,
                    )
                  }
                  const data = await res.json()
                  // Call match-supplier to find or
                  // create the Supplier. The OCR
                  // backend owns the matching
                  // logic (VAT-ID first, then name)
                  // — see ocr.controller.ts.
                  const ms = await fetch(
                    `${process.env.NEXT_PUBLIC_API_URL || ""}/api/v1/ocr/match-supplier?companyId=${companyId}`,
                    {
                      method: "POST",
                      headers: {
                        "Content-Type": "application/json",
                        "x-user-id":
                          localStorage.getItem("userId") || "",
                        "x-company-id": companyId,
                      },
                      body: JSON.stringify({
                        vatId: data.supplierVatId || "",
                        name: data.supplierName || "",
                      }),
                    },
                  )
                  const msBody = ms.ok
                    ? await ms.json()
                    : { supplierId: null, matchedBy: null }
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
                    {ocr.matchedBy === null &&
                      (t("expenses.ocrNoSupplierMatch") ||
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
                        setOcr({ step: "saving" })
                        try {
                          const res = await fetch(
                            `${process.env.NEXT_PUBLIC_API_URL || ""}/api/v1/expenses?companyId=${companyId}`,
                            {
                              method: "POST",
                              headers: {
                                "Content-Type": "application/json",
                                "x-user-id":
                                  localStorage.getItem("userId") || "",
                                "x-company-id": companyId,
                              },
                              body: JSON.stringify({
                                description:
                                  ocr.editable.description ||
                                  // Auto-fill from OCR fields
                                  // when the user didn't enter a
                                  // description manually. The
                                  // backend rejects empty
                                  // description (Beschreibung ist
                                  // erforderlich).
                                  [
                                    ocr.editable.supplierName,
                                    ocr.editable.invoiceNumber,
                                  ]
                                    .filter(Boolean)
                                    .join(" — ") ||
                                  "OCR-Scan",
                                invoiceDate:
                                  ocr.editable.invoiceDate,
                                invoiceNumber:
                                  ocr.editable.invoiceNumber || null,
                                supplierId:
                                  ocr.matchedSupplierId || null,
                                netAmount: parseFloat(
                                  ocr.editable.netAmount,
                                ),
                                vatRate:
                                  parseFloat(ocr.editable.vatRate) / 100,
                                vatAmount: parseFloat(
                                  ocr.editable.vatAmount,
                                ),
                                grossAmount: parseFloat(
                                  ocr.editable.grossAmount,
                                ),
                              }),
                            },
                          )
                          if (!res.ok) {
                            const t = await res.text()
                            throw new Error(
                              `${res.status} ${res.statusText} — ${t}`,
                            )
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
