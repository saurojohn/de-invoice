"use client"

import { useEffect, useState, useCallback, useMemo } from "react"
import { useRouter } from "next/navigation"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import LanguageSwitcher from "@/components/LanguageSwitcher"
import { useI18n } from "@/components/useI18n"
import { apiGet, apiPost } from "@/lib/api"

// The enriched Voucher summary returned by the
// GET /api/v1/accounting/vouchers endpoint. The list
// page doesn't pull the full line breakdown — it gets
// pre-aggregated Soll/Haben totals and the primary
// account (the line with the largest single amount,
// typically the Sachkonto).
interface VoucherSummary {
  id: string
  voucherNumber: string
  date: string
  description: string | null
  referenceType: string | null
  status: string
  totalDebit: string
  totalCredit: string
  balanced: boolean
  primaryAccount: string
  createdAt: string
}

interface VoucherListResponse {
  items: VoucherSummary[]
  total: number
}

interface Account {
  id: string
  accountNumber: string
  name: string
  type: string
  category: string | null
}

// One row in the "Neuer Beleg" modal. The user
// picks an account + debit/credit amounts. Soll
// and Haben on the same row are mutually exclusive
// (a single line is either debit or credit, never
// both — that's how a real Buchungssatz is read).
interface DraftLine {
  accountId: string
  debit: string
  credit: string
  description: string
}

// All referenceTypes we currently emit. Used to populate
// the filter dropdown and to translate the badge.
const REFERENCE_TYPE_LABELS: Record<string, string> = {
  BankReconciliation: "Bank",
  BankReconciliationReversal: "Storno",
  BankTransaction: "Bank",
  Expense: "Eingangsrechnung",
  Invoice: "Rechnung",
  Manual: "Manuell",
}

