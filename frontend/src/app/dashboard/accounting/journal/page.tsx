"use client"

// Tier 12: Buchungsjournal PDF viewer.
//
// The /accounting/journal page renders
// the journal PDF inline via the
// backend's
// /api/v1/accounting/journal/pdf route.
// The user picks a date range, the
// PDF is fetched as a Blob and shown
// in an <iframe> so the browser's
// built-in viewer (Chrome PDFium etc)
// handles rendering, search, zoom.
//
// Metadata from the response headers
// (X-Journal-Count, X-Journal-Balanced)
// is shown above the iframe so the user
// sees "3 Belege · Soll = Haben" before
// the PDF even loads — useful for the
// "is everything reconciled?" glance.
//
// Why an iframe (and not a server-rendered
// <embed> or a <a href> download)?
//   - Inline preview matches the UStVA
//     page pattern in the same app
//   - The browser PDF viewer is faster
//     and more familiar than any custom
//     React PDF viewer would be
//   - "Save As" is one click away
//   - We don't need page-by-page JS
//     interaction (the journal is a
//     reference document, not a form)

import { useEffect, useState } from "react"
import { useI18n } from "@/components/useI18n"
import { apiGetBlob } from "@/lib/api"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ErrorBanner } from "@/components/ui/error-banner"
import { Skeleton } from "@/components/ui/skeleton"

export default function JournalPage() {
  const { t } = useI18n()
  // Default to the current calendar
  // year so the user sees something
  // on first load (rather than a
  // 1970-01-01 / 2099-12-31 empty
  // range that surprises them).
  const now = new Date()
  const yearStart = `${now.getFullYear()}-01-01`
  const today = now.toISOString().slice(0, 10)
  const [dateFrom, setDateFrom] = useState(yearStart)
  const [dateTo, setDateTo] = useState(today)
  const [pdfUrl, setPdfUrl] = useState<string | null>(null)
  const [meta, setMeta] = useState<{
    count: number
    totalDebit: number
    totalCredit: number
    balanced: boolean
  } | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [companyId, setCompanyId] = useState("")

  useEffect(() => {
    const cid = localStorage.getItem("companyId") || ""
    setCompanyId(cid)
  }, [])

  // Revoke the Blob URL when we
  // replace it (otherwise the PDF
  // blob is pinned in memory until
  // the page reloads).
  useEffect(() => {
    return () => {
      if (pdfUrl) URL.revokeObjectURL(pdfUrl)
    }
  }, [pdfUrl])

  const load = async () => {
    if (!companyId) return
    setLoading(true)
    setError(null)
    try {
      const { blob, headers } = await apiGetBlob(
        `/api/v1/accounting/journal/pdf?companyId=${companyId}&dateFrom=${dateFrom}&dateTo=${dateTo}`,
      )
      if (pdfUrl) URL.revokeObjectURL(pdfUrl)
      const url = URL.createObjectURL(blob)
      setPdfUrl(url)
      setMeta({
        count: parseInt(headers["x-journal-count"] || "0", 10),
        totalDebit: parseFloat(headers["x-journal-total-debit"] || "0"),
        totalCredit: parseFloat(headers["x-journal-total-credit"] || "0"),
        balanced: headers["x-journal-balanced"] === "1",
      })
    } catch (e: any) {
      setError(e?.message || t("journal.loadError"))
    } finally {
      setLoading(false)
    }
  }

  const fmtMoney = (n: number) =>
    n.toLocaleString("de-DE", {
      style: "currency",
      currency: "EUR",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">{t("journal.title")}</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
          {t("journal.subtitle")}
        </p>
      </div>

      {error && (
        <ErrorBanner
          title={t("journal.loadError")}
          message={error}
          variant="error"
          onDismiss={() => setError(null)}
          onRetry={load}
        />
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("journal.filterTitle")}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
            <div className="space-y-1">
              <Label htmlFor="dateFrom">{t("journal.dateFrom")}</Label>
              <Input
                id="dateFrom"
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="dateTo">{t("journal.dateTo")}</Label>
              <Input
                id="dateTo"
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
              />
            </div>
            <Button onClick={load} disabled={loading || !companyId}>
              {loading ? t("common.loading") : t("journal.generate")}
            </Button>
          </div>
        </CardContent>
      </Card>

      {meta && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="p-3 border border-gray-200 dark:border-gray-700 rounded-lg">
            <div className="text-xs text-gray-500 dark:text-gray-400">
              {t("journal.metricCount")}
            </div>
            <div className="text-xl font-semibold tabular-nums">
              {meta.count}
            </div>
          </div>
          <div className="p-3 border border-gray-200 dark:border-gray-700 rounded-lg">
            <div className="text-xs text-gray-500 dark:text-gray-400">
              {t("journal.metricDebit")}
            </div>
            <div className="text-xl font-semibold tabular-nums">
              {fmtMoney(meta.totalDebit)}
            </div>
          </div>
          <div className="p-3 border border-gray-200 dark:border-gray-700 rounded-lg">
            <div className="text-xs text-gray-500 dark:text-gray-400">
              {t("journal.metricCredit")}
            </div>
            <div className="text-xl font-semibold tabular-nums">
              {fmtMoney(meta.totalCredit)}
            </div>
          </div>
          <div
            className={`p-3 border rounded-lg ${
              meta.balanced
                ? "border-emerald-300 bg-emerald-50 dark:bg-emerald-900/30 dark:border-emerald-800"
                : "border-red-300 bg-red-50 dark:bg-red-900/30 dark:border-red-800"
            }`}
          >
            <div className="text-xs text-gray-500 dark:text-gray-400">
              {t("journal.metricBalance")}
            </div>
            <div
              className={`text-sm font-semibold ${
                meta.balanced
                  ? "text-emerald-700 dark:text-emerald-300"
                  : "text-red-700 dark:text-red-300"
              }`}
            >
              {meta.balanced ? t("journal.balanced") : t("journal.unbalanced")}
            </div>
          </div>
        </div>
      )}

      {loading ? (
        <Card>
          <CardContent className="space-y-3">
            <Skeleton className="h-8 w-32" />
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-96 w-full" />
          </CardContent>
        </Card>
      ) : pdfUrl ? (
        <Card>
          <CardContent className="p-0">
            <iframe
              src={pdfUrl}
              className="w-full h-[800px] border-0 rounded-b-lg"
              title="Buchungsjournal"
            />
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="text-center text-sm text-gray-500 dark:text-gray-400 py-12">
            {t("journal.empty")}
          </CardContent>
        </Card>
      )}
    </div>
  )
}