"use client"

// Tier 10: SEPA-Überweisung + Lastschrift via FinTS.
//
// Two-step TAN flow (mirrors the read-sync
// pattern in /dashboard/banking):
//
//   1. Fill form → click "Überweisung
//      senden" → backend POSTs to FinTS,
//      returns {status: 'needs_tan',
//      tanChallenge, transferId}.
//
//   2. TAN modal opens with the bank's
//      challenge text. User enters 6-digit
//      TAN → submit → flips to 'ok'.
//
// The "Recent transfers" table below the
// form surfaces the history with status
// badges (draft / needs_tan / ok /
// failed). The user can also click a
// "neue Überweisung" button to reset the
// form after a successful transfer.
//
// Mandate + sequence-type fields are
// conditional: only shown when
// `kind === 'direct_debit'` (Lastschrift).
// Überweisung is the default.

import { useEffect, useState } from "react"
import { useI18n } from "@/components/useI18n"
import { apiGet, apiPost } from "@/lib/api"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"

interface FinTsConnection {
  id: string
  label: string
  blz: string
  status: string
}

interface FinTsTransfer {
  id: string
  kind: string
  creditorName: string
  creditorIban: string
  creditorBic: string | null
  amount: string
  currency: string
  purpose: string | null
  endToEndId: string
  status: string
  errorCode: string | null
  errorMessage: string | null
  startedAt: string
  finishedAt: string | null
}

