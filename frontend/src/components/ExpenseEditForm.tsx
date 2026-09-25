"use client"

// Tier 447: correct an expense (Eingangsrechnung) from the expenses page.
// PUT /expenses/:id (Tier 443) takes amounts positive; a credit note keeps its
// sign on the server. A paid expense or an AfA row carries `lockReason` —
// the form is not shown then, the reason is (it names the way out).
import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { useI18n } from "@/components/useI18n"
import { useToast } from "@/components/useToast"
import { ApiError, apiPut } from "@/lib/api"

export interface EditableExpense {
  id: string
  invoiceNumber: string | null
  description: string
  invoiceDate: string
  netAmount: string
  vatRate: string
  category: string | null
  supplier: { id: string; name: string } | null
  lockReason?: string | null
}

export function ExpenseEditForm({
  expense,
  suppliers,
  onSaved,
}: {
  expense: EditableExpense
  suppliers: Array<{ id: string; name: string }>
  onSaved: () => void
}) {
  const { t } = useI18n()
  const toast = useToast()
  const initial = () => ({
    invoiceDate: String(expense.invoiceDate).slice(0, 10),
    invoiceNumber: expense.invoiceNumber || "",
    supplierId: expense.supplier?.id || "",
    description: expense.description || "",
    category: expense.category || "",
    netAmount: String(Math.abs(Number(expense.netAmount))),
    vatRate: String(Number(expense.vatRate)),
  })
  const [form, setForm] = useState(initial)
  const [saving, setSaving] = useState(false)
  // A different row opened in the same modal starts from its own values.
  useEffect(() => setForm(initial()), [expense.id]) // eslint-disable-line react-hooks/exhaustive-deps

  if (expense.lockReason) {
    return (
      <div
        className="mb-4 rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-200"
        data-testid="expense-locked"
      >
        <div className="font-medium">🔒 {t("expenses.lockedTitle")}</div>
        <div className="mt-1">{expense.lockReason}</div>
      </div>
    )
  }

  const save = async () => {
    const companyId = localStorage.getItem("companyId")
    if (!companyId) return
    setSaving(true)
    try {
      await apiPut(`/api/v1/expenses/${expense.id}?companyId=${companyId}`, {
        invoiceDate: form.invoiceDate,
        invoiceNumber: form.invoiceNumber,
        supplierId: form.supplierId,
        description: form.description,
        category: form.category,
        netAmount: parseFloat(form.netAmount || "0"),
        vatRate: parseFloat(form.vatRate),
      })
      toast.success(t("expenses.editSaved"))
      onSaved()
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Fehler beim Speichern")
    } finally {
      setSaving(false)
    }
  }

  const input = "w-full px-2 py-1.5 border rounded text-sm dark:bg-gray-900"
  const label = "block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1"
  return (
    <div className="mb-4 rounded border p-3" data-testid="expense-edit">
      <div className="mb-2 text-sm font-medium">{t("expenses.editTitle")}</div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <div>
          <label className={label}>{t("expenses.invoiceDate")}</label>
          <input type="date" className={input} value={form.invoiceDate}
            onChange={(e) => setForm({ ...form, invoiceDate: e.target.value })} />
        </div>
        <div>
          <label className={label}>{t("expenses.invoiceNumber")}</label>
          <input className={input} value={form.invoiceNumber}
            onChange={(e) => setForm({ ...form, invoiceNumber: e.target.value })} />
        </div>
        <div>
          <label className={label}>{t("expenses.supplier")}</label>
          <select className={input} value={form.supplierId}
            onChange={(e) => setForm({ ...form, supplierId: e.target.value })}>
            <option value="">—</option>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </div>
        <div className="md:col-span-2">
          <label className={label}>{t("expenses.editDescription")}</label>
          <input className={input} value={form.description} data-testid="expense-edit-description"
            onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </div>
        <div>
          <label className={label}>{t("expenses.category")}</label>
          <input className={input} value={form.category}
            onChange={(e) => setForm({ ...form, category: e.target.value })} />
        </div>
        <div>
          <label className={label}>{t("expenses.net")}</label>
          <input type="number" step="0.01" className={`${input} text-right`} value={form.netAmount}
            data-testid="expense-edit-net"
            onChange={(e) => setForm({ ...form, netAmount: e.target.value })} />
        </div>
        <div>
          <label className={label}>{t("expenses.editVatRate")}</label>
          <select className={input} value={form.vatRate}
            onChange={(e) => setForm({ ...form, vatRate: e.target.value })}>
            <option value="0.19">19%</option>
            <option value="0.07">7%</option>
            <option value="0">0%</option>
          </select>
        </div>
        <div className="flex items-end justify-end">
          <Button size="sm" onClick={save} disabled={saving || !form.description} data-testid="expense-edit-save">
            ✓ {saving ? "…" : t("expenses.editSave")}
          </Button>
        </div>
      </div>
    </div>
  )
}
