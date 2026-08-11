"use client"

// Tier 48: Cost-Center Budgets CRUD page.
//
// /dashboard/cost-center-budgets
//
// Per-(costCenter, year) row with 12 monthly target
// amounts. The yearly report (tier-44) auto-joins
// these against actuals on the backend. This page
// is the input side: edit monthly targets, save,
// delete.
//
// Empty / new row states use the same form layout —
// a 12-cell number grid plus a label input. Cost
// center is a free-form string (matches
// Invoice.costCenter convention).

import { useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import LanguageSwitcher from "@/components/LanguageSwitcher"
import { ThemeToggle } from "@/components/ThemeToggle"
import { useI18n } from "@/components/useI18n"
import { useToast } from "@/components/useToast"
import { apiGet, apiPost, apiDelete } from "@/lib/api"

interface Budget {
  id: string
  costCenter: string
  label: string | null
  monthlyTargets: number[]
}

const MONTH_LABELS = [
  "budgetsJan", "budgetsFeb", "budgetsMar",
  "budgetsApr", "budgetsMay", "budgetsJun",
  "budgetsJul", "budgetsAug", "budgetsSep",
  "budgetsOct", "budgetsNov", "budgetsDec",
] as const

const eur = (n: number): string =>
  new Intl.NumberFormat("de-DE", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 0,
  }).format(n || 0)

/**
 * One editable budget row. Local state — the parent
 * commits via Save which POSTs to the backend. Delete
 * fires the DELETE endpoint after a window.confirm.
 */
function BudgetRow({
  budget,
  onSaved,
  onDeleted,
  monthLabels,
  labels,
}: {
  budget: Budget
  onSaved: (b: Budget) => void
  onDeleted: (id: string) => void
  monthLabels: string[]
  labels: {
    colCostCenter: string
    colLabel: string
    colTotal: string
    save: string
    delete: string
    confirmDelete: string
  }
}) {
  const [costCenter, setCostCenter] = useState(budget.costCenter)
  const [label, setLabel] = useState(budget.label || "")
  const [targets, setTargets] = useState<number[]>(
    budget.monthlyTargets.length === 12
      ? budget.monthlyTargets
      : Array(12).fill(0),
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const total = targets.reduce((s, v) => s + Number(v || 0), 0)

  const onChangeMonth = (idx: number, value: string) => {
    const next = [...targets]
    // Allow decimal entry — German "," and English
    // "." both accepted; we parseFloat below.
    next[idx] = Number(value.replace(",", ".")) || 0
    setTargets(next)
  }

  const year = new Date().getFullYear()

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      const companyId = localStorage.getItem("companyId") || ""
      const res = await apiPost<Budget>(
        `/api/v1/reports/cost-center-budgets?companyId=${companyId}`,
        {
          year,
          costCenter: costCenter.trim() === "Nicht zugewiesen" ? "" : costCenter,
          label: label.trim() || null,
          monthlyTargets: targets,
        },
      )
      onSaved(res)
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setSaving(false)
    }
  }

  const remove = () => {
    if (typeof window !== "undefined") {
      const ok = window.confirm(labels.confirmDelete)
      if (!ok) return
    }
    const companyId = localStorage.getItem("companyId") || ""
    apiDelete(`/api/v1/reports/cost-center-budgets/${budget.id}?companyId=${companyId}`)
      .then(() => onDeleted(budget.id))
      .catch((e) => setError(e?.message || String(e)))
  }

  return (
    <tr
      className="border-b border-gray-100 dark:border-gray-800 align-top"
      data-testid="budget-row"
    >
      <td className="py-3 px-3 sticky left-0 bg-white dark:bg-gray-800">
        <input
          type="text"
          value={costCenter}
          onChange={(e) => setCostCenter(e.target.value)}
          className="w-32 border rounded px-2 py-1 text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100"
          placeholder="z.B. VERTRIEB"
          data-testid="budget-cc-input"
        />
      </td>
      <td className="py-3 px-3">
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          className="w-40 border rounded px-2 py-1 text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100"
          placeholder="z.B. FY2026 plan"
          data-testid="budget-label-input"
        />
      </td>
      {targets.map((v, i) => (
        <td key={i} className="py-3 px-1">
          <input
            type="number"
            step="0.01"
            value={v || ""}
            onChange={(e) => onChangeMonth(i, e.target.value)}
            className="w-20 border rounded px-2 py-1 text-sm text-right font-mono dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100"
            data-testid="budget-month-input"
            data-month={i}
            title={monthLabels[i]}
          />
        </td>
      ))}
      <td className="py-3 px-3 text-right font-mono text-sm" data-testid="budget-total">
        {eur(total)}
      </td>
      <td className="py-3 px-3 text-right">
        <div className="flex flex-col gap-1 items-end">
          <Button
            size="sm"
            onClick={save}
            disabled={saving}
            data-testid="budget-save"
          >
            {saving ? "…" : labels.save}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={remove}
            data-testid="budget-delete"
          >
            {labels.delete}
          </Button>
        </div>
        {error && (
          <div
            className="mt-1 text-xs text-red-600 dark:text-red-400 max-w-[12rem] text-right"
            data-testid="budget-error"
          >
            {error}
          </div>
        )}
      </td>
    </tr>
  )
}

