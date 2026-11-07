"use client"

/**
 * Tier 812 — the journal against the reports (Abstimmung).
 *
 * The reports read invoices, expenses, payments and the cash book, not the
 * journal. This lists the vouchers of a year that are in the journal and the
 * DATEV export and in no report — manual vouchers and corrections on expense,
 * revenue or VAT accounts, bank debits booked „Als Aufwand" before Tier 809 —
 * with what they would add (GET /accounting/abstimmung).
 */
import { useEffect, useState } from "react"
import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { useI18n } from "@/components/useI18n"
import { apiGet } from "@/lib/api"
import { formatMoney } from "@/lib/money"

type Kind = "aufwand" | "ertrag" | "steuer"
interface Entry {
  id: string
  voucherNumber: string
  date: string
  description: string | null
  origin: "manual" | "correction" | "bank-expense"
  lines: Array<{ accountNumber: string; name: string; kind: Kind; debit: number; credit: number }>
}
interface Result {
  year: number
  entries: Entry[]
  totals: Record<Kind, number>
  truncated: boolean
  /** Tier 815: purchases on an Anlagekonto with no asset in the register */
  assetPurchases?: Array<{ id: string; date: string; description: string; accountNumber: string; net: number }>
}

const day = (iso: string) => iso.split("-").reverse().join(".")

export function JournalReconciliationCard() {
  const { t } = useI18n()
  const thisYear = new Date().getFullYear()
  const [year, setYear] = useState(thisYear)
  const [data, setData] = useState<Result | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    const companyId = localStorage.getItem("companyId")
    if (!companyId) return
    let alive = true
    setFailed(false)
    apiGet<Result>(`/api/v1/accounting/abstimmung?companyId=${companyId}&year=${year}`)
      .then((r) => { if (alive) setData(r) })
      .catch(() => { if (alive) setFailed(true) })
    return () => { alive = false }
  }, [year])

  return (
    <Card className="mb-4" data-testid="journal-reconciliation">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>{t("abstimmung.title")}</CardTitle>
          <label className="text-sm flex items-center gap-2">
            <span className="text-gray-600 dark:text-gray-300">{t("abstimmung.year")}</span>
            <select
              value={year}
              onChange={(e) => setYear(Number(e.target.value))}
              className="border rounded px-2 py-1 bg-white dark:bg-gray-800"
              data-testid="abstimmung-year"
            >
              {[thisYear + 1, thisYear, thisYear - 1, thisYear - 2, thisYear - 3].map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          </label>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-gray-600 dark:text-gray-300">{t("abstimmung.intro")}</p>
        {failed && <p className="text-red-700 dark:text-red-400">{t("abstimmung.failed")}</p>}
        {data && (data.assetPurchases?.length ?? 0) > 0 && (
          <div className="rounded border border-amber-300 dark:border-amber-700 p-3" data-testid="abstimmung-asset-purchases">
            <p className="font-medium text-amber-800 dark:text-amber-300">{t("abstimmung.assetsTitle")}</p>
            <p className="text-xs text-gray-600 dark:text-gray-300 mt-1">{t("abstimmung.assetsHint")}</p>
            <ul className="mt-2 space-y-1">
              {data.assetPurchases!.map((a) => (
                <li key={a.id} className="text-xs font-mono" data-testid="abstimmung-asset-purchase">
                  {day(a.date)} · {a.accountNumber} · {formatMoney(a.net)} · {a.description}
                </li>
              ))}
            </ul>
            <Link href="/dashboard/assets" className="text-xs underline">{t("abstimmung.toAssets")}</Link>
          </div>
        )}
        {data && data.entries.length === 0 && (data.assetPurchases?.length ?? 0) === 0 && (
          <p className="text-emerald-700 dark:text-emerald-400" data-testid="abstimmung-ok">{t("abstimmung.ok").replace("{year}", String(data.year))}</p>
        )}
        {data && data.entries.length > 0 && (
          <>
            <p className="text-amber-700 dark:text-amber-400" data-testid="abstimmung-summary">
              {t("abstimmung.summary")
                .replace("{count}", String(data.entries.length))
                .replace("{aufwand}", formatMoney(data.totals.aufwand))
                .replace("{ertrag}", formatMoney(data.totals.ertrag))
                .replace("{steuer}", formatMoney(data.totals.steuer))}
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-gray-500 dark:text-gray-400">
                    <th className="py-1 pr-2">{t("abstimmung.voucher")}</th>
                    <th className="py-1 pr-2">{t("abstimmung.lines")}</th>
                    <th className="py-1">{t("abstimmung.what")}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.entries.map((e) => (
                    <tr key={e.id} className="border-t align-top" data-testid="abstimmung-entry">
                      <td className="py-1 pr-2 whitespace-nowrap">
                        <span className="font-mono">{e.voucherNumber}</span>
                        <span className="block text-xs text-gray-500 dark:text-gray-400">{day(e.date)}</span>
                        {e.description && <span className="block text-xs text-gray-500 dark:text-gray-400 max-w-[14rem] truncate">{e.description}</span>}
                      </td>
                      <td className="py-1 pr-2">
                        {e.lines.map((l, i) => (
                          <span key={i} className="block font-mono text-xs">
                            {l.accountNumber} {l.name}: {l.debit ? `S ${formatMoney(l.debit)}` : `H ${formatMoney(l.credit)}`}
                          </span>
                        ))}
                      </td>
                      <td className="py-1 text-xs">
                        {t(`abstimmung.origin_${e.origin}`)}
                        {e.origin === "bank-expense" && (
                          <Link href="/dashboard/bank-import" className="block underline">{t("abstimmung.toBank")}</Link>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {data.truncated && <p className="text-xs text-gray-500 dark:text-gray-400">{t("abstimmung.truncated")}</p>}
          </>
        )}
      </CardContent>
    </Card>
  )
}
