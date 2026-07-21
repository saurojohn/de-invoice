"use client"

import { useEffect, useRef, useState, useCallback } from "react"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { useI18n } from "@/components/useI18n"
import { useToast } from "@/components/useToast"
import { apiGet, ApiError } from "@/lib/api"

interface OssLine {
  country: string
  countryName: string
  vatRate: number
  netAmount: number
  vatAmount: number
  grossAmount: number
  invoiceCount: number
}

interface OssCountryTotal {
  country: string
  countryName: string
  netAmount: number
  vatAmount: number
  grossAmount: number
  invoiceCount: number
  vatRates: OssLine[]
}

interface OssResult {
  year: number
  quarter: number
  companyId: string
  homeCountry: string
  countries: OssCountryTotal[]
  totals: {
    netAmount: number
    vatAmount: number
    grossAmount: number
    invoiceCount: number
  }
  counts: {
    eligible: number
    excludedB2B: number
    excludedSameCountry: number
    excludedNonEU: number
    excludedDraft: number
  }
  generatedAt: string
  disclaimer: string
}

function currentQuarter(): number {
  // 0-indexed Date.getMonth() → 1-indexed quarter (1-4).
  return Math.floor(new Date().getMonth() / 3) + 1
}

/**
 * Tier 78: EU OSS (One-Stop-Shop) quarterly B2C
 * distance-sales declaration.
 *
 * UI: a year + quarter picker + a "Berechnen"
 * button. On success, the response surfaces:
 *
 *   - 4 summary cards (net, VAT, gross, invoice
 *     count) — the totals across all in-scope
 *     countries
 *   - 1 exclusion-counts card (B2B, same-country,
 *     non-EU, drafts) so the user can see "I had
 *     12 non-EU invoices this quarter" — the kind
 *     of sanity check the BZSt auditor expects
 *   - 1 country breakdown table: one row per
 *     country, with a per-(country, vatRate)
 *     drill-in below the country subtotal
 *   - 1 CSV download button (→ /oss.csv)
 *   - 1 disclaimer line (the data is a preview,
 *     not a legal filing)
 *
 * The default year + quarter is the current
 * calendar quarter — the user mostly wants to
 * look at "what's in this quarter" and the
 * pickers are there for back-filing.
 */
