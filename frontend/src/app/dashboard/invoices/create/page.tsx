"use client"

import { useEffect, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
import { useI18n } from "@/components/useI18n"
import LanguageSwitcher from "@/components/LanguageSwitcher"
import { apiGet, apiPost, apiPut, apiFetch, ApiError } from "@/lib/api"

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
  // Rich description used as the line-item text on the
  // invoice (selectProduct picks this over name when set,
  // because many products use the `name` field as an
  // internal code and put the customer-facing label in
  // `description`).
  description?: string | null
  sku: string
  unit: string
  basePrice: string
  vatRate: string
}

interface Invoice {
  id: string
  invoiceNumber: string
  customerId: string
  customer: { name: string }
}

interface InvoiceItem {
  productId?: string
  // Produktnummer / SKU. Auto-filled when a product is picked
  // from the dropdown, but user-editable so manual line items
  // can carry a custom reference. Optional because the field
  // is only shown when non-empty in the PDF line item table.
  productNumber?: string
  description: string
  quantity: number
  unit: string
  unitPrice: number
  vatRate: number
}

export default function CreateInvoicePage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const editId = searchParams.get("id") || null
  const isEdit = !!editId
  const { t, locale, getDateLocale } = useI18n()
  const [customers, setCustomers] = useState<Customer[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [customerSearch, setCustomerSearch] = useState("")
  const [productSearch, setProductSearch] = useState("")
  const [showCustomerDropdown, setShowCustomerDropdown] = useState(false)
  const [showProductDropdown, setShowProductDropdown] = useState(false)
  const [activeItemIndex, setActiveItemIndex] = useState<number | null>(null)
  // Product-number search: a SEPARATE picker from the description-
  // triggered one. Triggered by typing into the Artikelnr. input
  // (see item row). When the user types a SKU that doesn't exist
  // yet, the dropdown shows a "Create new product" suggestion
  // that opens the newProductModal.
  const [productNumberSearch, setProductNumberSearch] = useState("")
  const [showProductNumberDropdown, setShowProductNumberDropdown] = useState(false)
  // Inline modal for "create a new product from the line item".
  // The field set mirrors the products page's create/edit
  // form 1:1 (see src/app/dashboard/products/page.tsx) so the
  // user gets the same UX in both places — no surprise gaps
  // when they later edit the product on the products page.
  // The "open" flag is just for visibility; the rest is
  // initialized to the same defaults the products form uses.
  const [newProductModal, setNewProductModal] = useState<{
    open: boolean
    name: string
    description: string
    sku: string
    type: "good" | "service"
    unit: string
    basePrice: string
    vatRate: string
    trackInventory: boolean
    stockQuantity: string
    lowStockThreshold: string
    index: number
    loading: boolean
  } | null>(null)
  const [invoiceType, setInvoiceType] = useState<InvoiceType>('INV')
  const [showInvoiceDropdown, setShowInvoiceDropdown] = useState(false)
  const [invoiceSearch, setInvoiceSearch] = useState("")
  const [templateType, setTemplateType] = useState<InvoiceTemplateType>('standard')
  const [form, setForm] = useState({
    customerId: "",
    referenceInvoiceId: "",
    issueDate: new Date().toISOString().split("T")[0],
    dueDate: "",
    // Default the Liefertermin to today. Most invoices are
    // issued and delivered the same day, and a pre-filled date
    // is easier to clear than to type. The PDF will show
    // "Liefertermin: <today>" by default; the user can clear
    // the input to hide the row on the PDF.
    deliveryDate: new Date().toISOString().split("T")[0],
    notes: "",
    discountPercent: 0,
    discountAmount: 0,
    paymentMethod: "bank_transfer",
    paymentTerms: 0,
    // Rechnungssprache — default to the current UI locale so the
    // user doesn't have to change anything when their UI is already
    // in the language they want the invoice in. They can still
    // override per-invoice (e.g. UI in DE, customer in EN).
    language: getDateLocale(),
    items: [{ description: "", productNumber: "", quantity: 1, unit: t("common2.unit"), unitPrice: 0, vatRate: 0.19 }] as InvoiceItem[],
  })
  const [loading, setLoading] = useState(false)
  // Top-of-page error from the initial-load fetch (e.g. 403 when
  // opening an old invoice in edit mode). Set here so we don't
  // crash when the user lands on /create?id=<old> directly.
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    const companyId = localStorage.getItem("companyId")
    if (!companyId) {
      router.push("/login")
      return
    }

    // If we're in edit mode, prefill the form from the existing
    // invoice BEFORE the dropdown fetch effect. Without this the
    // page would render a blank create form and then suddenly
    // populate once the edit fetch resolves, which flashes the
    // wrong state.
    if (editId) {
      apiGet<any>(`/api/v1/invoices/${editId}?companyId=${companyId}`)
        .then((inv) => {
          if (!inv || !inv.id) return
          setInvoiceType(inv.type || 'INV')
          setTemplateType(inv.templateType || 'standard')
          // The customer "select" is actually a custom search
          // input (value=customerSearch) with a click-list below.
          // The hidden form.customerId is the real field, but
          // the input's `required` HTML5 validation looks at the
          // input's *visible* value. Without setting customerSearch
          // here, the input shows the placeholder ("Kunde wählen"
          // / "选择客户") and submit gets blocked with "Please
          // fill out this field." — even though customerId IS set.
          // Use the customer name from the API response so the
          // visible text matches the hidden id.
          if (inv.customer?.name) {
            setCustomerSearch(inv.customer.name)
          } else {
            // Fallback: show the id so the user at least sees
            // something is selected.
            setCustomerSearch(inv.customerId || '')
          }
          setForm({
            customerId: inv.customerId || '',
            referenceInvoiceId: inv.referenceInvoiceId || '',
            issueDate: inv.issueDate ? String(inv.issueDate).slice(0, 10) : new Date().toISOString().split("T")[0],
            dueDate: inv.dueDate ? String(inv.dueDate).slice(0, 10) : "",
            // Default the Liefertermin to today when the stored
            // invoice has no value, so editing an old invoice
            // doesn't suddenly hide the row.
            deliveryDate: inv.deliveryDate ? String(inv.deliveryDate).slice(0, 10) : new Date().toISOString().split("T")[0],
            notes: inv.notes || '',
            discountPercent: Number(inv.discountPercent || 0),
            discountAmount: Number(inv.discountAmount || 0),
            paymentMethod: inv.paymentMethod || 'bank_transfer',
            paymentTerms: inv.paymentTerms ?? 0,
            language: inv.language || getDateLocale(),
            items: (inv.items || []).map((it: any) => ({
              description: it.description || '',
              productNumber: it.productNumber || '',
              quantity: Number(it.quantity || 1),
              unit: it.unit || t("common2.unit"),
              unitPrice: Number(it.unitPrice || 0),
              vatRate: Number(it.vatRate ?? 0.19),
            })),
          })
        })
        .catch((err) => {
          // 403 = not same day (or wrong permissions). Show the
          // error inline rather than silently redirecting.
          const msg = err instanceof ApiError ? err.message : 'Rechnung konnte nicht geladen werden.'
          setLoadError(msg)
        })
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
      // Use the product's rich description as the line-item
      // description, not the product's internal name. Many
      // products in this app use the `name` field as a short
      // code (e.g. "T13", "Mutter M5") and put the real
      // customer-facing label in `description` (e.g.
      // "Damentasche", "Sechskant-Stahlmutter M5 verzinkt").
      // For products with no description, fall back to the
      // name so the line item is never empty.
      //
      // This applies to ALL three picker flows:
      //   1. Description-dropdown picker (typing into the
      //      description field)
      //   2. Artikelnr.-dropdown picker (typing into the
      //      SKU field)
      //   3. Inline "Create new product" modal — when the
      //      user fills in the description field of the
      //      modal, that description now flows to the
      //      invoice line item as expected.
      description: (product.description?.trim() || product.name),
      // Auto-fill the SKU from the product master. The user can
      // still override this in the line-item row (e.g. to carry
      // a customer-specific part number on the invoice).
      productNumber: product.sku || "",
      quantity: 1,
      unit: product.unit,
      unitPrice: parseFloat(product.basePrice),
      vatRate: parseFloat(product.vatRate),
    }
    setForm({ ...form, items })
    setProductSearch("")
    setProductNumberSearch("")
    setShowProductDropdown(false)
    setShowProductNumberDropdown(false)
    setActiveItemIndex(null)
  }

  // Open the "create new product" modal. Triggered from the
  // product-number dropdown when 0 products match the typed
  // SKU. Mirrors the products page's "create" form layout
  // 1:1 so the user sees the same fields in both places.
  // Defaults match the products page exactly.
  const openNewProductModal = (index: number) => {
    const sku = (form.items[index]?.productNumber || "").trim()
    setNewProductModal({
      open: true,
      // Pre-fill the name with the SKU so the user can just
      // press Enter if the SKU is descriptive enough. They
      // can still edit it.
      name: sku,
      description: "",
      sku,
      type: "good",
      unit: t("common2.unit") || "Stück",
      // basePrice is a string in the products form so the
      // input can be empty without becoming NaN; the service
      // handles the empty-string → 0 coercion.
      basePrice: "",
      vatRate: "0.19",
      trackInventory: false,
      stockQuantity: "0",
      lowStockThreshold: "",
      index,
      loading: false,
    })
    setShowProductNumberDropdown(false)
  }

  // Save the new product via POST /api/v1/products, then
  // auto-select it for the originating line item. Mirrors
  // the user-flow of typing the SKU → not finding it →
  // creating it on the spot → it instantly being available.
  // The payload shape matches the products page's create
  // form 1:1 (no fields renamed, no defaults omitted) so
  // a product created here behaves identically to one
  // created from /dashboard/products.
  const createProductFromSku = async () => {
    if (!newProductModal) return
    const { name, index } = newProductModal
    if (!name.trim()) {
      alert(t("invoice.newProductName"))
      return
    }
    setNewProductModal({ ...newProductModal, loading: true })
    try {
      const companyId = localStorage.getItem("companyId") || "7de697d5-64a2-4632-9a87-d18b4e2a0214"
      // Same payload shape as the products page's handleSubmit:
      // string basePrice (server coerces to Decimal), string
      // vatRate (server normalizes >1 to decimal), string
      // stockQuantity + lowStockThreshold, all optional except
      // name + basePrice.
      const created = await apiPost<{ id: string; name: string; sku: string; unit: string; basePrice: string; vatRate: string }>(
        `/api/v1/products?companyId=${companyId}`,
        {
          name: newProductModal.name.trim(),
          description: newProductModal.description.trim() || undefined,
          sku: newProductModal.sku.trim() || undefined,
          type: newProductModal.type,
          unit: newProductModal.unit.trim() || undefined,
          // basePrice: empty string is acceptable for "0" — the
          // server's @Min(0) validator rejects negatives. Send
          // 0 (not "") so the products page can later display
          // the product with a clean price column.
          basePrice: newProductModal.basePrice === "" ? 0 : Number(newProductModal.basePrice),
          vatRate: Number(newProductModal.vatRate),
          trackInventory: newProductModal.trackInventory,
          stockQuantity: Number(newProductModal.stockQuantity) || 0,
          // lowStockThreshold: send null when the user hasn't
          // filled it in (so the product has no threshold),
          // and a number otherwise. Don't send 0 — that's a
          // real threshold of "alert when stock is 0 or below".
          lowStockThreshold: newProductModal.lowStockThreshold.trim() === ""
            ? null
            : Number(newProductModal.lowStockThreshold),
        }
      )
      // Refresh the in-memory products list so the user can
      // see the new entry in any future search.
      setProducts((prev) => [...prev, created])
      // Auto-fill the originating line item with the new
      // product's data.
      selectProduct(created, index)
      setNewProductModal(null)
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : `Netzwerkfehler: ${err}`
      alert(msg)
      setNewProductModal({ ...newProductModal, loading: false })
    }
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
      productNumber: it.productNumber || "",
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
        : [{ description: "", productNumber: "", quantity: 1, unit: t("common2.unit"), unitPrice: 0, vatRate: 0.19 }],
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
      items: [...form.items, { description: "", productNumber: "", quantity: 1, unit: t("common2.unit"), unitPrice: 0, vatRate: 0.19 }],
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
    await saveAndNavigate(false)
  }

  // "Speichern und drucken" — same as handleSubmit but after
  // creating the invoice we open its PDF in a new tab and
  // immediately trigger window.print() so the user lands
  // straight in the system print dialog. Faster workflow for
  // B2B where most invoices go straight to the printer.
  const handleSaveAndPrint = async (e: React.MouseEvent) => {
    e.preventDefault()
    await saveAndNavigate(true)
  }

  // Shared body for both submit handlers. When `printAfter` is
  // true, we fetch the generated PDF with auth headers, turn
  // it into a same-origin blob URL, open that in a new tab
  // and fire window.print(). Using a blob URL (instead of a
  // relative `/api/v1/...` path) avoids the 404 trap: a
  // relative path opened in a new tab is resolved against the
  // CURRENT origin (the frontend dev server on :3000), not
  // the backend on :3001, and Next.js has no such route. The
  // blob URL is served from the frontend's own origin, so the
  // PDF viewer can display it and the print dialog fires
  // correctly. We navigate to the invoice detail page in
  // parallel so the user can also see the created invoice in
  // the dashboard.
  const saveAndNavigate = async (printAfter: boolean) => {
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
      // Strip empty-string date fields before sending. Backend's
      // @IsOptional() only skips null/undefined, not "" — and
      // @IsDateString() rejects "". We removed the Fälligkeits-
      // datum input from the form (it's auto-computed from the
      // Zahlungsziel dropdown on the backend), so dueDate is
      // always empty here. deliveryDate is pre-filled with
      // today's date by default, but the user can clear it; if
      // cleared, treat it as "not set" instead of "set to empty".
      const payload = {
        ...form,
        type: invoiceType,
        templateType,
        dueDate: form.dueDate || undefined,
        deliveryDate: form.deliveryDate || undefined,
      }
      let createdId: string | null = null
      if (isEdit && editId) {
        // Edit mode: PUT replaces items wholesale and recomputes
        // totals. The service enforces same-day on the existing
        // invoice; if you landed here with a stale link the 403
        // will be surfaced in the alert below.
        await apiPut(`/api/v1/invoices/${editId}?companyId=${companyId}`, payload)
        createdId = editId
      } else {
        const result = await apiPost<{ id: string }>(`/api/v1/invoices?companyId=${companyId}`, payload)
        createdId = result.id
      }

      if (printAfter && createdId) {
        // Fetch the PDF with auth headers (apiFetch attaches
        // x-user-id + x-company-id from localStorage), then
        // build a same-origin blob URL the new tab can load.
        const cacheBust = `t=${Date.now()}`
        const pdfPath = `/api/v1/invoices/${createdId}/pdf?companyId=${companyId}&${cacheBust}`
        const response = await apiFetch(pdfPath, { throwOnError: false })
        if (!response.ok) {
          // The invoice was created (we have createdId) but the
          // PDF fetch failed — surface the error but still
          // navigate to the detail page so the user can
          // download manually from there.
          const msg = response.status === 401 || response.status === 403
            ? "Sitzung abgelaufen — bitte neu anmelden"
            : `PDF konnte nicht geladen werden (HTTP ${response.status})`
          alert(msg)
          // Fall through to the navigation below
        } else {
          const blob = await response.blob()
          const blobUrl = URL.createObjectURL(blob)
          const printWindow = window.open(blobUrl, "_blank")
          if (printWindow) {
            // Give the PDF viewer ~1.5s to load before firing
            // print. Most PDF viewers (Chrome/Edge/Firefox
            // built-in, plus the Adobe extension) will then
            // show the system print dialog automatically.
            // The user can also hit Cmd/Ctrl+P manually if
            // the dialog doesn't auto-appear.
            setTimeout(() => {
              try {
                printWindow.focus()
                printWindow.print()
              } catch (e) {
                // The blob URL is same-origin, so print() should
                // succeed; if it doesn't (very rare — e.g. user
                // closed the new tab), we silently no-op. The
                // blob is still downloadable from the new tab.
                console.error("Auto-print failed:", e)
              }
              // Revoke the blob URL after the print dialog has
              // had a chance to read the blob. The PDF is fully
              // rendered in the new tab by now, so this is safe.
              setTimeout(() => URL.revokeObjectURL(blobUrl), 5000)
            }, 1500)
          } else {
            // Popup blocked — fall back to triggering a
            // download in the current tab. The user can then
            // open the downloaded PDF and print from there.
            const a = document.createElement("a")
            a.href = blobUrl
            a.download = `rechnung-${createdId}.pdf`
            document.body.appendChild(a)
            a.click()
            document.body.removeChild(a)
            setTimeout(() => URL.revokeObjectURL(blobUrl), 10000)
          }
        }
      }

      // Always navigate back to the invoice detail (or list)
      // so the user has the invoice in their history.
      if (isEdit && editId) {
        router.push(`/dashboard/invoices/${editId}`)
      } else {
        router.push("/dashboard/invoices")
      }
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
          <h1 className="text-2xl font-bold text-blue-600">
            {isEdit ? (t("invoice.edit") || "Rechnung bearbeiten") : t("invoice.create")}
          </h1>
          <div className="flex items-center gap-2">
            <LanguageSwitcher />
            <Button variant="outline" onClick={() => router.push("/dashboard/invoices")}>{t("common.cancel")}</Button>
          </div>
        </div>
      </header>

      <div className="container mx-auto px-4 py-8 max-w-4xl">
        {/* Load error (e.g. opening an old invoice for edit). The
            form is still rendered below so the user can read
            what's there and back out via "Abbrechen". */}
        {loadError && (
          <div className="mb-4 bg-red-50 border border-red-200 text-red-800 text-sm rounded-lg px-4 py-2">
            ⚠ {loadError}{" "}
            <button
              type="button"
              onClick={() => router.push("/dashboard/invoices")}
              className="ml-2 underline"
            >
              {t("common.back") || "Zurück zur Liste"}
            </button>
          </div>
        )}
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

              <div className="grid md:grid-cols-3 gap-4">
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
                    <option value={0}>{t("paymentTerm.immediate")}</option>
                    <option value={7}>{t("paymentTerm.days7")}</option>
                    <option value={14}>{t("paymentTerm.days14")}</option>
                    <option value={30}>{t("paymentTerm.days30")}</option>
                    <option value={60}>{t("paymentTerm.days60")}</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">
                    {t("invoice.language") || "Rechnungssprache"}
                  </label>
                  <select
                    className="w-full h-10 border rounded-md px-3"
                    value={form.language}
                    onChange={(e) => setForm({ ...form, language: e.target.value })}
                    title={t("invoice.languageHint") || "Sprache der Rechnung (kann von der UI-Sprache abweichen)"}
                  >
                    <option value="de-DE">Deutsch</option>
                    <option value="en-US">English</option>
                    <option value="zh-CN">中文</option>
                  </select>
                </div>
              </div>

              {/* Liefertermin (delivery date) — optional, shown on
                  the PDF when set. Fälligkeitsdatum is intentionally
                  not editable here: it is auto-computed from the
                  Zahlungsziel dropdown at the top of this section
                  and stored when the invoice is created. The user
                  can override per-invoice on the detail page if
                  they really need to. */}
              <div className="grid md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-1">
                    {t("invoice.deliveryDate")}
                  </label>
                  <Input
                    type="date"
                    value={form.deliveryDate}
                    onChange={(e) => setForm({ ...form, deliveryDate: e.target.value })}
                    title={t("invoice.deliveryDateHint")}
                  />
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
                <div className="col-span-2">{t("invoice.productNumber")}</div>
                <div className="col-span-4">{t("invoice.description")}</div>
                <div className="col-span-2">{t("invoice.quantity")}</div>
                <div className="col-span-1">{t("invoice.unitPrice")} (€)</div>
                <div className="col-span-1">{t("invoice.vatRate")}</div>
                <div className="col-span-2">{t("common.actions")}</div>
              </div>
              {form.items.map((item, index) => (
                <div key={index} className="grid grid-cols-12 gap-2 items-end">
                  <div className="col-span-2 relative">
                    {/* Artikelnr. / SKU with a product search
                        dropdown. Typing here opens a list of
                        matching products (filtered by name or
                        SKU). Click a result to fill the whole
                        line item, same as the description picker.
                        If 0 products match, a "Create new
                        product" link appears at the bottom of
                        the dropdown to add a new product
                        without leaving the invoice. */}
                    <Input
                      value={item.productNumber || ""}
                      onChange={(e) => {
                        const items = [...form.items]
                        items[index].productNumber = e.target.value
                        setForm({ ...form, items })
                        // Trigger the search dropdown. We use
                        // the SKU text as the search string —
                        // filteredProducts already matches by
                        // name OR sku.
                        setProductNumberSearch(e.target.value)
                        setShowProductNumberDropdown(e.target.value.trim().length > 0)
                        setActiveItemIndex(index)
                        // Close the description-triggered
                        // dropdown to avoid two competing
                        // pickers on the same row.
                        setShowProductDropdown(false)
                      }}
                      onFocus={() => {
                        // Show dropdown if there's already a
                        // value (so the user can refine an
                        // existing SKU). Don't auto-clear it.
                        if ((item.productNumber || "").trim().length > 0) {
                          setProductNumberSearch(item.productNumber || "")
                          setShowProductNumberDropdown(true)
                          setActiveItemIndex(index)
                        }
                      }}
                      onBlur={() => {
                        // Delay close so a click on a dropdown
                        // item (which fires after blur) still
                        // registers. 200ms is the standard
                        // "let the click happen" delay.
                        setTimeout(() => setShowProductNumberDropdown(false), 200)
                      }}
                      placeholder={t("invoice.productNumber")}
                      title={t("invoice.productNumberSearchHint")}
                      className="font-mono text-sm"
                    />
                    {showProductNumberDropdown && activeItemIndex === index && productNumberSearch && (
                      <div className="absolute top-full left-0 right-0 mt-1 bg-white border rounded-lg shadow-lg max-h-56 overflow-y-auto z-20">
                        {(() => {
                          // Filter by SKU first (exact prefix
                          // match) then by name. The user is
                          // typing into a SKU field, so
                          // SKU-prefix matches are most
                          // relevant.
                          const q = productNumberSearch.trim().toLowerCase()
                          const matches = products.filter(p =>
                            (p.sku && p.sku.toLowerCase().includes(q)) ||
                            (p.name && p.name.toLowerCase().includes(q))
                          ).slice(0, 5)
                          if (matches.length === 0) {
                            return (
                              <>
                                <div className="px-3 py-2 text-gray-500 text-sm border-b">
                                  {t("errors.noProductsFound")}
                                </div>
                                {/* No match: offer to create a
                                    new product with the typed
                                    SKU. Pre-filled with the
                                    SKU; user can edit before
                                    saving. */}
                                <div
                                  className="px-3 py-2 hover:bg-blue-50 cursor-pointer text-blue-700 text-sm font-medium border-t"
                                  onMouseDown={(e) => {
                                    // Use onMouseDown so the
                                    // click fires BEFORE the
                                    // input's blur handler
                                    // closes the dropdown.
                                    e.preventDefault()
                                    openNewProductModal(index)
                                  }}
                                >
                                  + {t("invoice.createNewProductWithSku").replace("{sku}", productNumberSearch.trim() || "")}
                                </div>
                              </>
                            )
                          }
                          return matches.map((p) => (
                            <div
                              key={p.id}
                              className="px-3 py-2 hover:bg-blue-50 cursor-pointer"
                              onMouseDown={(e) => {
                                e.preventDefault()
                                selectProduct(p, index)
                              }}
                            >
                              <div className="font-medium text-sm">{p.name}</div>
                              <div className="text-xs text-gray-500 font-mono">
                                {p.sku && `${p.sku} · `}€{parseFloat(p.basePrice).toFixed(2)}
                              </div>
                            </div>
                          ))
                        })()}
                      </div>
                    )}
                  </div>
                  <div className="col-span-4 relative">
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

          {/* Submit — two actions:
                "Erstellen"   — save + navigate to detail/list
                "Erstellen & Drucken" — save + open the PDF in a
                  new tab and fire window.print() so the user
                  lands in the system print dialog. Faster B2B
                  workflow where most invoices go straight to
                  the printer. In edit mode only "Save changes"
                  shows (reprinting is one click away on the
                  detail page). */}
          <div className="flex gap-4">
            <Button type="submit" className="flex-1" disabled={loading || !!loadError}>
              {loading
                ? (t("common.saving") || "Wird gespeichert...")
                : isEdit
                  ? (t("invoice.saveChanges") || "Änderungen speichern")
                  : t("invoice.createInvoice")}
            </Button>
            {!isEdit && (
              <Button
                type="button"
                variant="outline"
                className="flex-1"
                disabled={loading || !!loadError}
                onClick={handleSaveAndPrint}
              >
                {t("invoice.createAndPrint") || "Erstellen & Drucken"}
              </Button>
            )}
          </div>
        </form>
      </div>

      {/* "Create new product" modal. Shown when the user
          clicks the "Create new product ..." link in the
          product-number dropdown. The field set mirrors the
          products page's create/edit form 1:1 so the user
          can fill in everything they need without having to
          come back later to add inventory / description /
          type etc. on the products page. POSTs to
          /api/v1/products on save and auto-selects the new
          product for the originating line item. The overlay
          uses a semi-transparent black layer so the
          underlying invoice form is dimmed but still
          visible (helps the user keep their place). */}
      {newProductModal?.open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => !newProductModal.loading && setNewProductModal(null)}
        >
          <div
            className="bg-white rounded-lg shadow-2xl max-w-lg w-full max-h-[90vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <Card>
              <CardHeader>
                <CardTitle>{t("invoice.newProductModalTitle")}</CardTitle>
                <p className="text-xs text-gray-500 mt-1">
                  {t("invoice.createNewProductWithSku").replace("{sku}", newProductModal.sku || "—")}
                </p>
              </CardHeader>
              <CardContent>
                <form
                  onSubmit={(e) => {
                    e.preventDefault()
                    createProductFromSku()
                  }}
                  className="space-y-4"
                >
                  {/* Name — required. Mirrors the products form's
                      first field. Autofocus so the user can start
                      typing immediately. Enter on this field (or
                      on any field below) submits the form. */}
                  <div>
                    <label className="block text-sm font-medium mb-1">{t("product.name")} *</label>
                    <Input
                      autoFocus
                      value={newProductModal.name}
                      onChange={(e) => setNewProductModal({ ...newProductModal, name: e.target.value })}
                      placeholder="z.B. Beratungsleistung"
                      required
                    />
                  </div>
                  {/* Description — optional, same as products form. */}
                  <div>
                    <label className="block text-sm font-medium mb-1">
                      {t("product.description") || "Beschreibung"}
                    </label>
                    <Input
                      value={newProductModal.description}
                      onChange={(e) => setNewProductModal({ ...newProductModal, description: e.target.value })}
                      placeholder="Optional"
                    />
                  </div>
                  {/* SKU + type — same row layout as products form.
                      SKU is pre-filled from the Artikelnr. input
                      the user typed into. */}
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium mb-1">{t("product.sku")}</label>
                      <Input
                        value={newProductModal.sku}
                        onChange={(e) => setNewProductModal({ ...newProductModal, sku: e.target.value })}
                        placeholder="PRD-001"
                        className="font-mono"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-1">{t("product.type")}</label>
                      <select
                        className="w-full h-10 border rounded-md px-3"
                        value={newProductModal.type}
                        onChange={(e) => setNewProductModal({ ...newProductModal, type: e.target.value as "good" | "service" })}
                      >
                        <option value="good">{t("product.typeGood")}</option>
                        <option value="service">{t("product.typeService")}</option>
                      </select>
                    </div>
                  </div>
                  {/* Unit + price + VAT — 3-col grid matching the
                      products form. basePrice is required. */}
                  <div className="grid grid-cols-3 gap-4">
                    <div>
                      <label className="block text-sm font-medium mb-1">{t("product.unit")}</label>
                      <Input
                        value={newProductModal.unit}
                        onChange={(e) => setNewProductModal({ ...newProductModal, unit: e.target.value })}
                        placeholder="Stück/Stunde/Projekt"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-1">{t("product.price")} (€) *</label>
                      <Input
                        type="number"
                        step="0.01"
                        min="0"
                        value={newProductModal.basePrice}
                        onChange={(e) => setNewProductModal({ ...newProductModal, basePrice: e.target.value })}
                        required
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-1">{t("product.vatRate")}</label>
                      <select
                        className="w-full h-10 border rounded-md px-3"
                        value={newProductModal.vatRate}
                        onChange={(e) => setNewProductModal({ ...newProductModal, vatRate: e.target.value })}
                      >
                        <option value="0.19">19% {t("product.standard")}</option>
                        <option value="0.07">7% {t("product.reduced")}</option>
                        <option value="0">0% {t("product.zero")}</option>
                      </select>
                    </div>
                  </div>

                  {/* Inventory section — same as the products
                      form. Hidden when trackInventory is off
                      (matches the products page behavior). */}
                  <div className="border-t pt-4 mt-4">
                    <h3 className="text-sm font-medium mb-3">{t("inventory.tracking")}</h3>
                    <div className="flex items-center justify-between mb-4">
                      <div>
                        <p className="font-medium">{t("inventory.trackProduct")}</p>
                        <p className="text-xs text-gray-500">{t("inventory.trackHint")}</p>
                      </div>
                      <Switch
                        checked={newProductModal.trackInventory}
                        onCheckedChange={(checked) => setNewProductModal({ ...newProductModal, trackInventory: checked })}
                      />
                    </div>
                    {newProductModal.trackInventory && (
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <label className="block text-sm font-medium mb-1">{t("inventory.currentStock")}</label>
                          <Input
                            type="number"
                            step="0.01"
                            value={newProductModal.stockQuantity}
                            onChange={(e) => setNewProductModal({ ...newProductModal, stockQuantity: e.target.value })}
                            placeholder="0"
                          />
                        </div>
                        <div>
                          <label className="block text-sm font-medium mb-1">{t("inventory.threshold")}</label>
                          <Input
                            type="number"
                            step="0.01"
                            value={newProductModal.lowStockThreshold}
                            onChange={(e) => setNewProductModal({ ...newProductModal, lowStockThreshold: e.target.value })}
                            placeholder="10"
                          />
                          <p className="text-xs text-gray-500 mt-1">{t("inventory.thresholdHint")}</p>
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="flex justify-end gap-2 pt-2">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setNewProductModal(null)}
                      disabled={newProductModal.loading}
                    >
                      {t("invoice.newProductCancel")}
                    </Button>
                    <Button
                      type="submit"
                      disabled={newProductModal.loading || !newProductModal.name.trim()}
                    >
                      {newProductModal.loading
                        ? (t("common.saving") || "...")
                        : t("invoice.newProductCreate")}
                    </Button>
                  </div>
                </form>
              </CardContent>
            </Card>
          </div>
        </div>
      )}
    </main>
  )
}