export default function AccountingPage() {
  const router = useRouter()
  const { t, locale, getDateLocale } = useI18n()
  const [vouchers, setVouchers] = useState<VoucherSummary[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState("")
  // Debounce the search input — the user types fast and
  // a 200ms buffer avoids one fetch per keystroke.
  const [debouncedSearch, setDebouncedSearch] = useState("")
  const [referenceType, setReferenceType] = useState("")
  const [status, setStatus] = useState("")

  // Manual-voucher modal state
  const [showCreate, setShowCreate] = useState(false)
  const [accounts, setAccounts] = useState<Account[]>([])
  const [draftDate, setDraftDate] = useState(new Date().toISOString().slice(0, 10))
  const [draftDescription, setDraftDescription] = useState("")
  const [draftLines, setDraftLines] = useState<DraftLine[]>([
    { accountId: "", debit: "", credit: "", description: "" },
    { accountId: "", debit: "", credit: "", description: "" },
  ])
  const [createError, setCreateError] = useState<string | null>(null)
  const [createSaving, setCreateSaving] = useState(false)

  // Push user input into the debounced field after 200ms.
  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(search), 200)
    return () => clearTimeout(id)
  }, [search])

  const load = useCallback(async () => {
    const companyId = localStorage.getItem("companyId")
    if (!companyId) {
      router.push("/login")
      return
    }
    setLoading(true)
    const params = new URLSearchParams({ companyId, take: "200" })
    if (debouncedSearch) params.set("search", debouncedSearch)
    if (referenceType) params.set("referenceType", referenceType)
    if (status) params.set("status", status)
    try {
      const data = await apiGet(`/api/v1/accounting/vouchers?${params.toString()}`)
      const resp = data as VoucherListResponse
      setVouchers(resp?.items ?? [])
      setTotal(resp?.total ?? 0)
    } catch (e) {
      console.error("vouchers load failed", e)
      setVouchers([])
      setTotal(0)
    } finally {
      setLoading(false)
    }
  }, [router, debouncedSearch, referenceType, status])

  useEffect(() => {
    load()
  }, [load])

  // Load the chart of accounts for the manual-
  // voucher modal. Fetches the full list — there
  // are typically 50-200 SKR03 accounts, well
  // within fetch size.
  const loadAccounts = useCallback(async () => {
    const companyId = localStorage.getItem("companyId")
    if (!companyId) return
    try {
      const data = await apiGet(`/api/v1/accounting/accounts?companyId=${companyId}`)
      setAccounts(Array.isArray(data) ? data : [])
    } catch (e) {
      console.error("accounts load failed", e)
    }
  }, [])
  useEffect(() => {
    loadAccounts()
  }, [loadAccounts])

  // Live Soll/Haben balance of the draft lines.
  // The user gets immediate feedback as they fill
  // the modal — green check when balanced, red
  // delta when not. 0.01 EUR tolerance for
  // rounding.
  const draftBalance = useMemo(() => {
    let d = 0
    let c = 0
    for (const l of draftLines) {
      d += parseFloat(l.debit || "0")
      c += parseFloat(l.credit || "0")
    }
    return { debit: d, credit: c, balanced: Math.abs(d - c) < 0.01 }
  }, [draftLines])

  const openCreate = () => {
    // Reset the draft each time the modal opens.
    setDraftDate(new Date().toISOString().slice(0, 10))
    setDraftDescription("")
    setDraftLines([
      { accountId: "", debit: "", credit: "", description: "" },
      { accountId: "", debit: "", credit: "", description: "" },
    ])
    setCreateError(null)
    setShowCreate(true)
  }

  const addLine = () => {
    setDraftLines((prev) => [
      ...prev,
      { accountId: "", debit: "", credit: "", description: "" },
    ])
  }
  const removeLine = (idx: number) => {
    setDraftLines((prev) => prev.filter((_, i) => i !== idx))
  }
  const updateLine = (idx: number, patch: Partial<DraftLine>) => {
    setDraftLines((prev) =>
      prev.map((l, i) => (i === idx ? { ...l, ...patch } : l)),
    )
  }

  const saveDraft = async () => {
    const companyId = localStorage.getItem("companyId")
    if (!companyId) return
    // Validation
    if (!draftDate) {
      setCreateError("Datum fehlt")
      return
    }
    if (draftLines.length < 2) {
      setCreateError("Mindestens 2 Positionen erforderlich")
      return
    }
    if (draftLines.some((l) => !l.accountId)) {
      setCreateError(t("accounting.noAccount"))
      return
    }
    if (!draftBalance.balanced) {
      setCreateError(t("accounting.unbalancedWarning"))
      return
    }
    setCreateError(null)
    setCreateSaving(true)
    try {
      await apiPost(`/api/v1/accounting/vouchers`, {
        companyId,
        date: draftDate,
        description: draftDescription || null,
        referenceType: "Manual",
        status: "posted",
        lines: draftLines.map((l) => ({
          accountId: l.accountId,
          debit: parseFloat(l.debit || "0"),
          credit: parseFloat(l.credit || "0"),
          description: l.description || null,
        })),
      })
      setShowCreate(false)
      // Reload the list so the new voucher shows.
      load()
    } catch (e: any) {
      console.error("voucher create failed", e)
      setCreateError(
        e?.response?.data?.message || e?.message || "Fehler beim Anlegen",
      )
    } finally {
      setCreateSaving(false)
    }
  }

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleDateString(getDateLocale())
  }

  const formatCurrency = (amount: string) => {
    const n = parseFloat(amount || "0")
    // Number format locale follows the same mapping as
    // getDateLocale() — DE uses 1.234,56 €, EN uses
    // €1,234.56, ZH uses €1,234.56 (but most Chinese
    // users prefer the Western thousand separator, not
    // the Chinese 万 grouping, since EUR is a foreign
    // currency to them).
    const intlLocale =
      locale === "de" ? "de-DE" : locale === "zh" ? "en-US" : "en-US"
    return new Intl.NumberFormat(intlLocale, {
      style: "currency",
      currency: "EUR",
    }).format(n)
  }

  // Aggregated summary at the top: total debit, total
  // credit, count of unbalanced. Lets the Berater spot
  // data-entry mistakes at a glance.
  const aggregates = useMemo(() => {
    let d = 0
    let c = 0
    let unbalanced = 0
    for (const v of vouchers) {
      d += parseFloat(v.totalDebit || "0")
      c += parseFloat(v.totalCredit || "0")
      if (!v.balanced) unbalanced += 1
    }
    return { d, c, unbalanced }
  }, [vouchers])

  const getStatusLabel = (s: string) => {
    const labels: Record<string, string> = {
      draft: t("accounting.draft"),
      booked: t("accounting.posted") || "Gebucht",
      posted: t("accounting.posted"),
      voided: t("accounting.voided"),
    }
    return labels[s] || s
  }
  const getStatusColor = (s: string) => {
    const colors: Record<string, string> = {
      draft: "bg-gray-100 text-gray-700",
      booked: "bg-green-100 text-green-700",
      posted: "bg-green-100 text-green-700",
      voided: "bg-red-100 text-red-700",
    }
    return colors[s] || colors.draft
  }

  return (
    <main className="min-h-screen bg-gray-50 p-6">
      <div className="max-w-7xl mx-auto">
        <div className="flex justify-between items-center mb-6">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">
              {t("accounting.vouchers")}
            </h1>
            <p className="text-sm text-gray-600 mt-1">
              {t("accounting.voucherList")} — {t("accounting.voucherJournalHint")}
            </p>
          </div>
          <div className="flex gap-2 items-center">
            <Button
              onClick={openCreate}
              className="bg-emerald-600 text-white hover:bg-emerald-700"
            >
              + {t("accounting.newVoucher")}
            </Button>
            <button
              onClick={() => router.push("/dashboard/accounting/ustva")}
              className="px-3 py-1 text-sm border border-blue-600 text-blue-700 rounded hover:bg-blue-50 font-medium"
              title="UStVA — Umsatzsteuervoranmeldung"
            >
              UStVA
            </button>
            <LanguageSwitcher />
            <button
              onClick={() => router.push("/dashboard")}
              className="px-3 py-1 text-sm border rounded hover:bg-gray-100"
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
                placeholder={t("accounting.searchVoucher")}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="border rounded px-3 py-2 text-sm"
              />
              <select
                value={referenceType}
                onChange={(e) => setReferenceType(e.target.value)}
                className="border rounded px-3 py-2 text-sm"
              >
                <option value="">{t("accounting.allTypes")}</option>
                {Object.keys(REFERENCE_TYPE_LABELS).map((rt) => (
                  <option key={rt} value={rt}>
                    {REFERENCE_TYPE_LABELS[rt]}
                  </option>
                ))}
              </select>
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value)}
                className="border rounded px-3 py-2 text-sm"
              >
                <option value="">{t("accounting.allStatuses")}</option>
                <option value="draft">Entwurf</option>
                <option value="booked">Gebucht</option>
                <option value="voided">Storniert</option>
              </select>
              <Button
                variant="outline"
                onClick={() => {
                  setSearch("")
                  setReferenceType("")
                  setStatus("")
                }}
              >
                {t("common.reset")}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Aggregates strip */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mb-4">
          <div className="bg-white rounded-lg border p-4">
            <div className="text-xs text-gray-500 uppercase">
              {t("accounting.countShown")}
            </div>
            <div className="text-xl font-bold mt-1 font-mono">
              {vouchers.length} / {total}
            </div>
          </div>
          <div className="bg-white rounded-lg border p-4">
            <div className="text-xs text-gray-500 uppercase">Σ Soll</div>
            <div className="text-xl font-bold mt-1 font-mono">
              {formatCurrency(aggregates.d.toFixed(2))}
            </div>
          </div>
          <div className="bg-white rounded-lg border p-4">
            <div className="text-xs text-gray-500 uppercase">Σ Haben</div>
            <div className="text-xl font-bold mt-1 font-mono">
              {formatCurrency(aggregates.c.toFixed(2))}
            </div>
          </div>
          <div
            className={
              "rounded-lg border p-4 " +
              (aggregates.unbalanced > 0
                ? "bg-red-50 border-red-300"
                : "bg-white")
            }
          >
            <div className="text-xs text-gray-500 uppercase">
              {t("accounting.unbalanced")}
            </div>
            <div
              className={
                "text-xl font-bold mt-1 font-mono " +
                (aggregates.unbalanced > 0 ? "text-red-700" : "")
              }
            >
              {aggregates.unbalanced}
            </div>
          </div>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>{t("accounting.voucherList")}</CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="space-y-4">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="h-16 bg-gray-100 rounded animate-pulse" />
                ))}
              </div>
            ) : vouchers.length === 0 ? (
              <div className="text-center py-12 text-gray-500">
                {t("common.noData")}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b">
                      <th className="text-left py-3 px-4 text-sm font-medium text-gray-500">
                        {t("accounting.voucherNumber")}
                      </th>
                      <th className="text-left py-3 px-4 text-sm font-medium text-gray-500">
                        {t("accounting.voucherDate")}
                      </th>
                      <th className="text-left py-3 px-4 text-sm font-medium text-gray-500">
                        {t("accounting.description")}
                      </th>
                      <th className="text-center py-3 px-4 text-sm font-medium text-gray-500">
                        {t("accounting.primaryAccount")}
                      </th>
                      <th className="text-right py-3 px-4 text-sm font-medium text-gray-500">
                        {t("accounting.total")}
                      </th>
                      <th className="text-center py-3 px-4 text-sm font-medium text-gray-500">
                        {t("accounting.balanced")}
                      </th>
                      <th className="text-center py-3 px-4 text-sm font-medium text-gray-500">
                        {t("accounting.status")}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {vouchers.map((v) => (
                      <tr
                        key={v.id}
                        className="border-b hover:bg-gray-50 cursor-pointer"
                        onClick={() =>
                          router.push(`/dashboard/accounting/vouchers/${v.id}`)
                        }
                      >
                        <td className="py-3 px-4 font-mono text-sm">
                          {v.voucherNumber}
                        </td>
                        <td className="py-3 px-4 text-sm">
                          {formatDate(v.date)}
                        </td>
                        <td className="py-3 px-4 text-sm text-gray-600">
                          {v.description || "-"}
                        </td>
                        <td className="py-3 px-4 text-center">
                          <span className="font-mono text-xs bg-gray-100 rounded px-2 py-1">
                            {v.primaryAccount}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-sm text-right font-mono">
                          {formatCurrency(v.totalDebit)}
                        </td>
                        <td className="py-3 px-4 text-center">
                          {v.balanced ? (
                            <span
                              className="text-green-600"
                              title="Soll = Haben"
                            >
                              ✓
                            </span>
                          ) : (
                            <span
                              className="text-red-600 font-bold"
                              title="Soll ≠ Haben"
                            >
                              ✗
                            </span>
                          )}
                        </td>
                        <td className="py-3 px-4 text-center">
                          <Badge className={getStatusColor(v.status)}>
                            {getStatusLabel(v.status)}
                          </Badge>
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

      {/* Manual-voucher create modal */}
      {showCreate && (
        <div className="fixed inset-0 bg-black bg-opacity-40 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-4xl p-6 max-h-[90vh] overflow-y-auto">
            <h2 className="text-xl font-bold mb-1">
              {t("accounting.createManual")}
            </h2>
            <p className="text-xs text-gray-500 mb-4">
              {t("accounting.reverseHint")}
            </p>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
              <div>
                <label className="text-xs text-gray-500 uppercase">
                  {t("accounting.voucherDate")}
                </label>
                <input
                  type="date"
                  value={draftDate}
                  onChange={(e) => setDraftDate(e.target.value)}
                  className="w-full border rounded px-3 py-2 text-sm mt-1"
                />
              </div>
              <div>
                <label className="text-xs text-gray-500 uppercase">
                  {t("accounting.voucherDescription")}
                </label>
                <input
                  type="text"
                  value={draftDescription}
                  onChange={(e) => setDraftDescription(e.target.value)}
                  placeholder="z.B. Reisekosten, Korrektur, Abgrenzung"
                  className="w-full border rounded px-3 py-2 text-sm mt-1"
                />
              </div>
            </div>

            <div className="border rounded-lg overflow-hidden">
              <table className="w-full">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="text-left px-3 py-2 text-xs font-medium text-gray-500">
                      {t("accounting.account")}
                    </th>
                    <th className="text-left px-3 py-2 text-xs font-medium text-gray-500 w-32">
                      {t("accounting.debit")}
                    </th>
                    <th className="text-left px-3 py-2 text-xs font-medium text-gray-500 w-32">
                      {t("accounting.credit")}
                    </th>
                    <th className="text-left px-3 py-2 text-xs font-medium text-gray-500">
                      Beschreibung
                    </th>
                    <th className="w-10"></th>
                  </tr>
                </thead>
                <tbody>
                  {draftLines.map((line, idx) => (
                    <tr key={idx} className="border-t">
                      <td className="px-3 py-1">
                        <select
                          value={line.accountId}
                          onChange={(e) =>
                            updateLine(idx, { accountId: e.target.value })
                          }
                          className="w-full border rounded px-2 py-1 text-sm"
                        >
                          <option value="">— Konto wählen —</option>
                          {accounts.map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.accountNumber} {a.name}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="px-3 py-1">
                        <input
                          type="number"
                          step="0.01"
                          value={line.debit}
                          onChange={(e) =>
                            updateLine(idx, { debit: e.target.value })
                          }
                          className="w-full border rounded px-2 py-1 text-sm text-right font-mono"
                          placeholder="0,00"
                        />
                      </td>
                      <td className="px-3 py-1">
                        <input
                          type="number"
                          step="0.01"
                          value={line.credit}
                          onChange={(e) =>
                            updateLine(idx, { credit: e.target.value })
                          }
                          className="w-full border rounded px-2 py-1 text-sm text-right font-mono"
                          placeholder="0,00"
                        />
                      </td>
                      <td className="px-3 py-1">
                        <input
                          type="text"
                          value={line.description}
                          onChange={(e) =>
                            updateLine(idx, { description: e.target.value })
                          }
                          className="w-full border rounded px-2 py-1 text-sm"
                          placeholder="optional"
                        />
                      </td>
                      <td className="px-3 py-1 text-center">
                        {draftLines.length > 2 && (
                          <button
                            onClick={() => removeLine(idx)}
                            className="text-red-600 hover:text-red-800"
                            title={t("accounting.removeLine")}
                          >
                            ×
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-gray-50 border-t-2 border-gray-300">
                  <tr>
                    <td className="px-3 py-2 text-xs font-medium text-gray-600 uppercase">
                      Summe
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-sm font-bold">
                      {formatCurrency(draftBalance.debit.toFixed(2))}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-sm font-bold">
                      {formatCurrency(draftBalance.credit.toFixed(2))}
                    </td>
                    <td
                      colSpan={2}
                      className={
                        "px-3 py-2 text-right text-sm font-bold " +
                        (draftBalance.balanced
                          ? "text-green-700"
                          : "text-red-700")
                      }
                    >
                      {draftBalance.balanced
                        ? "✓ " + t("accounting.balanced")
                        : `Δ ${formatCurrency(
                            Math.abs(
                              draftBalance.debit - draftBalance.credit,
                            ).toFixed(2),
                          )}`}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>

            <div className="flex justify-between items-center mt-3">
              <Button variant="outline" onClick={addLine}>
                + {t("accounting.addLine")}
              </Button>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={() => setShowCreate(false)}
                  disabled={createSaving}
                >
                  {t("accounting.cancel")}
                </Button>
                <Button
                  onClick={saveDraft}
                  disabled={createSaving || !draftBalance.balanced}
                  className="bg-emerald-600 text-white hover:bg-emerald-700"
                >
                  {createSaving ? "…" : t("accounting.save")}
                </Button>
              </div>
            </div>

            {createError && (
              <div className="mt-3 p-3 bg-red-50 border border-red-300 rounded text-sm text-red-800">
                {createError}
              </div>
            )}
          </div>
        </div>
      )}
     </main>
  )
}