export default function TransfersPage() {
  const { t } = useI18n()
  const [companyId, setCompanyId] = useState<string>("")

  const [connections, setConnections] = useState<FinTsConnection[]>([])
  const [transfers, setTransfers] = useState<FinTsTransfer[]>([])
  const [loading, setLoading] = useState(true)

  // Form state
  const [kind, setKind] = useState<"credit_transfer" | "direct_debit">(
    "credit_transfer",
  )
  const [connectionId, setConnectionId] = useState("")
  const [creditorName, setCreditorName] = useState("")
  const [creditorIban, setCreditorIban] = useState("")
  const [creditorBic, setCreditorBic] = useState("")
  const [amount, setAmount] = useState("")
  const [currency, setCurrency] = useState("EUR")
  const [purpose, setPurpose] = useState("")
  const [endToEndId, setEndToEndId] = useState("")
  const [mandateId, setMandateId] = useState("")
  const [sequenceType, setSequenceType] = useState<"FRST" | "RCUR" | "FNAL" | "OOFF">(
    "FRST",
  )
  const [submitting, setSubmitting] = useState(false)

  // TAN modal
  const [tanModalOpen, setTanModalOpen] = useState(false)
  const [tanChallenge, setTanChallenge] = useState("")
  const [pendingTransferId, setPendingTransferId] = useState("")
  const [tanInput, setTanInput] = useState("")

  const loadConnections = async (cid: string) => {
    if (!cid) return
    try {
      const data = await apiGet<FinTsConnection[]>(
        `/api/v1/fints/connections?companyId=${cid}`,
      )
      // Only active or pending connections can send transfers
      const usable = data.filter(
        (c) => c.status === "active" || c.status === "pending",
      )
      setConnections(usable)
      if (usable.length > 0 && !connectionId) {
        setConnectionId(usable[0].id)
      }
    } catch (e) {
      console.error("Failed to load FinTS connections:", e)
    }
  }

  const loadTransfers = async (cid: string) => {
    if (!cid) return
    try {
      const data = await apiGet<FinTsTransfer[]>(
        `/api/v1/fints/transfers?companyId=${cid}`,
      )
      setTransfers(data)
    } catch (e) {
      console.error("Failed to load transfers:", e)
    }
  }

  useEffect(() => {
    const cid = localStorage.getItem("companyId") || ""
    setCompanyId(cid)
    if (!cid) return
    setLoading(true)
    Promise.all([loadConnections(cid), loadTransfers(cid)]).finally(() =>
      setLoading(false),
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const resetForm = () => {
    setCreditorName("")
    setCreditorIban("")
    setCreditorBic("")
    setAmount("")
    setPurpose("")
    setEndToEndId("")
    setMandateId("")
    setSequenceType("FRST")
    setKind("credit_transfer")
  }

  const handleStart = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!companyId || !connectionId) {
      alert(t("banking.transferNoConnection"))
      return
    }
    setSubmitting(true)
    try {
      const result = await apiPost<{
        status: string
        tanChallenge?: string
        transferId: string
        errorMessage?: string
      }>(`/api/v1/fints/transfers`, {
        companyId,
        connectionId,
        kind,
        creditorName,
        creditorIban,
        creditorBic: creditorBic || undefined,
        amount,
        currency,
        purpose: purpose || undefined,
        endToEndId,
        mandateId: kind === "direct_debit" ? mandateId : undefined,
        sequenceType: kind === "direct_debit" ? sequenceType : undefined,
      })

      if (result.status === "needs_tan") {
        setTanChallenge(result.tanChallenge || "")
        setPendingTransferId(result.transferId)
        setTanModalOpen(true)
        alert(t("banking.transferTanRequired"))
      } else if (result.status === "ok") {
        alert(t("banking.transferOk"))
        resetForm()
        await loadTransfers(companyId)
      } else if (result.status === "failed") {
        alert(
          result.errorMessage || t("banking.transferFailed"),
        )
      }
    } catch (e: any) {
      alert(e?.message || t("banking.transferFailed"))
    } finally {
      setSubmitting(false)
    }
  }

  const handleSubmitTan = async () => {
    if (!pendingTransferId || !tanInput) return
    try {
      const result = await apiPost<{
        status: string
        errorMessage?: string
      }>(`/api/v1/fints/transfers/${pendingTransferId}/tan`, {
        companyId,
        tan: tanInput,
      })
      if (result.status === "ok") {
        alert(t("banking.transferOk"))
        setTanModalOpen(false)
        setTanInput("")
        setPendingTransferId("")
        resetForm()
        await loadTransfers(companyId)
      } else {
        alert(
          result.errorMessage || t("banking.transferTanFailed"),
        )
      }
    } catch (e: any) {
      alert(e?.message || t("banking.transferTanFailed"))
    }
  }

  // Auto-fill EndToEndId with timestamp + kind if empty.
  // SEPA E2E IDs must be ≤35 chars and ASCII;
  // we use YYYYMMDD-HHMMSS-<kind>-<rand> for
  // uniqueness. The user can override manually.
  const autofillE2E = () => {
    if (endToEndId) return
    const ts = new Date()
      .toISOString()
      .replace(/[-:T.Z]/g, "")
      .slice(0, 14)
    const tag = kind === "credit_transfer" ? "CT" : "DD"
    const rand = Math.floor(Math.random() * 10000)
      .toString()
      .padStart(4, "0")
    setEndToEndId(`${ts}-${tag}-${rand}`)
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => (window.location.href = "/dashboard/banking")}
        >
          ←
          {t("common.back")}
        </Button>
        <h1 className="text-2xl font-semibold">{t("banking.transferTitle")}</h1>
      </div>

      {loading ? (
        <div className="text-sm text-gray-500">{t("common.loading")}</div>
      ) : connections.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-gray-500">
            {t("banking.transferNoConnection")}
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Transfer form */}
          <Card>
            <CardHeader>
              <CardTitle>{t("banking.transferFormTitle")}</CardTitle>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleStart} className="space-y-4">
                {/* Kind toggle */}
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant={kind === "credit_transfer" ? "default" : "outline"}
                    size="sm"
                    onClick={() => setKind("credit_transfer")}
                  >
                    {t("banking.transferKindCredit")}
                  </Button>
                  <Button
                    type="button"
                    variant={kind === "direct_debit" ? "default" : "outline"}
                    size="sm"
                    onClick={() => setKind("direct_debit")}
                  >
                    {t("banking.transferKindDebit")}
                  </Button>
                </div>

                {/* Connection picker */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-1">
                    <Label htmlFor="conn">{t("banking.transferConnection")}</Label>
                    <select
                      id="conn"
                      value={connectionId}
                      onChange={(e) => setConnectionId(e.target.value)}
                      className="flex h-10 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800"
                      required
                    >
                      {connections.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.label} (BLZ {c.blz})
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                {/* Creditor */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-1">
                    <Label htmlFor="creditorName">
                      {t("banking.transferCreditorName")}
                    </Label>
                    <Input
                      id="creditorName"
                      value={creditorName}
                      onChange={(e) => setCreditorName(e.target.value)}
                      required
                      placeholder={t("banking.transferCreditorNamePlaceholder")}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="creditorIban">
                      {t("banking.transferCreditorIban")}
                    </Label>
                    <Input
                      id="creditorIban"
                      value={creditorIban}
                      onChange={(e) => setCreditorIban(e.target.value)}
                      required
                      placeholder="DE89 3704 0044 0532 0130 00"
                      className="font-mono"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="space-y-1">
                    <Label htmlFor="creditorBic">
                      {t("banking.transferCreditorBic")}
                    </Label>
                    <Input
                      id="creditorBic"
                      value={creditorBic}
                      onChange={(e) => setCreditorBic(e.target.value)}
                      placeholder="DEUTDEFF"
                      className="font-mono"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="amount">
                      {t("banking.transferAmount")}
                    </Label>
                    <Input
                      id="amount"
                      type="number"
                      step="0.01"
                      min="0.01"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      required
                      placeholder="119.00"
                      className="font-mono"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="currency">
                      {t("banking.transferCurrency")}
                    </Label>
                    <Input
                      id="currency"
                      value={currency}
                      onChange={(e) => setCurrency(e.target.value)}
                      maxLength={3}
                      required
                      className="font-mono"
                    />
                  </div>
                </div>

                <div className="space-y-1">
                  <Label htmlFor="purpose">
                    {t("banking.transferPurpose")}
                  </Label>
                  <Textarea
                    id="purpose"
                    value={purpose}
                    onChange={(e) => setPurpose(e.target.value)}
                    rows={2}
                    placeholder={t("banking.transferPurposePlaceholder")}
                  />
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-1">
                    <Label htmlFor="endToEndId">
                      {t("banking.transferEndToEndId")}
                    </Label>
                    <div className="flex gap-2">
                      <Input
                        id="endToEndId"
                        value={endToEndId}
                        onChange={(e) => setEndToEndId(e.target.value)}
                        required
                        maxLength={35}
                        className="font-mono"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={autofillE2E}
                      >
                        ↻
                      </Button>
                    </div>
                  </div>
                </div>

                {/* Lastschrift-only fields */}
                {kind === "direct_debit" && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 border-l-4 border-amber-400 pl-4">
                    <div className="space-y-1">
                      <Label htmlFor="mandateId">
                        {t("banking.transferMandateId")}
                      </Label>
                      <Input
                        id="mandateId"
                        value={mandateId}
                        onChange={(e) => setMandateId(e.target.value)}
                        required={kind === "direct_debit"}
                        placeholder="M-2026-001"
                        className="font-mono"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="sequenceType">
                        {t("banking.transferSequenceType")}
                      </Label>
                      <select
                        id="sequenceType"
                        value={sequenceType}
                        onChange={(e) =>
                          setSequenceType(e.target.value as any)
                        }
                        className="flex h-10 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800"
                      >
                        <option value="FRST">FRST — Erstlastschrift</option>
                        <option value="RCUR">RCUR — Folgelastschrift</option>
                        <option value="FNAL">FNAL — Letztmalig</option>
                        <option value="OOFF">OOFF — Einmalig</option>
                      </select>
                    </div>
                  </div>
                )}

                <div className="flex gap-2 pt-2">
                  <Button type="submit" disabled={submitting}>
                    ↗
                    {submitting ? t("common.loading") : t("banking.transferSubmit")}
                  </Button>
                  <Button type="button" variant="outline" onClick={resetForm}>
                    {t("common.reset")}
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>

          {/* History */}
          <Card>
            <CardHeader>
              <CardTitle>{t("banking.transferHistoryTitle")}</CardTitle>
            </CardHeader>
            <CardContent>
              {transfers.length === 0 ? (
                <div className="text-sm text-gray-500 dark:text-gray-400">
                  {t("banking.transferHistoryEmpty")}
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">
                        <th className="py-2 pr-3">{t("banking.transferHistoryDate")}</th>
                        <th className="py-2 pr-3">{t("banking.transferHistoryKind")}</th>
                        <th className="py-2 pr-3">{t("banking.transferHistoryCreditor")}</th>
                        <th className="py-2 pr-3 text-right">{t("banking.transferHistoryAmount")}</th>
                        <th className="py-2 pr-3">{t("banking.transferHistoryE2E")}</th>
                        <th className="py-2 pr-3">{t("banking.transferHistoryStatus")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {transfers.map((tr) => (
                        <tr
                          key={tr.id}
                          className="border-b border-gray-100 dark:border-gray-800"
                        >
                          <td className="py-2 pr-3 text-xs font-mono">
                            {tr.startedAt.slice(0, 10)}
                          </td>
                          <td className="py-2 pr-3 text-xs">
                            {tr.kind === "credit_transfer"
                              ? t("banking.transferKindCredit")
                              : t("banking.transferKindDebit")}
                          </td>
                          <td className="py-2 pr-3">
                            {tr.creditorName}
                            <div className="text-xs text-gray-500 dark:text-gray-400 font-mono">
                              {tr.creditorIban}
                            </div>
                          </td>
                          <td className="py-2 pr-3 text-right font-mono">
                            {parseFloat(tr.amount).toLocaleString("de-DE", {
                              style: "currency",
                              currency: tr.currency,
                            })}
                          </td>
                          <td className="py-2 pr-3 text-xs font-mono text-gray-500 dark:text-gray-400">
                            {tr.endToEndId}
                          </td>
                          <td className="py-2 pr-3">
                            <span
                              className={`text-xs px-2 py-1 rounded font-semibold ${
                                tr.status === "ok"
                                  ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200"
                                  : tr.status === "needs_tan"
                                  ? "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200"
                                  : tr.status === "failed"
                                  ? "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200"
                                  : "bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300"
                              }`}
                            >
                              {t(
                                `banking.transferStatus${
                                  tr.status.charAt(0).toUpperCase() +
                                  tr.status.slice(1)
                                }`,
                              )}
                            </span>
                            {tr.errorMessage && (
                              <div className="text-xs text-red-600 dark:text-red-400 mt-1">
                                {tr.errorMessage}
                              </div>
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
        </>
      )}

      {/* TAN modal */}
      {tanModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl p-6 max-w-md w-full mx-4">
            <h3 className="text-lg font-semibold mb-2">
              {t("banking.transferTanModalTitle")}
            </h3>
            <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">
              {tanChallenge}
            </p>
            <div className="space-y-3">
              <div className="space-y-1">
                <Label htmlFor="tanInput">
                  {t("banking.transferTanInputLabel")}
                </Label>
                <Input
                  id="tanInput"
                  value={tanInput}
                  onChange={(e) => setTanInput(e.target.value)}
                  placeholder="123456"
                  className="font-mono text-lg tracking-widest"
                  maxLength={8}
                  autoFocus
                />
              </div>
              <div className="flex gap-2 pt-2">
                <Button
                  onClick={handleSubmitTan}
                  disabled={tanInput.length < 6}
                >
                  ✓
                  {t("banking.transferTanSubmit")}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    setTanModalOpen(false)
                    setTanInput("")
                    setPendingTransferId("")
                  }}
                >
                  ✕
                  {t("common.cancel")}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}