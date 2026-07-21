"use client"

import { useEffect, useRef, useState, useCallback } from "react"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { useI18n } from "@/components/useI18n"
import { useToast } from "@/components/useToast"
import { apiGet, ApiError } from "@/lib/api"

interface GobdSummary {
  companyId: string
  year: number
  invoiceCount: number
  expenseCount: number
  attachmentCount: number
  auditLogCount: number
  totalRevenueNet: number
  totalExpenseNet: number
  totalVat: number
  totalVorsteuer: number
  generatedAt: string
}

/**
 * Tier 77: GoBD-Archiv section on
 * /dashboard/accounting.
 *
 * Shows a year picker + a "Vorschau" button that
 * loads the summary, then a "ZIP herunterladen"
 * button that triggers the actual archive build
 * (a multi-MB download). The summary gives the
 * user a "what's in the archive" preview before
 * the actual download — useful for big years
 * with hundreds of invoices.
 *
 * The GoBD § 147 AO 10-year retention is
 * satisfied as long as the source data is in
 * the DB. The archive is a snapshot export for
 * the Berater / Betriebsprüfer.
 */
export function GobdArchiveSection() {
  const { t } = useI18n()
  const toast = useToast()
  const toastRef = useRef(toast)
  toastRef.current = toast
  const tRef = useRef(t)
  tRef.current = t
  const [year, setYear] = useState<number>(new Date().getFullYear() - 1)
  const [summary, setSummary] = useState<GobdSummary | null>(null)
  const [loading, setLoading] = useState(false)
  const [zipUrl, setZipUrl] = useState<string>("#")

  const load = useCallback(async (y: number) => {
    setLoading(true)
    try {
      const companyId =
        typeof window !== "undefined" ? localStorage.getItem("companyId") : null
      const params = new URLSearchParams()
      if (companyId) params.set("companyId", companyId)
      params.set("year", String(y))
      const result = await apiGet<GobdSummary>(
        `/api/v1/accounting/gobd-archive/summary?${params}`,
      )
      setSummary(result)
    } catch (e: any) {
      const msg = e instanceof ApiError ? e.message : tRef.current("common.loadError")
      toastRef.current.error(msg)
    } finally {
      setLoading(false)
    }
  }, [])

  // Compute the ZIP download URL in a useEffect
  // so localStorage is reliably available.
  // (Same pattern as the EÜR PDF link in tier 76.)
  useEffect(() => {
    if (typeof window === "undefined") return
    const companyId = localStorage.getItem("companyId")
    if (!companyId) {
      setZipUrl("#")
      return
    }
    const apiBase =
      process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001"
    setZipUrl(
      `${apiBase}/api/v1/accounting/gobd-archive?companyId=${companyId}&year=${year}`,
    )
  }, [year])

  useEffect(() => {
    load(year)
  }, [year, load])

  const fmt = (n: number) =>
    new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR", minimumFractionDigits: 2 }).format(n)
  const fmtInt = (n: number) =>
    new Intl.NumberFormat("de-DE").format(n)

  return (
    <div className="mt-6 space-y-4" data-testid="gobd-archive-section">
      <Card>
        <CardHeader>
          <CardTitle>
            🗄️ {tRef.current("gobd.title")} ({summary?.year || year})
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
            {tRef.current("gobd.subtitle")}
          </p>

          <div className="flex flex-wrap items-end gap-3 mb-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">
                {tRef.current("gobd.year")}
              </label>
              <input
                type="number"
                min={2000}
                max={2100}
                value={year}
                onChange={(e) => setYear(Number(e.target.value) || new Date().getFullYear() - 1)}
                className="border rounded px-3 py-2 w-32 dark:bg-gray-800 dark:border-gray-700"
                data-testid="gobd-year"
              />
            </div>
            <Button
              onClick={() => load(year)}
              disabled={loading}
              data-testid="gobd-recompute"
            >
              {loading ? "..." : tRef.current("gobd.recompute")}
            </Button>
            <a
              href={zipUrl}
              target="_blank"
              rel="noreferrer"
              className="ml-auto"
              data-testid="gobd-zip-link"
            >
              <Button type="button" variant="outline">
                📦 {tRef.current("gobd.downloadZip")}
              </Button>
            </a>
          </div>

          {summary && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
                <div>
                  <div className="text-xs text-gray-500">{tRef.current("gobd.invoiceCount")}</div>
                  <div
                    className="font-mono font-semibold"
                    data-testid="gobd-invoice-count"
                  >
                    {fmtInt(summary.invoiceCount)}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-gray-500">{tRef.current("gobd.expenseCount")}</div>
                  <div
                    className="font-mono font-semibold"
                    data-testid="gobd-expense-count"
                  >
                    {fmtInt(summary.expenseCount)}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-gray-500">{tRef.current("gobd.attachmentCount")}</div>
                  <div
                    className="font-mono"
                    data-testid="gobd-attachment-count"
                  >
                    {fmtInt(summary.attachmentCount)}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-gray-500">{tRef.current("gobd.auditLogCount")}</div>
                  <div
                    className="font-mono"
                    data-testid="gobd-audit-count"
                  >
                    {fmtInt(summary.auditLogCount)}
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
                <div>
                  <div className="text-xs text-gray-500">{tRef.current("gobd.revenueNet")}</div>
                  <div className="font-mono text-emerald-600 dark:text-emerald-400 font-semibold">
                    +{fmt(summary.totalRevenueNet)}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-gray-500">{tRef.current("gobd.expenseNet")}</div>
                  <div className="font-mono text-red-600 dark:text-red-400 font-semibold">
                    −{fmt(summary.totalExpenseNet)}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-gray-500">{tRef.current("gobd.vat")}</div>
                  <div className="font-mono text-gray-700 dark:text-gray-300">
                    {fmt(summary.totalVat)}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-gray-500">{tRef.current("gobd.vorsteuer")}</div>
                  <div className="font-mono text-gray-700 dark:text-gray-300">
                    {fmt(summary.totalVorsteuer)}
                  </div>
                </div>
              </div>

              <div
                className="p-3 bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-700 rounded text-xs text-blue-800 dark:text-blue-200"
                data-testid="gobd-disclaimer"
              >
                📋 {tRef.current("gobd.disclaimer")}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
