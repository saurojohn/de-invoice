"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import LanguageSwitcher from "@/components/LanguageSwitcher"
import { useI18n } from "@/components/useI18n"
import { apiGet, apiPost, apiDelete, apiFetch } from "@/lib/api"

interface BankStatement {
  id: string
  format: string
  fileName: string
  fileSize: number
  accountIban: string | null
  periodFrom: string | null
  periodTo: string | null
  openingBalance: string | null
  closingBalance: string | null
  createdAt: string
  _count?: { transactions: number }
}

interface BankTransaction {
  id: string
  statementId: string
  valueDate: string
  entryDate: string | null
  amount: string
  currency: string
  counterpartyName: string | null
  counterpartyIban: string | null
  purpose: string | null
  endToEndId: string | null
  // voucher: present when this debit transaction was
  // booked as an expense (the auto VoucherService flow).
  // Credit transactions carry their voucher on the
  // BankReconciliation row, not on the txn itself.
  voucher: {
    id: string
    voucherNumber: string
    date: string
  } | null
}

interface Candidate {
  invoiceId: string
  invoiceNumber: string
  customerName: string
  customerNumber: string | null
  total: number
  dueDate: string | null
  confidence: number
  matchReason: string
}

interface Reconciliation {
  id: string
  bankTransactionId: string
  invoiceId: string
  appliedAmount: string
  status: "suggested" | "confirmed" | "rejected" | "reopened"
  confidence: number
  matchReason: string | null
  invoice: {
    invoiceNumber: string
    total: string
    customer: { name: string }
  }
  voucher: {
    id: string
    voucherNumber: string
    date: string
  } | null
  // Storno voucher, if this recon was reopened at
  // some point. The UI shows "BK-A reverted by
  // BK-B" when both are present. NULL on a
  // fresh-or-suggested recon.
  reversalVoucher: {
    id: string
    voucherNumber: string
    date: string
  } | null
}

// Shape of /api/v1/bank-statements/preview — the
// parse-only response that the import button shows
// before the user actually commits to persisting
// the file.
interface PreviewResult {
  format: string
  accountIban: string | null
  bankName: string | null
  periodFrom: string | null
  periodTo: string | null
  openingBalance: string | null
  closingBalance: string | null
  totalTransactions: number
  totalDebit: string
  totalCredit: string
  balanceCheck: "ok" | "mismatch" | "unknown"
  sampleTransactions: {
    valueDate: string
    entryDate?: string | null
    amount: string
    currency: string
    counterpartyName: string | null
    counterpartyIban: string | null
    purpose: string | null
    endToEndId: string | null
  }[]
}

const fmtMoney = (n: number) =>
  n.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const fmtDate = (s: string | null | undefined, locale = "de-DE") =>
  s ? new Date(s).toLocaleDateString(locale, { day: "2-digit", month: "2-digit", year: "numeric" }) : "—"

