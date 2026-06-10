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
  status: "suggested" | "confirmed" | "rejected"
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
      const formData = new FormData()
      formData.append("file", file)
      formData.append("companyId", companyId)
      if (userId) formData.append("userId", userId)
      // Use apiFetch (not raw fetch) so the helper adds
      // the absolute API_BASE prefix and auth headers.
      // FormData is supported — see lib/api.ts apiFetch.
      const res = await apiFetch(
        `/api/v1/bank-statements/import?companyId=${companyId}`,
        { method: "POST", body: formData }
      )
      await reload()
    } catch (err: any) {
      setError(err?.message || "Upload fehlgeschlagen")
    } finally {
      setUploading(false)
      e.target.value = "" // allow re-upload of same file
    }
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
      const res = await apiPost<{ generated: number }>(
        `/api/v1/bank-statements/${openId}/suggest?companyId=${companyId}`
      )
      setSuggestMsg(`${res.generated} Vorschläge erzeugt.`)
      setTimeout(() => setSuggestMsg(null), 4000)
      await loadReconciliations(openId)
    } catch (err: any) {
      alert(err?.message || "Fehler")
    }
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="container mx-auto px-4 py-8">
        <div className="flex justify-between items-center mb-6">
          <div>
            <h1 className="text-3xl font-bold text-gray-900">{t("bankImport.title")}</h1>
            <p className="text-gray-500 mt-1">{t("bankImport.subtitle")}</p>
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
            <p className="text-sm text-gray-600 mb-3">{t("bankImport.uploadHelp")}</p>
            {error && (
              <div className="mb-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded p-2">
                {error}
              </div>
            )}
            <div className="flex items-center gap-3">
              <label className="cursor-pointer inline-flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 text-sm font-medium">
                {uploading ? "..." : t("bankImport.uploadButton")}
                <input
                  type="file"
                  accept=".sta,.mt940,.txt,.xml"
                  onChange={handleUpload}
                  disabled={uploading}
                  className="hidden"
                />
              </label>
              {uploading && <span className="text-sm text-gray-500">Wird verarbeitet...</span>}
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
              <div className="text-sm text-gray-500">{t("common.loading")}</div>
            ) : statements.length === 0 ? (
              <div className="text-sm text-gray-500">{t("bankImport.noStatements")}</div>
            ) : (
              <div className="space-y-2">
                {statements.map((s) => (
                  <div
                    key={s.id}
                    className={`border rounded p-3 cursor-pointer transition-colors ${
                      openId === s.id ? "border-blue-500 bg-blue-50" : "border-gray-200 hover:bg-gray-50"
                    }`}
                    onClick={() => openStatement(s)}
                  >
                    <div className="flex justify-between items-center">
                      <div>
                        <div className="font-medium text-sm">
                          {s.fileName}{" "}
                          <span className="text-xs text-gray-500 font-mono">
                            ({s.format.toUpperCase()}, {s._count?.transactions ?? 0} txns)
                          </span>
                        </div>
                        <div className="text-xs text-gray-500 mt-0.5">
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
                  <Button size="sm" variant="outline" onClick={generateSuggestions}>
                    {t("bankImport.generateSuggestions")}
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                {loadingTx ? (
                  <div className="text-sm text-gray-500">{t("common.loading")}</div>
                ) : transactions.length === 0 ? (
                  <div className="text-sm text-gray-500">—</div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left text-gray-500 text-xs border-b">
                          <th className="py-2">{t("bankImport.tableDate")}</th>
                          <th>{t("bankImport.tableDescription")}</th>
                          <th className="text-right">{t("bankImport.tableAmount")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {transactions.map((t) => {
                          const isSel = selectedTxn?.id === t.id
                          const amt = Number(t.amount)
                          return (
                            <tr
                              key={t.id}
                              onClick={() => selectTxn(t)}
                              className={`border-b cursor-pointer ${
                                isSel ? "bg-blue-50" : "hover:bg-gray-50"
                              }`}
                            >
                              <td className="py-2 font-mono text-xs">{fmtDate(t.valueDate, dl)}</td>
                              <td>
                                <div className="font-medium">
                                  {t.counterpartyName || t.endToEndId || "—"}
                                </div>
                                {t.purpose && (
                                  <div className="text-xs text-gray-500 truncate max-w-[400px]">
                                    {t.purpose}
                                  </div>
                                )}
                              </td>
                              <td className={`text-right font-mono font-medium ${
                                amt >= 0 ? "text-emerald-700" : "text-red-700"
                              }`}>
                                € {fmtMoney(amt)}
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
                  <div className="text-sm text-gray-500">
                    {t("bankImport.selectTxnForCandidates")}
                  </div>
                ) : loadingCandidates ? (
                  <div className="text-sm text-gray-500">{t("common.loading")}</div>
                ) : candidates.length === 0 ? (
                  <div className="text-sm text-gray-500">
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
                              ? "border-emerald-300 bg-emerald-50"
                              : recon?.status === "rejected"
                              ? "border-gray-200 bg-gray-50 opacity-60"
                              : "border-gray-200"
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
                                      ? "bg-gray-200 text-gray-700"
                                      : "bg-blue-100 text-blue-800"
                                  }`}
                                >
                                  {recon.status === "confirmed"
                                    ? t("bankImport.statusConfirmed")
                                    : recon.status === "rejected"
                                    ? t("bankImport.statusRejected")
                                    : t("bankImport.statusSuggested")}
                                </span>
                              )}
                              <span
                                className={`text-xs px-1.5 py-0.5 rounded ${
                                  c.confidence >= 80
                                    ? "bg-emerald-100 text-emerald-800"
                                    : c.confidence >= 60
                                    ? "bg-yellow-100 text-yellow-800"
                                    : "bg-gray-100 text-gray-700"
                                }`}
                              >
                                {t("bankImport.confidence")}: {c.confidence}
                              </span>
                            </div>
                          </div>
                          <div className="text-xs text-gray-600">
                            {c.customerName}
                            {c.customerNumber && (
                              <span className="font-mono text-gray-400 ml-1">({c.customerNumber})</span>
                            )}
                          </div>
                          <div className="flex justify-between text-xs mt-1">
                            <span className="text-gray-500">{t("bankImport.tableAmount")}: € {fmtMoney(c.total)}</span>
                            {c.dueDate && (
                              <span className="text-gray-500">
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
                          {/* Voucher link — only on confirmed matches
                              (the GoBD audit trail: raw file →
                              transaction → payment → voucher). The
                              voucher number is the Belegnummer the
                              Berater references in the DATEV export. */}
                          {recon?.voucher && (
                            <div className="text-xs text-gray-500 mt-1">
                              {t("bankImport.voucher")}:{" "}
                              <span className="font-mono">{recon.voucher.voucherNumber}</span>
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
                    <tr className="text-left text-gray-500 text-xs border-b">
                      <th className="py-2">{t("bankImport.reconInvoice")}</th>
                      <th>{t("bankImport.reconCustomer")}</th>
                      <th className="text-right">{t("bankImport.reconAmount")}</th>
                      <th>{t("bankImport.reconStatus")}</th>
                      <th>{t("bankImport.voucher")}</th>
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
                                ? "bg-gray-200 text-gray-700"
                                : "bg-blue-100 text-blue-800"
                            }`}
                          >
                            {r.status === "confirmed"
                              ? t("bankImport.statusConfirmed")
                              : r.status === "rejected"
                              ? t("bankImport.statusRejected")
                              : t("bankImport.statusSuggested")}
                          </span>
                        </td>
                        <td className="font-mono text-xs">
                          {r.voucher ? r.voucher.voucherNumber : "—"}
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
    </div>
  )
}
