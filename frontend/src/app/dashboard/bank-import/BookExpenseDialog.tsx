"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { useI18n } from "@/components/useI18n"
import { formatMoney } from "@/lib/money"

/**
 * Tier 809 — „Als Aufwand buchen" records an expense the reports read, so it
 * asks for what the expense needs: the account, the VAT rate of the bill
 * behind the debit (its Vorsteuer), a category, the text. Was a prompt() for
 * the account alone, and the debit went into no report.
 *
 * mode "rebook": a debit booked the old way (a voucher only) is reversed and
 * booked again — the account stays the voucher's; the rate may be given.
 */
export type BookExpenseValues = {
  expenseAccountNumber?: string
  vatRate?: number
  category?: string
  description?: string
}

export function BookExpenseDialog({
  mode,
  amount,
  purpose,
  counterparty,
  busy,
  onCancel,
  onSubmit,
}: {
  mode: "book" | "rebook"
  amount: number
  purpose: string | null
  counterparty: string | null
  busy: boolean
  onCancel: () => void
  onSubmit: (v: BookExpenseValues) => void
}) {
  const { t } = useI18n()
  const gross = Math.abs(amount)
  const [account, setAccount] = useState("4900")
  // "keep": the rebooking keeps the old voucher's Vorsteuer
  const [rate, setRate] = useState<string>(mode === "rebook" ? "keep" : "0")
  const [category, setCategory] = useState("")
  const [description, setDescription] = useState(purpose || (counterparty ? `Bankausgang ${counterparty}` : ""))
  const r = rate === "keep" ? null : Number(rate)
  const vat = r ? Math.round((gross * r) / (1 + r) * 100) / 100 : 0

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    onSubmit({
      ...(mode === "book" ? { expenseAccountNumber: account.trim() || undefined, description: description.trim() || undefined } : {}),
      ...(r !== null ? { vatRate: r } : {}),
      ...(category.trim() ? { category: category.trim() } : {}),
    })
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50" role="dialog" aria-modal="true" data-testid="book-expense-dialog">
      <Card className="w-full max-w-md max-h-[90vh] overflow-y-auto">
        <CardHeader>
          <CardTitle>{t(mode === "book" ? "bankImport.bookExpense" : "bankImport.rebookExpense")}</CardTitle>
          <p className="text-sm text-gray-600 dark:text-gray-300 mt-1">
            {counterparty || "—"} · {formatMoney(gross)}
          </p>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-3">
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {t(mode === "book" ? "bankImport.bookExpenseHint" : "bankImport.rebookExpenseHint")}
            </p>
            {mode === "book" && (
              <div>
                <label htmlFor="be-account" className="block text-sm font-medium mb-1">{t("bankImport.expenseAccountPrompt")}</label>
                <Input id="be-account" data-testid="book-expense-account" inputMode="numeric" value={account} onChange={(e) => setAccount(e.target.value)} />
              </div>
            )}
            <div>
              <label htmlFor="be-rate" className="block text-sm font-medium mb-1">{t("bankImport.expenseVatRate")}</label>
              <select
                id="be-rate"
                data-testid="book-expense-rate"
                value={rate}
                onChange={(e) => setRate(e.target.value)}
                className="w-full rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm"
              >
                {mode === "rebook" && <option value="keep">{t("bankImport.expenseVatKeep")}</option>}
                <option value="0">{t("bankImport.expenseVatNone")}</option>
                <option value="0.19">19 %</option>
                <option value="0.07">7 %</option>
              </select>
              {vat > 0 && (
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1" data-testid="book-expense-vat">
                  {t("bankImport.expenseVatAmount").replace("{amount}", formatMoney(vat))}
                </p>
              )}
            </div>
            <div>
              <label htmlFor="be-category" className="block text-sm font-medium mb-1">{t("bankImport.expenseCategory")}</label>
              <Input id="be-category" data-testid="book-expense-category" value={category} maxLength={100} onChange={(e) => setCategory(e.target.value)} placeholder={t("bankImport.expenseCategoryPlaceholder")} />
            </div>
            {mode === "book" && (
              <div>
                <label htmlFor="be-description" className="block text-sm font-medium mb-1">{t("bankImport.expenseDescription")}</label>
                <Input id="be-description" value={description} maxLength={500} onChange={(e) => setDescription(e.target.value)} />
              </div>
            )}
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>{t("common.cancel")}</Button>
              <Button type="submit" disabled={busy} data-testid="book-expense-submit">
                {busy ? t("common.loading") : t(mode === "book" ? "bankImport.bookExpense" : "bankImport.rebookExpense")}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
