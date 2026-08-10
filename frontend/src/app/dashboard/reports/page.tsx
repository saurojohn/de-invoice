"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import LanguageSwitcher from "@/components/LanguageSwitcher"
import { apiFetch, apiGet } from "@/lib/api"
import { useI18n } from "@/components/useI18n"
import { PnlTab } from "./PnlTab"
import { OssTab } from "./OssTab"
import { BwaTab } from "./BwaTab"

type TabType = "sales" | "vat" | "customers" | "datev" | "pnl" | "oss" | "bwa"

interface SalesReport {
  totalSales: number
  totalVat: number
  byCustomer: Array<{
    customerId: string
    customerName: string
    totalAmount: number
    invoiceCount: number
  }>
  byMonth: Array<{
    month: string
    totalAmount: number
    invoiceCount: number
  }>
  yearOverYear: Array<{
    year: number
    totalAmount: number
    growthPercent: number | null
  }>
}

interface VatReport {
  byRate: Array<{
    vatRate: number
    netAmount: number
    vatAmount: number
    grossAmount: number
    invoiceCount: number
  }>
  totalNet: number
  totalVat: number
  totalGross: number
}

interface CustomerReport {
  customers: Array<{
    customerId: string
    customerName: string
    totalInvoices: number
    totalAmount: number
    paidAmount: number
    pendingAmount: number
    overdueAmount: number
    lastInvoiceDate: string | null
  }>
  summary: {
    totalCustomers: number
    totalAmount: number
    totalPaid: number
    totalPending: number
    totalOverdue: number
  }
}

