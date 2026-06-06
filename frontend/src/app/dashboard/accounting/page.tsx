"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import LanguageSwitcher from "@/components/LanguageSwitcher"
import { useI18n } from "@/components/useI18n"

interface VoucherLine {
  id: string
  description: string
  debit: string
  credit: string
  account: {
    accountNumber: string
    name: string
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

export default function AccountingPage() {
  const router = useRouter()
  const { t, locale, getDateLocale } = useI18n()
  const [vouchers, setVouchers] = useState<Voucher[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const companyId = localStorage.getItem("companyId")
    if (!companyId) {
      router.push("/login")
      return
    }

    fetch(`http://localhost:3001/api/v1/accounting/vouchers?companyId=${companyId}`)
      .then((res) => res.json())
      .then((data) => {
        if (Array.isArray(data)) {
          setVouchers(data)
        }
      })
      .finally(() => setLoading(false))
  }, [router])

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
      draft: "bg-gray-100 text-gray-700",
      posted: "bg-green-100 text-green-700",
      voided: "bg-red-100 text-red-700",
    }
    return colors[status] || colors.draft
  }

  const calculateTotal = (lines: VoucherLine[]) => {
    return lines.reduce((sum, line) => sum + parseFloat(line.debit || "0"), 0)
  }

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleDateString(getDateLocale())
  }

  return (
    <main className="min-h-screen bg-gray-50 p-6">
      <div className="max-w-7xl mx-auto">
        <div className="flex justify-between items-center mb-6">
          <h1 className="text-2xl font-bold text-gray-900">{t("accounting.vouchers")}</h1>
          <div className="flex gap-2 items-center">
            <button
              onClick={() => router.push("/dashboard/accounting/ustva")}
              className="px-3 py-1 text-sm border border-blue-600 text-blue-700 rounded hover:bg-blue-50 font-medium"
              title="UStVA — Umsatzsteuervoranmeldung"
            >
              UStVA
            </button>
            <LanguageSwitcher />
            <button
              onClick={() => router.push("/dashboard")}
              className="px-3 py-1 text-sm border rounded hover:bg-gray-100"
            >
              {t("common.back")}
            </button>
          </div>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>{t("accounting.voucherList")}</CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="space-y-4">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="h-16 bg-gray-100 rounded animate-pulse" />
                ))}
              </div>
            ) : vouchers.length === 0 ? (
              <div className="text-center py-12 text-gray-500">
                {t("common.noData")}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b">
                      <th className="text-left py-3 px-4 text-sm font-medium text-gray-500">
                        {t("accounting.voucherNumber")}
                      </th>
                      <th className="text-left py-3 px-4 text-sm font-medium text-gray-500">
                        {t("accounting.voucherDate")}
                      </th>
                      <th className="text-left py-3 px-4 text-sm font-medium text-gray-500">
                        {t("accounting.description")}
                      </th>
                      <th className="text-right py-3 px-4 text-sm font-medium text-gray-500">
                        {t("accounting.total")}
                      </th>
                      <th className="text-center py-3 px-4 text-sm font-medium text-gray-500">
                        {t("accounting.status")}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {vouchers.map((voucher) => (
                      <tr
                        key={voucher.id}
                        className="border-b hover:bg-gray-50 cursor-pointer"
                        onClick={() => router.push(`/dashboard/accounting/${voucher.id}`)}
                      >
                        <td className="py-3 px-4 font-mono text-sm">{voucher.voucherNumber}</td>
                        <td className="py-3 px-4 text-sm">{formatDate(voucher.date)}</td>
                        <td className="py-3 px-4 text-sm text-gray-600">{voucher.description || "-"}</td>
                        <td className="py-3 px-4 text-sm text-right font-mono">
                          €{calculateTotal(voucher.lines).toFixed(2)}
                        </td>
                        <td className="py-3 px-4 text-center">
                          <Badge className={getStatusColor(voucher.status)}>
                            {getStatusLabel(voucher.status)}
                          </Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </main>
  )
}