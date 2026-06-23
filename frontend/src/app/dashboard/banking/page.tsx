"use client"

import { useEffect, useState, useCallback } from "react"
import { useI18n } from "@/components/useI18n"
import { apiGet, apiPost, apiDelete } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { useToast } from "@/components/useToast"

interface FinTSConnection {
  id: string
  blz: string
  userId: string
  label: string
  endpointUrl: string
  mockMode: number
  tanMethod: string | null
  status: string
  lastSyncAt: string | null
  lastError: string | null
  createdAt: string
}

interface FinTSSyncRun {
  id: string
  status: string
  txCount: number
  tanChallenge: string | null
  errorCode: string | null
  errorMessage: string | null
  startedAt: string
  finishedAt: string | null
}

interface BankTransaction {
  id: string
  valueDate: string
  amount: string
  currency: string
  counterpartyName: string | null
  counterpartyIban: string | null
  purpose: string | null
  endToEndId: string | null
}

/**
 * Tier 6: Online-Banking (FinTS) dashboard page.
 *
 * Three main UI sections:
 *
 * 1. **Connection list** — every FinTSConnection
 *    the user has configured. Each card shows
 *    status (pending / active / error) and a
 *    "Jetzt synchronisieren" button. Status='error'
 *    rows show the last error in red.
 *
 * 2. **Add-connection wizard** — a small modal
 *    with: BLZ (with lookup for known banks),
 *    online-banking user-id, display label, PIN.
 *    Defaults to mockMode=true for safety; a
 *    checkbox lets the user opt in to real-mode.
 *
 * 3. **TAN modal** — appears when a sync returns
 *    status='needs_tan'. Shows the bank's
 *    challenge text + an input for the TAN. The
 *    "Senden" button calls /fints/sync-runs/:id/tan.
 *
 * 4. **Recent transactions** — last 20 mock /
 *    real transactions, with the auto-match
 *    suggestions marked.
 *
 * The "Buchungen abgleichen" button at the top
 * calls /fints/auto-match and tells the user how
 * many high-confidence (>=80) matches were
 * created.
 */
