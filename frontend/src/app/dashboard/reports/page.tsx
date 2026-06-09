"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import LanguageSwitcher from "@/components/LanguageSwitcher"
import { apiFetch } from "@/lib/api"

type TabType = "sales" | "vat" | "customers"

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
    <main className="min-h-screen bg-gray-50">
      <header className="bg-white border-b shadow-sm">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <h1 className="text-2xl font-bold text-blue-600">Berichtscenter</h1>
          <div className="flex gap-2 items-center">
            <Button variant="outline" onClick={() => router.push("/dashboard/reports/aging")}>
              Altersstruktur
            </Button>
            <Button variant="outline" onClick={exportDatev}>
              DATEV Export
            </Button>
            <LanguageSwitcher />
            <Button variant="outline" onClick={() => router.push("/dashboard")}>
              Zurück
            </Button>
          </div>
        </div>
      </header>

      <div className="container mx-auto px-4 py-8">
        {/* Tab Navigation */}
        <div className="flex border-b mb-6">
          <button
            className={`px-6 py-3 font-medium border-b-2 transition-colors ${
              activeTab === "sales"
                ? "border-blue-600 text-blue-600"
                : "border-transparent text-gray-500 hover:text-gray-700"
            }`}
            onClick={() => setActiveTab("sales")}
          >
            Umsatzbericht
          </button>
          <button
            className={`px-6 py-3 font-medium border-b-2 transition-colors ${
              activeTab === "vat"
                ? "border-blue-600 text-blue-600"
                : "border-transparent text-gray-500 hover:text-gray-700"
            }`}
            onClick={() => setActiveTab("vat")}
          >
            MwSt-Bericht
          </button>
          <button
            className={`px-6 py-3 font-medium border-b-2 transition-colors ${
              activeTab === "customers"
                ? "border-blue-600 text-blue-600"
                : "border-transparent text-gray-500 hover:text-gray-700"
            }`}
            onClick={() => setActiveTab("customers")}
          >
            Kundenbericht
          </button>
        </div>

        {/* Date Range Selection */}
        {activeTab !== "vat" && (
          <Card className="mb-6">
            <CardContent className="pt-6">
              <div className="flex flex-wrap gap-4 items-end">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Von Datum
                  </label>
                  <input
                    type="date"
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                    className="px-3 py-2 border border-gray-300 rounded-md"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Bis Datum
                  </label>
                  <input
                    type="date"
                    value={endDate}
                    onChange={(e) => setEndDate(e.target.value)}
                    className="px-3 py-2 border border-gray-300 rounded-md"
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
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Jahr
                  </label>
                  <input
                    type="number"
                    value={vatYear}
                    onChange={(e) => setVatYear(e.target.value)}
                    min="2020"
                    max="2030"
                    className="px-3 py-2 border border-gray-300 rounded-md w-32"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Zeitraum
                  </label>
                  <select
                    value={vatPeriod}
                    onChange={(e) => setVatPeriod(e.target.value as any)}
                    className="px-3 py-2 border border-gray-300 rounded-md"
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
            <div className="text-gray-500">Berichte werden geladen...</div>
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
                      <div className="text-3xl font-bold text-blue-600">
                        {formatCurrency(salesReport.totalSales)}
                      </div>
                      <div className="text-gray-500 mt-1">Gesamtumsatz</div>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardContent className="pt-6">
                      <div className="text-3xl font-bold text-green-600">
                        {formatCurrency(salesReport.totalVat)}
                      </div>
                      <div className="text-gray-500 mt-1">Gesamt MwSt.</div>
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
                      <table className="w-full">
                        <thead className="bg-gray-50 border-b">
                          <tr>
                            <th className="px-4 py-3 text-left text-sm font-medium text-gray-600">Monat</th>
                            <th className="px-4 py-3 text-right text-sm font-medium text-gray-600">Anzahl Rechnungen</th>
                            <th className="px-4 py-3 text-right text-sm font-medium text-gray-600">Gesamtbetrag</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y">
                          {(salesReport.byMonth || []).map((month) => (
                            <tr key={month.month} className="hover:bg-gray-50">
                              <td className="px-4 py-3">{formatMonth(month.month)}</td>
                              <td className="px-4 py-3 text-right">{month.invoiceCount}</td>
                              <td className="px-4 py-3 text-right">{formatCurrency(month.totalAmount)}</td>
                            </tr>
                          ))}
                          {(salesReport.byMonth || []).length === 0 && (
                            <tr>
                              <td colSpan={3} className="px-4 py-8 text-center text-gray-500">
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
                      <table className="w-full">
                        <thead className="bg-gray-50 border-b">
                          <tr>
                            <th className="px-4 py-3 text-left text-sm font-medium text-gray-600">Kunde</th>
                            <th className="px-4 py-3 text-right text-sm font-medium text-gray-600">Anzahl Rechnungen</th>
                            <th className="px-4 py-3 text-right text-sm font-medium text-gray-600">Gesamtbetrag</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y">
                          {(salesReport.byCustomer || []).map((customer) => (
                            <tr key={customer.customerId} className="hover:bg-gray-50">
                              <td className="px-4 py-3">{customer.customerName}</td>
                              <td className="px-4 py-3 text-right">{customer.invoiceCount}</td>
                              <td className="px-4 py-3 text-right">{formatCurrency(customer.totalAmount)}</td>
                            </tr>
                          ))}
                          {(salesReport.byCustomer || []).length === 0 && (
                            <tr>
                              <td colSpan={3} className="px-4 py-8 text-center text-gray-500">
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
                        <table className="w-full">
                          <thead className="bg-gray-50 border-b">
                            <tr>
                              <th className="px-4 py-3 text-left text-sm font-medium text-gray-600">Jahr</th>
                              <th className="px-4 py-3 text-right text-sm font-medium text-gray-600">Gesamtbetrag</th>
                              <th className="px-4 py-3 text-right text-sm font-medium text-gray-600">Wachstum</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y">
                            {(salesReport.yearOverYear || []).map((year) => (
                              <tr key={year.year} className="hover:bg-gray-50">
                                <td className="px-4 py-3">{year.year}</td>
                                <td className="px-4 py-3 text-right">{formatCurrency(year.totalAmount)}</td>
                                <td className="px-4 py-3 text-right">
                                  {year.growthPercent !== null ? (
                                    <span className={year.growthPercent >= 0 ? "text-green-600" : "text-red-600"}>
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
                      <div className="text-3xl font-bold text-blue-600">
                        {formatCurrency(vatReport.totalNet)}
                      </div>
                      <div className="text-gray-500 mt-1">Netto gesamt</div>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardContent className="pt-6">
                      <div className="text-3xl font-bold text-green-600">
                        {formatCurrency(vatReport.totalVat)}
                      </div>
                      <div className="text-gray-500 mt-1">MwSt. gesamt</div>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardContent className="pt-6">
                      <div className="text-3xl font-bold text-purple-600">
                        {formatCurrency(vatReport.totalGross)}
                      </div>
                      <div className="text-gray-500 mt-1">Brutto gesamt</div>
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
                      <table className="w-full">
                        <thead className="bg-gray-50 border-b">
                          <tr>
                            <th className="px-4 py-3 text-left text-sm font-medium text-gray-600">MwSt-Satz</th>
                            <th className="px-4 py-3 text-right text-sm font-medium text-gray-600">Netto</th>
                            <th className="px-4 py-3 text-right text-sm font-medium text-gray-600">MwSt.</th>
                            <th className="px-4 py-3 text-right text-sm font-medium text-gray-600">Brutto</th>
                            <th className="px-4 py-3 text-right text-sm font-medium text-gray-600">Anzahl</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y">
                          {vatReport.byRate.map((rate) => (
                            <tr key={rate.vatRate} className="hover:bg-gray-50">
                              <td className="px-4 py-3">{(rate.vatRate * 100).toFixed(1)}%</td>
                              <td className="px-4 py-3 text-right">{formatCurrency(rate.netAmount)}</td>
                              <td className="px-4 py-3 text-right">{formatCurrency(rate.vatAmount)}</td>
                              <td className="px-4 py-3 text-right">{formatCurrency(rate.grossAmount)}</td>
                              <td className="px-4 py-3 text-right">{rate.invoiceCount}</td>
                            </tr>
                          ))}
                          {vatReport.byRate.length === 0 && (
                            <tr>
                              <td colSpan={5} className="px-4 py-8 text-center text-gray-500">
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
                      <div className="text-3xl font-bold text-blue-600">
                        {customerReport.summary.totalCustomers}
                      </div>
                      <div className="text-gray-500 mt-1">Kunden gesamt</div>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardContent className="pt-6">
                      <div className="text-3xl font-bold text-green-600">
                        {formatCurrency(customerReport.summary.totalAmount)}
                      </div>
                      <div className="text-gray-500 mt-1">Umsatz gesamt</div>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardContent className="pt-6">
                      <div className="text-3xl font-bold text-yellow-600">
                        {formatCurrency(customerReport.summary.totalPending)}
                      </div>
                      <div className="text-gray-500 mt-1">Ausstehend</div>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardContent className="pt-6">
                      <div className="text-3xl font-bold text-red-600">
                        {formatCurrency(customerReport.summary.totalOverdue)}
                      </div>
                      <div className="text-gray-500 mt-1">Überfällig</div>
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
                      <table className="w-full">
                        <thead className="bg-gray-50 border-b">
                          <tr>
                            <th className="px-4 py-3 text-left text-sm font-medium text-gray-600">Kunde</th>
                            <th className="px-4 py-3 text-right text-sm font-medium text-gray-600">Rechnungen</th>
                            <th className="px-4 py-3 text-right text-sm font-medium text-gray-600">Gesamt</th>
                            <th className="px-4 py-3 text-right text-sm font-medium text-gray-600">Bezahlt</th>
                            <th className="px-4 py-3 text-right text-sm font-medium text-gray-600">Ausstehend</th>
                            <th className="px-4 py-3 text-right text-sm font-medium text-gray-600">Überfällig</th>
                            <th className="px-4 py-3 text-left text-sm font-medium text-gray-600">Letzte Rechnung</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y">
                          {customerReport.customers.map((customer) => (
                            <tr key={customer.customerId} className="hover:bg-gray-50">
                              <td className="px-4 py-3">{customer.customerName}</td>
                              <td className="px-4 py-3 text-right">{customer.totalInvoices}</td>
                              <td className="px-4 py-3 text-right">{formatCurrency(customer.totalAmount)}</td>
                              <td className="px-4 py-3 text-right text-green-600">{formatCurrency(customer.paidAmount)}</td>
                              <td className="px-4 py-3 text-right text-yellow-600">{formatCurrency(customer.pendingAmount)}</td>
                              <td className="px-4 py-3 text-right text-red-600">{formatCurrency(customer.overdueAmount)}</td>
                              <td className="px-4 py-3">
                                {customer.lastInvoiceDate ? formatDate(customer.lastInvoiceDate) : "-"}
                              </td>
                            </tr>
                          ))}
                          {customerReport.customers.length === 0 && (
                            <tr>
                              <td colSpan={7} className="px-4 py-8 text-center text-gray-500">
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
          </>
        )}
      </div>
    </main>
  )
}