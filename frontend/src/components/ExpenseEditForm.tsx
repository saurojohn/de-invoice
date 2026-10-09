"use client"

// Tier 447: correct an expense (Eingangsrechnung) from the expenses page.
// PUT /expenses/:id (Tier 443) takes amounts positive; a credit note keeps its
// sign on the server. A paid expense or an AfA row carries `lockReason` —
// the form is not shown then, the reason is (it names the way out).
import { todayIso } from "@/lib/today"
import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { useI18n } from "@/components/useI18n"
import { useToast } from "@/components/useToast"
import { ApiError, apiPost, apiPut } from "@/lib/api"

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
  paidAt?: string | null
  // Tier 581: the VAT lines of an invoice with several rates (empty otherwise)
  taxLines?: Array<{ vatRate: string | number; netAmount: string | number; vatAmount: string | number }>
  isReverseCharge?: boolean
  isIntraEU?: boolean
}

/** Tier 605: what "new expense" starts from. */
export const BLANK_EXPENSE: EditableExpense = {
  id: "", invoiceNumber: "", description: "", invoiceDate: todayIso(),
  netAmount: "", vatRate: "0.19", category: "", supplier: null,
}
type Treatment = "normal" | "rc" | "ige"

type LineForm = { vatRate: string; netAmount: string; vatAmount: string }
const RATES = ["0.19", "0.07", "0"]
const cents = (s: string) => Math.round(parseFloat(s || "0") * 100)
const de = (c: number) => (c / 100).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export function ExpenseEditForm({
  expense,
  suppliers,
  onSaved,
  create = false,
}: {
  expense: EditableExpense
  suppliers: Array<{ id: string; name: string }>
  onSaved: () => void
  /** Tier 605: a new expense (POST) instead of a correction (PUT) */
  create?: boolean
}) {
  const { t } = useI18n()
  const toast = useToast()
  const initial = () => ({
    invoiceDate: String(expense.invoiceDate).slice(0, 10),
    invoiceNumber: expense.invoiceNumber || "",
    supplierId: expense.supplier?.id || "",
    description: expense.description || "",
    category: expense.category || "",
    netAmount: expense.netAmount === "" ? "" : String(Math.abs(Number(expense.netAmount))),
    vatRate: String(Number(expense.vatRate)),
    paidAt: expense.paidAt ? String(expense.paidAt).slice(0, 10) : "",
  })
  // Tier 581: one line per VAT rate when the invoice has several; empty = one rate.
  const initialLines = (): LineForm[] =>
    (expense.taxLines ?? []).length > 1
      ? expense.taxLines!.map((l) => ({
          vatRate: String(Number(l.vatRate)),
          netAmount: String(Math.abs(Number(l.netAmount))),
          vatAmount: String(Math.abs(Number(l.vatAmount))),
        }))
      : []
  const [form, setForm] = useState(initial)
  const [lines, setLines] = useState<LineForm[]>(initialLines)
  const [saving, setSaving] = useState(false)
  // Tier 605: § 13b / intra-community acquisition. The invoice shows no VAT;
  // the UStVA computes it. Until now this could only be set on the UStVA page.
  const initialTreatment = (): Treatment => (expense.isReverseCharge ? "rc" : expense.isIntraEU ? "ige" : "normal")
  const [treatment, setTreatment] = useState<Treatment>(initialTreatment)
  // A different row opened in the same modal starts from its own values.
  useEffect(() => {
    setForm(initial())
    setLines(initialLines())
    setTreatment(initialTreatment())
  }, [expense.id]) // eslint-disable-line react-hooks/exhaustive-deps
  const hadLines = (expense.taxLines ?? []).length > 1
  const setLine = (i: number, patch: Partial<LineForm>) =>
    setLines((all) =>
      all.map((l, k) => {
        if (k !== i) return l
        const next = { ...l, ...patch }
        // the VAT follows net × rate until it is typed
        if (patch.netAmount !== undefined || patch.vatRate !== undefined) {
          next.vatAmount = ((cents(next.netAmount) * parseFloat(next.vatRate || "0")) / 100).toFixed(2)
        }
        return next
      }),
    )
  // a second rate: the amounts so far become the first line
  const addLine = () =>
    setLines((all) => {
      const base: LineForm[] = all.length
        ? all
        : [{ vatRate: form.vatRate, netAmount: form.netAmount, vatAmount: ((cents(form.netAmount) * parseFloat(form.vatRate || "0")) / 100).toFixed(2) }]
      const free = RATES.find((r) => !base.some((l) => Number(l.vatRate) === Number(r))) ?? "0"
      return [...base, { vatRate: free, netAmount: "", vatAmount: "0.00" }]
    })
  const removeLine = (i: number) =>
    setLines((all) => {
      const rest = all.filter((_, k) => k !== i)
      if (rest.length === 1) {
        // back to one rate: its amounts go into the ordinary fields
        setForm((f) => ({ ...f, netAmount: rest[0].netAmount, vatRate: rest[0].vatRate }))
        return []
      }
      return rest
    })
  const lineTotals = lines.reduce(
    (sum, l) => ({ net: sum.net + cents(l.netAmount), vat: sum.vat + cents(l.vatAmount) }),
    { net: 0, vat: 0 },
  )
  const duplicateRate = lines.some((l, i) => lines.findIndex((o) => Number(o.vatRate) === Number(l.vatRate)) !== i)

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
      const noVat = treatment !== "normal"
      const net = parseFloat(form.netAmount || "0")
      const rate = parseFloat(form.vatRate)
      const vat = Math.round(net * rate * 100) / 100
      const body = {
        invoiceDate: form.invoiceDate,
        invoiceNumber: form.invoiceNumber,
        supplierId: form.supplierId,
        description: form.description,
        category: form.category,
        isReverseCharge: treatment === "rc",
        isIntraEU: treatment === "ige",
        ...(lines.length > 1 && !noVat
          ? {
              taxLines: lines.map((l) => ({
                vatRate: parseFloat(l.vatRate),
                netAmount: parseFloat(l.netAmount || "0"),
                vatAmount: parseFloat(l.vatAmount || "0"),
              })),
            }
          : {
              // [] takes the lines of a multi-rate expense away again
              ...(hadLines ? { taxLines: [] } : {}),
              netAmount: net,
              // § 13b / ig. Erwerb: the invoice carries no VAT
              ...(noVat
                ? { vatRate: 0.19, vatAmount: 0, grossAmount: net }
                : create
                  ? { vatRate: rate, vatAmount: vat, grossAmount: Math.round((net + vat) * 100) / 100 }
                  : { vatRate: rate }),
            }),
        // Tier 454: paid by card / privately — the EÜR counts it on this day
        paidAt: form.paidAt || null,
      }
      if (create) {
        const { supplierId, invoiceNumber, category, paidAt, ...rest } = body
        await apiPost(`/api/v1/expenses?companyId=${companyId}`, {
          ...rest,
          ...(supplierId ? { supplierId } : {}),
          ...(invoiceNumber ? { invoiceNumber } : {}),
          ...(category ? { category } : {}),
          ...(paidAt ? { paidAt } : {}),
        })
      } else {
        await apiPut(`/api/v1/expenses/${expense.id}?companyId=${companyId}`, body)
      }
      toast.success(t(create ? "expenses.createSaved" : "expenses.editSaved"))
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
    <div className="mb-4 rounded border p-3" data-testid={create ? "expense-create" : "expense-edit"}>
      <div className="mb-2 text-sm font-medium">{t(create ? "expenses.createTitle" : "expenses.editTitle")}</div>
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
        <div className="md:col-span-3">
          <label className={label} htmlFor="expense-treatment">{t("expenses.treatment")}</label>
          <select id="expense-treatment" className={input} value={treatment} data-testid="expense-edit-treatment"
            onChange={(e) => {
              const v = e.target.value as Treatment
              setTreatment(v)
              // lines carry VAT — a § 13b / ig. invoice has none
              if (v !== "normal" && lines.length > 1) {
                setForm((f) => ({ ...f, netAmount: (lineTotals.net / 100).toFixed(2) }))
                setLines([])
              }
            }}>
            <option value="normal">{t("expenses.treatmentNormal")}</option>
            <option value="rc">{t("expenses.treatmentRc")}</option>
            <option value="ige">{t("expenses.treatmentIge")}</option>
          </select>
          {treatment !== "normal" && (
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{t("expenses.treatmentHint")}</p>
          )}
        </div>
        {lines.length > 1 && treatment === "normal" ? (
          <div className="md:col-span-3" data-testid="expense-edit-tax-lines">
            <label className={label}>{t("expenses.taxLines")}</label>
            <div className="space-y-2">
              {lines.map((l, i) => (
                <div key={i} className="grid grid-cols-[5rem_1fr_1fr_auto] items-center gap-2" data-testid="expense-edit-tax-line">
                  <select className={input} value={l.vatRate} aria-label={t("expenses.editVatRate")}
                    onChange={(e) => setLine(i, { vatRate: e.target.value })}>
                    {[...new Set([...RATES, l.vatRate])].map((r) => (
                      <option key={r} value={r}>{(Number(r) * 100).toLocaleString("de-DE")}%</option>
                    ))}
                  </select>
                  <input type="number" step="0.01" min="0" className={`${input} text-right`} value={l.netAmount}
                    placeholder={t("expenses.net")} aria-label={t("expenses.net")} data-testid={`expense-edit-line-net-${i}`}
                    onChange={(e) => setLine(i, { netAmount: e.target.value })} />
                  <input type="number" step="0.01" min="0" className={`${input} text-right`} value={l.vatAmount}
                    placeholder={t("expenses.vat")} aria-label={t("expenses.vat")} data-testid={`expense-edit-line-vat-${i}`}
                    onChange={(e) => setLines((all) => all.map((o, k) => (k === i ? { ...o, vatAmount: e.target.value } : o)))} />
                  <button type="button" className="px-2 text-red-600 dark:text-red-400" title={t("expenses.removeTaxLine")}
                    aria-label={t("expenses.removeTaxLine")} data-testid={`expense-edit-line-remove-${i}`} onClick={() => removeLine(i)}>
                    ✕
                  </button>
                </div>
              ))}
            </div>
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-gray-600 dark:text-gray-300">
              <button type="button" className="text-blue-600 hover:underline dark:text-blue-400" onClick={addLine} data-testid="expense-edit-add-tax-line">
                + {t("expenses.addTaxLine")}
              </button>
              <span className="font-mono" data-testid="expense-edit-line-totals">
                {t("expenses.net")} {de(lineTotals.net)} + {t("expenses.vat")} {de(lineTotals.vat)} = {de(lineTotals.net + lineTotals.vat)} €
              </span>
            </div>
            {duplicateRate && <div className="mt-1 text-xs text-red-600 dark:text-red-400">{t("expenses.taxLineDuplicate")}</div>}
          </div>
        ) : (
          <>
            <div>
              <label className={label}>{t("expenses.net")}</label>
              <input type="number" step="0.01" className={`${input} text-right`} value={form.netAmount}
                data-testid="expense-edit-net"
                onChange={(e) => setForm({ ...form, netAmount: e.target.value })} />
            </div>
            <div className={treatment === "normal" ? "" : "hidden"}>
              <label className={label}>{t("expenses.editVatRate")}</label>
              <select className={input} value={form.vatRate}
                onChange={(e) => setForm({ ...form, vatRate: e.target.value })}>
                <option value="0.19">19%</option>
                <option value="0.07">7%</option>
                <option value="0">0%</option>
              </select>
              <button type="button" className="mt-1 text-xs text-blue-600 hover:underline dark:text-blue-400" onClick={addLine}
                data-testid="expense-edit-add-tax-line">
                + {t("expenses.addTaxLine")}
              </button>
            </div>
          </>
        )}
        <div>
          <label className={label}>{t("expenses.paidAt")}</label>
          <input type="date" className={input} value={form.paidAt} data-testid="expense-edit-paid-at"
            onChange={(e) => setForm({ ...form, paidAt: e.target.value })} />
        </div>
        <div className="flex items-end justify-end md:col-span-3">
          <Button size="sm" onClick={save} disabled={saving || !form.description || duplicateRate || (create && !(parseFloat(form.netAmount) > 0) && lines.length < 2)} data-testid="expense-edit-save">
            ✓ {saving ? "…" : t("expenses.editSave")}
          </Button>
        </div>
      </div>
    </div>
  )
}
