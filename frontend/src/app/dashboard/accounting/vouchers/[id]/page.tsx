"use client"

import { useEffect, useState } from "react"
import { useRouter, useParams } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import LanguageSwitcher from "@/components/LanguageSwitcher"
import { useI18n } from "@/components/useI18n"
import { apiGet } from "@/lib/api"

// VoucherLine — the individual debit/credit lines that
// make up a Voucher (Buchungsbeleg). One Voucher = one
// "Buchungssatz" (e.g. Bank 1200 / Forderung 1406).
interface VoucherLine {
  id: string
  description: string | null
  debit: string
  credit: string
  vatRate: string | null
  vatAmount: string | null
  sortOrder: number
  account: {
    accountNumber: string
    name: string
    type: string
    category: string | null
  }
}

// Audit-pivot: this Voucher may be linked to one or
// more BankReconciliations (cash side of a customer
// payment), BankReconciliationReversals (Storno
// bookings), BankTransactions (expense bookings), or
// Invoice rows (legacy auto-generated revenue
// vouchers). Each is the user's path BACK to the
// original raw document.
interface ReconLink {
  id: string
  status: string
  appliedAmount: string
  invoice: { id: string; invoiceNumber: string; total: string } | null
  bankTransaction: {
    id: string
    valueDate: string
    amount: string
    counterpartyName: string | null
    purpose: string | null
    endToEndId: string | null
    statement: { id: string; fileName: string; format: string } | null
  } | null
}

// A BankTransaction that booked directly into this
// Voucher via bank-import.bookExpense (no invoice
// link — pure expense posting).
interface DirectBankTxnLink {
  id: string
  valueDate: string
  amount: string
  counterpartyName: string | null
  purpose: string | null
  statement: { id: string; fileName: string; format: string } | null
}

interface Voucher {
  id: string
  voucherNumber: string
  date: string
  description: string | null
  referenceType: string | null
  status: string
  createdAt: string
  lines: VoucherLine[]
  bankReconciliations: ReconLink[]
  reversalOf: ReconLink[]
  bankTransactions: DirectBankTxnLink[]
  invoiceRef: { id: string; invoiceNumber: string; total: string } | null
  // GoBD self-relation. Non-null on a Korrekturbeleg
  // (Storno-Buchung): points back to the original
  // Voucher that this one is the Storno of. Null
  // on the original itself.
  reversedById: string | null
  // Symmetric back-relation: on an ORIGINAL Voucher
  // that has been corrected, this contains the
  // Storno vouchers. Empty array on a Voucher with
  // no Storno.
  reversals: { id: string; voucherNumber: string; date: string }[]
}

const fmtMoney = (n: number) =>
  n.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const fmtDate = (s: string | null | undefined, locale = "de-DE") =>
  s ? new Date(s).toLocaleDateString(locale, { day: "2-digit", month: "2-digit", year: "numeric" }) : "—"

const STATUS_LABEL: Record<string, string> = {
  posted: "Gebucht",
  draft: "Entwurf",
  voided: "Storniert",
}

const REF_LABEL: Record<string, string> = {
  BankReconciliation: "Bankabgleich (Kundenzahlung)",
  BankReconciliationReversal: "Storno-Buchung",
  BankTransaction: "Bankbuchung (Aufwand)",
  Invoice: "Rechnung (Erlöse)",
  "": "Manuell",
}

