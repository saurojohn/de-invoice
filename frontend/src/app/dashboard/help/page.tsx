"use client"

/**
 * Tier 831 — „Kurzanleitung": the daily work in a few steps, each section
 * with the page it is about. The texts are in messages/{de,en,zh}.json
 * (`help.sections.<id>.<n>`, numbered from 1); the operator's section is
 * shown to the operator only.
 */
import Link from "next/link"
import { useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { useI18n } from "@/components/useI18n"
import { apiGet } from "@/lib/api"

const SECTIONS: { id: string; href: string; operatorOnly?: boolean }[] = [
  { id: "start", href: "/dashboard/settings" },
  { id: "invoice", href: "/dashboard/invoices/create" },
  { id: "expense", href: "/dashboard/expenses" },
  { id: "bank", href: "/dashboard/bank-import" },
  { id: "dunning", href: "/dashboard/invoices?status=overdue" },
  { id: "month", href: "/dashboard/accounting/ustva" },
  { id: "year", href: "/dashboard/accounting" },
  { id: "adviser", href: "/dashboard/reports" },
  { id: "operator", href: "/dashboard/operator", operatorOnly: true },
]

export default function HelpPage() {
  const { t } = useI18n()
  const [operator, setOperator] = useState(false)
  useEffect(() => {
    apiGet<{ operator?: boolean }>("/api/v1/auth/me")
      .then((me) => setOperator(me?.operator === true))
      .catch(() => setOperator(false))
  }, [])

  const steps = (id: string): string[] => {
    const out: string[] = []
    for (let n = 1; n < 10; n++) {
      const key = "help.sections." + id + "." + n
      const text = t(key)
      if (text === key) break
      out.push(text)
    }
    return out
  }

  return (
    <div className="p-4 sm:p-6 max-w-3xl space-y-6">
      <div>
        <Link href="/dashboard" className="text-sm text-blue-600 dark:text-blue-400 hover:underline">← Dashboard</Link>
        <h1 className="text-2xl font-bold mt-1">{t("help.title")}</h1>
        <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">{t("help.intro")}</p>
      </div>
      {SECTIONS.filter((s) => !s.operatorOnly || operator).map((s, i) => (
        <Card key={s.id} data-testid={`help-${s.id}`}>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex flex-wrap items-baseline justify-between gap-2">
              <span>{i + 1}. {t("help.sections." + s.id + ".title")}</span>
              <Link href={s.href} className="text-sm font-normal text-blue-600 dark:text-blue-400 hover:underline" data-testid={`help-link-${s.id}`}>
                {t("help.open")} →
              </Link>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ol className="list-decimal pl-5 space-y-2 text-sm text-gray-700 dark:text-gray-300">
              {steps(s.id).map((text) => <li key={text}>{text}</li>)}
            </ol>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
