"use client"

import { useEffect, useState } from "react"
import { useRouter, useParams } from "next/navigation"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { useI18n } from "@/components/useI18n"

interface VoucherLine {
  id: string
  description: string
  debit: string
  credit: string
  account: {
    id: string
    accountNumber: string
    name: string
    type: string
  }
}

interface Voucher {
  id: string
  voucherNumber: string
  date: string
  description: string
  referenceType: string
  status: string
  lines: VoucherLine[]
}

export default function VoucherDetailPage() {
  const router = useRouter()
  const params = useParams()
  const { t, getDateLocale } = useI18n()
  const [voucher, setVoucher] = useState<Voucher | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const companyId = localStorage.getItem("companyId")
    if (!companyId) {
      router.push("/login")
      return
    }

    const voucherId = params.id as string
    fetch(`http://localhost:3001/api/v1/accounting/vouchers/${voucherId}?companyId=${companyId}`)
      .then((res) => res.json())
      .then(setVoucher)
      .finally(() => setLoading(false))
  }, [router, params.id])

  const getStatusLabel = (status: string) => {
    const labels: Record<string, string> = {
      draft: t("accounting.draft"),
      posted: t("accounting.posted"),
      voided: t("accounting.voided"),
    }
    return labels[status] || status
  }

  const getStatusColor = (status: string) => {
    const colors: Record<string, string> = {
      draft: "bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-200",
      posted: "bg-green-100 text-green-700 dark:text-green-300",
      voided: "bg-red-100 text-red-700 dark:text-red-300",
    }
    return colors[status] || colors.draft
  }

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleDateString(getDateLocale())
  }

  const totalDebit = voucher?.lines.reduce((sum, line) => sum + parseFloat(line.debit || "0"), 0) || 0
  const totalCredit = voucher?.lines.reduce((sum, line) => sum + parseFloat(line.credit || "0"), 0) || 0
  const isBalanced = Math.abs(totalDebit - totalCredit) < 0.01

  if (loading) {
    return (
      <main className="min-h-screen bg-gray-50 dark:bg-gray-900 p-6">
        <div className="max-w-5xl mx-auto">
          <div className="h-8 w-48 bg-gray-200 dark:bg-gray-700 rounded animate-pulse mb-6" />
          <Card>
            <CardContent className="p-6">
              <div className="space-y-4">
                {[1, 2, 3, 4, 5].map((i) => (
                  <div key={i} className="h-12 bg-gray-100 dark:bg-gray-800 rounded animate-pulse" />
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      </main>
    )
  }

  if (!voucher) {
    return (
      <main className="min-h-screen bg-gray-50 dark:bg-gray-900 p-6">
        <div className="max-w-5xl mx-auto text-center">
          <p className="text-gray-500 dark:text-gray-400">{t("common.notFound")}</p>
          <Button onClick={() => router.push("/dashboard/accounting")} className="mt-4">
            {t("accounting.back")}
          </Button>
        </div>
      </main>
    )
  }

  return (
    <main className="min-h-screen bg-gray-50 dark:bg-gray-900 p-6">
      <div className="max-w-5xl mx-auto">
        <Button
          variant="ghost"
          onClick={() => router.push("/dashboard/accounting")}
          className="mb-4"
        >
          ← {t("accounting.back")}
        </Button>

        <Card className="mb-6">
          <CardHeader>
            <div className="flex justify-between items-center">
              <CardTitle className="font-mono text-xl">{voucher.voucherNumber}</CardTitle>
              <Badge className={getStatusColor(voucher.status)}>
                {getStatusLabel(voucher.status)}
              </Badge>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div>
                <p className="text-sm text-gray-500 dark:text-gray-400">{t("accounting.voucherDate")}</p>
                <p className="font-medium">{formatDate(voucher.date)}</p>
              </div>
              <div>
                <p className="text-sm text-gray-500 dark:text-gray-400">{t("accounting.voucherType")}</p>
                <p className="font-medium">{voucher.referenceType || "-"}</p>
              </div>
              <div className="col-span-2">
                <p className="text-sm text-gray-500 dark:text-gray-400">{t("accounting.description")}</p>
                <p className="font-medium">{voucher.description || "-"}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Buchungszeilen</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b bg-gray-50 dark:bg-gray-900">
                    <th className="text-left py-3 px-4 text-sm font-medium text-gray-500 dark:text-gray-400 w-24">
                      {t("accounting.account")}
                    </th>
                    <th className="text-left py-3 px-4 text-sm font-medium text-gray-500 dark:text-gray-400">
                      {t("accounting.accountName")}
                    </th>
                    <th className="text-left py-3 px-4 text-sm font-medium text-gray-500 dark:text-gray-400">
                      {t("accounting.description")}
                    </th>
                    <th className="text-right py-3 px-4 text-sm font-medium text-gray-500 dark:text-gray-400 w-32">
                      {t("accounting.debit")}
                    </th>
                    <th className="text-right py-3 px-4 text-sm font-medium text-gray-500 dark:text-gray-400 w-32">
                      {t("accounting.credit")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {voucher.lines.map((line) => (
                    <tr key={line.id} className="border-b">
                      <td className="py-3 px-4 font-mono text-sm">{line.account.accountNumber}</td>
                      <td className="py-3 px-4 text-sm">{line.account.name}</td>
                      <td className="py-3 px-4 text-sm text-gray-600 dark:text-gray-300">{line.description || "-"}</td>
                      <td className="py-3 px-4 text-sm text-right font-mono">
                        {parseFloat(line.debit) > 0 ? `€${parseFloat(line.debit).toFixed(2)}` : ""}
                      </td>
                      <td className="py-3 px-4 text-sm text-right font-mono">
                        {parseFloat(line.credit) > 0 ? `€${parseFloat(line.credit).toFixed(2)}` : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 bg-gray-50 dark:bg-gray-900 font-bold">
                    <td colSpan={3} className="py-3 px-4">{t("accounting.total")}</td>
                    <td className="py-3 px-4 text-right font-mono">€{totalDebit.toFixed(2)}</td>
                    <td className="py-3 px-4 text-right font-mono">€{totalCredit.toFixed(2)}</td>
                  </tr>
                </tfoot>
              </table>

              <div className={`mt-4 p-3 rounded-lg text-center ${isBalanced ? "bg-green-50 text-green-700 dark:text-green-300" : "bg-red-50 text-red-700 dark:text-red-300"}`}>
                {isBalanced ? t("accounting.balanced") : t("accounting.unbalanced")}
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </main>
  )
}