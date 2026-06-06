"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { useI18n } from "@/components/useI18n"
import { apiGet, apiPost, ApiError } from "@/lib/api"

type InvoiceType = 'INV' | 'CN' | 'PI' | 'RCV'
type InvoiceTemplateType = 'standard' | 'simplified' | 'compact'

interface Customer {
  id: string
  name: string
  vatId?: string
}

interface Product {
  id: string
  name: string
  sku: string
  unit: string
  basePrice: string
  vatRate: string
}

interface Invoice {
  id: string
  invoiceNumber: string
  customer: { name: string }
}

interface InvoiceItem {
  productId?: string
  description: string
  quantity: number
  unit: string
  unitPrice: number
  vatRate: number
}

export default function CreateInvoicePage() {
  const router = useRouter()
  const { t, locale, getDateLocale } = useI18n()
  const [customers, setCustomers] = useState<Customer[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [customerSearch, setCustomerSearch] = useState("")
  const [productSearch, setProductSearch] = useState("")
  const [showCustomerDropdown, setShowCustomerDropdown] = useState(false)
  const [showProductDropdown, setShowProductDropdown] = useState(false)
  const [activeItemIndex, setActiveItemIndex] = useState<number | null>(null)
  const [invoiceType, setInvoiceType] = useState<InvoiceType>('INV')
  const [showInvoiceDropdown, setShowInvoiceDropdown] = useState(false)
  const [invoiceSearch, setInvoiceSearch] = useState("")
  const [templateType, setTemplateType] = useState<InvoiceTemplateType>('standard')
  const [form, setForm] = useState({
    customerId: "",
    referenceInvoiceId: "",
    issueDate: new Date().toISOString().split("T")[0],
    notes: "",
    discountPercent: 0,
    discountAmount: 0,
    paymentMethod: "bank_transfer",
    paymentTerms: 0,
    items: [{ description: "", quantity: 1, unit: t("common2.unit"), unitPrice: 0, vatRate: 0.19 }] as InvoiceItem[],
  })
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    const companyId = localStorage.getItem("companyId")
    if (!companyId) {
      router.push("/login")
      return
    }

    Promise.all([
      apiGet<any>(`/api/v1/customers?companyId=${companyId}&pageSize=200`),
      apiGet<any>(`/api/v1/products?companyId=${companyId}&pageSize=200`),
      apiGet<any>(`/api/v1/invoices?companyId=${companyId}&pageSize=200`),
    ]).then(([c, p, inv]) => {
      setCustomers(Array.isArray(c) ? c : (c.data || []))
      setProducts(Array.isArray(p) ? p : (p.data || []))
      setInvoices(Array.isArray(inv) ? inv : (inv.data || []))
    }).catch((err) => {
      console.error('Invoice create dropdowns fetch failed:', err)
    })
  }, [router])

  const filteredCustomers = customers.filter(c =>
    c.name.toLowerCase().includes(customerSearch.toLowerCase())
  )

  const filteredProducts = products.filter(p =>
    p.name.toLowerCase().includes(productSearch.toLowerCase()) ||
    (p.sku && p.sku.toLowerCase().includes(productSearch.toLowerCase()))
  )

  const filteredInvoices = invoices.filter(inv =>
    inv.invoiceNumber.toLowerCase().includes(invoiceSearch.toLowerCase())
  )

  const selectCustomer = (customer: Customer) => {
    setForm({ ...form, customerId: customer.id })
    setCustomerSearch(customer.name)
    setShowCustomerDropdown(false)
  }

  const selectProduct = (product: Product, index: number) => {
    const items = [...form.items]
    items[index] = {
      productId: product.id,
      description: product.name,
      quantity: 1,
      unit: product.unit,
      unitPrice: parseFloat(product.basePrice),
      vatRate: parseFloat(product.vatRate),
    }
    setForm({ ...form, items })
    setProductSearch("")
    setShowProductDropdown(false)
    setActiveItemIndex(null)
  }

  const selectReferenceInvoice = (invoice: Invoice) => {
    // When picking a reference invoice for a credit note, auto-fill:
    //   1. customerId — from the original invoice's customer
    //      (so the backend stores the right customer for the CN)
    //   2. items — copy items from the original, with negative amounts
    //      so the CN reverses the original totals. User can edit
    //      quantities / add/remove rows before submitting.
    const refCustomerId = invoice.customerId || ""
    const refCustomerName = invoice.customer?.name || ""
    const refItems = (invoice.items || []).map((it) => ({
      description: it.description,
      quantity: Number(it.quantity),
      unit: it.unit,
      unitPrice: Number(it.unitPrice),
      vatRate: Number(it.vatRate),
    }))
    setForm({
      ...form,
      referenceInvoiceId: invoice.id,
      customerId: refCustomerId,
      items: refItems.length > 0
        ? refItems
        : [{ description: "", quantity: 1, unit: t("common2.unit"), unitPrice: 0, vatRate: 0.19 }],
    })
    setInvoiceSearch(invoice.invoiceNumber)
    setCustomerSearch(refCustomerName)
    setShowInvoiceDropdown(false)
  }

  const getInvoiceTypeLabel = (type: InvoiceType) => {
    const labels: Record<InvoiceType, string> = {
      INV: t("invoice.typeInvoice"),
      CN: t("invoice.typeCreditNote"),
      PI: t("invoice.typeProforma"),
      RCV: t("invoice.typeReceipt"),
    }
    return labels[type]
  }

  const getInvoiceTypeColor = (type: InvoiceType) => {
    const colors: Record<InvoiceType, string> = {
      INV: "bg-blue-100 text-blue-700",
      CN: "bg-orange-100 text-orange-700",
      PI: "bg-purple-100 text-purple-700",
      RCV: "bg-green-100 text-green-700",
    }
    return colors[type]
  }

  const addItem = () => {
    setForm({
      ...form,
      items: [...form.items, { description: "", quantity: 1, unit: t("common2.unit"), unitPrice: 0, vatRate: 0.19 }],
    })
  }

  const calculateSubtotal = () => {
    return form.items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0)
  }

  const calculateDiscount = () => {
    if (form.discountPercent > 0) {
      return calculateSubtotal() * (form.discountPercent / 100)
    }
    return form.discountAmount
  }

  const calculateVat = () => {
    return form.items.reduce((sum, item) => {
      const itemNet = item.quantity * item.unitPrice
      return sum + itemNet * item.vatRate
    }, 0)
  }

  const calculateTotal = () => {
    return calculateSubtotal() - calculateDiscount() + calculateVat()
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    // Validation — credit notes (CN) need a reference invoice, NOT
    // a directly-picked customer (the customer is copied from the
    // reference). For all other types, customer is required.
    if (invoiceType === 'CN') {
      if (!form.referenceInvoiceId) {
        alert(t("common2.referenceInvoice") + " " + t("common.required"))
        return
      }
    } else if (!form.customerId) {
      alert(t("common2.selectCustomer"))
      return
    }

    setLoading(true)

    try {
      const companyId = localStorage.getItem("companyId") || "7de697d5-64a2-4632-9a87-d18b4e2a0214"
      await apiPost(`/api/v1/invoices?companyId=${companyId}`, {
        ...form,
        type: invoiceType,
        templateType,
        language: getDateLocale(),
      })
      router.push("/dashboard/invoices")
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : `Netzwerkfehler: ${err}`
      alert(msg)
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="min-h-screen bg-gray-50">
      <header className="bg-white border-b shadow-sm">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <h1 className="text-2xl font-bold text-blue-600">{t("invoice.create")}</h1>
          <Button variant="outline" onClick={() => router.push("/dashboard/invoices")}>{t("common.cancel")}</Button>
        </div>
      </header>

      <div className="container mx-auto px-4 py-8 max-w-4xl">
        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Basic Info Card */}
          <Card>
            <CardHeader>
              <CardTitle>{t("invoice.basicInfo")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Invoice Type Selector */}
              <div>
                <label className="block text-sm font-medium mb-1">{t("invoice.invoiceType")}</label>
                <div className="flex gap-2">
                  {(['INV', 'CN', 'PI', 'RCV'] as InvoiceType[]).map((type) => (
                    <button
                      key={type}
                      type="button"
                      onClick={() => {
                        // When switching between invoice types, clear
                        // type-specific state (reference invoice for CN,
                        // customer for the rest) so the form starts clean.
                        setInvoiceType(type)
                        setForm((f) => ({
                          ...f,
                          referenceInvoiceId: "",
                          customerId: "",
                        }))
                        setInvoiceSearch("")
                        setCustomerSearch("")
                      }}
                      className={`px-4 py-2 rounded-lg border text-sm font-medium transition-colors ${
                        invoiceType === type
                          ? 'border-blue-500 bg-blue-50 text-blue-700'
                          : 'border-gray-300 bg-white text-gray-600 hover:bg-gray-50'
                      }`}
                    >
                      <span className={`px-2 py-0.5 rounded text-xs mr-1 ${getInvoiceTypeColor(type)}`}>
                        {type}
                      </span>
                      {getInvoiceTypeLabel(type)}
                    </button>
                  ))}
                </div>
              </div>

              {/* Customer Search */}
              <div className="relative">
                <label className="block text-sm font-medium mb-1">
                  {invoiceType === "CN"
                    ? `${t("invoice.customer")} (${t("common.fromReferenceInvoice") || "aus Referenzrechnung"})`
                    : `${t("invoice.customer")} *`}
                </label>
                <Input
                  value={customerSearch}
                  onChange={(e) => {
                    setCustomerSearch(e.target.value)
                    setShowCustomerDropdown(true)
                    setForm({ ...form, customerId: "" })
                  }}
                  onFocus={() => setShowCustomerDropdown(customerSearch.length > 0 || true)}
                  placeholder={t("invoice.selectCustomer")}
                  required={invoiceType !== 'CN'}
                  readOnly={invoiceType === 'CN' && !!form.customerId}
                />
                {showCustomerDropdown && (
                  <div className="absolute top-full left-0 right-0 mt-1 bg-white border rounded-lg shadow-lg max-h-48 overflow-y-auto z-10">
                    {filteredCustomers.length === 0 ? (
                      <div className="px-3 py-2 text-gray-500 text-sm">{t("common2.noCustomersFound")}</div>
                    ) : (
                      filteredCustomers.map((c) => (
                        <div
                          key={c.id}
                          className="px-3 py-2 hover:bg-blue-50 cursor-pointer"
                          onClick={() => selectCustomer(c)}
                        >
                          <div className="font-medium text-sm">{c.name}</div>
                          {c.vatId && <div className="text-xs text-gray-500">UST-IDNr.: {c.vatId}</div>}
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>

              {/* Reference Invoice for Credit Note */}
              {invoiceType === 'CN' && (
                <div className="relative">
                  <label className="block text-sm font-medium mb-1">
                    {t("common2.referenceInvoice")} *
                  </label>
                  <Input
                    value={invoiceSearch}
                    onChange={(e) => {
                      setInvoiceSearch(e.target.value)
                      setShowInvoiceDropdown(e.target.value.length > 0)
                      setForm({ ...form, referenceInvoiceId: "" })
                    }}
                    onFocus={() => setShowInvoiceDropdown(invoiceSearch.length > 0 || true)}
                    placeholder={t("common2.searchInvoiceNumber")}
                  />
                  {showInvoiceDropdown && invoiceSearch && (
                    <div className="absolute top-full left-0 right-0 mt-1 bg-white border rounded-lg shadow-lg max-h-48 overflow-y-auto z-10">
                      {filteredInvoices.length === 0 ? (
                        <div className="px-3 py-2 text-gray-500 text-sm">
                          {t("common2.noInvoicesFound")}
                        </div>
                      ) : (
                        filteredInvoices.map((inv) => (
                          <div
                            key={inv.id}
                            className="px-3 py-2 hover:bg-blue-50 cursor-pointer"
                            onClick={() => selectReferenceInvoice(inv)}
                          >
                            <div className="font-medium text-sm">{inv.invoiceNumber}</div>
                            <div className="text-xs text-gray-500">{inv.customer?.name}</div>
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </div>
              )}

              <div className="grid md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-1">{t("invoice.date")} *</label>
                  <Input
                    type="date"
                    value={form.issueDate}
                    onChange={(e) => setForm({ ...form, issueDate: e.target.value })}
                    required
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">{t("invoice.paymentTerms")}</label>
                  <select
                    className="w-full h-10 border rounded-md px-3"
                    value={form.paymentTerms}
                    onChange={(e) => setForm({ ...form, paymentTerms: Number(e.target.value) })}
                  >
                    <option value={-1}>{t("paymentTerm.immediate")}</option>
                    <option value={0}>{t("paymentTerm.none")}</option>
                    <option value={7}>{t("paymentTerm.days7")}</option>
                    <option value={14}>{t("paymentTerm.days14")}</option>
                    <option value={30}>{t("paymentTerm.days30")}</option>
                    <option value={60}>{t("paymentTerm.days60")}</option>
                  </select>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Template Selection Card */}
          <Card>
            <CardHeader>
              <CardTitle>{t("template.label")}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-3 gap-4">
                <div
                  className={`p-4 border-2 rounded-lg cursor-pointer transition-all ${
                    templateType === "standard"
                      ? "border-blue-500 bg-blue-50"
                      : "border-gray-200 hover:border-blue-300"
                  }`}
                  onClick={() => setTemplateType("standard")}
                >
                  <div className="font-medium text-sm mb-1">
                    {t("template.standard")}
                  </div>
                  <div className="text-xs text-gray-500">
                    {t("template.standardDesc")}
                  </div>
                </div>
                <div
                  className={`p-4 border-2 rounded-lg cursor-pointer transition-all ${
                    templateType === "simplified"
                      ? "border-blue-500 bg-blue-50"
                      : "border-gray-200 hover:border-blue-300"
                  }`}
                  onClick={() => setTemplateType("simplified")}
                >
                  <div className="font-medium text-sm mb-1">
                    {t("template.simplified")}
                  </div>
                  <div className="text-xs text-gray-500">
                    {t("template.simplifiedDesc")}
                  </div>
                </div>
                <div
                  className={`p-4 border-2 rounded-lg cursor-pointer transition-all ${
                    templateType === "compact"
                      ? "border-blue-500 bg-blue-50"
                      : "border-gray-200 hover:border-blue-300"
                  }`}
                  onClick={() => setTemplateType("compact")}
                >
                  <div className="font-medium text-sm mb-1">
                    {t("template.compact")}
                  </div>
                  <div className="text-xs text-gray-500">
                    {t("template.compactDesc")}
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Line Items Card */}
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle>{t("invoice.items")}</CardTitle>
              <Button type="button" variant="outline" size="sm" onClick={addItem}>+ {t("invoice.addItem")}</Button>
            </CardHeader>
            {invoiceType === "CN" && form.referenceInvoiceId && (
              <div className="px-6 pb-2 text-xs text-amber-700 bg-amber-50 border-t border-amber-100 -mt-2 pt-2">
                ℹ️ {t("common2.creditNoteItemsHint")}
              </div>
            )}
            <CardContent className="space-y-4">
              <div className="grid grid-cols-12 gap-2 text-sm font-medium text-gray-600 px-2">
                <div className="col-span-5">{t("invoice.description")}</div>
                <div className="col-span-2">{t("invoice.quantity")}</div>
                <div className="col-span-2">{t("invoice.unitPrice")} (€)</div>
                <div className="col-span-1">{t("invoice.vatRate")}</div>
                <div className="col-span-2">{t("common.actions")}</div>
              </div>
              {form.items.map((item, index) => (
                <div key={index} className="grid grid-cols-12 gap-2 items-end">
                  <div className="col-span-5 relative">
                    <Input
                      value={item.description}
                      onChange={(e) => {
                        const items = [...form.items]
                        items[index].description = e.target.value
                        items[index].productId = undefined
                        setForm({ ...form, items })
                        setProductSearch(e.target.value)
                        setShowProductDropdown(e.target.value.length > 0)
                        setActiveItemIndex(index)
                      }}
                      onFocus={() => {
                        setActiveItemIndex(index)
                        setShowProductDropdown(item.description.length > 0)
                      }}
                      placeholder={t("common2.productSearch")}
                    />
                    {showProductDropdown && activeItemIndex === index && productSearch && (
                      <div className="absolute top-full left-0 right-0 mt-1 bg-white border rounded-lg shadow-lg max-h-40 overflow-y-auto z-10">
                        {filteredProducts.length === 0 ? (
                          <div className="px-3 py-2 text-gray-500 text-sm">{t("errors.noProductsFound")}</div>
                        ) : (
                          filteredProducts.slice(0, 5).map((p) => (
                            <div
                              key={p.id}
                              className="px-3 py-2 hover:bg-blue-50 cursor-pointer"
                              onClick={() => selectProduct(p, index)}
                            >
                              <div className="font-medium text-sm">{p.name}</div>
                              <div className="text-xs text-gray-500">
                                {p.sku && `${p.sku} · `}€{parseFloat(p.basePrice).toFixed(2)}
                              </div>
                            </div>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                  <div className="col-span-2 flex gap-1">
                    <Input
                      type="number"
                      min="1"
                      value={item.quantity}
                      className="w-16"
                      onChange={(e) => {
                        const items = [...form.items]
                        items[index].quantity = Number(e.target.value)
                        setForm({ ...form, items })
                      }}
                    />
                    <Input
                      value={item.unit}
                      className="w-16"
                      onChange={(e) => {
                        const items = [...form.items]
                        items[index].unit = e.target.value
                        setForm({ ...form, items })
                      }}
                    />
                  </div>
                  <div className="col-span-2">
                    <Input
                      type="number"
                      step="0.01"
                      min="0"
                      value={item.unitPrice}
                      onChange={(e) => {
                        const items = [...form.items]
                        items[index].unitPrice = Number(e.target.value)
                        setForm({ ...form, items })
                      }}
                    />
                  </div>
                  <div className="col-span-1">
                    <select
                      className="w-full h-10 border rounded-md px-1 text-sm"
                      value={item.vatRate}
                      onChange={(e) => {
                        const items = [...form.items]
                        items[index].vatRate = Number(e.target.value)
                        setForm({ ...form, items })
                      }}
                    >
                      <option value={0.19}>19%</option>
                      <option value={0.07}>7%</option>
                      <option value={0}>0%</option>
                    </select>
                  </div>
                  <div className="col-span-2">
                    <Button type="button" variant="ghost" size="sm" onClick={() => {
                      const items = form.items.filter((_, i) => i !== index)
                      setForm({ ...form, items })
                    }}>{t("invoice.removeItem")}</Button>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>

          {/* Discount Card */}
          <Card>
            <CardHeader>
              <CardTitle>{t("invoice.discount")}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-1">{t("invoice.discountPercent")}</label>
                  <Input
                    type="number"
                    min="0"
                    max="100"
                    step="0.1"
                    value={form.discountPercent}
                    onChange={(e) => setForm({ ...form, discountPercent: Number(e.target.value), discountAmount: 0 })}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">{t("invoice.discountAmount")} (€)</label>
                  <Input
                    type="number"
                    step="0.01"
                    min="0"
                    value={form.discountAmount}
                    onChange={(e) => setForm({ ...form, discountAmount: Number(e.target.value), discountPercent: 0 })}
                  />
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Payment Info Card */}
          <Card>
            <CardHeader>
              <CardTitle>{t("common2.paymentInfo")}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-1">{t("invoice.paymentMethod")}</label>
                  <select
                    className="w-full h-10 border rounded-md px-3"
                    value={form.paymentMethod}
                    onChange={(e) => setForm({ ...form, paymentMethod: e.target.value })}
                  >
                    <option value="bank_transfer">{t("paymentMethod.bankTransfer")}</option>
                    <option value="cash">{t("paymentMethod.cash")}</option>
                    <option value="ec_card">EC-Karte</option>
                    <option value="credit_card">{t("paymentMethod.creditCard")}</option>
                    <option value="paypal">PayPal</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">{t("invoice.notes")}</label>
                  <Input
                    value={form.notes}
                    onChange={(e) => setForm({ ...form, notes: e.target.value })}
                    placeholder={t("common2.additionalNotes")}
                  />
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Summary Card */}
          <Card className="bg-gray-50">
            <CardHeader>
              <CardTitle>{t("common2.summary")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="flex justify-between">
                <span className="text-gray-600">{t("invoice.subtotal")} ({t("common2.net")}):</span>
                <span>€{calculateSubtotal().toFixed(2)}</span>
              </div>
              {calculateDiscount() > 0 && (
                <div className="flex justify-between text-green-600">
                  <span>{t("invoice.discount")}:</span>
                  <span>-€{calculateDiscount().toFixed(2)}</span>
                </div>
              )}
              <div className="flex justify-between">
                <span className="text-gray-600">{t("invoice.vat")}:</span>
                <span>€{calculateVat().toFixed(2)}</span>
              </div>
              <div className="flex justify-between text-xl font-bold border-t pt-3">
                <span>{t("common2.totalGross")}:</span>
                <span className="text-blue-600">€{calculateTotal().toFixed(2)}</span>
              </div>
            </CardContent>
          </Card>

          {/* Submit */}
          <div className="flex gap-4">
            <Button type="submit" className="flex-1" disabled={loading}>
              {loading ? (t("common2.creating")) : t("invoice.createInvoice")}
            </Button>
          </div>
        </form>
      </div>
    </main>
  )
}