export default function ReportsPage() {
  const router = useRouter()
  const [activeTab, setActiveTab] = useState<TabType>("sales")
  const [loading, setLoading] = useState(true)

  // Date range state
  const currentYear = new Date().getFullYear()
  const [startDate, setStartDate] = useState(`${currentYear}-01-01`)
  const [endDate, setEndDate] = useState(new Date().toISOString().split("T")[0])
  const [vatYear, setVatYear] = useState(currentYear.toString())
  const [vatPeriod, setVatPeriod] = useState<"year" | "q1" | "q2" | "q3" | "q4" | "m1" | "m2" | "m3" | "m4" | "m5" | "m6" | "m7" | "m8" | "m9" | "m10" | "m11" | "m12">("year")

  // Report data state
  const [salesReport, setSalesReport] = useState<SalesReport | null>(null)
  const [vatReport, setVatReport] = useState<VatReport | null>(null)
  const [customerReport, setCustomerReport] = useState<CustomerReport | null>(null)

  useEffect(() => {
    const companyId = localStorage.getItem("companyId")
    if (!companyId) {
      router.push("/login")
      return
    }
    loadReports(companyId)
  }, [router, startDate, endDate, vatYear, vatPeriod])

  const loadReports = async (companyId: string) => {
    setLoading(true)
    try {
      // Use apiFetch so x-user-id / x-company-id get
      // injected. Raw fetch() against HeaderAuthGuard
      // returns 401 and res.json() throws — the page
      // would have shown nothing. This was the same bug
      // the dashboard had before commit 8b696b0.
      // Load sales report
      const salesRes = await apiFetch(
        `/api/v1/reports/sales?companyId=${companyId}&startDate=${startDate}&endDate=${endDate}`,
        { throwOnError: false }
      )
      const salesData = salesRes.ok ? await salesRes.json() : null
      setSalesReport(salesData)

      // Load VAT report
      let vatPath = `/api/v1/reports/vat?companyId=${companyId}&year=${vatYear}`
      if (vatPeriod !== "year") {
        if (vatPeriod.startsWith("q")) {
          vatPath += `&quarter=${vatPeriod.slice(1)}`
        } else if (vatPeriod.startsWith("m")) {
          vatPath += `&month=${vatPeriod.slice(1)}`
        }
      }
      const vatRes = await apiFetch(vatPath, { throwOnError: false })
      const vatData = vatRes.ok ? await vatRes.json() : null
      setVatReport(vatData)

      // Load customer report
      const customerRes = await apiFetch(
        `/api/v1/reports/customers?companyId=${companyId}&startDate=${startDate}&endDate=${endDate}`,
        { throwOnError: false }
      )
      const customerData = customerRes.ok ? await customerRes.json() : null
      setCustomerReport(customerData)
    } catch (err) {
      console.error("Fehler beim Laden der Berichte:", err)
    } finally {
      setLoading(false)
    }
  }

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat("de-DE", {
      style: "currency",
      currency: "EUR",
    }).format(amount)
  }

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleDateString("de-DE")
  }

  const formatMonth = (monthStr: string) => {
    const [year, month] = monthStr.split("-")
    const date = new Date(parseInt(year), parseInt(month) - 1)
    return date.toLocaleDateString("de-DE", { month: "long", year: "numeric" })
  }

  const exportToCSV = (data: any[], filename: string, headers: string[]) => {
    const csvContent = [
      headers.join(";"),
      ...data.map((row) => Object.values(row).join(";"))
    ].join("\n")

    const BOM = "\uFEFF"
    const blob = new Blob([BOM + csvContent], { type: "text/csv;charset=utf-8;" })
    const url = window.URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `${filename}_${new Date().toISOString().split("T")[0]}.csv`
    document.body.appendChild(a)
    a.click()
    window.URL.revokeObjectURL(url)
    document.body.removeChild(a)
  }

  const getSalesByCustomerCSV = () => {
    if (!salesReport?.byCustomer) return
    const data = salesReport.byCustomer.map((c) => ({
      Kunde: c.customerName,
      "Anzahl Rechnungen": c.invoiceCount,
      "Gesamtbetrag": formatCurrency(c.totalAmount)
    }))
    exportToCSV(data, "umsatzbericht_nach_kunde", Object.keys(data[0] || {}))
  }

  /**
   * Download the DATEV Buchungsstapel for the current
   * calendar year. Goes through apiFetch so x-user-id /
   * x-company-id are attached (a plain <a href> would
   * skip the auth headers). The server already sets
   * Content-Disposition: attachment, so blob + click
   * just saves the file.
   */
  const exportDatev = async () => {
    const companyId = localStorage.getItem("companyId")
    if (!companyId) return
    try {
      const year = new Date().getFullYear()
      const res = await apiFetch(
        `/api/v1/reports/datev-export?companyId=${companyId}&startDate=${year}-01-01&endDate=${year}-12-31`,
        { method: "GET" }
      )
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = `DATEV_Buchungsstapel_${year}.csv`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch (e: any) {
      console.error("DATEV export failed:", e)
      alert(e?.message || "DATEV-Export fehlgeschlagen")
    }
  }

  /**
   * Tier 167: see DatevExportTab.exportBuchungsliste
   * — the function lives in the DatevExportTab scope
   * (alongside loadPreview) because the Buchungsliste
   * button is part of the DATEV tab UI, not the
   * main reports page. Keeping it in the same
   * component as the button avoids prop-drilling the
   * year / companyId down from main.
   */

  /**
   * Download the full DATEV-Beleg-Paket: the CSV
   * PLUS every Beleg-Bild PDF the Berater needs
   * for the import. The bundle comes as a single
   * .zip — saves the user from manually zipping
   * the CSV and re-uploading every PDF to DATEV
   * after the import.
   *
   * Same auth-via-apiFetch pattern as the CSV
   * download. The zip can be 10-50 MB depending
   * on how many invoices are in the period,
   * so we show a small "wird vorbereitet..."
   * hint via the button label.
   */
  const exportDatevBundle = async () => {
    const companyId = localStorage.getItem("companyId")
    if (!companyId) return
    const btn = document.getElementById("datev-bundle-btn") as HTMLButtonElement | null
    const originalLabel = btn?.textContent || ""
    if (btn) {
      btn.disabled = true
      btn.textContent = "Wird vorbereitet…"
    }
    try {
      const year = new Date().getFullYear()
      const res = await apiFetch(
        `/api/v1/reports/datev-export-bundle?companyId=${companyId}&startDate=${year}-01-01&endDate=${year}-12-31`,
        { method: "GET" }
      )
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      // The server sets Content-Disposition but the
      // user might double-click and we want a sensible
      // fallback name.
      a.download = `EXTF_Buchungsstapel_${year}.zip`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch (e: any) {
      console.error("DATEV bundle export failed:", e)
      alert(e?.message || "DATEV-Paket-Export fehlgeschlagen")
    } finally {
      if (btn) {
        btn.disabled = false
        btn.textContent = originalLabel
      }
    }
  }

  const getSalesByMonthCSV = () => {
    if (!salesReport?.byMonth) return
    const data = salesReport.byMonth.map((m) => ({
      Monat: formatMonth(m.month),
      "Anzahl Rechnungen": m.invoiceCount,
      "Gesamtbetrag": formatCurrency(m.totalAmount)
    }))
    exportToCSV(data, "umsatzbericht_nach_monat", Object.keys(data[0] || {}))
  }

  const getVatCSV = () => {
    if (!vatReport?.byRate) return
    const data = vatReport.byRate.map((r) => ({
      "MwSt-Satz": `${(r.vatRate * 100).toFixed(1)}%`,
      "Nettobetrag": formatCurrency(r.netAmount),
      "MwSt-Betrag": formatCurrency(r.vatAmount),
      "Bruttobetrag": formatCurrency(r.grossAmount),
      "Anzahl Rechnungen": r.invoiceCount
    }))
    exportToCSV(data, "mwst_bericht", Object.keys(data[0] || {}))
  }

  const getCustomersCSV = () => {
    if (!customerReport?.customers) return
    const data = customerReport.customers.map((c) => ({
      Kunde: c.customerName,
      "Anzahl Rechnungen": c.totalInvoices,
      "Gesamtbetrag": formatCurrency(c.totalAmount),
      "Bezahlt": formatCurrency(c.paidAmount),
      "Ausstehend": formatCurrency(c.pendingAmount),
      "Überfällig": formatCurrency(c.overdueAmount)
    }))
    exportToCSV(data, "kundenbericht", Object.keys(data[0] || {}))
  }

  return (
    <main className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <header className="bg-white dark:bg-gray-800 border-b shadow-sm">
        {/* Tier 125: responsive header — flex-wrap so
            the 2 buttons + h1 don't clip on mobile. */}
        <div className="container mx-auto px-3 sm:px-4 py-3 sm:py-4 flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-xl sm:text-2xl font-bold text-blue-600 dark:text-blue-400">Berichtscenter</h1>
          <div className="flex flex-wrap gap-2 items-center">
            <Button size="sm" variant="outline" onClick={() => router.push("/dashboard/reports/aging")}>
              Altersstruktur
            </Button>
            <Button variant="outline" onClick={exportDatev}>
              DATEV Export
            </Button>
            <Button
              id="datev-bundle-btn"
              variant="default"
              onClick={exportDatevBundle}
              title="CSV + alle Beleg-PDFs als ZIP herunterladen"
            >
              DATEV-Paket (CSV + PDFs)
            </Button>
            <LanguageSwitcher />
            <Button variant="outline" onClick={() => router.push("/dashboard")}>
              Zurück
            </Button>
          </div>
        </div>
      </header>

      <div className="container mx-auto px-3 sm:px-4 py-4 sm:py-8">
        {/* Tab Navigation */}
        {/* Tier 125: overflow-x-auto so the 4 long
            German tab labels (Umsatzbericht /
            MwSt-Bericht / Kundenbericht / DATEV-...)
            scroll horizontally on a 375px phone
            instead of pushing the page out of bounds. */}
        <div className="flex border-b mb-6 overflow-x-auto">
          <button
            className={`px-6 py-3 font-medium border-b-2 transition-colors ${
              activeTab === "sales"
                ? "border-blue-600 text-blue-600 dark:text-blue-400"
                : "border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:text-gray-200"
            }`}
            onClick={() => setActiveTab("sales")}
          >
            Umsatzbericht
          </button>
          <button
            className={`px-6 py-3 font-medium border-b-2 transition-colors ${
              activeTab === "vat"
                ? "border-blue-600 text-blue-600 dark:text-blue-400"
                : "border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:text-gray-200"
            }`}
            onClick={() => setActiveTab("vat")}
          >
            MwSt-Bericht
          </button>
          <button
            className={`px-6 py-3 font-medium border-b-2 transition-colors ${
              activeTab === "customers"
                ? "border-blue-600 text-blue-600 dark:text-blue-400"
                : "border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:text-gray-200"
            }`}
            onClick={() => setActiveTab("customers")}
          >
            Kundenbericht
          </button>
          <button
            className={`px-6 py-3 font-medium border-b-2 transition-colors ${
              activeTab === "datev"
                ? "border-blue-600 text-blue-600 dark:text-blue-400"
                : "border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:text-gray-200"
            }`}
            onClick={() => setActiveTab("datev")}
            data-testid="tab-datev"
          >
            DATEV-Export
          </button>
          <button
            className={`px-6 py-3 font-medium border-b-2 transition-colors ${
              activeTab === "pnl"
                ? "border-blue-600 text-blue-600 dark:text-blue-400"
                : "border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
            }`}
            onClick={() => setActiveTab("pnl")}
            data-testid="tab-pnl"
          >
            GuV (P&amp;L)
          </button>
          <button
            className={`px-6 py-3 font-medium border-b-2 transition-colors ${
              activeTab === "oss"
                ? "border-blue-600 text-blue-600 dark:text-blue-400"
                : "border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
            }`}
            onClick={() => setActiveTab("oss")}
            data-testid="tab-oss"
          >
            EU OSS
          </button>
          <button
            className={`px-6 py-3 font-medium border-b-2 transition-colors ${
              activeTab === "bwa"
                ? "border-blue-600 text-blue-600 dark:text-blue-400"
                : "border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
            }`}
            onClick={() => setActiveTab("bwa")}
            data-testid="tab-bwa"
          >
            BWA
          </button>
        </div>

        {/* Date Range Selection */}
        {activeTab !== "vat" && (
          <Card className="mb-6">
            <CardContent className="pt-6">
              <div className="flex flex-wrap gap-4 items-end">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">
                    Von Datum
                  </label>
                  <input
                    type="date"
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                    className="px-3 py-2 border border-gray dark:border-gray-700-300 dark:border-gray-600 rounded-md"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">
                    Bis Datum
                  </label>
                  <input
                    type="date"
                    value={endDate}
                    onChange={(e) => setEndDate(e.target.value)}
                    className="px-3 py-2 border border-gray dark:border-gray-700-300 dark:border-gray-600 rounded-md"
                  />
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {activeTab === "vat" && (
          <Card className="mb-6">
            <CardContent className="pt-6">
              <div className="flex flex-wrap gap-4 items-end">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">
                    Jahr
                  </label>
                  <input
                    type="number"
                    value={vatYear}
                    onChange={(e) => setVatYear(e.target.value)}
                    min="2020"
                    max="2030"
                    className="px-3 py-2 border border-gray dark:border-gray-700-300 dark:border-gray-600 rounded-md w-32"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">
                    Zeitraum
                  </label>
                  <select
                    value={vatPeriod}
                    onChange={(e) => setVatPeriod(e.target.value as any)}
                    className="px-3 py-2 border border-gray dark:border-gray-700-300 dark:border-gray-600 rounded-md"
                  >
                    <option value="year">Gesamtjahr</option>
                    <option value="q1">Q1 (Jan-Mär)</option>
                    <option value="q2">Q2 (Apr-Jun)</option>
                    <option value="q3">Q3 (Jul-Sep)</option>
                    <option value="q4">Q4 (Okt-Dez)</option>
                    <option value="m1">Januar</option>
                    <option value="m2">Februar</option>
                    <option value="m3">März</option>
                    <option value="m4">April</option>
                    <option value="m5">Mai</option>
                    <option value="m6">Juni</option>
                    <option value="m7">Juli</option>
                    <option value="m8">August</option>
                    <option value="m9">September</option>
                    <option value="m10">Oktober</option>
                    <option value="m11">November</option>
                    <option value="m12">Dezember</option>
                  </select>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {loading ? (
          <div className="text-center py-12">
            <div className="text-gray-500 dark:text-gray-400">Berichte werden geladen...</div>
          </div>
        ) : (
          <>
            {/* Sales Report */}
            {activeTab === "sales" && salesReport && (
              <div className="space-y-6">
                {/* Summary Cards */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <Card>
                    <CardContent className="pt-6">
                      <div className="text-3xl font-bold text-blue-600 dark:text-blue-400">
                        {formatCurrency(salesReport.totalSales)}
                      </div>
                      <div className="text-gray-500 dark:text-gray-400 mt-1">Gesamtumsatz</div>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardContent className="pt-6">
                      <div className="text-3xl font-bold text-green-600 dark:text-green-400">
                        {formatCurrency(salesReport.totalVat)}
                      </div>
                      <div className="text-gray-500 dark:text-gray-400 mt-1">Gesamt MwSt.</div>
                    </CardContent>
                  </Card>
                </div>

                {/* By Month Table */}
                <Card>
                  <CardHeader>
                    <div className="flex justify-between items-center">
                      <CardTitle>Umsatz nach Monat</CardTitle>
                      <Button size="sm" variant="outline" onClick={getSalesByMonthCSV}>
                        CSV Export
                      </Button>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[640px]">
                        <thead className="bg-gray-50 dark:bg-gray-900 border-b">
                          <tr>
                            <th className="px-4 py-3 text-left text-sm font-medium text-gray-600 dark:text-gray-300">Monat</th>
                            <th className="px-4 py-3 text-right text-sm font-medium text-gray-600 dark:text-gray-300">Anzahl Rechnungen</th>
                            <th className="px-4 py-3 text-right text-sm font-medium text-gray-600 dark:text-gray-300">Gesamtbetrag</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y">
                          {(salesReport.byMonth || []).map((month) => (
                            <tr key={month.month} className="hover:bg-gray-50 dark:bg-gray-900">
                              <td className="px-4 py-3">{formatMonth(month.month)}</td>
                              <td className="px-4 py-3 text-right">{month.invoiceCount}</td>
                              <td className="px-4 py-3 text-right">{formatCurrency(month.totalAmount)}</td>
                            </tr>
                          ))}
                          {(salesReport.byMonth || []).length === 0 && (
                            <tr>
                              <td colSpan={3} className="px-4 py-8 text-center text-gray-500 dark:text-gray-400">
                                Keine Daten für diesen Zeitraum
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </CardContent>
                </Card>

                {/* By Customer Table */}
                <Card>
                  <CardHeader>
                    <div className="flex justify-between items-center">
                      <CardTitle>Umsatz nach Kunde</CardTitle>
                      <Button size="sm" variant="outline" onClick={getSalesByCustomerCSV}>
                        CSV Export
                      </Button>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[640px]">
                        <thead className="bg-gray-50 dark:bg-gray-900 border-b">
                          <tr>
                            <th className="px-4 py-3 text-left text-sm font-medium text-gray-600 dark:text-gray-300">Kunde</th>
                            <th className="px-4 py-3 text-right text-sm font-medium text-gray-600 dark:text-gray-300">Anzahl Rechnungen</th>
                            <th className="px-4 py-3 text-right text-sm font-medium text-gray-600 dark:text-gray-300">Gesamtbetrag</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y">
                          {(salesReport.byCustomer || []).map((customer) => (
                            <tr key={customer.customerId} className="hover:bg-gray-50 dark:bg-gray-900">
                              <td className="px-4 py-3">{customer.customerName}</td>
                              <td className="px-4 py-3 text-right">{customer.invoiceCount}</td>
                              <td className="px-4 py-3 text-right">{formatCurrency(customer.totalAmount)}</td>
                            </tr>
                          ))}
                          {(salesReport.byCustomer || []).length === 0 && (
                            <tr>
                              <td colSpan={3} className="px-4 py-8 text-center text-gray-500 dark:text-gray-400">
                                Keine Daten für diesen Zeitraum
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </CardContent>
                </Card>

                {/* Year over Year */}
                {(salesReport.yearOverYear || []).length > 1 && (
                  <Card>
                    <CardHeader>
                      <CardTitle>Jahresvergleich</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="overflow-x-auto">
                        <table className="w-full min-w-[640px]">
                          <thead className="bg-gray-50 dark:bg-gray-900 border-b">
                            <tr>
                              <th className="px-4 py-3 text-left text-sm font-medium text-gray-600 dark:text-gray-300">Jahr</th>
                              <th className="px-4 py-3 text-right text-sm font-medium text-gray-600 dark:text-gray-300">Gesamtbetrag</th>
                              <th className="px-4 py-3 text-right text-sm font-medium text-gray-600 dark:text-gray-300">Wachstum</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y">
                            {(salesReport.yearOverYear || []).map((year) => (
                              <tr key={year.year} className="hover:bg-gray-50 dark:bg-gray-900">
                                <td className="px-4 py-3">{year.year}</td>
                                <td className="px-4 py-3 text-right">{formatCurrency(year.totalAmount)}</td>
                                <td className="px-4 py-3 text-right">
                                  {year.growthPercent !== null ? (
                                    <span className={year.growthPercent >= 0 ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}>
                                      {year.growthPercent >= 0 ? "+" : ""}{year.growthPercent.toFixed(1)}%
                                    </span>
                                  ) : (
                                    <span className="text-gray-400">-</span>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </CardContent>
                  </Card>
                )}
              </div>
            )}

            {/* VAT Report */}
            {activeTab === "vat" && vatReport && (
              <div className="space-y-6">
                {/* Summary Cards */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                  <Card>
                    <CardContent className="pt-6">
                      <div className="text-3xl font-bold text-blue-600 dark:text-blue-400">
                        {formatCurrency(vatReport.totalNet)}
                      </div>
                      <div className="text-gray-500 dark:text-gray-400 mt-1">Netto gesamt</div>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardContent className="pt-6">
                      <div className="text-3xl font-bold text-green-600 dark:text-green-400">
                        {formatCurrency(vatReport.totalVat)}
                      </div>
                      <div className="text-gray-500 dark:text-gray-400 mt-1">MwSt. gesamt</div>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardContent className="pt-6">
                      <div className="text-3xl font-bold text-purple-600 dark:text-purple-400">
                        {formatCurrency(vatReport.totalGross)}
                      </div>
                      <div className="text-gray-500 dark:text-gray-400 mt-1">Brutto gesamt</div>
                    </CardContent>
                  </Card>
                </div>

                {/* By Rate Table */}
                <Card>
                  <CardHeader>
                    <div className="flex justify-between items-center">
                      <CardTitle>Nach MwSt-Satz</CardTitle>
                      <Button size="sm" variant="outline" onClick={getVatCSV}>
                        CSV Export
                      </Button>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[640px]">
                        <thead className="bg-gray-50 dark:bg-gray-900 border-b">
                          <tr>
                            <th className="px-4 py-3 text-left text-sm font-medium text-gray-600 dark:text-gray-300">MwSt-Satz</th>
                            <th className="px-4 py-3 text-right text-sm font-medium text-gray-600 dark:text-gray-300">Netto</th>
                            <th className="px-4 py-3 text-right text-sm font-medium text-gray-600 dark:text-gray-300">MwSt.</th>
                            <th className="px-4 py-3 text-right text-sm font-medium text-gray-600 dark:text-gray-300">Brutto</th>
                            <th className="px-4 py-3 text-right text-sm font-medium text-gray-600 dark:text-gray-300">Anzahl</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y">
                          {vatReport.byRate.map((rate) => (
                            <tr key={rate.vatRate} className="hover:bg-gray-50 dark:bg-gray-900">
                              <td className="px-4 py-3">{(rate.vatRate * 100).toFixed(1)}%</td>
                              <td className="px-4 py-3 text-right">{formatCurrency(rate.netAmount)}</td>
                              <td className="px-4 py-3 text-right">{formatCurrency(rate.vatAmount)}</td>
                              <td className="px-4 py-3 text-right">{formatCurrency(rate.grossAmount)}</td>
                              <td className="px-4 py-3 text-right">{rate.invoiceCount}</td>
                            </tr>
                          ))}
                          {vatReport.byRate.length === 0 && (
                            <tr>
                              <td colSpan={5} className="px-4 py-8 text-center text-gray-500 dark:text-gray-400">
                                Keine Daten für diesen Zeitraum
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </CardContent>
                </Card>
              </div>
            )}

            {/* Customer Report */}
            {activeTab === "customers" && customerReport && (
              <div className="space-y-6">
                {/* Summary Cards */}
                <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
                  <Card>
                    <CardContent className="pt-6">
                      <div className="text-3xl font-bold text-blue-600 dark:text-blue-400">
                        {customerReport.summary.totalCustomers}
                      </div>
                      <div className="text-gray-500 dark:text-gray-400 mt-1">Kunden gesamt</div>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardContent className="pt-6">
                      <div className="text-3xl font-bold text-green-600 dark:text-green-400">
                        {formatCurrency(customerReport.summary.totalAmount)}
                      </div>
                      <div className="text-gray-500 dark:text-gray-400 mt-1">Umsatz gesamt</div>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardContent className="pt-6">
                      <div className="text-3xl font-bold text-yellow-600 dark:text-yellow-400">
                        {formatCurrency(customerReport.summary.totalPending)}
                      </div>
                      <div className="text-gray-500 dark:text-gray-400 mt-1">Ausstehend</div>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardContent className="pt-6">
                      <div className="text-3xl font-bold text-red-600 dark:text-red-400">
                        {formatCurrency(customerReport.summary.totalOverdue)}
                      </div>
                      <div className="text-gray-500 dark:text-gray-400 mt-1">Überfällig</div>
                    </CardContent>
                  </Card>
                </div>

                {/* Customer Table */}
                <Card>
                  <CardHeader>
                    <div className="flex justify-between items-center">
                      <CardTitle>Kundenübersicht</CardTitle>
                      <Button size="sm" variant="outline" onClick={getCustomersCSV}>
                        CSV Export
                      </Button>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[640px]">
                        <thead className="bg-gray-50 dark:bg-gray-900 border-b">
                          <tr>
                            <th className="px-4 py-3 text-left text-sm font-medium text-gray-600 dark:text-gray-300">Kunde</th>
                            <th className="px-4 py-3 text-right text-sm font-medium text-gray-600 dark:text-gray-300">Rechnungen</th>
                            <th className="px-4 py-3 text-right text-sm font-medium text-gray-600 dark:text-gray-300">Gesamt</th>
                            <th className="px-4 py-3 text-right text-sm font-medium text-gray-600 dark:text-gray-300">Bezahlt</th>
                            <th className="px-4 py-3 text-right text-sm font-medium text-gray-600 dark:text-gray-300">Ausstehend</th>
                            <th className="px-4 py-3 text-right text-sm font-medium text-gray-600 dark:text-gray-300">Überfällig</th>
                            <th className="px-4 py-3 text-left text-sm font-medium text-gray-600 dark:text-gray-300">Letzte Rechnung</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y">
                          {customerReport.customers.map((customer) => (
                            <tr key={customer.customerId} className="hover:bg-gray-50 dark:bg-gray-900">
                              <td className="px-4 py-3">{customer.customerName}</td>
                              <td className="px-4 py-3 text-right">{customer.totalInvoices}</td>
                              <td className="px-4 py-3 text-right">{formatCurrency(customer.totalAmount)}</td>
                              <td className="px-4 py-3 text-right text-green-600 dark:text-green-400">{formatCurrency(customer.paidAmount)}</td>
                              <td className="px-4 py-3 text-right text-yellow-600 dark:text-yellow-400">{formatCurrency(customer.pendingAmount)}</td>
                              <td className="px-4 py-3 text-right text-red-600 dark:text-red-400">{formatCurrency(customer.overdueAmount)}</td>
                              <td className="px-4 py-3">
                                {customer.lastInvoiceDate ? formatDate(customer.lastInvoiceDate) : "-"}
                              </td>
                            </tr>
                          ))}
                          {customerReport.customers.length === 0 && (
                            <tr>
                              <td colSpan={7} className="px-4 py-8 text-center text-gray-500 dark:text-gray-400">
                                Keine Daten für diesen Zeitraum
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </CardContent>
                </Card>
              </div>
            )}

            {/* DATEV-Export — Tier 69: preview before download */}
            {activeTab === "datev" && (
              <DatevExportTab
                startDate={startDate}
                endDate={endDate}
              />
            )}

            {/* Tier 75: P&L (Gewinn- und Verlustrechnung) */}
            {activeTab === "pnl" && <PnlTab />}

            {/* Tier 78: EU OSS (One-Stop-Shop) */}
            {activeTab === "oss" && <OssTab />}

            {/* Tier 86: BWA (Betriebswirtschaftliche Auswertung) */}
            {activeTab === "bwa" && <BwaTab />}
          </>
        )}
      </div>
    </main>
  )
}
/**
 * Tier 69: DATEV-Export Preview tab.
 *
 * Before the Berater hands a CSV to the
 * Steuerberater, they want to see "what's in
 * the box". This tab:
 *
 *   1. Shows a date-range picker (the parent
 *      component owns the state).
 *   2. Renders a "Vorschau" button that hits
 *      /reports/datev-preview.
 *   3. Shows the preview: header, totals,
 *      per-Konto summary, first 5 rows, and
 *      any validation issues (Soll/Haben not
 *      balanced, missing USt-Schlüssel on
 *      revenue lines, etc.).
 *   4. Provides two download buttons (CSV
 *      only, CSV + Belegbilder ZIP) that
 *      share the same startDate/endDate
 *      as the preview — the user can't
 *      accidentally download a different
 *      period than they just previewed.
 *
 * Why not show the preview by default: the
 * preview hits the same DB query as the
 * download (buildBuchungenFromDb walks every
 * paid invoice + voucher + expense in the
 * period). For a 12-month period with 5k
 * Buchungen, that query takes ~600ms. The
 * user clicks "Vorschau" only when they
 * actually want to look at it.
 */
function DatevExportTab({
  startDate,
  endDate,
}: {
  startDate: string
  endDate: string
}) {
  const { t } = useI18n()
  const [preview, setPreview] = useState<any | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const companyId =
    typeof window !== "undefined" ? localStorage.getItem("companyId") : null

  const loadPreview = async () => {
    if (!companyId) return
    setLoading(true)
    setError(null)
    try {
      const data = await apiGet<any>(
        `/api/v1/reports/datev-preview?companyId=${companyId}&startDate=${startDate}&endDate=${endDate}`,
      )
      setPreview(data)
    } catch (e: any) {
      setError(e?.message || t("common.loadError") || "Fehler")
    } finally {
      setLoading(false)
    }
  }

  /**
   * Tier 167: Download the DATEV Buchungsliste —
   * the per-Sachkonto summary that the Berater
   * pastes into their own Kontenplan-Werkzeug
   * for manual review. The download is a ZIP
   * containing 4 CSVs (Buchungsliste /
   * Buchungsstapel / USt-Verprobung /
   * Kontenplan) + a manifest.json with
   * per-file sha256.
   *
   * We read the year from the datev startDate
   * input (yyyy-mm-dd → first 4 chars) so the
   * button uses the same year as the rest of
   * the DATEV tab.
   */
  const exportBuchungsliste = async () => {
    if (!companyId) return
    const btn = document.getElementById(
      "datev-download-buchungsliste-btn",
    ) as HTMLButtonElement | null
    const originalLabel = btn?.textContent || ""
    if (btn) {
      btn.disabled = true
      btn.textContent = "Wird vorbereitet…"
    }
    try {
      const year =
        startDate && startDate.length >= 4
          ? parseInt(startDate.slice(0, 4), 10)
          : new Date().getFullYear()
      const res = await apiFetch(
        `/api/v1/reports/datev-buchungsliste?companyId=${companyId}&year=${year}`,
        { method: "GET" },
      )
      if (!res.ok) {
        alert(`Buchungsliste: HTTP ${res.status}`)
        return
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      // Filename from Content-Disposition
      // header — fallback to a sensible name
      // if the header is missing.
      const cd = res.headers.get("content-disposition") || ""
      const m = cd.match(/filename="([^"]+)"/)
      a.download = m?.[1] || `DATEV-Buchungsliste-${year}.zip`
      a.href = url
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch (e: any) {
      console.error("DATEV Buchungsliste export failed:", e)
      alert(e?.message || "Buchungsliste-Export fehlgeschlagen")
    } finally {
      if (btn) {
        btn.disabled = false
        btn.textContent = originalLabel
      }
    }
  }

  const fmtMoney = (n: number) =>
    n.toLocaleString("de-DE", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })

  return (
    <div className="space-y-6" data-testid="datev-tab">
      <Card>
        <CardHeader>
          <CardTitle>DATEV-Buchungsstapel-Export</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">
            Zeitraum: {startDate} – {endDate}
          </p>
          <div className="flex flex-wrap gap-3">
            <Button
              onClick={loadPreview}
              disabled={loading}
              data-testid="datev-preview-btn"
            >
              🔍 {loading ? "Wird geladen…" : "Vorschau anzeigen"}
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                if (!companyId) return
                window.open(
                  `/api/v1/reports/datev-export?companyId=${companyId}&startDate=${startDate}&endDate=${endDate}`,
                  "_blank",
                )
              }}
              data-testid="datev-download-csv-btn"
            >
              📥 CSV herunterladen
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                if (!companyId) return
                window.open(
                  `/api/v1/reports/datev-export-bundle?companyId=${companyId}&startDate=${startDate}&endDate=${endDate}`,
                  "_blank",
                )
              }}
              data-testid="datev-download-bundle-btn"
            >
              📦 CSV + Belegbilder (ZIP)
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                if (!companyId) return
                // Tier 142: monthly split. The Berater
                // gets one ZIP with one CSV per month
                // (2026-07/, 2026-08/, ...) + a per-month
                // Belegbilder subfolder so each month can
                // be imported as its own Buchungslauf.
                // Sequential laufNr (L001, L002, ...) keeps
                // the DATEV import order deterministic.
                window.open(
                  `/api/v1/reports/datev-export-monthly?companyId=${companyId}&startDate=${startDate}&endDate=${endDate}`,
                  "_blank",
                )
              }}
              data-testid="datev-download-monthly-btn"
              title="Erzeugt einen ZIP-Ordner mit einer CSV pro Monat + Belegbilder pro Monat — für Buchungslauf pro Monat in DATEV."
            >
              📅 Per Monat aufteilen (ZIP)
            </Button>
            {/* Tier 167: DATEV Buchungsliste — per-
                Sachkonto summary + USt-Verprobung.
                For the Berater who wants a
                human-readable "one row per account"
                view (the standard Excel template
                they paste into DATEV after manual
                review). The Berater's Kontenplan
                is the single-source-of-truth for
                Sachkonto assignments; the
                Buchungsliste tells them "what was
                actually booked against each
                account this year". The two views
                are reconciled line by line at
                Jahresabschluss. */}
            <Button
              variant="outline"
              onClick={exportBuchungsliste}
              data-testid="datev-download-buchungsliste-btn"
              title="Erzeugt eine Buchungsliste (eine Zeile pro Sachkonto), den DATEV-Buchungsstapel, eine USt-Verprobung pro USt-Schlüssel und den SKR03-Kontenplan-Auszug — alles in einem ZIP."
            >
              📊 Buchungsliste (ZIP)
            </Button>
          </div>
        </CardContent>
      </Card>

      {error && (
        <div
          className="p-3 rounded bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-300 text-sm"
          data-testid="datev-error"
        >
          {error}
        </div>
      )}

      {preview && (
        <>
          {/* Header summary */}
          <Card data-testid="datev-header-card">
            <CardHeader>
              <CardTitle className="text-lg">Kopfdatenzusammenfassung</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
                <div>
                  <div className="text-gray-500">Berater-Nr.</div>
                  <div className="font-mono" data-testid="datev-beraterNr">
                    {preview.header.beraterNr}
                  </div>
                </div>
                <div>
                  <div className="text-gray-500">Mandanten-Nr.</div>
                  <div className="font-mono" data-testid="datev-mandantenNr">
                    {preview.header.mandantenNr}
                  </div>
                </div>
                <div>
                  <div className="text-gray-500">Buchungslauf-Nr.</div>
                  <div className="font-mono">{preview.header.buchungsLaufNr}</div>
                </div>
                <div>
                  <div className="text-gray-500">Zeitraum</div>
                  <div>
                    {preview.header.startDate} – {preview.header.endDate}
                  </div>
                </div>
                <div className="md:col-span-2">
                  <div className="text-gray-500">Dateiname</div>
                  <div className="font-mono text-xs break-all">
                    {preview.header.filename}
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Totals + balance */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Summen</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div>
                  <div className="text-gray-500 text-xs">Buchungen</div>
                  <div
                    className="text-2xl font-bold"
                    data-testid="datev-rowCount"
                  >
                    {preview.rowCount.toLocaleString("de-DE")}
                  </div>
                </div>
                <div>
                  <div className="text-gray-500 text-xs">Gesamtbetrag</div>
                  <div className="text-2xl font-bold">
                    {fmtMoney(preview.totalAmount)} €
                  </div>
                </div>
                <div>
                  <div className="text-gray-500 text-xs">Soll</div>
                  <div className="text-xl font-mono">
                    {fmtMoney(preview.totalSoll)} €
                  </div>
                </div>
                <div>
                  <div className="text-gray-500 text-xs">Haben</div>
                  <div className="text-xl font-mono">
                    {fmtMoney(preview.totalHaben)} €
                  </div>
                </div>
              </div>
              <div
                className={`mt-3 text-sm ${
                  Math.abs(preview.balanceDelta) < 0.01
                    ? "text-emerald-600 dark:text-emerald-400"
                    : "text-red-600 dark:text-red-400"
                }`}
                data-testid="datev-balance"
              >
                {Math.abs(preview.balanceDelta) < 0.01
                  ? "✓ Soll/Haben ausgeglichen"
                  : `✗ Differenz: ${fmtMoney(preview.balanceDelta)} €`}
              </div>
            </CardContent>
          </Card>

          {/* Validation issues */}
          {preview.issues && preview.issues.length > 0 && (
            <Card data-testid="datev-issues-card">
              <CardHeader>
                <CardTitle className="text-lg">
                  Hinweise ({preview.issues.length})
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="space-y-1 text-sm">
                  {preview.issues.map(
                    (issue: { severity: string; message: string }, i: number) => (
                      <li
                        key={i}
                        className={`flex items-start gap-2 ${
                          issue.severity === "error"
                            ? "text-red-700 dark:text-red-400"
                            : "text-amber-700 dark:text-amber-400"
                        }`}
                        data-testid="datev-issue"
                      >
                        <span>
                          {issue.severity === "error" ? "✗" : "⚠"}
                        </span>
                        <span>{issue.message}</span>
                      </li>
                    ),
                  )}
                </ul>
              </CardContent>
            </Card>
          )}

          {/* Per-account summary */}
          {preview.byAccount && preview.byAccount.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Kontenübersicht</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm" data-testid="datev-byAccount">
                    <thead>
                      <tr className="text-left border-b border-gray-200 dark:border-gray-700">
                        <th className="py-2 px-2">Konto</th>
                        <th className="py-2 px-2 text-right">Soll (€)</th>
                        <th className="py-2 px-2 text-right">Haben (€)</th>
                        <th className="py-2 px-2 text-right">Buchungen</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.byAccount.map(
                        (a: { konto: string; soll: number; haben: number; count: number }) => (
                          <tr
                            key={a.konto}
                            className="border-b border-gray-100 dark:border-gray-700"
                          >
                            <td className="py-2 px-2 font-mono">{a.konto}</td>
                            <td className="py-2 px-2 text-right font-mono">
                              {fmtMoney(a.soll)}
                            </td>
                            <td className="py-2 px-2 text-right font-mono">
                              {fmtMoney(a.haben)}
                            </td>
                            <td className="py-2 px-2 text-right">
                              {a.count}
                            </td>
                          </tr>
                        ),
                      )}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          )}

          {/* First 5 rows preview */}
          {preview.firstRows && preview.firstRows.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">
                  Erste {preview.firstRows.length} Buchungen (Vorschau)
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs" data-testid="datev-firstRows">
                    <thead>
                      <tr className="text-left border-b border-gray-200 dark:border-gray-700">
                        <th className="py-2 px-2">Datum</th>
                        <th className="py-2 px-2">Belegfeld 1</th>
                        <th className="py-2 px-2">Soll-Kto</th>
                        <th className="py-2 px-2">Haben-Kto</th>
                        <th className="py-2 px-2 text-right">Betrag</th>
                        <th className="py-2 px-2">S/H</th>
                        <th className="py-2 px-2">Text</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.firstRows.map(
                        (
                          r: {
                            belegdatum: string
                            belegfeld1: string
                            konto: string
                            gegenkonto: string
                            betrag: number
                            shVz: string
                            buchungstext: string
                          },
                          i: number,
                        ) => (
                          <tr
                            key={i}
                            className="border-b border-gray-100 dark:border-gray-700"
                          >
                            <td className="py-2 px-2 font-mono">{r.belegdatum}</td>
                            <td className="py-2 px-2 font-mono">{r.belegfeld1}</td>
                            <td className="py-2 px-2 font-mono">{r.konto}</td>
                            <td className="py-2 px-2 font-mono">{r.gegenkonto}</td>
                            <td className="py-2 px-2 text-right font-mono">
                              {fmtMoney(r.betrag)}
                            </td>
                            <td className="py-2 px-2 font-mono">{r.shVz}</td>
                            <td className="py-2 px-2 truncate max-w-xs">
                              {r.buchungstext}
                            </td>
                          </tr>
                        ),
                      )}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  )
}