export default function BankImportPage() {
  const router = useRouter()
  const { t, getDateLocale } = useI18n()
  const dl = getDateLocale()

  const [statements, setStatements] = useState<BankStatement[]>([])
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Pending import preview — when a file is selected
  // we PARSE-ONLY first and show the user the IBAN,
  // bank, period, balances + first N transactions
  // before persisting. The pending file + parsed
  // data live here until the user clicks "Bestätigen"
  // (then import) or "Abbrechen" (discard).
  const [pendingPreview, setPendingPreview] = useState<{
    file: File
    preview: PreviewResult
  } | null>(null)

  // Currently expanded statement + its transactions
  const [openId, setOpenId] = useState<string | null>(null)
  const [transactions, setTransactions] = useState<BankTransaction[]>([])
  const [loadingTx, setLoadingTx] = useState(false)

  // Selected transaction (for the candidates panel)
  const [selectedTxn, setSelectedTxn] = useState<BankTransaction | null>(null)
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [loadingCandidates, setLoadingCandidates] = useState(false)

  // Auto-suggest feedback
  const [suggestMsg, setSuggestMsg] = useState<string | null>(null)

  // Auto-confirm threshold (0-100). 0 = the safe default
  // — write a "suggested" recon and let the user click
  // Bestätigen manually. ≥80 enables auto-confirm for
  // matches scoring above the threshold. The Berater
  // can raise it to 95+ if the upstream bank always
  // includes the invoice number in the purpose.
  const [autoConfirmThreshold, setAutoConfirmThreshold] = useState<number>(0)

  // Reconciliations for the open statement (one per
  // suggested/confirmed/rejected match). Used to
  // render the "Bestätigen" / "Ablehnen" buttons and
  // the status badge next to each candidate.
  const [reconciliations, setReconciliations] = useState<Reconciliation[]>([])
  const [busyRecon, setBusyRecon] = useState<string | null>(null)

  /** Map of (txnId, invoiceId) → reconciliation. Used
   *  to look up the recon for a given candidate card. */
  const reconByPair = (txnId: string, invoiceId: string) =>
    reconciliations.find(
      (r) => r.bankTransactionId === txnId && r.invoiceId === invoiceId,
    )

  const loadReconciliations = async (statementId: string) => {
    const companyId = localStorage.getItem("companyId")!
    try {
      const list = await apiGet<Reconciliation[]>(
        `/api/v1/bank-statements/${statementId}/reconciliations?companyId=${companyId}`
      )
      setReconciliations(list || [])
    } catch (e) {
      console.error("Load reconciliations failed:", e)
      setReconciliations([])
    }
  }

  const confirmCandidate = async (reconId: string, invoiceNumber: string) => {
    if (!openId) return
    if (!confirm(t("bankImport.confirmCandidateConfirm").replace("{invoice}", invoiceNumber))) return
    const companyId = localStorage.getItem("companyId")!
    setBusyRecon(reconId)
    try {
      await apiPost(
        `/api/v1/bank-statements/reconciliations/${reconId}/confirm?companyId=${companyId}`,
        {}
      )
      await loadReconciliations(openId)
      // Refresh candidates: a paid invoice no longer
      // appears in the open-invoices list.
      if (selectedTxn) {
        const res = await apiGet<{ candidates: Candidate[] }>(
          `/api/v1/bank-statements/${openId}/transactions/${selectedTxn.id}/candidates?companyId=${companyId}`
        )
        setCandidates(res.candidates || [])
      }
    } catch (err: any) {
      alert(err?.message || "Bestätigen fehlgeschlagen")
    } finally {
      setBusyRecon(null)
    }
  }

  const rejectCandidate = async (reconId: string) => {
    if (!openId) return
    const companyId = localStorage.getItem("companyId")!
    setBusyRecon(reconId)
    try {
      await apiPost(
        `/api/v1/bank-statements/reconciliations/${reconId}/reject?companyId=${companyId}`,
        {}
      )
      await loadReconciliations(openId)
    } catch (err: any) {
      alert(err?.message || "Ablehnen fehlgeschlagen")
    } finally {
      setBusyRecon(null)
    }
  }

  /** Reopen a confirmed match. GoBD-correct path: the
   *  original Voucher stays in the books, a Storno
   *  Voucher is written that nets each account to
   *  zero, the Payment is removed, and the invoice
   *  flips back to "sent". The recon status becomes
   *  "reopened" so the audit trail shows the
   *  correction. */
  const reopenCandidate = async (reconId: string, invoiceNumber: string) => {
    if (!openId) return
    if (!confirm(t("bankImport.reopenCandidateConfirm").replace("{invoice}", invoiceNumber))) return
    const companyId = localStorage.getItem("companyId")!
    setBusyRecon(reconId)
    try {
      await apiPost(
        `/api/v1/bank-statements/reconciliations/${reconId}/reopen?companyId=${companyId}`,
        {}
      )
      // Reload recons (status changed) AND the
      // transaction list (the txn.voucher may have
      // changed for debit txns; for credit txns the
      // invoice is no longer paid so the candidates
      // list for the selected txn can be refreshed).
      await loadReconciliations(openId)
      if (selectedTxn) {
        const detail = await apiGet<{ transactions: BankTransaction[] }>(
          `/api/v1/bank-statements/${openId}?companyId=${companyId}`
        )
        setTransactions(detail.transactions || [])
        const res = await apiGet<{ candidates: Candidate[] }>(
          `/api/v1/bank-statements/${openId}/transactions/${selectedTxn.id}/candidates?companyId=${companyId}`
        )
        setCandidates(res.candidates || [])
      }
    } catch (err: any) {
      alert(err?.message || "Rückgängig fehlgeschlagen")
    } finally {
      setBusyRecon(null)
    }
  }

  /** Book a debit transaction as a GoBD expense. The
   *  server picks the SKR03 4900 (Aufwandskonto)
   *  default; the user can override with a custom
   *  account number from the prompt. */
  const bookExpense = async (txnId: string) => {
    if (!openId) return
    const acct = prompt(t("bankImport.expenseAccountPrompt"), "4900")
    if (acct === null) return
    const companyId = localStorage.getItem("companyId")!
    setBusyRecon(txnId)
    try {
      await apiPost(
        `/api/v1/bank-statements/${openId}/transactions/${txnId}/book-expense?companyId=${companyId}`,
        { expenseAccountNumber: acct || undefined }
      )
      // Reload the statement to pick up the txn.voucher
      const detail = await apiGet<{ transactions: BankTransaction[] }>(
        `/api/v1/bank-statements/${openId}?companyId=${companyId}`
      )
      setTransactions(detail.transactions || [])
      // Clear the selected txn (the candidates list is
      // empty for debit txns anyway).
      setSelectedTxn(null)
      setCandidates([])
    } catch (err: any) {
      alert(err?.message || "Buchen fehlgeschlagen")
    } finally {
      setBusyRecon(null)
    }
  }

  const reload = async () => {
    const companyId = localStorage.getItem("companyId")
    if (!companyId) {
      router.push("/login")
      return
    }
    setLoading(true)
    try {
      const list = await apiGet<BankStatement[]>(`/api/v1/bank-statements?companyId=${companyId}`)
      setStatements(list || [])
    } catch (e) {
      console.error("Bank statement load failed:", e)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { reload() /* eslint-disable-next-line */ }, [])

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const companyId = localStorage.getItem("companyId")
    const userId = localStorage.getItem("userId")
    if (!companyId) {
      router.push("/login")
      return
    }
    setUploading(true)
    setError(null)
    try {
      // Step 1: PARSE-ONLY preview. The user gets a
      // modal with the parsed header (IBAN, bank,
      // period, balances) + the first 25 transactions.
      // They click "Import bestätigen" to actually
      // persist, or "Abbrechen" to discard. This
      // prevents the very real mistake of uploading
      // the wrong account's MT940 (e.g. a personal
      // account file by accident).
      const previewForm = new FormData()
      previewForm.append("file", file)
      const previewRes = await apiFetch(
        `/api/v1/bank-statements/preview`,
        { method: "POST", body: previewForm },
      )
      const preview: PreviewResult = await previewRes.json()
      setPendingPreview({ file, preview })
    } catch (err: any) {
      setError(err?.message || "Vorschau fehlgeschlagen")
    } finally {
      setUploading(false)
      // Don't clear e.target.value yet — we still
      // need the file in pendingPreview.file. We
      // reset the input after the modal closes.
    }
  }

  // Confirm the preview — actually persist the file.
  // Called from the "Bestätigen" button in the
  // preview modal. After the import, we reload the
  // statement list and clear the pending preview.
  const confirmImport = async () => {
    const pending = pendingPreview
    if (!pending) return
    const companyId = localStorage.getItem("companyId")
    const userId = localStorage.getItem("userId")
    if (!companyId) {
      router.push("/login")
      return
    }
    setUploading(true)
    setError(null)
    try {
      const formData = new FormData()
      formData.append("file", pending.file)
      formData.append("companyId", companyId)
      if (userId) formData.append("userId", userId)
      await apiFetch(
        `/api/v1/bank-statements/import?companyId=${companyId}`,
        { method: "POST", body: formData },
      )
      setPendingPreview(null)
      await reload()
    } catch (err: any) {
      setError(err?.message || "Import fehlgeschlagen")
    } finally {
      setUploading(false)
      // Reset the file input by setting its value to
      // empty so the user can re-select the same file
      // (browsers don't fire onChange for a duplicate
      // selection otherwise).
      const fileInput = document.getElementById(
        "bank-import-file-input",
      ) as HTMLInputElement | null
      if (fileInput) fileInput.value = ""
    }
  }

  const cancelPreview = () => {
    setPendingPreview(null)
    const fileInput = document.getElementById(
      "bank-import-file-input",
    ) as HTMLInputElement | null
    if (fileInput) fileInput.value = ""
  }

  const openStatement = async (s: BankStatement) => {
    if (openId === s.id) {
      setOpenId(null)
      setTransactions([])
      setSelectedTxn(null)
      setReconciliations([])
      return
    }
    const companyId = localStorage.getItem("companyId")!
    setOpenId(s.id)
    setSelectedTxn(null)
    setReconciliations([])
    setLoadingTx(true)
    await loadReconciliations(s.id)
    try {
      const detail = await apiGet<{ transactions: BankTransaction[] }>(
        `/api/v1/bank-statements/${s.id}?companyId=${companyId}`
      )
      setTransactions(detail.transactions || [])
    } catch (e) {
      console.error("Load transactions failed:", e)
    } finally {
      setLoadingTx(false)
    }
  }

  const selectTxn = async (t: BankTransaction) => {
    setSelectedTxn(t)
    setCandidates([])
    const companyId = localStorage.getItem("companyId")!
    if (!openId) return
    setLoadingCandidates(true)
    try {
      const res = await apiGet<{ candidates: Candidate[] }>(
        `/api/v1/bank-statements/${openId}/transactions/${t.id}/candidates?companyId=${companyId}`
      )
      setCandidates(res.candidates || [])
    } catch (e) {
      console.error("Load candidates failed:", e)
    } finally {
      setLoadingCandidates(false)
    }
  }

  const deleteStatement = async (s: BankStatement) => {
    if (!confirm(t("bankImport.deleteConfirm"))) return
    const companyId = localStorage.getItem("companyId")!
    try {
      await apiDelete(`/api/v1/bank-statements/${s.id}?companyId=${companyId}`)
      if (openId === s.id) {
        setOpenId(null)
        setTransactions([])
        setSelectedTxn(null)
      }
      await reload()
    } catch (err: any) {
      alert(err?.message || "Fehler beim Löschen")
    }
  }

  const generateSuggestions = async () => {
    if (!openId) return
    const companyId = localStorage.getItem("companyId")!
    try {
      // Threshold 0 = conservative (no auto-confirm).
      // 80 = the recommended safe value: SKR03 typical
      // matches (amount exact + date ±3d) score 90;
      // (amount exact + date ±7d) score 80; purpose
      // match adds 25 (capped at 100). 95+ means the
      // purpose contained the invoice number.
      const threshold = autoConfirmThreshold
      const res = await apiPost<{ generated: number; autoConfirmed: number; threshold: number }>(
        `/api/v1/bank-statements/${openId}/suggest?companyId=${companyId}`,
        { autoConfirmThreshold: threshold }
      )
      if (res.autoConfirmed > 0) {
        setSuggestMsg(
          `${res.generated} Vorschläge — ${res.autoConfirmed} automatisch bestätigt (Schwelle ${res.threshold}).`
        )
      } else {
        setSuggestMsg(`${res.generated} Vorschläge erzeugt.`)
      }
      setTimeout(() => setSuggestMsg(null), 6000)
      // Reload both: recons changed AND the
      // transactions may have been paid (auto-confirm
      // flipped invoice status, so the candidates list
      // for any selected txn needs to refresh).
      await loadReconciliations(openId)
      if (selectedTxn) {
        const detail = await apiGet<{ transactions: BankTransaction[] }>(
          `/api/v1/bank-statements/${openId}?companyId=${companyId}`
        )
        setTransactions(detail.transactions || [])
      }
    } catch (err: any) {
      alert(err?.message || "Fehler")
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <div className="container mx-auto px-4 py-8">
        <div className="flex justify-between items-center mb-6">
          <div>
            <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100">{t("bankImport.title")}</h1>
            <p className="text-gray-500 dark:text-gray-400 mt-1">{t("bankImport.subtitle")}</p>
          </div>
          <div className="flex gap-2 items-center">
            <LanguageSwitcher />
            <Button variant="outline" onClick={() => router.push("/dashboard")}>
              {t("common.back")}
            </Button>
          </div>
        </div>

        {/* Upload card */}
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>{t("bankImport.uploadTitle")}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-gray-600 dark:text-gray-300 mb-3">{t("bankImport.uploadHelp")}</p>
            {error && (
              <div className="mb-3 text-sm text-red-700 dark:text-red-300 bg-red-50 border border-red-200 rounded p-2">
                {error}
              </div>
            )}
            <div className="flex items-center gap-3">
              <label className="cursor-pointer inline-flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 text-sm font-medium">
                {uploading ? "..." : t("bankImport.uploadButton")}
                <input
                  id="bank-import-file-input"
                  type="file"
                  accept=".sta,.mt940,.txt,.xml"
                  onChange={handleUpload}
                  disabled={uploading}
                  className="hidden"
                />
              </label>
              {uploading && <span className="text-sm text-gray-500 dark:text-gray-400">Wird verarbeitet...</span>}
            </div>
          </CardContent>
        </Card>

        {/* Statements list */}
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>{t("bankImport.statementsTitle")}</CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="text-sm text-gray-500 dark:text-gray-400">{t("common.loading")}</div>
            ) : statements.length === 0 ? (
              <div className="text-sm text-gray-500 dark:text-gray-400">{t("bankImport.noStatements")}</div>
            ) : (
              <div className="space-y-2">
                {statements.map((s) => (
                  <div
                    key={s.id}
                    className={`border rounded p-3 cursor-pointer transition-colors ${
                      openId === s.id ? "border-blue-500 bg-blue-50" : "border-gray dark:border-gray-700-200 dark:border-gray-700 hover:bg-gray-50 dark:bg-gray-900"
                    }`}
                    onClick={() => openStatement(s)}
                  >
                    <div className="flex justify-between items-center">
                      <div>
                        <div className="font-medium text-sm">
                          {s.fileName}{" "}
                          <span className="text-xs text-gray-500 dark:text-gray-400 font-mono">
                            ({s.format.toUpperCase()}, {s._count?.transactions ?? 0} txns)
                          </span>
                        </div>
                        <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                          {s.accountIban && (
                            <span className="font-mono mr-3">{s.accountIban}</span>
                          )}
                          {s.periodFrom && s.periodTo && (
                            <span className="mr-3">
                              {fmtDate(s.periodFrom, dl)} – {fmtDate(s.periodTo, dl)}
                            </span>
                          )}
                          {s.openingBalance && (
                            <span className="mr-3">Open: € {fmtMoney(Number(s.openingBalance))}</span>
                          )}
                          {s.closingBalance && (
                            <span>Close: € {fmtMoney(Number(s.closingBalance))}</span>
                          )}
                        </div>
                      </div>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={(e) => {
                          e.stopPropagation()
                          deleteStatement(s)
                        }}
                      >
                        🗑
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Expanded statement: transactions + candidates side by side */}
        {openId && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            {/* Transactions (2/3 width) */}
            <Card className="lg:col-span-2">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle>{t("bankImport.transactionsTitle")}</CardTitle>
                  {suggestMsg && (
                    <div className="text-xs text-emerald-700 bg-emerald-50 px-2 py-1 rounded">
                      {suggestMsg}
                    </div>
                  )}
                </div>
                {/* Auto-confirm threshold + suggest button.
                    The threshold input defaults to 0 (no
                    auto-confirm — the safe default). When
                    the user raises it to 80/90/95 the
                    suggest call also auto-confirms matches
                    that clear the threshold. */}
                <div className="flex items-center gap-3 mt-2 text-xs text-gray-600 dark:text-gray-300">
                  <label className="flex items-center gap-1">
                    {t("bankImport.autoConfirmThreshold")}:
                    <input
                      type="number"
                      min={0}
                      max={100}
                      step={5}
                      value={autoConfirmThreshold}
                      onChange={(e) => {
                        const v = parseInt(e.target.value, 10)
                        setAutoConfirmThreshold(isNaN(v) ? 0 : Math.max(0, Math.min(100, v)))
                      }}
                      className="w-16 px-1 py-0.5 border border-gray dark:border-gray-700-300 dark:border-gray-600 rounded text-right"
                    />
                  </label>
                  <span className="text-gray-400">|</span>
                  <Button size="sm" variant="outline" onClick={generateSuggestions}>
                    {t("bankImport.generateSuggestions")}
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                {loadingTx ? (
                  <div className="text-sm text-gray-500 dark:text-gray-400">{t("common.loading")}</div>
                ) : transactions.length === 0 ? (
                  <div className="text-sm text-gray-500 dark:text-gray-400">—</div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left text-gray-500 dark:text-gray-400 text-xs border-b">
                          <th className="py-2">{t("bankImport.tableDate")}</th>
                          <th>{t("bankImport.tableDescription")}</th>
                          <th className="text-right">{t("bankImport.tableAmount")}</th>
                          <th className="text-right">{t("bankImport.tableAction")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {transactions.map((txn) => {
                          const isSel = selectedTxn?.id === txn.id
                          const amt = Number(txn.amount)
                          const isDebit = amt < 0
                          return (
                            <tr
                              key={txn.id}
                              onClick={() => selectTxn(txn)}
                              className={`border-b cursor-pointer ${
                                isSel ? "bg-blue-50" : "hover:bg-gray-50 dark:bg-gray-900"
                              }`}
                            >
                              <td className="py-2 font-mono text-xs">{fmtDate(txn.valueDate, dl)}</td>
                              <td>
                                <div className="font-medium">
                                  {txn.counterpartyName || txn.endToEndId || "—"}
                                </div>
                                {txn.purpose && (
                                  <div className="text-xs text-gray-500 dark:text-gray-400 truncate max-w-[400px]">
                                    {txn.purpose}
                                  </div>
                                )}
                              </td>
                              <td className={`text-right font-mono font-medium ${
                                amt >= 0 ? "text-emerald-700" : "text-red-700 dark:text-red-300"
                              }`}>
                                € {fmtMoney(amt)}
                              </td>
                              <td className="text-right text-xs">
                                {/* Debit txn: show "Als Aufwand
                                    buchen" button (only if not
                                    already booked). Credit txn:
                                    no action here — the
                                    candidates panel handles
                                    the matching. */}
                                {isDebit && !txn.voucher && (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    disabled={busyRecon === txn.id}
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      bookExpense(txn.id)
                                    }}
                                  >
                                    {busyRecon === txn.id
                                      ? t("common.loading")
                                      : t("bankImport.bookExpense")}
                                  </Button>
                                )}
                                {/* Expense already booked:
                                    show the voucher number as
                                    the audit-trail reference. */}
                                {txn.voucher && (
                                  <span className="font-mono text-emerald-700">
                                    {txn.voucher.voucherNumber}
                                  </span>
                                )}
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Candidates (1/3 width) */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">
                  {t("bankImport.candidatesTitle")}
                </CardTitle>
              </CardHeader>
              <CardContent>
                {!selectedTxn ? (
                  <div className="text-sm text-gray-500 dark:text-gray-400">
                    {t("bankImport.selectTxnForCandidates")}
                  </div>
                ) : loadingCandidates ? (
                  <div className="text-sm text-gray-500 dark:text-gray-400">{t("common.loading")}</div>
                ) : candidates.length === 0 ? (
                  <div className="text-sm text-gray-500 dark:text-gray-400">
                    {t("bankImport.noCandidates")}
                  </div>
                ) : (
                  <div className="space-y-2">
                    {candidates.map((c) => {
                      const recon = selectedTxn
                        ? reconByPair(selectedTxn.id, c.invoiceId)
                        : undefined
                      return (
                        <div
                          key={c.invoiceId}
                          className={`border rounded p-2 ${
                            recon?.status === "confirmed"
                              ? "border-emerald-300 dark:border-emerald-700 bg-emerald-50"
                              : recon?.status === "rejected"
                              ? "border-gray dark:border-gray-700-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 opacity-60"
                              : "border-gray dark:border-gray-700-200 dark:border-gray-700"
                          }`}
                        >
                          <div className="flex justify-between items-center mb-1">
                            <span className="font-mono text-sm font-medium">
                              {c.invoiceNumber}
                            </span>
                            <div className="flex items-center gap-1">
                              {recon && (
                                <span
                                  className={`text-xs px-1.5 py-0.5 rounded ${
                                    recon.status === "confirmed"
                                      ? "bg-emerald-200 text-emerald-900"
                                      : recon.status === "rejected"
                                      ? "bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-200"
                                      : recon.status === "reopened"
                                      ? "bg-amber-200 text-amber-900"
                                      : "bg-blue-100 text-blue-800"
                                  }`}
                                >
                                  {recon.status === "confirmed"
                                    ? t("bankImport.statusConfirmed")
                                    : recon.status === "rejected"
                                    ? t("bankImport.statusRejected")
                                    : recon.status === "reopened"
                                    ? t("bankImport.statusReopened")
                                    : t("bankImport.statusSuggested")}
                                </span>
                              )}
                              <span
                                className={`text-xs px-1.5 py-0.5 rounded ${
                                  c.confidence >= 80
                                    ? "bg-emerald-100 text-emerald-800"
                                    : c.confidence >= 60
                                    ? "bg-yellow-100 text-yellow-800"
                                    : "bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-200"
                                }`}
                              >
                                {t("bankImport.confidence")}: {c.confidence}
                              </span>
                            </div>
                          </div>
                          <div className="text-xs text-gray-600 dark:text-gray-300">
                            {c.customerName}
                            {c.customerNumber && (
                              <span className="font-mono text-gray-400 ml-1">({c.customerNumber})</span>
                            )}
                          </div>
                          <div className="flex justify-between text-xs mt-1">
                            <span className="text-gray-500 dark:text-gray-400">{t("bankImport.tableAmount")}: € {fmtMoney(c.total)}</span>
                            {c.dueDate && (
                              <span className="text-gray-500 dark:text-gray-400">
                                {t("bankImport.tableDate")}: {fmtDate(c.dueDate, dl)}
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-gray-400 italic mt-1">
                            {c.matchReason}
                          </div>
                          {/* Action buttons — shown only for
                              suggested matches (not confirmed /
                              rejected). After confirmation the
                              candidate is removed from the
                              candidates list anyway (because the
                              invoice is now 'paid'). */}
                          {recon && recon.status === "suggested" && (
                            <div className="flex gap-2 mt-2">
                              <Button
                                size="sm"
                                disabled={busyRecon === recon.id}
                                onClick={() => confirmCandidate(recon.id, c.invoiceNumber)}
                                className="bg-emerald-600 hover:bg-emerald-700 text-white"
                              >
                                {busyRecon === recon.id
                                  ? t("common.loading")
                                  : t("bankImport.confirmCandidate")}
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={busyRecon === recon.id}
                                onClick={() => rejectCandidate(recon.id)}
                              >
                                {t("bankImport.rejectCandidate")}
                              </Button>
                            </div>
                          )}
                          {/* "Rückgängig" — only on confirmed
                              matches. The GoBD-correct reopen
                              flow: keeps the original Voucher
                              in the books, writes a Storno
                              Voucher, removes the Payment,
                              flips the invoice back to
                              "sent". Shown next to the
                              voucher number so the user can
                              see the audit link AND the
                              correction in one place. */}
                          {recon && recon.status === "confirmed" && (
                            <div className="mt-2">
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={busyRecon === recon.id}
                                onClick={() => reopenCandidate(recon.id, c.invoiceNumber)}
                              >
                                {busyRecon === recon.id
                                  ? t("common.loading")
                                  : t("bankImport.reopenCandidate")}
                              </Button>
                            </div>
                          )}
                          {/* Voucher link — only on confirmed matches
                              (the GoBD audit trail: raw file →
                              transaction → payment → voucher). The
                              voucher number is the Belegnummer the
                              Berater references in the DATEV export. */}
                          {recon?.voucher && (
                            <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                              {t("bankImport.voucher")}:{" "}
                              <span className="font-mono">{recon.voucher.voucherNumber}</span>
                              {recon.reversalVoucher && (
                                <span className="text-amber-700 ml-2">
                                  (Storno {recon.reversalVoucher.voucherNumber})
                                </span>
                              )}
                            </div>
                          )}
                        </div>
                      )
                     })}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        )}

        {/* All reconciliations for the open statement —
            shown BELOW the txn+candidates panel so the
            user can see the full GoBD audit trail
            (raw file → txn → recon → voucher) including
            confirmed matches that have been removed
            from the candidates list (because the
            invoice is now 'paid'). */}
        {openId && reconciliations.length > 0 && (
          <Card className="mt-4">
            <CardHeader>
              <CardTitle className="text-base">
                {t("bankImport.reconciliationsTitle")} ({reconciliations.length})
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-gray-500 dark:text-gray-400 text-xs border-b">
                      <th className="py-2">{t("bankImport.reconInvoice")}</th>
                      <th>{t("bankImport.reconCustomer")}</th>
                      <th className="text-right">{t("bankImport.reconAmount")}</th>
                      <th>{t("bankImport.reconStatus")}</th>
                      <th>{t("bankImport.voucher")}</th>
                      <th className="text-right">{t("bankImport.tableAction")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {reconciliations.map((r) => (
                      <tr key={r.id} className="border-b">
                        <td className="py-2 font-mono text-xs">{r.invoice.invoiceNumber}</td>
                        <td className="text-xs">{r.invoice.customer.name}</td>
                        <td className="text-right font-mono text-xs">€ {fmtMoney(Number(r.appliedAmount))}</td>
                        <td>
                          <span
                            className={`text-xs px-1.5 py-0.5 rounded ${
                              r.status === "confirmed"
                                ? "bg-emerald-100 text-emerald-800"
                                : r.status === "rejected"
                                ? "bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-200"
                                : r.status === "reopened"
                                ? "bg-amber-100 text-amber-900"
                                : "bg-blue-100 text-blue-800"
                            }`}
                          >
                            {r.status === "confirmed"
                              ? t("bankImport.statusConfirmed")
                              : r.status === "rejected"
                              ? t("bankImport.statusRejected")
                              : r.status === "reopened"
                              ? t("bankImport.statusReopened")
                              : t("bankImport.statusSuggested")}
                          </span>
                        </td>
                        <td className="font-mono text-xs">
                          {/* Show both the current and the
                              Storno voucher when this
                              recon has been reopened.
                              The Berater can pivot from
                              the DATEV row (which lists
                              both) back to the recon
                              row, and from the recon
                              row back to either
                              Belegnummer. */}
                          {r.voucher ? (
                            <span>
                              <button
                                onClick={() => router.push(`/dashboard/accounting/vouchers/${r.voucher!.id}`)}
                                className="font-mono text-blue-700 dark:text-blue-300 hover:underline"
                              >
                                {r.voucher.voucherNumber}
                              </button>
                              {r.reversalVoucher && (
                                <>
                                  <br />
                                  <button
                                    onClick={() => router.push(`/dashboard/accounting/vouchers/${r.reversalVoucher!.id}`)}
                                    className="text-amber-700 text-[10px] hover:underline"
                                  >
                                    Storno {r.reversalVoucher.voucherNumber}
                                  </button>
                                </>
                              )}
                            </span>
                          ) : r.reversalVoucher ? (
                            <button
                              onClick={() => router.push(`/dashboard/accounting/vouchers/${r.reversalVoucher!.id}`)}
                              className="text-amber-700 hover:underline"
                            >
                              Storno {r.reversalVoucher.voucherNumber}
                            </button>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="text-right text-xs">
                          {/* Rückgängig on confirmed rows.
                              The Zuordnungen panel is where the
                              user audits the full GoBD trail
                              (raw file → txn → recon →
                              voucher). Putting the reopen
                              action here means the correction
                              is reachable from the audit
                              view itself, not just from the
                              candidate card (which is hidden
                              once the invoice is paid). */}
                          {r.status === "confirmed" && (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={busyRecon === r.id}
                              onClick={() => reopenCandidate(r.id, r.invoice.invoiceNumber)}
                            >
                              {busyRecon === r.id
                                ? t("common.loading")
                                : t("bankImport.reopenCandidate")}
                            </Button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Preview modal — shown after the user picks a
          file. Displays the parsed header (IBAN, bank,
          period, balances) + the first 25 transactions
          so they can eyeball-verify it's the right
          file before the import is committed. */}
      {pendingPreview && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl w-full max-w-4xl p-6 max-h-[90vh] overflow-y-auto">
            <h2 className="text-xl font-bold mb-1">
              {t("bankImport.previewTitle") || "Import-Vorschau"}
            </h2>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
              {t("bankImport.previewHint") ||
                "Prüfen Sie die unten angezeigten Daten, bevor Sie den Import bestätigen."}
            </p>

            {/* Balance-check warning — flag mismatched
                opening+credits−debits vs closing. This
                catches files that were truncated or
                contain another account's transactions. */}
            {pendingPreview.preview.balanceCheck === "mismatch" && (
              <div className="mb-4 p-3 bg-red-50 border border-red-300 dark:border-red-700 rounded text-sm text-red-800">
                ⚠ {t("bankImport.balanceMismatch") ||
                  "Eröffnungssaldo + Gutschriften − Lastschriften ≠ Schlusssaldo. Datei möglicherweise unvollständig oder falsches Konto."}
              </div>
            )}

            {/* Header strip — IBAN, bank, period,
                balances. The IBAN is the most
                important field — if it doesn't match
                the user's company bank, the import
                must be cancelled. */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
              <div className="bg-gray-50 dark:bg-gray-900 rounded p-3">
                <div className="text-xs text-gray-500 dark:text-gray-400 uppercase">IBAN</div>
                <div className="text-sm font-mono font-bold mt-1">
                  {pendingPreview.preview.accountIban || "—"}
                </div>
              </div>
              <div className="bg-gray-50 dark:bg-gray-900 rounded p-3">
                <div className="text-xs text-gray-500 dark:text-gray-400 uppercase">Bank</div>
                <div className="text-sm font-bold mt-1">
                  {pendingPreview.preview.bankName || "—"}
                </div>
              </div>
              <div className="bg-gray-50 dark:bg-gray-900 rounded p-3">
                <div className="text-xs text-gray-500 dark:text-gray-400 uppercase">Zeitraum</div>
                <div className="text-sm font-bold mt-1">
                  {pendingPreview.preview.periodFrom &&
                  pendingPreview.preview.periodTo
                    ? `${new Date(pendingPreview.preview.periodFrom).toLocaleDateString("de-DE")} – ${new Date(pendingPreview.preview.periodTo).toLocaleDateString("de-DE")}`
                    : "—"}
                </div>
              </div>
              <div className="bg-gray-50 dark:bg-gray-900 rounded p-3">
                <div className="text-xs text-gray-500 dark:text-gray-400 uppercase">
                  Format
                </div>
                <div className="text-sm font-mono font-bold mt-1 uppercase">
                  {pendingPreview.preview.format}
                </div>
              </div>
              <div className="bg-gray-50 dark:bg-gray-900 rounded p-3">
                <div className="text-xs text-gray-500 dark:text-gray-400 uppercase">
                  Eröffnung
                </div>
                <div className="text-sm font-mono font-bold mt-1">
                  {pendingPreview.preview.openingBalance
                    ? `${pendingPreview.preview.openingBalance} €`
                    : "—"}
                </div>
              </div>
              <div className="bg-gray-50 dark:bg-gray-900 rounded p-3">
                <div className="text-xs text-gray-500 dark:text-gray-400 uppercase">Schluss</div>
                <div className="text-sm font-mono font-bold mt-1">
                  {pendingPreview.preview.closingBalance
                    ? `${pendingPreview.preview.closingBalance} €`
                    : "—"}
                </div>
              </div>
              <div className="bg-gray-50 dark:bg-gray-900 rounded p-3">
                <div className="text-xs text-gray-500 dark:text-gray-400 uppercase">Σ Soll</div>
                <div className="text-sm font-mono font-bold mt-1 text-red-700 dark:text-red-300">
                  {pendingPreview.preview.totalDebit} €
                </div>
              </div>
              <div className="bg-gray-50 dark:bg-gray-900 rounded p-3">
                <div className="text-xs text-gray-500 dark:text-gray-400 uppercase">Σ Haben</div>
                <div className="text-sm font-mono font-bold mt-1 text-green-700 dark:text-green-300">
                  {pendingPreview.preview.totalCredit} €
                </div>
              </div>
            </div>

            <div className="mb-2 text-sm font-bold">
              {t("bankImport.previewSampleTitle") || "Erste Transaktionen"}{" "}
              <span className="text-gray-500 dark:text-gray-400 font-normal">
                ({pendingPreview.preview.sampleTransactions.length} /{" "}
                {pendingPreview.preview.totalTransactions})
              </span>
            </div>

            <div className="border rounded overflow-x-auto max-h-80">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 dark:bg-gray-900 sticky top-0">
                  <tr>
                    <th className="text-left px-3 py-2 text-xs font-medium text-gray-500 dark:text-gray-400">
                      Datum
                    </th>
                    <th className="text-left px-3 py-2 text-xs font-medium text-gray-500 dark:text-gray-400">
                      Gegenpartei
                    </th>
                    <th className="text-left px-3 py-2 text-xs font-medium text-gray-500 dark:text-gray-400">
                      Zweck
                    </th>
                    <th className="text-right px-3 py-2 text-xs font-medium text-gray-500 dark:text-gray-400">
                      Betrag
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {pendingPreview.preview.sampleTransactions.map(
                    (t, i) => (
                      <tr key={i} className="border-t">
                        <td className="px-3 py-1 whitespace-nowrap">
                          {new Date(t.valueDate).toLocaleDateString("de-DE")}
                        </td>
                        <td className="px-3 py-1">
                          {t.counterpartyName || "—"}
                        </td>
                        <td className="px-3 py-1 text-gray-600 dark:text-gray-300 max-w-md truncate">
                          {t.purpose || "—"}
                        </td>
                        <td
                          className={
                            "px-3 py-1 text-right font-mono " +
                            (parseFloat(t.amount) < 0
                              ? "text-red-700 dark:text-red-300"
                              : "text-green-700 dark:text-green-300")
                          }
                        >
                          {parseFloat(t.amount).toFixed(2)} €
                        </td>
                      </tr>
                    ),
                  )}
                </tbody>
              </table>
            </div>

            {pendingPreview.preview.totalTransactions >
              pendingPreview.preview.sampleTransactions.length && (
              <div className="text-xs text-gray-500 dark:text-gray-400 mt-2 text-center">
                … und{" "}
                {pendingPreview.preview.totalTransactions -
                  pendingPreview.preview.sampleTransactions.length}{" "}
                weitere
              </div>
            )}

            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={cancelPreview}
                disabled={uploading}
                className="px-4 py-2 text-sm border rounded hover:bg-gray-100 dark:hover:bg-gray-700"
              >
                {t("common.cancel") || "Abbrechen"}
              </button>
              <button
                onClick={confirmImport}
                disabled={uploading}
                className="px-4 py-2 text-sm bg-emerald-600 text-white rounded hover:bg-emerald-700"
              >
                {uploading
                  ? "…"
                  : t("bankImport.previewConfirm") ||
                    `Import bestätigen (${pendingPreview.preview.totalTransactions} Buchungen)`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
