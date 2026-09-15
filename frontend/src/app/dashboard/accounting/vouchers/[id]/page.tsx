"use client"

import { useEffect, useState } from "react"
import { useRouter, useParams } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import LanguageSwitcher from "@/components/LanguageSwitcher"
import { useI18n } from "@/components/useI18n"
import { useToast } from "@/components/useToast"
import { apiGet, apiPost, apiFetch, apiGetBlob } from "@/lib/api"
import { ReceiptsPanel } from "@/components/ReceiptsPanel"

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
  // Tier 41: per-line DATEV Kostenstelle + Kostenträger stamps.
  // Optional on older rows (migration added the column null).
  costCenter: string | null
  costObject: string | null
  account: {
    id: string
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
  const toast = useToast()
  const dl = getDateLocale()

  const [voucher, setVoucher] = useState<Voucher | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Tier 42: Korrektur modal state. Pre-fills the form
  // with the original Voucher's lines + a single
  // top-level "reason" field; on submit it POSTs to
  // /vouchers/:id/correct and the backend atomically
  // creates the Storno + K-booking pair. We only
  // expose the *reason* and the *corrected lines*
  // here — the user can re-author the Sachkonto /
  // Beträge / Kostenstelle / Kostenträger values
  // before submitting. Defaults the form to a small
  // copy of the original lines so the UI never starts
  // empty (which would land the user on a 400).
  const [showCorrectModal, setShowCorrectModal] = useState(false)
  const [correctReason, setCorrectReason] = useState("")
  const [correctLines, setCorrectLines] = useState<Array<{
    accountId: string
    description: string
    debit: string
    credit: string
    costCenter: string
    costObject: string
  }>>([])
  const [correctSaving, setCorrectSaving] = useState(false)
  const [correctError, setCorrectError] = useState<string | null>(null)

  // Tier 50: "Als Vorlage speichern" modal state. Tiny
  // prompt with a single name field; default pre-fills
  // to "<voucher description> (auto)" so the user can
  // either accept or override. Submits via
  // POST /voucher-templates/from-voucher/:id.
  const [showTemplateModal, setShowTemplateModal] = useState(false)
  const [templateName, setTemplateName] = useState("")
  const [templateSaving, setTemplateSaving] = useState(false)
  const [templateError, setTemplateError] = useState<string | null>(null)
  const [templateSaved, setTemplateSaved] = useState<string | null>(null)

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
    <>
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
                data-testid="voucher-pdf-download"
                onClick={async () => {
                  // Tier 377: fetch with the auth headers and save the
                  // blob. This was a plain window.location.assign to a
                  // relative URL: it only reached the backend behind
                  // nginx, and only worked because GET
                  // /accounting/vouchers/:id/pdf had no guard. Since
                  // Tier 375 a navigation (which cannot send headers)
                  // gets 401.
                  const companyId =
                    localStorage.getItem("companyId") || ""
                  try {
                    const { blob } = await apiGetBlob(
                      `/api/v1/accounting/vouchers/${voucher.id}/pdf?companyId=${companyId}`,
                    )
                    const url = URL.createObjectURL(blob)
                    const a = document.createElement("a")
                    a.href = url
                    a.download = `${voucher.voucherNumber || "Buchungsbeleg"}.pdf`
                    a.click()
                    setTimeout(() => URL.revokeObjectURL(url), 60000)
                  } catch (e: any) {
                    toast.error(e?.message || "PDF konnte nicht geladen werden")
                  }
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
                      // Tier 377: apiFetch prefixes API_BASE. The relative
                      // `/api/v1/...` only reached the backend behind nginx;
                      // elsewhere it hit the Next server (no rewrites) → 404.
                      const res = await apiFetch(
                        `/api/v1/accounting/vouchers/${voucher.id}/reversal?companyId=${companyId}`,
                        {
                          method: "POST",
                          body: { reason: reason || "" },
                          throwOnError: false,
                        },
                      )
                      if (!res.ok) {
                        const err = await res
                          .json()
                          .catch(() => ({ message: res.statusText }))
                        toast.error(
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
                      toast.error("Fehler: " + (e?.message || String(e)))
                    }
                  }}
                   className="bg-red-600 text-white hover:bg-red-700"
                >
                  {t("accounting.reverseVoucher") || "Stornieren"}
                </Button>
                )}
                {/* Tier 42: Korrektur button — atomic
                    Storno+replace. Sibling of the
                    Stornieren button. */}
                {voucher && (
                  <Button
                    data-testid="voucher-correct-button"
                    variant="outline"
                    onClick={async () => {
                      const baseLines = (voucher!.lines || []).map(
                        (l) => ({
                          accountId: l.account?.id || "",
                          description: l.description || "",
                          debit: l.debit || "",
                          credit: l.credit || "",
                          costCenter: l.costCenter || "",
                          costObject: l.costObject || "",
                        }),
                      )
                      setCorrectLines(baseLines)
                      setCorrectReason("")
                      setCorrectError(null)
                      setShowCorrectModal(true)

                      // Tier 43: Pre-fill cost-center stamps
                      // for any line whose cc is still
                      // empty — same behaviour as the
                      // Voucher create form (Tier 41).
                      // For each unique accountId with an
                      // empty cc we fetch the most-used
                      // (costCenter, costObject) pair via
                      // /cost-center-suggestion. We dedupe
                      // accountIds so the same Sachkonto
                      // doesn't get fetched twice on a
                      // 10-line Voucher with 5 debits on
                      // the same account.
                      const companyId =
                        localStorage.getItem("companyId") || ""
                      try {
                        // Build distinct accountIds needing
                        // a suggestion (line has an accountId
                        // AND empty costCenter).
                        const todo = new Map<
                          string,
                          { cc: string; idx: number }
                        >()
                        baseLines.forEach((l, idx) => {
                          if (l.accountId && !l.costCenter.trim()) {
                            todo.set(l.accountId, { cc: "", idx })
                          }
                        })
                        // Fetch in parallel — each is a
                        // fast index hit on VoucherLine
                        // (accountId, costCenter).
                        const fetched = await Promise.all(
                          Array.from(todo.keys()).map((aid) =>
                            apiGet<{
                              costCenter: string | null
                              costObject: string | null
                            }>(
                              `/api/v1/accounting/vouchers/cost-center-suggestion?companyId=${companyId}&accountId=${aid}`,
                            )
                              .then((s) => ({ aid, s }))
                              .catch(() => ({ aid, s: null })),
                          ),
                        )
                        // Apply each suggestion to all lines
                        // matching that accountId whose cc
                        // is still empty. We rebuild the
                        // state fresh (no race with the
                        // user's editing) by merging the
                        // suggestions into baseLines.
                        const updated = baseLines.slice()
                        for (const line of updated) {
                          if (
                            line.accountId &&
                            !line.costCenter.trim()
                          ) {
                            const f = fetched.find(
                              (x) => x.aid === line.accountId,
                            )
                            if (f?.s?.costCenter) {
                              line.costCenter = f.s.costCenter
                              line.costObject =
                                f.s.costObject || ""
                            }
                          }
                        }
                        setCorrectLines(updated)
                      } catch {
                        // Soft-fail: don't block the
                        // modal if the suggestion fetch
                        // throws. The user sees the
                        // original (empty) costCenter
                        // fields and can type them
                        // manually.
                      }
                    }}
                  >
                    {t("accounting.correctVoucher") || "Korrigieren"}
                  </Button>
                )}
                {/* Tier 50: "Als Vorlage speichern" button.
                    Captures the voucher's lines + cost-center
                    stamps + description into a reusable
                    VoucherTemplate so future vouchers with
                    the same shape can be created in one
                    click via the apply-template dropdown. */}
                {voucher && (
                  <Button
                    data-testid="voucher-save-template-button"
                    variant="outline"
                    onClick={() => {
                      setTemplateName(
                        (voucher.description || "") + " (auto)",
                      )
                      setTemplateError(null)
                      setTemplateSaved(null)
                      setShowTemplateModal(true)
                    }}
                  >
                    {t("voucherTemplate.saveAsTemplate") ||
                      "Als Vorlage speichern"}
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

            {/* GoBD §146 AO — every booking needs the
                original Beleg attached. The ReceiptsPanel
                renders the upload drop-zone, the list of
                existing attachments with preview / download
                / delete, and the extracted OCR text (when
                present). Same component used on the
                Expense detail page — single source of
                truth for the attachment UX. */}
            <Card className="mb-4">
              <CardHeader>
                <CardTitle>{t("voucher.receipts")}</CardTitle>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                  {t("voucher.receiptsHint")}
                </p>
              </CardHeader>
              <CardContent>
                <ReceiptsPanel
                  companyId={localStorage.getItem("companyId") || ""}
                  entityType="voucher"
                  entityId={params.id as string}
                />
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

      <>
      {/* Tier 42: Korrektur modal. Compact — the user
          sees the original lines + a reason field,
          can edit a Betrag/Sachkonto in place, then
          hit "Korrektur anwenden". The backend posts
          atomically to /vouchers/:id/correct. */}
      {showCorrectModal && voucher && (
        <div
          className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4"
          data-testid="voucher-correct-modal"
        >
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl w-full max-w-3xl max-h-[90vh] overflow-y-auto p-6">
            <h2 className="text-xl font-bold text-gray-900 dark:text-gray-100 mb-2">
              {t("accounting.correctVoucher") || "Korrektur"}
            </h2>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
              {t("accounting.correctDescription") ||
                "Storniert die Originalbuchung und legt einen Korrekturbeleg an. Beide Einträge sind sichtbar im Journal."}
            </p>

            {correctError && (
              <div
                className="p-3 mb-3 bg-red-50 border border-red-200 text-red-800 rounded text-sm"
                data-testid="voucher-correct-error"
              >
                ✗ {correctError}
              </div>
            )}

            <label className="block text-sm font-medium mb-1 text-gray-700 dark:text-gray-300">
              {t("accounting.correctReason") || "Grund der Korrektur"}
            </label>
            <input
              type="text"
              value={correctReason}
              onChange={(e) => setCorrectReason(e.target.value)}
              placeholder="z.B. Bank fee 1,20 € korrigiert auf 1,50 €"
              className="w-full border rounded px-3 py-2 text-sm mb-4 dark:bg-gray-700 dark:border-gray-600"
              data-testid="voucher-correct-reason"
            />

            <table className="w-full text-sm mb-4">
              <thead>
                <tr className="text-left border-b border-gray-200 dark:border-gray-700 text-xs uppercase text-gray-500">
                  <th className="py-2 pr-2">Soll €</th>
                  <th className="py-2 pr-2">Haben €</th>
                  <th className="py-2 pr-2">Beschreibung</th>
                </tr>
              </thead>
              <tbody>
                {correctLines.map((l, idx) => (
                  <tr
                    key={idx}
                    className="border-t border-gray-100 dark:border-gray-800"
                    data-testid="voucher-correct-line-row"
                  >
                    <td className="py-1 pr-2">
                      <input
                        type="number"
                        step="0.01"
                        value={l.debit}
                        onChange={(e) => {
                          const cc = [...correctLines]
                          cc[idx] = { ...cc[idx], debit: e.target.value }
                          setCorrectLines(cc)
                        }}
                        className="w-full border rounded px-2 py-1 text-right font-mono dark:bg-gray-700 dark:border-gray-600"
                        data-testid="voucher-correct-debit"
                      />
                    </td>
                    <td className="py-1 pr-2">
                      <input
                        type="number"
                        step="0.01"
                        value={l.credit}
                        onChange={(e) => {
                          const cc = [...correctLines]
                          cc[idx] = { ...cc[idx], credit: e.target.value }
                          setCorrectLines(cc)
                        }}
                        className="w-full border rounded px-2 py-1 text-right font-mono dark:bg-gray-700 dark:border-gray-600"
                      />
                    </td>
                    <td className="py-1 pr-2">
                      <input
                        type="text"
                        value={l.description}
                        onChange={(e) => {
                          const cc = [...correctLines]
                          cc[idx] = { ...cc[idx], description: e.target.value }
                          setCorrectLines(cc)
                        }}
                        className="w-full border rounded px-2 py-1 text-sm dark:bg-gray-700 dark:border-gray-600"
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => setShowCorrectModal(false)}
                disabled={correctSaving}
              >
                Abbrechen
              </Button>
              <Button
                data-testid="voucher-correct-submit"
                onClick={async () => {
                  const companyId =
                    localStorage.getItem("companyId") || ""
                  setCorrectSaving(true)
                  setCorrectError(null)
                  try {
                    // Tier 377: apiFetch → API_BASE (see the reversal above).
                    const res = await apiFetch(
                      `/api/v1/accounting/vouchers/${voucher.id}/correct?companyId=${companyId}`,
                      {
                        method: "POST",
                        throwOnError: false,
                        body: JSON.stringify({
                          date: new Date().toISOString(),
                          description: "Korrektur zu " + voucher.voucherNumber,
                          reason: correctReason,
                          lines: correctLines.map((l) => ({
                            accountId: l.accountId,
                            debit: parseFloat(l.debit || "0") || 0,
                            credit: parseFloat(l.credit || "0") || 0,
                            description: l.description || null,
                            costCenter: l.costCenter || undefined,
                            costObject: l.costObject || undefined,
                          })),
                        }),
                      },
                    )
                    if (!res.ok) {
                      const err = await res
                        .json()
                        .catch(() => ({ message: res.statusText }))
                      setCorrectError(
                        err.message || `HTTP ${res.status}`,
                      )
                      setCorrectSaving(false)
                      return
                    }
                    const data = await res.json()
                    setShowCorrectModal(false)
                    router.push(
                      `/dashboard/accounting/vouchers/${data.correction.id}`,
                    )
                  } catch (e: any) {
                    setCorrectError(
                      "Fehler: " + (e?.message || String(e)),
                    )
                    setCorrectSaving(false)
                  }
                }}
                disabled={correctSaving}
              >
                {correctSaving ? "…" : "Korrektur anwenden"}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Tier 50: Save-as-template modal — single name
          field + Submit. The backend captures the
          voucher's lines, accountNumber-resolved per
          line, plus per-line costCenter/costObject/
          description. We only send the name override;
          everything else is server-side from the
          voucher itself. */}
      {showTemplateModal && voucher && (
        <div
          className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4"
          data-testid="voucher-save-template-modal"
        >
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl w-full max-w-md p-6">
            <h2 className="text-xl font-bold text-gray-900 dark:text-gray-100 mb-2">
              {t("voucherTemplate.saveAsTemplate") ||
                "Als Vorlage speichern"}
            </h2>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
              {t("voucherTemplate.saveAsTemplateHint") ||
                "Übernimmt alle Positionen, Sachkonten, Kostenstellen und Beschreibungen dieses Belegs in eine wiederverwendbare Vorlage."}
            </p>

            {templateError && (
              <div
                className="p-3 mb-3 bg-red-50 border border-red-200 text-red-800 rounded text-sm"
                data-testid="voucher-save-template-error"
              >
                ✗ {templateError}
              </div>
            )}
            {templateSaved && (
              <div
                className="p-3 mb-3 bg-emerald-50 border border-emerald-200 text-emerald-800 rounded text-sm"
                data-testid="voucher-save-template-success"
              >
                ✓ {t("voucherTemplate.saveAsTemplateSuccess") ||
                  "Vorlage gespeichert"}{" "}
                <span className="font-mono">{templateSaved}</span>
              </div>
            )}

            <label className="block text-sm font-medium mb-1 text-gray-700 dark:text-gray-300">
              {t("voucherTemplate.name") || "Vorlagenname"}
            </label>
            <input
              type="text"
              value={templateName}
              onChange={(e) => setTemplateName(e.target.value)}
              placeholder={t("voucherTemplate.namePlaceholder") ||
                "z.B. Bankgebühr-Buchung"}
              className="w-full border rounded px-3 py-2 text-sm mb-4 dark:bg-gray-700 dark:border-gray-600"
              data-testid="voucher-save-template-name"
            />

            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  setShowTemplateModal(false)
                  setTemplateSaved(null)
                  setTemplateError(null)
                }}
                disabled={templateSaving}
              >
                {t("common.cancel") || "Abbrechen"}
              </Button>
              <Button
                data-testid="voucher-save-template-submit"
                onClick={async () => {
                  if (!templateName.trim()) {
                    setTemplateError(
                      t("voucherTemplate.nameRequired") ||
                        "Name ist erforderlich",
                    )
                    return
                  }
                  const companyId =
                    localStorage.getItem("companyId") || ""
                  setTemplateSaving(true)
                  setTemplateError(null)
                  try {
                    const data = await apiPost<{
                      id: string
                      name: string
                    }>(
                      `/api/v1/voucher-templates/from-voucher/${voucher.id}?companyId=${companyId}`,
                      { name: templateName.trim() },
                    )
                    setTemplateSaving(false)
                    setTemplateSaved(data.name)
                    // Auto-close on success after a short
                    // delay so the user sees the green
                    // confirmation. We don't navigate —
                    // they probably want to keep editing
                    // this voucher.
                    setTimeout(() => {
                      setShowTemplateModal(false)
                      setTemplateSaved(null)
                    }, 1200)
                  } catch (e: any) {
                    setTemplateSaving(false)
                    setTemplateError(
                      e?.message ||
                        `HTTP ${e?.status || "?"}`,
                    )
                  }
                }}
                disabled={templateSaving || !templateName.trim()}
              >
                {templateSaving
                  ? "…"
                  : t("voucherTemplate.save") || "Speichern"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
    </>
  )
}