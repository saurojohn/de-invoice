"use client"

/**
 * Tier 58: Customer credit balance (Kundenguthaben) page.
 *
 * Shows the customer's current credit balance + the full
 * ledger of every credit movement (overpayment, Gutschrift
 * overage, payout, apply-to-invoice, manual adjustment) and
 * the Auszahlung form for posting a refund.
 *
 * The page is the natural drill-down from the customer
 * list / statement page's "Kundenguthaben" badge — click the
 * badge, you land here, you see the full history + can
 * issue a new payout.
 *
 * URL: /dashboard/customers/[id]/credit?companyId=<id>
 */

import { useEffect, useState } from "react"
import { useParams, useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { ErrorBanner } from "@/components/ui/error-banner"
import { useI18n } from "@/components/useI18n"
import { apiGet, apiPost, ApiError } from "@/lib/api"

interface LedgerRow {
  id: string
  type: "overpayment" | "gutschrift" | "payout" | "apply" | "manual"
  amount: number
  currency: string
  balanceAfter: number
  referenceType: string | null
  referenceId: string | null
  description: string | null
  createdById: string | null
  createdAt: string
}

interface BankAccount {
  id: string
  accountNumber: string
  name: string
}

function fmtEur(n: number, locale: string = "de-DE"): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n)
}

function fmtDateDE(d: string): string {
  const date = new Date(d)
  const day = String(date.getUTCDate()).padStart(2, "0")
  const month = String(date.getUTCMonth() + 1).padStart(2, "0")
  return `${day}.${month}.${date.getUTCFullYear()}`
}

function fmtDateTimeDE(d: string): string {
  const date = new Date(d)
  const day = String(date.getUTCDate()).padStart(2, "0")
  const month = String(date.getUTCMonth() + 1).padStart(2, "0")
  const year = date.getUTCFullYear()
  const hh = String(date.getUTCHours()).padStart(2, "0")
  const mm = String(date.getUTCMinutes()).padStart(2, "0")
  return `${day}.${month}.${year} ${hh}:${mm}`
}

// Human-readable label for each ledger type. Used in
// the ledger table and in the payout success toast so
// the Berater can see at a glance which kind of
// movement they just recorded.
const TYPE_LABEL: Record<string, string> = {
  overpayment: "Überzahlung",
  gutschrift: "Gutschrift-Überschuss",
  payout: "Auszahlung",
  apply: "Verrechnung mit Rechnung",
  manual: "Manuelle Korrektur",
}

