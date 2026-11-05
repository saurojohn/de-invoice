"use client"

/**
 * Tier 801 — "Nächste Steuertermine" (Tier 804; was "Abgabefristen") on the dashboard: the UStVA, ZM and OSS
 * returns due next, with the day they are due (§ 18 / § 18a / § 18j UStG,
 * § 108 Abs. 3 AO) and whether the UStVA was already submitted here. Each row
 * opens its report on that period.
 */
import { useEffect, useState } from "react"
import Link from "next/link"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { useI18n } from "@/components/useI18n"
import { deadlineDay, deadlinePeriodLabel, loadFilingDeadlines, type FilingDeadline, type FilingDeadlines } from "@/lib/filing-deadlines"

const KIND_KEY: Record<FilingDeadline["kind"], string> = {
  ustva: "deadlines.kind.ustva", zm: "deadlines.kind.zm", oss: "deadlines.kind.oss",
  annual: "deadlines.kind.annual", svz: "deadlines.kind.svz", dauerfrist: "deadlines.kind.dauerfrist",
  kst: "deadlines.kind.kst", gewst: "deadlines.kind.gewst",
}

function href(d: FilingDeadline): string {
  // Tier 802
  if (d.kind === "annual") return "/dashboard/accounting"
  if (d.kind === "svz") return "/dashboard/accounting/ustva#ust-payments"
  if (d.kind === "dauerfrist") return "/dashboard/accounting/ustva#filing-settings"
  // Tier 804: where the prepayments of the Bescheid are entered
  if (d.kind === "kst") return `/dashboard/accounting?kstYear=${d.year}#form-kst1`
  if (d.kind === "gewst") return `/dashboard/accounting?gewstYear=${d.year}#form-gewst`
  if (d.kind === "oss") return `/dashboard/reports?tab=oss&year=${d.year}&quarter=${d.quarter}`
  if (d.kind === "zm") return `/dashboard/accounting/ustva?zmYear=${d.year}&zmQuarter=${d.quarter}#zm`
  return d.month
    ? `/dashboard/accounting/ustva?year=${d.year}&month=${d.month}`
    : `/dashboard/accounting/ustva?year=${d.year}&quarter=${d.quarter}`
}

export function FilingDeadlinesCard() {
  const { t, locale } = useI18n()
  const [data, setData] = useState<FilingDeadlines | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let alive = true
    loadFilingDeadlines(true).then((d) => {
      if (!alive) return
      if (d) setData(d)
      else setFailed(true)
    })
    return () => { alive = false }
  }, [])

  const when = (d: FilingDeadline) => {
    if (d.status === "filed") return t(d.kind === "svz" || d.kind === "kst" || d.kind === "gewst" ? "deadlines.paid" : "deadlines.filed")
    if (d.status === "option") return t("deadlines.possibleUntil")
    if (d.daysLeft === 0) return t("deadlines.today")
    if (d.daysLeft < 0) return t("deadlines.overdueSince", { days: String(-d.daysLeft) })
    if (d.daysLeft === 1) return t("deadlines.tomorrow")
    return t("deadlines.inDays", { days: String(d.daysLeft) })
  }
  const money = (n: number) => n.toLocaleString(locale === "en" ? "en-GB" : locale === "zh" ? "zh-CN" : "de-DE", { style: "currency", currency: "EUR" })
  const tone = (d: FilingDeadline) =>
    d.status === "filed"
      ? "text-emerald-700 dark:text-emerald-400"
      : d.status === "option"
        ? "text-gray-500"
        : d.status === "overdue" || (d.status === "open" && d.daysLeft <= 3)
        ? "text-red-700 dark:text-red-400"
        : d.status === "open" && d.daysLeft <= 10
          ? "text-amber-700 dark:text-amber-400"
            : "text-gray-600 dark:text-gray-300"

  return (
    <Card data-testid="filing-deadlines-card">
      <CardHeader>
        <CardTitle>{t("deadlines.title")}</CardTitle>
      </CardHeader>
      <CardContent>
        {failed && <p className="text-sm text-gray-500">{t("deadlines.loadFailed")}</p>}
        {!data && !failed && <p className="text-sm text-gray-500">{t("common.loading")}</p>}
        {data && (
          <>
            {data.deadlines.length === 0 ? (
              <p className="text-sm text-gray-500" data-testid="filing-deadlines-empty">{t("deadlines.none")}</p>
            ) : (
              <ul className="divide-y divide-gray-100 dark:divide-gray-800">
                {data.deadlines.map((d) => (
                  <li key={`${d.kind}-${d.year}-${d.month ?? ""}-${d.quarter ?? ""}`} className="py-2" data-testid="filing-deadline" data-kind={d.kind} data-status={d.status}>
                    <Link href={href(d)} className="flex flex-wrap items-baseline justify-between gap-x-3 hover:underline">
                      <span className="font-medium text-gray-900 dark:text-gray-100">
                        {t(KIND_KEY[d.kind])} {deadlinePeriodLabel(d, locale)}
                        {d.amount != null && d.amount > 0 && (
                          <span className="ml-2 font-normal text-gray-700 dark:text-gray-200" data-testid="filing-deadline-amount">
                            {/* Tier 804: only the Sondervorauszahlung is an estimate */}
                            {d.kind === "svz"
                              ? t("deadlines.about", { amount: money(d.amount) })
                              : money(d.amount)}
                          </span>
                        )}
                        {d.status === "running" && <span className="ml-2 text-xs font-normal text-gray-500">{t("deadlines.running")}</span>}
                      </span>
                      <span className="text-sm">
                        <span className="text-gray-700 dark:text-gray-200" data-testid="filing-deadline-due">{t(d.status === "option" ? "deadlines.byDate" : "deadlines.dueOn", { date: deadlineDay(d.dueDate) })}</span>
                        <span className={`ml-2 ${tone(d)}`}>{when(d)}</span>
                      </span>
                    </Link>
                    {d.noteCode && <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">{t(`deadlines.note.${d.noteCode}`)}</p>}
                  </li>
                ))}
              </ul>
            )}
            {(data.rhythmSource !== "setting" || data.dauerfristSource !== "setting") && data.rhythm !== "none" && (
              <p className="mt-3 text-xs text-gray-500" data-testid="filing-deadlines-assumed">
                {t("deadlines.assumed", {
                  rhythm: t(data.rhythm === "monthly" ? "deadlines.rhythmMonthly" : "deadlines.rhythmQuarterly"),
                  dauerfrist: t(data.dauerfrist ? "deadlines.withDauerfrist" : "deadlines.withoutDauerfrist"),
                })}{" "}
                <Link href="/dashboard/accounting/ustva#filing-settings" className="underline">{t("deadlines.setIt")}</Link>
              </p>
            )}
            {!data.bundesland && (
              <p className="mt-1 text-xs text-gray-500">{t("deadlines.noBundesland")}</p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