export function OssTab() {
  const { t } = useI18n()
  const toast = useToast()
  // Tier 73: useToast/useI18n return fresh objects
  // every render — capture in refs so useCallback
  // deps stay stable.
  const toastRef = useRef(toast)
  toastRef.current = toast
  const tRef = useRef(t)
  tRef.current = t
  const [year, setYear] = useState<number>(new Date().getFullYear())
  const [quarter, setQuarter] = useState<number>(currentQuarter())
  const [data, setData] = useState<OssResult | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async (y: number, q: number) => {
    setLoading(true)
    try {
      const companyId =
        typeof window !== "undefined" ? localStorage.getItem("companyId") : null
      const params = new URLSearchParams()
      if (companyId) params.set("companyId", companyId)
      params.set("year", String(y))
      params.set("quarter", String(q))
      const result = await apiGet<OssResult>(`/api/v1/reports/oss?${params}`)
      setData(result)
    } catch (e: any) {
      const msg = e instanceof ApiError ? e.message : tRef.current("common.loadError")
      toastRef.current.error(msg)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load(year, quarter)
  }, [year, quarter, load])

  const fmt = (n: number) =>
    new Intl.NumberFormat("de-DE", {
      style: "currency",
      currency: "EUR",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(n)
  const fmtPct = (r: number) =>
    `${(r * 100).toFixed(r === Math.floor(r * 100) / 100 ? 0 : 1).replace(".", ",")} %`

  // Compute the CSV download URL via useState +
  // useEffect so the localStorage value is
  // reliably available (avoids the SSR /
  // pre-hydration window where window is
  // undefined OR the addInitScript hasn't fired
  // yet).
  const [csvUrl, setCsvUrl] = useState<string>("#")
  useEffect(() => {
    if (typeof window === "undefined") return
    const companyId = localStorage.getItem("companyId")
    if (!companyId) {
      setCsvUrl("#")
      return
    }
    const apiBase =
      process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001"
    setCsvUrl(
      `${apiBase}/api/v1/reports/oss.csv?companyId=${companyId}&year=${year}&quarter=${quarter}`,
    )
  }, [year, quarter])

  return (
    <div className="space-y-4" data-testid="oss-tab">
      <Card>
        <CardHeader>
          <CardTitle>🌍 {tRef.current("oss.title")}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">
            {tRef.current("oss.subtitle")}
          </p>
          <div className="flex flex-wrap items-end gap-3 mb-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">
                {tRef.current("oss.year")}
              </label>
              <input
                type="number"
                min={2000}
                max={2100}
                value={year}
                onChange={(e) => setYear(Number(e.target.value) || new Date().getFullYear())}
                className="border rounded px-3 py-2 w-32 dark:bg-gray-800 dark:border-gray-700"
                data-testid="oss-year"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">
                {tRef.current("oss.quarter")}
              </label>
              <select
                value={quarter}
                onChange={(e) => setQuarter(Number(e.target.value))}
                className="border rounded px-3 py-2 dark:bg-gray-800 dark:border-gray-700"
                data-testid="oss-quarter"
              >
                <option value={1}>{tRef.current("oss.q1")}</option>
                <option value={2}>{tRef.current("oss.q2")}</option>
                <option value={3}>{tRef.current("oss.q3")}</option>
                <option value={4}>{tRef.current("oss.q4")}</option>
              </select>
            </div>
            <Button
              onClick={() => load(year, quarter)}
              disabled={loading}
              data-testid="oss-recompute"
            >
              {loading ? "..." : tRef.current("oss.recompute")}
            </Button>
            <a
              href={csvUrl}
              target="_blank"
              rel="noreferrer"
              className="ml-auto"
              data-testid="oss-csv-link"
            >
              <Button variant="outline" type="button" disabled={csvUrl === "#"}>
                📥 {tRef.current("oss.downloadCsv")}
              </Button>
            </a>
          </div>

          {data && (
            <p className="text-xs text-gray-500 dark:text-gray-400" data-testid="oss-homeCountry">
              {tRef.current("oss.homeCountry")}: {data.homeCountry}
            </p>
          )}
        </CardContent>
      </Card>

      {data && (
        <>
          {/* Summary cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Card>
              <CardContent className="pt-6">
                <div className="text-xs text-gray-500 dark:text-gray-400">
                  {tRef.current("oss.net")}
                </div>
                <div
                  className="text-2xl font-bold text-blue-600 dark:text-blue-400"
                  data-testid="oss-total-net"
                >
                  {fmt(data.totals.netAmount)}
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6">
                <div className="text-xs text-gray-500 dark:text-gray-400">
                  {tRef.current("oss.vat")}
                </div>
                <div
                  className="text-2xl font-bold text-amber-600 dark:text-amber-400"
                  data-testid="oss-total-vat"
                >
                  {fmt(data.totals.vatAmount)}
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6">
                <div className="text-xs text-gray-500 dark:text-gray-400">
                  {tRef.current("oss.gross")}
                </div>
                <div
                  className="text-2xl font-bold text-emerald-600 dark:text-emerald-400"
                  data-testid="oss-total-gross"
                >
                  {fmt(data.totals.grossAmount)}
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6">
                <div className="text-xs text-gray-500 dark:text-gray-400">
                  {tRef.current("oss.invoices")}
                </div>
                <div
                  className="text-2xl font-bold"
                  data-testid="oss-total-invoices"
                >
                  {data.totals.invoiceCount}
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Per-country breakdown */}
          {data.countries.length === 0 ? (
            <Card>
              <CardContent className="pt-6 text-center text-gray-500 dark:text-gray-400">
                {tRef.current("oss.noData")}
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">
                  {tRef.current("oss.country")}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm" data-testid="oss-countries-table">
                    <thead>
                      <tr className="text-xs text-gray-500 border-b">
                        <th className="text-left py-2">{tRef.current("oss.country")}</th>
                        <th className="text-right py-2">{tRef.current("oss.net")}</th>
                        <th className="text-right py-2">{tRef.current("oss.vat")}</th>
                        <th className="text-right py-2">{tRef.current("oss.gross")}</th>
                        <th className="text-right py-2">{tRef.current("oss.invoices")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.countries.map((c) => (
                        <CountryRow key={c.country} country={c} fmt={fmt} fmtPct={fmtPct} />
                      ))}
                      <tr className="border-t-2 font-semibold" data-testid="oss-total-row">
                        <td className="py-2">{tRef.current("oss.total")}</td>
                        <td className="py-2 text-right font-mono">{fmt(data.totals.netAmount)}</td>
                        <td className="py-2 text-right font-mono">{fmt(data.totals.vatAmount)}</td>
                        <td className="py-2 text-right font-mono">{fmt(data.totals.grossAmount)}</td>
                        <td className="py-2 text-right font-mono">{data.totals.invoiceCount}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Exclusion counts — visible always so the
              user can see "12 non-EU this quarter" even
              if the OSS report itself is empty. */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">
                {tRef.current("oss.excludedTitle")}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                <div data-testid="oss-excluded-b2b">
                  <div className="text-xs text-gray-500">
                    {tRef.current("oss.excludedB2B")}
                  </div>
                  <div className="text-lg font-semibold">{data.counts.excludedB2B}</div>
                </div>
                <div data-testid="oss-excluded-sameCountry">
                  <div className="text-xs text-gray-500">
                    {tRef.current("oss.excludedSameCountry")}
                  </div>
                  <div className="text-lg font-semibold">{data.counts.excludedSameCountry}</div>
                </div>
                <div data-testid="oss-excluded-nonEU">
                  <div className="text-xs text-gray-500">
                    {tRef.current("oss.excludedNonEU")}
                  </div>
                  <div className="text-lg font-semibold">{data.counts.excludedNonEU}</div>
                </div>
                <div data-testid="oss-excluded-draft">
                  <div className="text-xs text-gray-500">
                    {tRef.current("oss.excludedDraft")}
                  </div>
                  <div className="text-lg font-semibold">{data.counts.excludedDraft}</div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Disclaimer */}
          <p className="text-xs text-gray-500 dark:text-gray-400 italic" data-testid="oss-disclaimer">
            {data.disclaimer}
          </p>
        </>
      )}
    </div>
  )
}

/**
 * One row in the per-country table. Includes an
 * expandable drill-in for the per-VAT-rate lines
 * (the country subtotal collapses/expands on
 * click). Default state: collapsed.
 */
function CountryRow({
  country,
  fmt,
  fmtPct,
}: {
  country: OssCountryTotal
  fmt: (n: number) => string
  fmtPct: (r: number) => string
}) {
  const [expanded, setExpanded] = useState(false)
  return (
    <>
      <tr
        className="border-b hover:bg-gray-50 dark:hover:bg-gray-900 cursor-pointer"
        onClick={() => setExpanded(!expanded)}
        data-testid={`oss-country-row-${country.country}`}
      >
        <td className="py-2">
          <span className="mr-1 text-xs text-gray-400">{expanded ? "▼" : "▶"}</span>
          {country.countryName} ({country.country})
        </td>
        <td className="py-2 text-right font-mono">{fmt(country.netAmount)}</td>
        <td className="py-2 text-right font-mono">{fmt(country.vatAmount)}</td>
        <td className="py-2 text-right font-mono">{fmt(country.grossAmount)}</td>
        <td className="py-2 text-right font-mono">{country.invoiceCount}</td>
      </tr>
      {expanded &&
        country.vatRates.map((v) => (
          <tr
            key={`${country.country}-${v.vatRate}`}
            className="bg-gray-50 dark:bg-gray-900 text-xs"
            data-testid={`oss-rateline-${country.country}-${v.vatRate}`}
          >
            <td className="py-1 pl-8 text-gray-500">
              └ USt {fmtPct(v.vatRate)}
            </td>
            <td className="py-1 text-right font-mono">{fmt(v.netAmount)}</td>
            <td className="py-1 text-right font-mono">{fmt(v.vatAmount)}</td>
            <td className="py-1 text-right font-mono">{fmt(v.grossAmount)}</td>
            <td className="py-1 text-right font-mono">{v.invoiceCount}</td>
          </tr>
        ))}
    </>
  )
}