export default function BankingPage() {
  const { t } = useI18n()
  const toast = useToast()
  const [companyId, setCompanyId] = useState<string>("")
  const [connections, setConnections] = useState<FinTSConnection[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showAddModal, setShowAddModal] = useState(false)
  const [tanModal, setTanModal] = useState<{
    syncRunId: string
    challenge: string
    connId: string
  } | null>(null)
  const [syncingIds, setSyncingIds] = useState<Set<string>>(new Set())
  const [recentTxns, setRecentTxns] = useState<BankTransaction[]>([])
  // Tier 9: BankReconciliation rows
  // surfaced in /dashboard/banking. The
  // user clicks Bestätigen/Ablehnen on
  // auto-matched rows here; before this
  // they had to navigate to /bank-import.
  interface Reconciliation {
    id: string
    confidence: number
    matchReason: string | null
    status: string
    appliedAmount: string
    invoice: {
      invoiceNumber: string
      total: string
      customer: { name: string }
    }
    bankTransaction: {
      id: string
      valueDate: string
      amount: string
      currency: string
      counterpartyName: string | null
      counterpartyIban: string | null
      purpose: string | null
    }
  }
  const [reconciliations, setReconciliations] = useState<Reconciliation[]>([])
  const [reconsLoading, setReconsLoading] = useState(false)

  const fetchConnections = useCallback(async (cid: string) => {
    setLoading(true)
    setError(null)
    try {
      const data = await apiGet<FinTSConnection[]>(
        `/api/v1/fints/connections?companyId=${cid}`,
      )
      setConnections(data)
    } catch (err: any) {
      setError(err?.message || t("banking.loadError"))
    } finally {
      setLoading(false)
    }
  }, [t])

  const fetchRecentTxns = useCallback(async (cid: string) => {
    try {
      // Recent mock transactions. We pull
      // the statements and then their
      // transactions; for mock-mode
      // syncs this gives us the latest
      // 20 MOCK-* txns. The bank-import
      // /statements endpoint returns the
      // BankStatement[] with transactions
      // included.
      const stmts = await apiGet<any[]>(
        `/api/v1/bank-import?companyId=${cid}`,
      )
      const allTxns: BankTransaction[] = []
      for (const s of stmts) {
        if (s.format === "fints-mock" && s.transactions) {
          for (const t of s.transactions) {
            if (t.endToEndId?.startsWith("MOCK-")) {
              allTxns.push(t)
            }
          }
        }
      }
      allTxns.sort(
        (a, b) =>
          new Date(b.valueDate).getTime() - new Date(a.valueDate).getTime(),
      )
      setRecentTxns(allTxns.slice(0, 20))
    } catch {
      // non-fatal — list just shows empty
    }
  }, [])

  // Tier 9: load BankReconciliation
  // rows. The list is sorted by confidence
  // DESC so the high-confidence auto-matches
  // (>=95) surface first. The user can
  // confirm or reject each one inline; we
  // don't navigate them away from /banking.
  const fetchReconciliations = useCallback(async (cid: string) => {
    setReconsLoading(true)
    try {
      const data = await apiGet<Reconciliation[]>(
        `/api/v1/bank-statements/reconciliations?companyId=${cid}`,
      )
      setReconciliations(data)
    } catch {
      setReconciliations([])
    } finally {
      setReconsLoading(false)
    }
  }, [])

  const handleConfirmRecon = async (reconId: string) => {
    try {
      await apiPost(
        `/api/v1/bank-statements/reconciliations/${reconId}/confirm?companyId=${companyId}`,
        {},
      )
      toast.success(t("banking.reconConfirmed"))
      fetchReconciliations(companyId)
    } catch (err: any) {
      toast.error(err?.message || t("banking.reconConfirmError"))
    }
  }

  const handleRejectRecon = async (reconId: string) => {
    try {
      await apiPost(
        `/api/v1/bank-statements/reconciliations/${reconId}/reject?companyId=${companyId}`,
        {},
      )
      toast.success(t("banking.reconRejected"))
      fetchReconciliations(companyId)
    } catch (err: any) {
      toast.error(err?.message || t("banking.reconRejectError"))
    }
  }

  useEffect(() => {
    const cid = localStorage.getItem("companyId") || ""
    if (cid) {
      setCompanyId(cid)
      fetchConnections(cid)
      fetchRecentTxns(cid)
      fetchReconciliations(cid)
    }
  }, [fetchConnections, fetchRecentTxns])

  const handleAdd = async (form: {
    blz: string
    userId: string
    label: string
    pin: string
    mockMode: boolean
  }) => {
    try {
      await apiPost<{ id: string }>("/api/v1/fints/connections", {
        companyId,
        blz: form.blz,
        userId: form.userId,
        label: form.label,
        pin: form.pin,
        mockMode: form.mockMode,
      })
      toast.success(t("banking.connectionCreated"))
      setShowAddModal(false)
      fetchConnections(companyId)
    } catch (err: any) {
      toast.error(err?.message || t("banking.connectionCreateError"))
    }
  }

  const handleSync = async (connId: string) => {
    setSyncingIds((prev) => new Set(prev).add(connId))
    try {
      const result = await apiPost<{
        status: string
        txCount?: number
        tanChallenge?: string
        syncRunId: string
        errorMessage?: string
      }>(`/api/v1/fints/connections/${connId}/sync`, { companyId })
      if (result.status === "needs_tan") {
        setTanModal({
          syncRunId: result.syncRunId,
          challenge: result.tanChallenge || t("banking.tanPrompt"),
          connId,
        })
        toast.info(t("banking.tanRequired"))
      } else if (result.status === "ok") {
        toast.success(
          t("banking.syncOk", { count: result.txCount || 0 }),
        )
        fetchConnections(companyId)
        fetchRecentTxns(companyId)
        fetchReconciliations(companyId)
      } else {
        toast.error(result.errorMessage || t("banking.syncFailed"))
      }
    } catch (err: any) {
      toast.error(err?.message || t("banking.syncFailed"))
    } finally {
      setSyncingIds((prev) => {
        const next = new Set(prev)
        next.delete(connId)
        return next
      })
    }
  }

  const handleTanSubmit = async (tan: string) => {
    if (!tanModal) return
    try {
      const result = await apiPost<{ status: string; txCount?: number }>(
        `/api/v1/fints/sync-runs/${tanModal.syncRunId}/tan`,
        { companyId, tan },
      )
      if (result.status === "ok") {
        toast.success(
          t("banking.syncOk", { count: result.txCount || 0 }),
        )
        setTanModal(null)
        fetchConnections(companyId)
        fetchRecentTxns(companyId)
        fetchReconciliations(companyId)
      } else {
        toast.error(t("banking.tanRejected"))
      }
    } catch (err: any) {
      toast.error(err?.message || t("banking.tanRejected"))
    }
  }

  const handleDelete = async (connId: string) => {
    if (!confirm(t("banking.confirmDelete"))) return
    try {
      await apiDelete(
        `/api/v1/fints/connections/${connId}?companyId=${companyId}`,
      )
      toast.success(t("banking.deleted"))
      fetchConnections(companyId)
    } catch (err: any) {
      toast.error(err?.message || t("banking.deleteError"),)
    }
  }

  const handleAutoMatch = async () => {
    try {
      const result = await apiPost<{ matched: number; suggested: number }>(
        "/api/v1/fints/auto-match",
        { companyId },
      )
      toast.success(
        t("banking.autoMatchDone", {
          matched: result.matched,
          suggested: result.suggested,
        }),
      )
    } catch (err: any) {
      toast.error(err?.message || t("banking.autoMatchError"))
    }
  }

  if (loading) {
    return (
      <div className="p-8 text-gray-500 dark:text-gray-400">{t("common.loading")}</div>
    )
  }

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{t("banking.title")}</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            {t("banking.subtitle")}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={handleAutoMatch}>
            {t("banking.autoMatch")}
          </Button>
          <Button onClick={() => setShowAddModal(true)}>
            {t("banking.addConnection")}
          </Button>
        </div>
      </div>

      {error && (
        <div className="text-red-600 dark:text-red-400 text-sm">{error}</div>
      )}

      {/* Connection list */}
      <div className="space-y-3">
        {connections.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-center text-sm text-gray-500 dark:text-gray-400">
              {t("banking.empty")}
            </CardContent>
          </Card>
        ) : (
          connections.map((c) => (
            <Card key={c.id}>
              <CardContent className="pt-4 space-y-2">
                <div className="flex items-start justify-between">
                  <div>
                    <div className="font-semibold">{c.label}</div>
                    <div className="text-xs text-gray-500 dark:text-gray-400 font-mono">
                      BLZ {c.blz} · {c.endpointUrl}
                    </div>
                    <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                      {c.lastSyncAt
                        ? `${t("banking.lastSync")}: ${new Date(c.lastSyncAt).toLocaleString("de-DE")}`
                        : t("banking.neverSynced")}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span
                      className={`text-xs px-2 py-1 rounded ${
                        c.status === "active"
                          ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200"
                          : c.status === "error"
                          ? "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200"
                          : "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200"
                      }`}
                    >
                      {c.status === "active"
                        ? t("banking.statusActive")
                        : c.status === "error"
                        ? t("banking.statusError")
                        : t("banking.statusPending")}
                    </span>
                    {c.mockMode === 1 && (
                      <span className="text-xs px-2 py-1 rounded bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300">
                        {t("banking.mockBadge")}
                      </span>
                    )}
                  </div>
                </div>
                {c.lastError && c.status === "error" && (
                  <div className="text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 p-2 rounded">
                    {c.lastError}
                  </div>
                )}
                <div className="flex gap-2 pt-1">
                  <Button
                    size="sm"
                    onClick={() => handleSync(c.id)}
                    disabled={syncingIds.has(c.id)}
                  >
                    {syncingIds.has(c.id)
                      ? t("banking.syncing")
                      : t("banking.syncNow")}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleDelete(c.id)}
                  >
                    {t("banking.delete")}
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </div>

      {/* Recent transactions */}
      {recentTxns.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>{t("banking.recentTxns")}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">
                    <th className="py-2 pr-3">{t("banking.txnDate")}</th>
                    <th className="py-2 pr-3">{t("banking.txnCounterparty")}</th>
                    <th className="py-2 pr-3">{t("banking.txnPurpose")}</th>
                    <th className="py-2 pr-3 text-right">{t("banking.txnAmount")}</th>
                  </tr>
                </thead>
                <tbody>
                  {recentTxns.map((t) => (
                    <tr
                      key={t.id}
                      className="border-b border-gray-100 dark:border-gray-800"
                    >
                      <td className="py-2 pr-3 font-mono text-xs">
                        {new Date(t.valueDate).toLocaleDateString("de-DE")}
                      </td>
                      <td className="py-2 pr-3">
                        {t.counterpartyName || "—"}
                      </td>
                      <td className="py-2 pr-3 text-xs text-gray-600 dark:text-gray-400">
                        {t.purpose || "—"}
                      </td>
                      <td
                        className={`py-2 pr-3 text-right font-mono ${
                          parseFloat(t.amount) >= 0
                            ? "text-emerald-700 dark:text-emerald-400"
                            : "text-red-700 dark:text-red-400"
                        }`}
                      >
                        {parseFloat(t.amount).toLocaleString("de-DE", {
                          style: "currency",
                          currency: t.currency,
                        })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Tier 9: Reconciliations panel.
          Lists the auto-matched BankReconciliation
          rows so the user can confirm/reject
          inline. Sorted by confidence DESC — the
          high-confidence matches (>=95) appear
          first, the borderline ones (50-80) need
          a closer look. The "reason" column shows
          WHY the matcher paired them (FX tolerance,
          sum-to-invoice, name fuzzy, etc.) so the
          user can sanity-check before confirming. */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {t("banking.reconPanelTitle")}
            {reconciliations.filter((r) => r.status === "suggested").length > 0 && (
              <span className="text-xs px-2 py-1 rounded bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200">
                {reconciliations.filter((r) => r.status === "suggested").length}
              </span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {reconsLoading ? (
            <div className="text-sm text-gray-500 dark:text-gray-400">
              {t("common.loading")}
            </div>
          ) : reconciliations.length === 0 ? (
            <div className="text-sm text-gray-500 dark:text-gray-400">
              {t("banking.reconEmpty")}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">
                    <th className="py-2 pr-3">
                      {t("banking.reconConfidence")}
                    </th>
                    <th className="py-2 pr-3">
                      {t("banking.reconInvoice")}
                    </th>
                    <th className="py-2 pr-3">
                      {t("banking.reconCounterparty")}
                    </th>
                    <th className="py-2 pr-3 text-right">
                      {t("banking.reconAmount")}
                    </th>
                    <th className="py-2 pr-3">
                      {t("banking.reconReason")}
                    </th>
                    <th className="py-2 pr-3">
                      {t("banking.reconActions")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {reconciliations.map((r) => (
                    <tr
                      key={r.id}
                      className="border-b border-gray-100 dark:border-gray-800"
                    >
                      <td className="py-2 pr-3 font-mono text-xs">
                        <span
                          className={`px-2 py-1 rounded text-xs font-semibold ${
                            r.confidence >= 95
                              ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200"
                              : r.confidence >= 80
                              ? "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200"
                              : "bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300"
                          }`}
                        >
                          {r.confidence}
                        </span>
                      </td>
                      <td className="py-2 pr-3 font-mono text-xs">
                        {r.invoice.invoiceNumber}
                        <div className="text-xs text-gray-500 dark:text-gray-400">
                          {parseFloat(r.invoice.total).toLocaleString("de-DE", {
                            style: "currency",
                            currency: "EUR",
                          })}
                        </div>
                      </td>
                      <td className="py-2 pr-3">
                        {r.bankTransaction.counterpartyName || "—"}
                        <div className="text-xs text-gray-500 dark:text-gray-400 font-mono">
                          {r.bankTransaction.valueDate.slice(0, 10)}
                        </div>
                      </td>
                      <td className="py-2 pr-3 text-right font-mono">
                        {parseFloat(r.bankTransaction.amount).toLocaleString(
                          "de-DE",
                          {
                            style: "currency",
                            currency: r.bankTransaction.currency,
                          },
                        )}
                      </td>
                      <td className="py-2 pr-3 text-xs text-gray-600 dark:text-gray-400 italic">
                        {r.matchReason || "—"}
                      </td>
                      <td className="py-2 pr-3">
                        {r.status === "suggested" ? (
                          <div className="flex gap-2">
                            <Button
                              size="sm"
                              onClick={() => handleConfirmRecon(r.id)}
                            >
                              {t("banking.reconConfirm")}
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => handleRejectRecon(r.id)}
                            >
                              {t("banking.reconReject")}
                            </Button>
                          </div>
                        ) : (
                          <span className="text-xs px-2 py-1 rounded bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200">
                            {t("banking.reconStatusConfirmed")}
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

      {/* Add-connection modal */}
      {showAddModal && (
        <AddConnectionModal
          onClose={() => setShowAddModal(false)}
          onSubmit={handleAdd}
        />
      )}

      {/* TAN modal */}
      {tanModal && (
        <TanModal
          challenge={tanModal.challenge}
          onClose={() => setTanModal(null)}
          onSubmit={handleTanSubmit}
        />
      )}
    </div>
  )
}

function AddConnectionModal({
  onClose,
  onSubmit,
}: {
  onClose: () => void
  onSubmit: (form: {
    blz: string
    userId: string
    label: string
    pin: string
    mockMode: boolean
  }) => void
}) {
  const { t } = useI18n()
  const [blz, setBlz] = useState("")
  const [userId, setUserId] = useState("")
  const [label, setLabel] = useState("")
  const [pin, setPin] = useState("")
  const [mockMode, setMockMode] = useState(true)

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <Card className="w-full max-w-md mx-4">
        <CardHeader>
          <CardTitle>{t("banking.addConnectionTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <label className="text-sm font-medium block mb-1">{t("banking.blz")}</label>
            <Input
              value={blz}
              onChange={(e) => setBlz(e.target.value)}
              placeholder="50050201"
              maxLength={8}
            />
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              {t("banking.blzHint")}
            </p>
          </div>
          <div>
            <label className="text-sm font-medium block mb-1">{t("banking.userId")}</label>
            <Input
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              placeholder="e2e-test-user"
            />
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              {t("banking.userIdHint")}
            </p>
          </div>
          <div>
            <label className="text-sm font-medium block mb-1">{t("banking.label")}</label>
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={t("banking.labelPlaceholder")}
            />
          </div>
          <div>
            <label className="text-sm font-medium block mb-1">{t("banking.pin")}</label>
            <Input
              type="password"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
            />
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              {t("banking.pinHint")}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="mockMode"
              checked={mockMode}
              onChange={(e) => setMockMode(e.target.checked)}
            />
            <label htmlFor="mockMode" className="text-sm">
              {t("banking.mockModeLabel")}
            </label>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button
              onClick={() => onSubmit({ blz, userId, label, pin, mockMode })}
              disabled={!blz || !userId || !label || !pin}
            >
              {t("banking.create")}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

function TanModal({
  challenge,
  onClose,
  onSubmit,
}: {
  challenge: string
  onClose: () => void
  onSubmit: (tan: string) => void
}) {
  const { t } = useI18n()
  const [tan, setTan] = useState("")

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <Card className="w-full max-w-md mx-4">
        <CardHeader>
          <CardTitle>{t("banking.tanTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="bg-amber-50 dark:bg-amber-900/20 p-3 rounded text-sm text-amber-800 dark:text-amber-200">
            {challenge}
          </div>
          <div>
            <label className="text-sm font-medium block mb-1">{t("banking.tan")}</label>
            <Input
              value={tan}
              onChange={(e) => setTan(e.target.value)}
              placeholder="123456"
              autoFocus
            />
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              {t("banking.tanHint")}
            </p>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button onClick={() => onSubmit(tan)} disabled={tan.length < 4}>
              {t("banking.tanSubmit")}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