export default function CustomerCreditPage() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const { t } = useI18n()

  const [companyId, setCompanyId] = useState<string | null>(null)
  const [balance, setBalance] = useState<number>(0)
  const [ledger, setLedger] = useState<LedgerRow[]>([])
  const [customerName, setCustomerName] = useState<string>("")
  const [customerNumber, setCustomerNumber] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Payout form state
  const [showPayout, setShowPayout] = useState(false)
  const [payoutAmount, setPayoutAmount] = useState<string>("")
  const [payoutDescription, setPayoutDescription] = useState<string>("")
  const [bankAccounts, setBankAccounts] = useState<BankAccount[]>([])
  const [payoutBankId, setPayoutBankId] = useState<string>("")
  const [payoutDate, setPayoutDate] = useState<string>(
    new Date().toISOString().slice(0, 10),
  )
  const [payoutSubmitting, setPayoutSubmitting] = useState(false)
  const [payoutError, setPayoutError] = useState<string | null>(null)
  const [payoutSuccess, setPayoutSuccess] = useState<string | null>(null)

  // Manual adjustment form state
  const [showAdjust, setShowAdjust] = useState(false)
  const [adjustAmount, setAdjustAmount] = useState<string>("")
  const [adjustDescription, setAdjustDescription] = useState<string>("")
  const [adjustSubmitting, setAdjustSubmitting] = useState(false)
  const [adjustError, setAdjustError] = useState<string | null>(null)

  useEffect(() => {
    const stored = typeof window !== "undefined" ? localStorage.getItem("companyId") : null
    if (stored) setCompanyId(stored)
  }, [])

  // Fetch customer + balance + ledger + bank accounts in parallel.
  // All three are read-only and have small payloads.
  useEffect(() => {
    if (!companyId || !id) return
    let cancelled = false
    setLoading(true)
    setError(null)
    Promise.all([
      apiGet<{ name: string; customerNumber: string | null }>(
        `/api/v1/customers/${id}?companyId=${companyId}`,
      ),
      apiGet<{ balance: number; currency: string }>(
        `/api/v1/customers/${id}/credit-balance?companyId=${companyId}`,
      ),
      apiGet<LedgerRow[]>(
        `/api/v1/customers/${id}/credit-ledger?companyId=${companyId}`,
      ),
      apiGet<BankAccount[]>(
        `/api/v1/accounting/accounts?companyId=${companyId}`,
      ),
    ])
      .then(([cust, bal, led, accs]) => {
        if (cancelled) return
        setCustomerName(cust.name)
        setCustomerNumber(cust.customerNumber)
        setBalance(bal.balance)
        setLedger(led)
        // Bank accounts are filtered to "liquidity" — the
        // Sachkonten that can hold a real Euro balance
        // (1000 Kasse, 1200 Bank, etc.). 1400 Forderungen
        // is a receivable, not a payout target, so we
        // exclude it from the dropdown to avoid a 400 from
        // the payout endpoint's "1200/1400 not 1210"
        // fallback mismatch.
        const liquidity = accs.filter(
          (a) => a.accountNumber === "1000" || a.accountNumber === "1200" || a.accountNumber === "1800",
        )
        setBankAccounts(liquidity)
        if (liquidity.length > 0) {
          // Default to Bank (1200) if present, else Kasse
          const bank =
            liquidity.find((a) => a.accountNumber === "1200") ||
            liquidity[0]
          setPayoutBankId(bank.id)
        }
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof ApiError ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [companyId, id])

  async function handlePayout(e: React.FormEvent) {
    e.preventDefault()
    if (!companyId || !id) return
    if (!payoutBankId) {
      setPayoutError("Bitte ein Bankkonto auswählen")
      return
    }
    const amount = parseFloat(payoutAmount.replace(",", "."))
    if (!Number.isFinite(amount) || amount <= 0) {
      setPayoutError("Betrag muss eine positive Zahl sein")
      return
    }
    if (amount > balance) {
      setPayoutError(
        `Guthaben reicht nicht aus: ${fmtEur(balance)} verfügbar, ${fmtEur(amount)} angefordert`,
      )
      return
    }
    setPayoutSubmitting(true)
    setPayoutError(null)
    try {
      const r = await apiPost<{
        voucherNumber: string
        ledgerId: string
        balanceAfter: number
      }>(
        `/api/v1/customers/${id}/credit-payout?companyId=${companyId}`,
        {
          amount,
          paymentDate: payoutDate,
          bankAccountId: payoutBankId,
          description: payoutDescription || undefined,
        },
      )
      setPayoutSuccess(
        `Auszahlung gebucht: Beleg ${r.voucherNumber}, neuer Saldo ${fmtEur(r.balanceAfter)}`,
      )
      setShowPayout(false)
      setPayoutAmount("")
      setPayoutDescription("")
      // Re-fetch ledger + balance so the UI reflects the
      // new row immediately.
      const [bal, led] = await Promise.all([
        apiGet<{ balance: number }>(
          `/api/v1/customers/${id}/credit-balance?companyId=${companyId}`,
        ),
        apiGet<LedgerRow[]>(
          `/api/v1/customers/${id}/credit-ledger?companyId=${companyId}`,
        ),
      ])
      setBalance(bal.balance)
      setLedger(led)
    } catch (err) {
      setPayoutError(
        err instanceof ApiError ? err.message : `Fehler: ${String(err)}`,
      )
    } finally {
      setPayoutSubmitting(false)
    }
  }

  async function handleAdjust(e: React.FormEvent) {
    e.preventDefault()
    if (!companyId || !id) return
    const amount = parseFloat(adjustAmount.replace(",", "."))
    if (!Number.isFinite(amount) || amount === 0) {
      setAdjustError("Betrag darf nicht 0 sein")
      return
    }
    if (!adjustDescription.trim()) {
      setAdjustError("Beschreibung ist erforderlich")
      return
    }
    setAdjustSubmitting(true)
    setAdjustError(null)
    try {
      await apiPost(
        `/api/v1/customers/${id}/credit-adjust?companyId=${companyId}`,
        { amount, description: adjustDescription },
      )
      setShowAdjust(false)
      setAdjustAmount("")
      setAdjustDescription("")
      const [bal, led] = await Promise.all([
        apiGet<{ balance: number }>(
          `/api/v1/customers/${id}/credit-balance?companyId=${companyId}`,
        ),
        apiGet<LedgerRow[]>(
          `/api/v1/customers/${id}/credit-ledger?companyId=${companyId}`,
        ),
      ])
      setBalance(bal.balance)
      setLedger(led)
    } catch (err) {
      setAdjustError(
        err instanceof ApiError ? err.message : `Fehler: ${String(err)}`,
      )
    } finally {
      setAdjustSubmitting(false)
    }
  }

  if (!companyId) {
    return (
      <div className="container mx-auto p-8">
        <p className="text-gray-500">{t("common.loading") || "Lädt..."}</p>
      </div>
    )
  }

  return (
    <div className="container mx-auto p-4 md:p-8">
      <header className="mb-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold" data-testid="credit-page-title">
              {t("credit.title") || "Kundenguthaben"}
            </h1>
            <p className="text-gray-500 dark:text-gray-400 mt-1">
              {customerName}
              {customerNumber ? (
                <span className="font-mono ml-2 text-sm">
                  ({customerNumber})
                </span>
              ) : null}
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() => router.push(`/dashboard/customers/${id}/statement`)}
              data-testid="credit-back-to-statement"
            >
              📊 {t("statement.title") || "Kontoauszug"}
            </Button>
            <Button
              variant="outline"
              onClick={() => router.push("/dashboard/customers")}
            >
              ← {t("common.back") || "Zurück"}
            </Button>
          </div>
        </div>
      </header>

      {error && <ErrorBanner title={t("common.error") || "Fehler"} message={error} />}
      {payoutSuccess && (
        <div
          className="mb-4 p-3 rounded border border-emerald-300 bg-emerald-50 text-emerald-800 text-sm"
          data-testid="credit-payout-success"
        >
          ✓ {payoutSuccess}
        </div>
      )}

      {loading ? (
        <div className="p-4 text-gray-500">{t("common.loading") || "Lädt..."}</div>
      ) : (
        <>
          {/* Balance summary + actions */}
          <Card className="mb-6">
            <CardHeader>
              <CardTitle>
                <div className="flex items-baseline justify-between gap-4">
                  <span>{t("credit.currentBalance") || "Aktuelles Guthaben"}</span>
                  <span
                    className={
                      "text-3xl font-mono font-bold " +
                      (balance > 0
                        ? "text-blue-700"
                        : balance < 0
                          ? "text-orange-700"
                          : "text-gray-500")
                    }
                    data-testid="credit-balance-value"
                  >
                    {fmtEur(balance)}
                  </span>
                </div>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-2">
                <Button
                  onClick={() => setShowPayout(!showPayout)}
                  disabled={balance <= 0}
                  data-testid="credit-payout-button"
                >
                  💸 {t("credit.issuePayout") || "Auszahlung buchen"}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => setShowAdjust(!showAdjust)}
                  data-testid="credit-adjust-button"
                >
                  ✏️ {t("credit.manualAdjust") || "Manuelle Korrektur"}
                </Button>
              </div>
              {balance <= 0 && (
                <p className="text-xs text-gray-500 mt-2">
                  {t("credit.payoutDisabledHint") ||
                    "Eine Auszahlung ist erst möglich, wenn der Kunde ein positives Guthaben hat."}
                </p>
              )}
            </CardContent>
          </Card>

          {/* Payout form (collapsible) */}
          {showPayout && (
            <Card className="mb-6" data-testid="credit-payout-form">
              <CardHeader>
                <CardTitle>
                  {t("credit.payoutTitle") || "Auszahlung an Kunden buchen"}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <form onSubmit={handlePayout} className="space-y-3">
                  <div>
                    <label className="text-sm text-gray-600 dark:text-gray-300 block mb-1">
                      {t("credit.payoutAmount") || "Betrag (EUR)"} *
                    </label>
                    <Input
                      type="text"
                      inputMode="decimal"
                      value={payoutAmount}
                      onChange={(e) => setPayoutAmount(e.target.value)}
                      placeholder={balance.toFixed(2)}
                      data-testid="credit-payout-amount"
                      required
                    />
                    <p className="text-xs text-gray-500 mt-1">
                      {t("credit.availableBalance") || "Verfügbares Guthaben"}: {fmtEur(balance)}
                    </p>
                  </div>
                  <div>
                    <label className="text-sm text-gray-600 dark:text-gray-300 block mb-1">
                      {t("credit.payoutDate") || "Datum"} *
                    </label>
                    <Input
                      type="date"
                      value={payoutDate}
                      onChange={(e) => setPayoutDate(e.target.value)}
                      data-testid="credit-payout-date"
                      required
                    />
                  </div>
                  <div>
                    <label className="text-sm text-gray-600 dark:text-gray-300 block mb-1">
                      {t("credit.payoutBankAccount") || "Bankkonto (Soll 1200/1000)"} *
                    </label>
                    <select
                      value={payoutBankId}
                      onChange={(e) => setPayoutBankId(e.target.value)}
                      className="w-full border rounded px-3 py-2 text-sm dark:bg-gray-800 dark:border-gray-600"
                      data-testid="credit-payout-bank"
                      required
                    >
                      {bankAccounts.length === 0 ? (
                        <option value="">— Bitte Bankkonto (1000/1200) einrichten —</option>
                      ) : (
                        bankAccounts.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.accountNumber} {a.name}
                          </option>
                        ))
                      )}
                    </select>
                  </div>
                  <div>
                    <label className="text-sm text-gray-600 dark:text-gray-300 block mb-1">
                      {t("credit.payoutDescription") || "Beschreibung (optional)"}
                    </label>
                    <Input
                      type="text"
                      value={payoutDescription}
                      onChange={(e) => setPayoutDescription(e.target.value)}
                      placeholder={t("credit.payoutDescriptionHint") || "z. B. Erstattung Q1-2026"}
                      data-testid="credit-payout-description"
                    />
                  </div>
                  {payoutError && (
                    <div className="text-sm text-red-600">{payoutError}</div>
                  )}
                  <div className="flex gap-2">
                    <Button
                      type="submit"
                      disabled={payoutSubmitting || bankAccounts.length === 0}
                      data-testid="credit-payout-submit"
                    >
                      {payoutSubmitting
                        ? (t("common.saving") || "Speichert...")
                        : (t("credit.payoutSubmit") || "Auszahlung buchen")}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => {
                        setShowPayout(false)
                        setPayoutError(null)
                      }}
                    >
                      {t("common.cancel") || "Abbrechen"}
                    </Button>
                  </div>
                  <p className="text-xs text-gray-500">
                    {t("credit.payoutAccountingNote") ||
                      "Es wird ein Buchungsbeleg erstellt: 1200 Bank (Soll) ↔ 1400 Forderungen (Haben). Der Beleg erscheint im Journal und im DATEV-Export."}
                  </p>
                </form>
              </CardContent>
            </Card>
          )}

          {/* Manual adjust form (collapsible) */}
          {showAdjust && (
            <Card className="mb-6" data-testid="credit-adjust-form">
              <CardHeader>
                <CardTitle>
                  {t("credit.adjustTitle") || "Manuelle Korrektur"}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <form onSubmit={handleAdjust} className="space-y-3">
                  <div>
                    <label className="text-sm text-gray-600 dark:text-gray-300 block mb-1">
                      {t("credit.adjustAmountSigned") || "Betrag (positiv = Gutschrift, negativ = Belastung)"} *
                    </label>
                    <Input
                      type="text"
                      inputMode="decimal"
                      value={adjustAmount}
                      onChange={(e) => setAdjustAmount(e.target.value)}
                      placeholder="z. B. 50.00 oder -20.00"
                      data-testid="credit-adjust-amount"
                      required
                    />
                  </div>
                  <div>
                    <label className="text-sm text-gray-600 dark:text-gray-300 block mb-1">
                      {t("credit.adjustDescription") || "Begründung"} *
                    </label>
                    <Input
                      type="text"
                      value={adjustDescription}
                      onChange={(e) => setAdjustDescription(e.target.value)}
                      placeholder={t("credit.adjustDescriptionHint") || "Warum wird das Guthaben korrigiert?"}
                      data-testid="credit-adjust-description"
                      required
                    />
                  </div>
                  {adjustError && (
                    <div className="text-sm text-red-600">{adjustError}</div>
                  )}
                  <div className="flex gap-2">
                    <Button type="submit" disabled={adjustSubmitting}>
                      {adjustSubmitting
                        ? (t("common.saving") || "Speichert...")
                        : (t("credit.adjustSubmit") || "Korrektur buchen")}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => {
                        setShowAdjust(false)
                        setAdjustError(null)
                      }}
                    >
                      {t("common.cancel") || "Abbrechen"}
                    </Button>
                  </div>
                </form>
              </CardContent>
            </Card>
          )}

          {/* Ledger */}
          <Card>
            <CardHeader>
              <CardTitle>
                {t("credit.ledgerTitle") || "Guthaben-Verlauf"}
                <span className="text-sm font-normal text-gray-500 ml-2">
                  ({ledger.length} {t("credit.entries") || "Einträge"})
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {ledger.length === 0 ? (
                <div
                  className="text-center text-gray-500 py-8"
                  data-testid="credit-ledger-empty"
                >
                  {t("credit.empty") || "Keine Bewegungen vorhanden."}
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table
                    className="w-full text-sm"
                    data-testid="credit-ledger-table"
                  >
                    <thead className="border-b-2">
                      <tr className="text-left">
                        <th className="py-1 px-2">
                          {t("credit.colDate") || "Datum"}
                        </th>
                        <th className="py-1 px-2">
                          {t("credit.colType") || "Art"}
                        </th>
                        <th className="py-1 px-2">
                          {t("credit.colDescription") || "Beschreibung"}
                        </th>
                        <th className="py-1 px-2 text-right">
                          {t("credit.colAmount") || "Betrag"}
                        </th>
                        <th className="py-1 px-2 text-right">
                          {t("credit.colBalanceAfter") || "Saldo"}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {ledger.map((row) => (
                        <tr
                          key={row.id}
                          className="border-b border-gray-100 dark:border-gray-800"
                          data-testid="credit-ledger-row"
                          data-type={row.type}
                        >
                          <td className="py-1 px-2 whitespace-nowrap">
                            {fmtDateTimeDE(row.createdAt)}
                          </td>
                          <td className="py-1 px-2">
                            <span
                              className={
                                "text-[10px] px-2 py-0.5 rounded font-medium " +
                                (row.amount > 0
                                  ? "bg-blue-100 text-blue-800"
                                  : "bg-amber-100 text-amber-800")
                              }
                            >
                              {TYPE_LABEL[row.type] || row.type}
                            </span>
                          </td>
                          <td className="py-1 px-2 text-gray-600 dark:text-gray-300">
                            {row.description || "—"}
                          </td>
                          <td
                            className={
                              "py-1 px-2 text-right font-mono " +
                              (row.amount > 0
                                ? "text-blue-700"
                                : "text-amber-700")
                            }
                          >
                            {row.amount > 0 ? "+" : ""}
                            {fmtEur(row.amount)}
                          </td>
                          <td className="py-1 px-2 text-right font-mono font-medium">
                            {fmtEur(row.balanceAfter)}
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
    </div>
  )
}