export default function VoucherDetailPage() {
  const router = useRouter()
  const params = useParams<{ id: string }>()
  const { t, getDateLocale } = useI18n()
  const dl = getDateLocale()

  const [voucher, setVoucher] = useState<Voucher | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const companyId = localStorage.getItem("companyId")
    if (!companyId) {
      router.push("/login")
      return
    }
    apiGet<Voucher>(
      `/api/v1/accounting/vouchers/${params.id}?companyId=${companyId}`
    )
      .then((v) => setVoucher(v))
      .catch((e: any) => setError(e?.message || "Fehler beim Laden"))
      .finally(() => setLoading(false))
  }, [params.id, router])

  // Sum-of-debits and sum-of-credits are the visible
  // sanity check for double-entry. They should always
  // be equal for a well-formed Voucher.
  const totals = voucher
    ? voucher.lines.reduce(
        (acc, l) => {
          acc.debit += Number(l.debit)
          acc.credit += Number(l.credit)
          return acc
        },
        { debit: 0, credit: 0 }
      )
    : { debit: 0, credit: 0 }
  const isBalanced = Math.abs(totals.debit - totals.credit) < 0.01

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <div className="container mx-auto px-4 py-8">
        <div className="flex justify-between items-center mb-6">
          <div>
            <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100">
              {t("voucher.title")}
            </h1>
            {voucher && (
              <p className="text-gray-500 dark:text-gray-400 mt-1 font-mono">
                {voucher.voucherNumber}
              </p>
            )}
          </div>
          <div className="flex gap-2 items-center">
            {voucher && (
              <Button
                variant="outline"
                onClick={() => {
                  // Direct browser download. The API
                  // returns application/pdf with
                  // Content-Disposition: attachment;
                  // filename=BK-XXXX.pdf — a plain
                  // window.location assignment triggers
                  // the file save dialog.
                  const companyId =
                    localStorage.getItem("companyId") || ""
                  window.location.assign(
                    `/api/v1/accounting/vouchers/${voucher.id}/pdf?companyId=${companyId}`
                  )
                }}
              >
                {t("voucher.downloadPdf")}
              </Button>
            )}
            {voucher &&
              voucher.status === "posted" &&
              !voucher.reversedById &&
              voucher.referenceType !== "VoucherReversal" &&
              (voucher.reversals?.length ?? 0) === 0 && (
                <Button
                  onClick={async () => {
                    const reason = window.prompt(
                      t("accounting.reverseReason") ||
                        "Stornogrund (optional)",
                    )
                    // The user can cancel the prompt — null
                    // means "I changed my mind". Allow it.
                    const companyId =
                      localStorage.getItem("companyId") || ""
                    try {
                      const res = await fetch(
                        `/api/v1/accounting/vouchers/${voucher.id}/reversal?companyId=${companyId}`,
                        {
                          method: "POST",
                          headers: {
                            "Content-Type": "application/json",
                            "x-user-id":
                              localStorage.getItem("userId") || "",
                            "x-company-id": companyId,
                          },
                          body: JSON.stringify({ reason: reason || "" }),
                        },
                      )
                      if (!res.ok) {
                        const err = await res
                          .json()
                          .catch(() => ({ message: res.statusText }))
                        alert(
                          (err.message || "Fehler") +
                            "\n\n" +
                            (t("accounting.reverseHint") || ""),
                        )
                        return
                      }
                      const data = await res.json()
                      // Navigate to the new Storno so the
                      // user can see the result immediately.
                      router.push(
                        `/dashboard/accounting/vouchers/${data.id}`,
                      )
                    } catch (e: any) {
                      alert("Fehler: " + (e?.message || String(e)))
                    }
                  }}
                  className="bg-red-600 text-white hover:bg-red-700"
                >
                  {t("accounting.reverseVoucher") || "Stornieren"}
                </Button>
              )}
            {voucher &&
              voucher.reversals &&
              voucher.reversals.length > 0 && (
                // On an ORIGINAL Voucher that has already
                // been corrected, surface the existing
                // Korrekturbeleg as a link rather than
                // offering another Stornieren button
                // (would just return the same one).
                <Button
                  variant="outline"
                  onClick={() =>
                    router.push(
                      `/dashboard/accounting/vouchers/${voucher.reversals[0].id}`,
                    )
                  }
                  className="border-red-300 dark:border-red-700 text-red-700 dark:text-red-300"
                  title="Bereits storniert — Korrekturbeleg öffnen"
                >
                  ↪ Storno: {voucher.reversals[0].voucherNumber}
                </Button>
              )}
            <LanguageSwitcher />
            <Button variant="outline" onClick={() => router.push("/dashboard")}>
              {t("common.back")}
            </Button>
          </div>
        </div>

        {error && (
          <div className="mb-4 text-sm text-red-700 dark:text-red-300 bg-red-50 border border-red-200 rounded p-3">
            {error}
          </div>
        )}

        {loading ? (
          <div className="text-sm text-gray-500 dark:text-gray-400">{t("common.loading")}</div>
        ) : !voucher ? (
          <div className="text-sm text-gray-500 dark:text-gray-400">—</div>
        ) : (
          <>
            {/* Voucher header card — the meta info that
                appears on the Beleg itself */}
            <Card className="mb-4">
              <CardHeader>
                <CardTitle>{t("voucher.meta")}</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                  <div>
                    <div className="text-gray-500 dark:text-gray-400">{t("voucher.number")}</div>
                    <div className="font-mono text-lg">{voucher.voucherNumber}</div>
                  </div>
                  <div>
                    <div className="text-gray-500 dark:text-gray-400">{t("voucher.date")}</div>
                    <div className="font-medium">{fmtDate(voucher.date, dl)}</div>
                  </div>
                  <div>
                    <div className="text-gray-500 dark:text-gray-400">{t("voucher.status")}</div>
                    <div>
                      <span
                        className={`text-xs px-2 py-0.5 rounded ${
                          voucher.status === "posted"
                            ? "bg-emerald-100 text-emerald-800"
                            : voucher.status === "voided"
                            ? "bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-200"
                            : "bg-blue-100 text-blue-800"
                        }`}
                      >
                        {STATUS_LABEL[voucher.status] || voucher.status}
                      </span>
                    </div>
                  </div>
                  <div>
                    <div className="text-gray-500 dark:text-gray-400">{t("voucher.referenceType")}</div>
                    <div className="text-sm">
                      {REF_LABEL[voucher.referenceType || ""] ||
                        voucher.referenceType ||
                        "—"}
                    </div>
                  </div>
                  <div className="md:col-span-2">
                    <div className="text-gray-500 dark:text-gray-400">{t("voucher.description")}</div>
                    <div className="font-medium">
                      {voucher.description || "—"}
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Lines — the actual double-entry posting.
                Each row is one Soll OR one Haben of the
                same booking. The total of Soll equals
                the total of Haben (Sanity: shown below
                the table). */}
            <Card className="mb-4">
              <CardHeader>
                <CardTitle>{t("voucher.lines")}</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-gray-500 dark:text-gray-400 text-xs border-b">
                        <th className="py-2">{t("voucher.account")}</th>
                        <th>{t("voucher.accountName")}</th>
                        <th className="text-right">{t("voucher.debit")}</th>
                        <th className="text-right">{t("voucher.credit")}</th>
                        <th>{t("voucher.lineDescription")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {voucher.lines.map((l) => (
                        <tr key={l.id} className="border-b">
                          <td className="py-2 font-mono">{l.account.accountNumber}</td>
                          <td>{l.account.name}</td>
                          <td className="text-right font-mono">
                            {Number(l.debit) > 0
                              ? `€ ${fmtMoney(Number(l.debit))}`
                              : ""}
                          </td>
                          <td className="text-right font-mono">
                            {Number(l.credit) > 0
                              ? `€ ${fmtMoney(Number(l.credit))}`
                              : ""}
                          </td>
                          <td className="text-xs text-gray-600 dark:text-gray-300">
                            {l.description || "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t-2 border-gray dark:border-gray-700-300 dark:border-gray-600 font-medium">
                        <td colSpan={2} className="py-2 text-right text-gray-600 dark:text-gray-300">
                          {t("voucher.total")}
                        </td>
                        <td className="text-right font-mono">
                          € {fmtMoney(totals.debit)}
                        </td>
                        <td className="text-right font-mono">
                          € {fmtMoney(totals.credit)}
                        </td>
                        <td></td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
                <div
                  className={`mt-2 text-xs ${
                    isBalanced ? "text-emerald-700" : "text-red-700 dark:text-red-300"
                  }`}
                >
                  {isBalanced
                    ? `✓ ${t("voucher.balanced")}`
                    : `✗ ${t("voucher.unbalanced")}`}
                </div>
              </CardContent>
            </Card>

            {/* Audit pivot — where this Voucher is
                referenced from. The Berater's primary
                use case: "I see BK-XXXX in the DATEV
                export, what is it for?" — each link
                below is a path back to the original
                raw document (MT940 file, invoice,
                etc.). */}
            <Card>
              <CardHeader>
                <CardTitle>{t("voucher.auditTrail")}</CardTitle>
              </CardHeader>
              <CardContent>
                {/* Customer payment path — this Voucher
                    is the cash side of a bank-import
                    confirmed match. Clicking the
                    invoice number takes the user to
                    the invoice detail page. */}
                {voucher.bankReconciliations.length > 0 && (
                  <div className="mb-4">
                    <h4 className="text-sm font-medium text-gray-700 dark:text-gray-200 mb-2">
                      {t("voucher.fromBankReconciliation")}
                    </h4>
                    {voucher.bankReconciliations.map((r) => (
                      <div
                        key={r.id}
                        className="border-l-2 border-emerald-300 dark:border-emerald-700 pl-3 py-2 text-sm"
                      >
                        <div>
                          <span className="text-gray-500 dark:text-gray-400">{t("voucher.reconStatus")}: </span>
                          <span className="font-medium">{r.status}</span>
                        </div>
                        {r.invoice && (
                          <div>
                            <span className="text-gray-500 dark:text-gray-400">{t("voucher.invoice")}: </span>
                            <button
                              onClick={() => router.push(`/dashboard/invoices/${r.invoice!.id}`)}
                              className="font-mono text-blue-700 dark:text-blue-300 hover:underline"
                            >
                              {r.invoice.invoiceNumber}
                            </button>
                          </div>
                        )}
                        {r.bankTransaction && (
                          <div className="text-xs text-gray-600 dark:text-gray-300">
                            <span className="text-gray-500 dark:text-gray-400">{t("voucher.txnDate")}: </span>
                            {fmtDate(r.bankTransaction.valueDate, dl)}
                            {" · "}
                            <span className="text-gray-500 dark:text-gray-400">{t("voucher.txnAmount")}: </span>
                            € {fmtMoney(Number(r.bankTransaction.amount))}
                            {r.bankTransaction.counterpartyName && (
                              <>
                                {" · "}
                                <span className="text-gray-500 dark:text-gray-400">{t("voucher.txnCounterparty")}: </span>
                                {r.bankTransaction.counterpartyName}
                              </>
                            )}
                            {r.bankTransaction.statement && (
                              <>
                                {" · "}
                                <span className="text-gray-500 dark:text-gray-400">{t("voucher.statement")}: </span>
                                <span className="font-mono">{r.bankTransaction.statement.fileName}</span>
                                <span className="text-gray-400 ml-1">
                                  ({r.bankTransaction.statement.format.toUpperCase()})
                                </span>
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {/* Storno path — this Voucher is the
                    reversal of an earlier recon. Shown
                    so the audit reviewer can see "BK-A
                    was reverted by THIS voucher (BK-B)". */}
                {voucher.reversalOf.length > 0 && (
                  <div className="mb-4">
                    <h4 className="text-sm font-medium text-amber-700 mb-2">
                      {t("voucher.reversalOf")}
                    </h4>
                    {voucher.reversalOf.map((r) => (
                      <div
                        key={r.id}
                        className="border-l-2 border-amber-300 pl-3 py-2 text-sm"
                      >
                        <div>
                          <span className="text-gray-500 dark:text-gray-400">{t("voucher.reconStatus")}: </span>
                          <span className="font-medium">{r.status}</span>
                        </div>
                        {r.invoice && (
                          <div>
                            <span className="text-gray-500 dark:text-gray-400">{t("voucher.invoice")}: </span>
                            <button
                              onClick={() => router.push(`/dashboard/invoices/${r.invoice!.id}`)}
                              className="font-mono text-blue-700 dark:text-blue-300 hover:underline"
                            >
                              {r.invoice.invoiceNumber}
                            </button>
                          </div>
                        )}
                        {r.bankTransaction && (
                          <div className="text-xs text-gray-600 dark:text-gray-300">
                            <span className="text-gray-500 dark:text-gray-400">{t("voucher.txnDate")}: </span>
                            {fmtDate(r.bankTransaction.valueDate, dl)}
                            {" · "}
                            <span className="text-gray-500 dark:text-gray-400">{t("voucher.txnAmount")}: </span>
                            € {fmtMoney(Number(r.bankTransaction.amount))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {/* Expense path — this Voucher is the
                    booking of a bank-import expense
                    (debit transaction with no matching
                    invoice). The transaction links back
                    to the raw statement file. */}
                {voucher.bankTransactions.length > 0 && (
                  <div className="mb-4">
                    <h4 className="text-sm font-medium text-gray-700 dark:text-gray-200 mb-2">
                      {t("voucher.fromBankTransaction")}
                    </h4>
                    {voucher.bankTransactions.map((t_) => (
                      <div
                        key={t_.id}
                        className="border-l-2 border-blue-300 dark:border-blue-700 pl-3 py-2 text-sm"
                      >
                        <div>
                          <span className="text-gray-500 dark:text-gray-400">{t("voucher.txnDate")}: </span>
                          {fmtDate(t_.valueDate, dl)}
                          {" · "}
                          <span className="text-gray-500 dark:text-gray-400">{t("voucher.txnAmount")}: </span>
                          € {fmtMoney(Number(t_.amount))}
                          {t_.counterpartyName && (
                            <>
                              {" · "}
                              <span className="text-gray-500 dark:text-gray-400">{t("voucher.txnCounterparty")}: </span>
                              {t_.counterpartyName}
                            </>
                          )}
                          {t_.purpose && (
                            <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                              {t_.purpose}
                            </div>
                          )}
                          {t_.statement && (
                            <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                              <span className="text-gray-400">{t("voucher.statement")}: </span>
                              <span className="font-mono">{t_.statement.fileName}</span>
                              <span className="text-gray-400 ml-1">
                                ({t_.statement.format.toUpperCase()})
                              </span>
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Legacy invoice-path voucher (if the
                    company used the old auto-voucher
                    flow that came from the invoice
                    itself, not from a bank
                    reconciliation). */}
                {voucher.invoiceRef && !voucher.bankReconciliations.length && !voucher.bankTransactions.length && (
                  <div className="mb-4">
                    <h4 className="text-sm font-medium text-gray-700 dark:text-gray-200 mb-2">
                      {t("voucher.fromInvoice")}
                    </h4>
                    <button
                      onClick={() => router.push(`/dashboard/invoices/${voucher.invoiceRef!.id}`)}
                      className="font-mono text-blue-700 dark:text-blue-300 hover:underline text-sm"
                    >
                      {voucher.invoiceRef.invoiceNumber}
                    </button>
                  </div>
                )}

                {/* Empty state — no audit pivot found
                    (legacy / manually created voucher). */}
                {!voucher.bankReconciliations.length &&
                  !voucher.reversalOf.length &&
                  !voucher.bankTransactions.length &&
                  !voucher.invoiceRef && (
                    <div className="text-sm text-gray-500 dark:text-gray-400">
                      {t("voucher.noAuditLink")}
                    </div>
                  )}
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </div>
  )
}
