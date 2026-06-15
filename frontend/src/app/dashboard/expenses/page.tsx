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
      setItems(Array.isArray(data) ? data : [])
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
    <main className="min-h-screen bg-gray-50 dark:bg-gray-900 p-6">
      <div className="max-w-7xl mx-auto">
        <div className="flex justify-between items-center mb-6">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
              {t("expenses.title")}
            </h1>
            <p className="text-sm text-gray-600 dark:text-gray-300 mt-1">
              {t("expenses.subtitle")}
            </p>
          </div>
          <div className="flex gap-2 items-center">
            <LanguageSwitcher />
            <button
              onClick={() => router.push("/dashboard")}
              className="px-3 py-1 text-sm border rounded hover:bg-gray-100 dark:hover:bg-gray-700"
            >
              {t("common.back")}
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
                <table className="w-full">
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
    </main>
  )
}