export default function CostCenterBudgetsPage() {
  const { t } = useI18n()
  const toast = useToast()
  const [year, setYear] = useState<number>(new Date().getFullYear())
  const [budgets, setBudgets] = useState<Budget[]>([])
  const [loading, setLoading] = useState(true)

  const companyId =
    typeof window !== "undefined"
      ? localStorage.getItem("companyId") || ""
      : ""

  const monthLabels = useMemo(
    () => MONTH_LABELS.map((k) => t(`costCenterReport.${k}`) as string),
    [t],
  )

  const labels = {
    colCostCenter: t("costCenterReport.budgetsColCostCenter") as string,
    colLabel: t("costCenterReport.budgetsColLabel") as string,
    colTotal: t("costCenterReport.budgetsColTotal") as string,
    save: t("costCenterReport.budgetsSave") as string,
    delete: t("costCenterReport.budgetsDelete") as string,
    confirmDelete: t("costCenterReport.budgetsConfirmDelete") as string,
  }

  const refresh = async () => {
    if (!companyId) return
    setLoading(true)
    try {
      const res = await apiGet<{ year: number; budgets: Budget[] }>(
        `/api/v1/reports/cost-center-budgets?companyId=${companyId}&year=${year}`,
      )
      setBudgets(res.budgets)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    refresh()
  }, [companyId, year]) // eslint-disable-line react-hooks/exhaustive-deps

  const addNew = () => {
    const newRow: Budget = {
      id: `__new_${Date.now()}`,
      costCenter: "",
      label: "",
      monthlyTargets: Array(12).fill(0),
    }
    setBudgets((prev) => [newRow, ...prev])
  }

  const onSaved = (saved: Budget) => {
    setBudgets((prev) => {
      const idx = prev.findIndex((b) => b.id === saved.id)
      if (idx >= 0) {
        const next = [...prev]
        next[idx] = saved
        return next
      }
      // New row → prepend
      return [saved, ...prev]
    })
  }
  const onDeleted = (id: string) => {
    setBudgets((prev) => prev.filter((b) => b.id !== id))
  }

  const title = (t("costCenterReport.budgetsTitle") as string).replace(
    "{year}",
    String(year),
  )

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <header className="border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
            {title}
          </h1>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 max-w-2xl">
            {t("costCenterReport.budgetsSubtitle")}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Link
            href="/dashboard/cost-center-report"
            className="text-sm text-gray-600 dark:text-gray-300 hover:underline"
          >
            ← {t("nav.costCenterReport")}
          </Link>
          <LanguageSwitcher />
          <ThemeToggle />
        </div>
      </header>

      <main className="max-w-full mx-auto px-6 py-8 space-y-6">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-base">
              {t("costCenterReport.filterYear")}
            </CardTitle>
            <div className="flex items-center gap-2">
              <select
                data-testid="budget-year-select"
                value={year}
                onChange={(e) => setYear(Number(e.target.value))}
                className="border rounded px-2 py-1 text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100"
              >
                {Array.from({ length: 5 }).map((_, i) => {
                  const y = new Date().getFullYear() - i
                  return (
                    <option key={y} value={y}>
                      {y}
                    </option>
                  )
                })}
              </select>
              <Button
                onClick={addNew}
                data-testid="budget-add"
              >
                {t("costCenterReport.budgetsAdd")}
              </Button>
            </div>
          </CardHeader>
          <CardContent className="p-0 overflow-x-auto">
            {loading && budgets.length === 0 ? (
              <div className="text-sm text-gray-500 dark:text-gray-400 py-8 text-center">
                {t("costCenterReport.loading")}
              </div>
            ) : budgets.length === 0 ? (
              <div className="text-sm text-gray-500 dark:text-gray-400 py-8 text-center">
                {t("costCenterReport.budgetsEmpty")}
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left border-b border-gray-200 dark:border-gray-700 text-xs uppercase text-gray-500">
                    <th className="py-3 px-3 sticky left-0 bg-white dark:bg-gray-800">
                      {labels.colCostCenter}
                    </th>
                    <th className="py-3 px-3">{labels.colLabel}</th>
                    {monthLabels.map((m, i) => (
                      <th
                        key={i}
                        className="py-3 px-1 text-right text-[10px] font-mono"
                        data-testid="budget-month-header"
                      >
                        {m}
                      </th>
                    ))}
                    <th className="py-3 px-3 text-right">{labels.colTotal}</th>
                    <th className="py-3 px-3"></th>
                  </tr>
                </thead>
                <tbody>
                  {budgets.map((b) => (
                    <BudgetRow
                      key={b.id}
                      budget={b}
                      onSaved={onSaved}
                      onDeleted={onDeleted}
                      monthLabels={monthLabels}
                      labels={labels}
                    />
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  )
}