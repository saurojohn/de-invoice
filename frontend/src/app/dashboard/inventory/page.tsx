/**
 * Inventory Management page
 *
 * Renders the /dashboard/inventory route. Three concerns:
 *   1. Top "low stock" warning card (lists products below
 *      their threshold, click to select)
 *   2. Master list of products with inventory tracking on
 *      (click to select)
 *   3. Detail panel (current stock + threshold + history
 *      table) for the currently selected product, with an
 *      "Adjust" button to open the adjust-stock modal
 *
 * i18n: every user-visible string goes through t() so the
 * page renders in DE / EN / ZH per the user's locale. The
 * previous version of this file had all strings hardcoded
 * in German and additionally had mojibake characters in
 * two of the adjust-type option labels (line 388-389 in
 * the old version, the "(zug受加了)" fragments). Those
 * were copy-paste artifacts from an editor that mangled
 * UTF-8 \u2014 the rewrite drops them entirely in favor of
 * t() lookups.
 *
 * Network: uses apiGet / apiPut from @/lib/api so the
 * x-user-id + x-company-id auth headers from localStorage
 * are attached automatically. The previous version used
 * raw fetch() with the hardcoded backend URL, which would
 * have produced 403 "Unzureichende Berechtigung" as soon
 * as the HeaderAuthGuard checked the headers.
 */
"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { useI18n } from "@/components/useI18n"
import { apiGet, apiPost, apiPut, ApiError } from "@/lib/api"

interface ProductStock {
  id: string
  name: string
  sku: string | null
  stockQuantity: string
  lowStockThreshold: string | null
  trackInventory: boolean
  unit: string
}

interface StockHistory {
  id: string
  changeType: string
  quantity: string
  previousQty: string
  newQty: string
  reference: string | null
  referenceType: string | null
  notes: string | null
  createdAt: string
}

export default function InventoryPage() {
  const router = useRouter()
  const { t, getDateLocale } = useI18n()
  const [products, setProducts] = useState<ProductStock[]>([])
  const [lowStockProducts, setLowStockProducts] = useState<ProductStock[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedProduct, setSelectedProduct] = useState<ProductStock | null>(null)
  const [history, setHistory] = useState<StockHistory[]>([])
  const [showAdjustModal, setShowAdjustModal] = useState(false)
  const [adjustForm, setAdjustForm] = useState({
    quantity: "",
    changeType: "adjustment",
    notes: "",
  })
  // Goods-receipt (Wareneingang) state — a separate
  // modal dedicated to the purchase / incoming-stock
  // workflow. The user wanted a quick dedicated entry
  // point for deliveries, distinct from the generic
  // adjust-stock modal (which is for manual corrections
  // and the like). The shape mirrors the adjust modal
  // but pre-fills changeType=purchase and adds business
  // fields (supplier, PO number) that the generic
  // adjust modal doesn't have.
  const [showPurchaseModal, setShowPurchaseModal] = useState(false)
  const [purchaseForm, setPurchaseForm] = useState({
    quantity: "",
    supplier: "",
    orderNumber: "",
    notes: "",
  })
  const [purchaseLoading, setPurchaseLoading] = useState(false)
  // Inline "create new product" modal — the user
  // reported that the inventory page had no way to
  // add a new product. The previous workflow required
  // a side-trip to /dashboard/products, creating the
  // product there (with trackInventory enabled), then
  // coming back to inventory. The new inline modal
  // cuts that round-trip: pick name + sku + unit +
  // initial stock + (optional) threshold, save, and
  // the new product shows up in the inventory list
  // immediately, already stocked.
  //
  // Mirrors the products page's create form 1:1 (same
  // POST payload shape) but stripped down to the
  // fields the inventory context needs. Defaults:
  // trackInventory=true, type='good', basePrice=0,
  // vatRate=0.19, unit=translated 'Stück'/'piece'/'件'
  // (via the common2.unit key).
  const [showNewProductModal, setShowNewProductModal] = useState(false)
  const [newProductForm, setNewProductForm] = useState({
    name: "",
    sku: "",
    unit: "",
    initialStock: "",
    lowStockThreshold: "",
  })
  const [newProductLoading, setNewProductLoading] = useState(false)
  // New-product modal: dual-mode UI.
  //   mode='search'  — search bar + dropdown of existing
  //                    products. Picking a match reuses
  //                    the product (no new product
  //                    created).
  //   mode='create'  — 5-field create form for new
  //                    products.
  // Initial mode is 'search' so the user is gently
  // guided to pick an existing product first (avoiding
  // duplicates). 0-match dropdown shows a 'Create new
  // product "{name}"' link that switches to 'create'
  // mode with the name pre-filled.
  const [newProductMode, setNewProductMode] = useState<"search" | "create">("search")
  const [newProductSearch, setNewProductSearch] = useState("")
  const [showNewProductDropdown, setShowNewProductDropdown] = useState(false)
  // Re-use the already-loaded `products` list
  // (trackInventory=true items). We don't re-fetch the
  // full catalog here because (a) the inventory page
  // only cares about tracked products, and (b) any
  // un-tracked product wouldn't make sense to add stock
  // to anyway. If the user wants to start tracking a
  // new SKU, they can do it on the products page.
  const newProductMatches = newProductSearch.trim()
    ? products.filter(p => {
        const q = newProductSearch.toLowerCase()
        return (
          (p.name || "").toLowerCase().includes(q) ||
          (p.sku || "").toLowerCase().includes(q)
        )
      }).slice(0, 5)
    : []

  useEffect(() => {
    const companyId = localStorage.getItem("companyId")
    if (!companyId) {
      router.push("/login")
      return
    }

    loadProducts(companyId)
    loadLowStock(companyId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router])

  // Load all products with trackInventory=true. We fetch
  // the full products list (rather than only the tracked
  // ones from a dedicated endpoint) because the inventory
  // page needs product name + sku + unit alongside the
  // stock fields, and the products endpoint already joins
  // everything.
  //
  // The apiGet<T> helper returns the parsed JSON typed as
  // T, so we use \`as any\` and handle the two backend
  // response shapes (raw array vs paginated {data,total}
  // envelope) at runtime.
  const loadProducts = async (companyId: string) => {
    try {
      const data: any = await apiGet<any>(`/api/v1/products?companyId=${companyId}`)
      const list: any[] = Array.isArray(data) ? data : (data?.data || [])
      setProducts(list.filter((p: any) => p.trackInventory))
    } catch (error) {
      console.error("Error loading products:", error)
    } finally {
      setLoading(false)
    }
  }

  // Load the low-stock list. The backend computes this
  // server-side (filters by stockQuantity <= lowStockThreshold
  // AND trackInventory=true) so the page can show a
  // separate "needs attention" panel.
  const loadLowStock = async (companyId: string) => {
    try {
      const data: any = await apiGet<any>(`/api/v1/inventory/low-stock?companyId=${companyId}`)
      setLowStockProducts(Array.isArray(data) ? data : (data?.data || []))
    } catch (error) {
      console.error("Error loading low stock products:", error)
    }
  }

  const loadHistory = async (productId: string) => {
    try {
      const data: any = await apiGet<any>(`/api/v1/inventory/${productId}/history`)
      setHistory(Array.isArray(data) ? data : (data?.data || []))
    } catch (error) {
      console.error("Error loading history:", error)
    }
  }

  const selectProduct = (product: ProductStock) => {
    setSelectedProduct(product)
    loadHistory(product.id)
  }

  const handleAdjustStock = async () => {
    if (!selectedProduct || !adjustForm.quantity) return
    const companyId = localStorage.getItem("companyId")!

    try {
      await apiPut(
        `/api/v1/inventory/${selectedProduct.id}/adjust`,
        {
          quantity: parseFloat(adjustForm.quantity),
          changeType: adjustForm.changeType,
          notes: adjustForm.notes || null,
          referenceType: "manual",
        }
      )

      // Reload data so the new stock level + the new
      // history entry both show up immediately.
      await loadProducts(companyId)
      await loadLowStock(companyId)
      await loadHistory(selectedProduct.id)

      // Refresh the selected product card so the "current
      // stock" number updates without the user having to
      // re-click the row.
      const updated = await apiGet<ProductStock>(`/api/v1/inventory/${selectedProduct.id}`)
      setSelectedProduct(updated)

      setShowAdjustModal(false)
      setAdjustForm({ quantity: "", changeType: "adjustment", notes: "" })
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : `Netzwerkfehler: ${err}`
      alert(msg)
    }
  }

  // Look up the localized label for a stock change type.
  // t(\`inventory.stockChangeType_${type}\`) returns the
  // translation for "sale" / "purchase" / etc. Falls back
  // to the raw type if the key is missing (e.g. a new
  // type added server-side before the i18n file is
  // updated).
  const getChangeTypeLabel = (type: string): string => {
    const key = `inventory.stockChangeType_${type}` as const
    const v = t(key as any)
    return v === key ? type : v
  }

  // Color-coded badge for each change type. Sale = red
  // (stock decreases), Purchase / Return = green/blue
  // (stock increases), Adjustment = yellow (could go
  // either way), Initial = gray (setup).
  const getChangeTypeBadge = (type: string): string => {
    switch (type) {
      case "sale": return "bg-red-100 text-red-700 dark:text-red-300"
      case "purchase": return "bg-green-100 text-green-700 dark:text-green-300"
      case "return": return "bg-blue-100 text-blue-700 dark:text-blue-300"
      case "adjustment": return "bg-yellow-100 text-yellow-700 dark:text-yellow-300"
      case "initial": return "bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-200"
      default: return "bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-200"
    }
  }

  // Format a date in the user's active locale, not a
  // hardcoded "de-DE" (the previous version was de-only).
  // getDateLocale() returns "de-DE" / "en-US" / "zh-CN"
  // based on the in-app language.
  const formatDate = (dateStr: string): string => {
    return new Date(dateStr).toLocaleString(getDateLocale(), {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    })
  }

  // Record a goods receipt (Wareneingang) — calls the
  // existing PUT /api/v1/inventory/:id/adjust with
  // changeType='purchase' so the backend's stock +
  // history logic is reused. The PO number goes into
  // the \`reference\` field, and the supplier + free
  // notes go into the \`notes\` field. Both reference
  // and notes are shown in the history panel.
  const recordPurchase = async () => {
    if (!selectedProduct) return
    const qty = parseFloat(purchaseForm.quantity)
    if (!qty || qty <= 0) {
      alert(t("inventory.purchaseQuantity"))
      return
    }
    setPurchaseLoading(true)
    try {
      const companyId = localStorage.getItem("companyId")!
      // Compose the notes field so the supplier + PO
      // number are both visible in the history row.
      // The backend's reference field is a single
      // string, so we put the PO number there and
      // keep the supplier in notes.
      const notesParts: string[] = []
      if (purchaseForm.supplier.trim()) notesParts.push(`${t("inventory.purchaseSupplier").replace(" (optional)", "").replace("（可选）", "")}: ${purchaseForm.supplier.trim()}`)
      if (purchaseForm.notes.trim()) notesParts.push(purchaseForm.notes.trim())
      const composedNotes = notesParts.join(" · ") || null

      await apiPut(
        `/api/v1/inventory/${selectedProduct.id}/adjust`,
        {
          quantity: qty,
          changeType: "purchase",
          notes: composedNotes,
          reference: purchaseForm.orderNumber.trim() || null,
          referenceType: "purchase_order",
        }
      )

      // Reload everything so the new stock + the new
      // history row both appear.
      await loadProducts(companyId)
      await loadLowStock(companyId)
      await loadHistory(selectedProduct.id)
      const updated = await apiGet<ProductStock>(`/api/v1/inventory/${selectedProduct.id}`)
      setSelectedProduct(updated)

      setShowPurchaseModal(false)
      setPurchaseForm({ quantity: "", supplier: "", orderNumber: "", notes: "" })

      // Friendly success toast via the same alert path
      // the adjust modal uses. Could be replaced with a
      // proper toast component later.
      alert(
        t("inventory.purchaseSuccess")
          .replace("{qty}", qty.toString())
          .replace("{unit}", selectedProduct.unit || "")
      )
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : `Netzwerkfehler: ${err}`
      alert(msg)
    } finally {
      setPurchaseLoading(false)
    }
  }

  // Create a brand-new product directly from the
  // inventory page, with the initial stock already
  // booked. Defaults to trackInventory=true so the
  // new product shows up in the inventory list
  // immediately. POST payload shape matches the
  // /dashboard/products create form 1:1 (the same
  // backend DTO is used; we just send the minimum
  // set of fields the inventory flow needs).
  //
  // After save, we refresh the local products /
  // low-stock lists so the new entry is visible
  // without a page reload, and auto-select it so the
  // user can immediately do further actions (history
  // view, adjust, etc.).
  //
  // Apply the modal to an EXISTING product (called when
  // the user picked a match from the search dropdown).
  // We don't POST a new product; instead we PUT
  // /api/v1/inventory/:id/adjust with changeType=
  // 'initial' to set the stock to the user-entered
  // initialStock value (if any). After the call, we
  // close the modal, refresh the lists, and auto-select
  // the existing product so the user can see the new
  // state in the detail card.
  //
  // If the user didn't enter an initial stock, we just
  // refresh the lists and select the product — the
  // modal effectively becomes a 'go to this product'
  // shortcut.
  const useExistingProductInline = async (p: ProductStock) => {
    setNewProductLoading(true)
    try {
      const companyId = localStorage.getItem("companyId")!
      const initialStock = parseFloat(newProductForm.initialStock) || 0
      if (initialStock > 0) {
        await apiPut(
          `/api/v1/inventory/${p.id}/adjust`,
          {
            quantity: initialStock,
            changeType: "initial",
            referenceType: "manual",
            notes: t("inventory.useExistingProductHint"),
          }
        )
      }
      await loadProducts(companyId)
      await loadLowStock(companyId)
      const updated: any = await apiGet<ProductStock>(`/api/v1/inventory/${p.id}`)
      setSelectedProduct(updated)
      await loadHistory(p.id)
      setShowNewProductModal(false)
      setNewProductMode("search")
      setNewProductSearch("")
      setShowNewProductDropdown(false)
      setNewProductForm({ name: "", sku: "", unit: "", initialStock: "", lowStockThreshold: "" })
      if (initialStock > 0) {
        alert(
          t("inventory.purchaseSuccess")
            .replace("{qty}", initialStock.toString())
            .replace("{unit}", p.unit || "")
        )
      }
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : `Netzwerkfehler: ${err}`
      alert(msg)
    } finally {
      setNewProductLoading(false)
    }
  }

  const createProductInline = async () => {
    if (!newProductForm.name.trim()) {
      alert(t("customer.name") + " *")
      return
    }
    const initialStock = parseFloat(newProductForm.initialStock) || 0
    setNewProductLoading(true)
    try {
      const companyId = localStorage.getItem("companyId")!
      const created: any = await apiPost(
        `/api/v1/products?companyId=${companyId}`,
        {
          name: newProductForm.name.trim(),
          // SKU is optional in the DTO; trim+omit if
          // empty so the backend doesn't store ''.
          sku: newProductForm.sku.trim() || undefined,
          // Inventory-specific defaults:
          trackInventory: true,
          stockQuantity: initialStock,
          // lowStockThreshold is optional; null when
          // the user didn't fill it in.
          lowStockThreshold: newProductForm.lowStockThreshold.trim()
            ? parseFloat(newProductForm.lowStockThreshold)
            : null,
          // Sensible defaults for the other fields the
          // products page would ask for, so the new
          // product is usable on invoices too. The user
          // can edit them later on /dashboard/products.
          type: "good",
          basePrice: 0,
          vatRate: 0.19,
          unit: newProductForm.unit.trim() || t("common2.unit") || "Stück",
        }
      )

      // Refresh the local lists so the new product
      // shows up in the inventory table immediately.
      await loadProducts(companyId)
      await loadLowStock(companyId)

      // Auto-select the new product so the user can
      // immediately see its history card and continue
      // working with it.
      setSelectedProduct(created)
      await loadHistory(created.id)

      setShowNewProductModal(false)
      setNewProductForm({ name: "", sku: "", unit: "", initialStock: "", lowStockThreshold: "" })

      alert(
        t("inventory.newProductSuccess")
          .replace("{qty}", initialStock.toString())
          .replace("{unit}", created.unit || "")
      )
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : `Netzwerkfehler: ${err}`
      alert(msg)
    } finally {
      setNewProductLoading(false)
    }
  }

  return (
    <main className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <header className="bg-white dark:bg-gray-800 border-b shadow-sm">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <h1 className="text-2xl font-bold text-blue-600 dark:text-blue-400">{t("inventory.title")}</h1>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => router.push("/dashboard")}>
              {t("inventory.back")}
            </Button>
          </div>
        </div>
      </header>

      <div className="container mx-auto px-4 py-8">
        {/* Low Stock Warnings — server-computed list, click
            a card to select that product. */}
        {lowStockProducts.length > 0 && (
          <Card className="mb-8 border-red-300 dark:border-red-700 bg-red-50">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-red-700 dark:text-red-300">
                <span className="text-xl">⚠️</span>
                {t("inventory.lowStockCount").replace("{count}", String(lowStockProducts.length))}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {lowStockProducts.map((product) => (
                  <div
                    key={product.id}
                    className="bg-white dark:bg-gray-800 p-4 rounded-lg border border-red-200 cursor-pointer hover:border-red-400"
                    onClick={() => selectProduct(product)}
                  >
                    <p className="font-medium">{product.name}</p>
                    <p className="text-sm text-gray-500 dark:text-gray-400">{product.sku || t("inventory.noSku")}</p>
                    <div className="mt-2 flex items-center justify-between">
                      <span className="text-red-600 dark:text-red-400 font-bold">
                        {parseFloat(product.stockQuantity).toFixed(2)} {product.unit}
                      </span>
                      <span className="text-sm text-gray-500 dark:text-gray-400">
                        {t("inventory.threshold")}: {parseFloat(product.lowStockThreshold || "0").toFixed(2)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          {/* Product List — every product with trackInventory=true.
              The CardHeader has an '+ Neues Produkt' button
              that opens the inline createProductInline modal,
              so the user can add a new inventory-tracked
              product without leaving the inventory page. */}
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle>{t("inventory.trackedProducts")}</CardTitle>
              <Button
                size="sm"
                onClick={() => setShowNewProductModal(true)}
                title={t("inventory.addNewProductDesc")}
              >
                + {t("inventory.addNewProduct")}
              </Button>
            </CardHeader>
            <CardContent>
              {loading ? (
                <div className="text-center py-8">{t("inventory.loading")}</div>
              ) : products.length === 0 ? (
                <div className="text-center py-8 text-gray-500 dark:text-gray-400">
                  {t("inventory.noTrackedProducts")}
                </div>
              ) : (
                <div className="space-y-2">
                  {products.map((product) => {
                    const isLow = lowStockProducts.some((p) => p.id === product.id)
                    const currentStock = parseFloat(product.stockQuantity)
                    const threshold = parseFloat(product.lowStockThreshold || "0")
                    const isBelowThreshold = isLow || (threshold > 0 && currentStock <= threshold)

                    return (
                      <div
                        key={product.id}
                        className={`p-4 rounded-lg border cursor-pointer transition-colors ${
                          selectedProduct?.id === product.id
                            ? "border-blue-500 bg-blue-50"
                            : isBelowThreshold
                            ? "border-red-300 dark:border-red-700 bg-red-50 hover:bg-red-100"
                            : "border-gray dark:border-gray-700-200 dark:border-gray-700 hover:bg-gray-50 dark:bg-gray-900"
                        }`}
                        onClick={() => selectProduct(product)}
                      >
                        <div className="flex items-center justify-between">
                          <div>
                            <p className="font-medium">{product.name}</p>
                            <p className="text-sm text-gray-500 dark:text-gray-400">{product.sku || t("inventory.noSku")}</p>
                          </div>
                          <div className="text-right">
                            <p className={`font-bold ${isBelowThreshold ? "text-red-600 dark:text-red-400" : "text-gray-900 dark:text-gray-100"}`}>
                              {currentStock.toFixed(2)} {product.unit}
                            </p>
                            {isBelowThreshold && (
                              <Badge variant="destructive" className="text-xs">
                                {t("inventory.lowStockBadge")}
                              </Badge>
                            )}
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Stock Details & History */}
          <div className="space-y-6">
            {selectedProduct ? (
              <>
                <Card>
                  <CardHeader className="flex flex-row items-center justify-between">
                    <CardTitle>{selectedProduct.name}</CardTitle>
                    {/* Two actions: a quick "goods receipt"
                        button for incoming deliveries (the
                        most common action in B2B) and a
                        general "adjust" button for manual
                        corrections / counts. The Wareneingang
                        button is primary-styled so the
                        common case (deliveries) is the
                        visually default action. */}
                    <div className="flex gap-2">
                      <Button
                        onClick={() => setShowPurchaseModal(true)}
                        size="sm"
                        title={t("inventory.purchaseEntryDesc")}
                      >
                        📦 {t("inventory.purchaseEntry")}
                      </Button>
                      <Button
                        variant="outline"
                        onClick={() => setShowAdjustModal(true)}
                        size="sm"
                      >
                        {t("inventory.adjustStock")}
                      </Button>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="bg-gray-50 dark:bg-gray-900 p-4 rounded-lg">
                        <p className="text-sm text-gray-500 dark:text-gray-400">{t("inventory.currentStock")}</p>
                        <p className="text-2xl font-bold">
                          {parseFloat(selectedProduct.stockQuantity).toFixed(2)} {selectedProduct.unit}
                        </p>
                      </div>
                      <div className="bg-gray-50 dark:bg-gray-900 p-4 rounded-lg">
                        <p className="text-sm text-gray-500 dark:text-gray-400">{t("inventory.threshold")}</p>
                        <p className="text-2xl font-bold">
                          {parseFloat(selectedProduct.lowStockThreshold || "0").toFixed(2)} {selectedProduct.unit}
                        </p>
                      </div>
                    </div>
                    {selectedProduct.sku && (
                      <p className="mt-4 text-sm text-gray-500 dark:text-gray-400">
                        {t("product.sku")}: {selectedProduct.sku}
                      </p>
                    )}
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle>{t("inventory.stockHistory")}</CardTitle>
                  </CardHeader>
                  <CardContent>
                    {history.length === 0 ? (
                      <p className="text-center py-4 text-gray-500 dark:text-gray-400">{t("inventory.noHistory")}</p>
                    ) : (
                      <div className="space-y-3">
                        {history.map((entry) => (
                          <div key={entry.id} className="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-900 rounded-lg">
                            <div className="flex items-center gap-3">
                              <span className={`px-2 py-1 rounded text-xs font-medium ${getChangeTypeBadge(entry.changeType)}`}>
                                {getChangeTypeLabel(entry.changeType)}
                              </span>
                              <div>
                                <p className="text-sm">
                                  {t("inventory.previousToNew")
                                    .replace("{prev}", parseFloat(entry.previousQty).toFixed(2))
                                    .replace("{new}", parseFloat(entry.newQty).toFixed(2))}
                                </p>
                                {entry.notes && (
                                  <p className="text-xs text-gray-500 dark:text-gray-400">{entry.notes}</p>
                                )}
                              </div>
                            </div>
                            <div className="text-right">
                              <p className="text-xs text-gray-500 dark:text-gray-400">{formatDate(entry.createdAt)}</p>
                              {entry.reference && (
                                <p className="text-xs text-blue-600 dark:text-blue-400">{t("inventory.reference")}: {entry.reference}</p>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </CardContent>
                </Card>
              </>
            ) : (
              <Card>
                <CardContent className="text-center py-12 text-gray-500 dark:text-gray-400">
                  <p>{t("inventory.selectProductHint")}</p>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </div>

      {/* Adjust Stock Modal — opens when the user clicks
          "Bestand anpassen" on the selected product card.
          Supports two modes: 'adjustment' (set the new
          total stock directly) and the delta modes
          ('purchase' / 'return' / 'initial') where the
          quantity is a delta to add to the current stock. */}
      {showAdjustModal && selectedProduct && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <Card className="w-full max-w-md">
            <CardHeader>
              <CardTitle>{t("inventory.adjustStock")}</CardTitle>
            </CardHeader>
            <CardContent>
              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  handleAdjustStock()
                }}
                className="space-y-4"
              >
                <div>
                  <label className="block text-sm font-medium mb-1">{t("inventory.currentStock")}</label>
                  <p className="text-lg font-bold">
                    {parseFloat(selectedProduct.stockQuantity).toFixed(2)} {selectedProduct.unit}
                  </p>
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">{t("inventory.adjustType")}</label>
                  <select
                    className="w-full h-10 border rounded-md px-3"
                    value={adjustForm.changeType}
                    onChange={(e) => setAdjustForm({ ...adjustForm, changeType: e.target.value })}
                  >
                    {(["adjustment", "purchase", "return", "initial"] as const).map((k) => (
                      <option key={k} value={k}>{t(`inventory.adjustTypeOption_${k}` as any)}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">{t("inventory.quantity")}</label>
                  <Input
                    type="number"
                    step="0.01"
                    value={adjustForm.quantity}
                    onChange={(e) => setAdjustForm({ ...adjustForm, quantity: e.target.value })}
                    placeholder={
                      adjustForm.changeType === "adjustment"
                        ? t("inventory.quantityPlaceholderAdjustment")
                        : t("inventory.quantityPlaceholderDelta")
                    }
                    required
                  />
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                    {adjustForm.changeType === "adjustment"
                      ? t("inventory.stockChangeHint_adjustment")
                      : t("inventory.stockChangeHint_delta")}
                  </p>
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">{t("inventory.notes")}</label>
                  <Input
                    value={adjustForm.notes}
                    onChange={(e) => setAdjustForm({ ...adjustForm, notes: e.target.value })}
                    placeholder={t("inventory.notesPlaceholder")}
                  />
                </div>
                <div className="flex gap-4 pt-4">
                  <Button
                    type="button"
                    variant="outline"
                    className="flex-1"
                    onClick={() => {
                      setShowAdjustModal(false)
                      setAdjustForm({ quantity: "", changeType: "adjustment", notes: "" })
                    }}
                  >
                    {t("inventory.cancel")}
                  </Button>
                  <Button type="submit" className="flex-1">
                    {t("inventory.save")}
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Goods-Receipt (Wareneingang) Modal. A focused
          alternative to the generic adjust modal, pre-
          configured for incoming deliveries:
          - changeType is fixed to 'purchase' (the user
            doesn't have to pick from a dropdown)
          - the form has dedicated business fields
            (supplier + PO number) that the generic
            adjust modal doesn't
          - the quantity placeholder says "Eingehende
            Menge" so the user knows they should enter
            a positive delta, not a new total

          The backend's PUT /inventory/:id/adjust handles
          'purchase' by ADDING the quantity to the
          current stock and writing a ProductStockHistory
          row with the supplier + PO number preserved
          (PO in `reference`, supplier in `notes`). */}
      {showPurchaseModal && selectedProduct && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <Card className="w-full max-w-md">
            <CardHeader>
              <CardTitle>📦 {t("inventory.purchaseEntryTitle")}</CardTitle>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                {t("inventory.purchaseEntryDesc")}
              </p>
            </CardHeader>
            <CardContent>
              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  recordPurchase()
                }}
                className="space-y-4"
              >
                {/* Current stock shown read-only so the
                    user knows the baseline they're adding
                    to. Highlighted in blue so it stands
                    out from the input fields. */}
                <div className="bg-blue-50 p-3 rounded-lg">
                  <p className="text-sm text-gray-600 dark:text-gray-300">{t("inventory.currentStock")}</p>
                  <p className="text-2xl font-bold text-blue-700 dark:text-blue-300">
                    {parseFloat(selectedProduct.stockQuantity).toFixed(2)} {selectedProduct.unit}
                  </p>
                </div>
                {/* Quantity — required, must be > 0. This
                    is a DELTA, not a total (the user
                    entering "24" means "24 units just
                    arrived", not "set stock to 24"). The
                    backend's 'purchase' branch does
                    newQty = previousQty + quantity. */}
                <div>
                  <label className="block text-sm font-medium mb-1">{t("inventory.purchaseQuantity")} *</label>
                  <Input
                    type="number"
                    step="0.01"
                    min="0.01"
                    value={purchaseForm.quantity}
                    onChange={(e) => setPurchaseForm({ ...purchaseForm, quantity: e.target.value })}
                    placeholder={t("inventory.purchaseQuantityPlaceholder")}
                    required
                    autoFocus
                  />
                </div>
                {/* Supplier + PO number — both optional but
                    typically the user wants to record
                    them for audit purposes. The PO number
                    goes into the `reference` column of
                    the history row; the supplier goes
                    into `notes` together with the user's
                    free-form notes. */}
                <div>
                  <label className="block text-sm font-medium mb-1">{t("inventory.purchaseSupplier")}</label>
                  <Input
                    value={purchaseForm.supplier}
                    onChange={(e) => setPurchaseForm({ ...purchaseForm, supplier: e.target.value })}
                    placeholder={t("inventory.purchaseSupplierPlaceholder")}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">{t("inventory.purchaseOrderNumber")}</label>
                  <Input
                    value={purchaseForm.orderNumber}
                    onChange={(e) => setPurchaseForm({ ...purchaseForm, orderNumber: e.target.value })}
                    placeholder={t("inventory.purchaseOrderNumberPlaceholder")}
                    className="font-mono"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">{t("inventory.notes")}</label>
                  <Input
                    value={purchaseForm.notes}
                    onChange={(e) => setPurchaseForm({ ...purchaseForm, notes: e.target.value })}
                    placeholder={t("inventory.notesPlaceholder")}
                  />
                </div>
                <div className="flex gap-4 pt-4">
                  <Button
                    type="button"
                    variant="outline"
                    className="flex-1"
                    onClick={() => {
                      setShowPurchaseModal(false)
                      setPurchaseForm({ quantity: "", supplier: "", orderNumber: "", notes: "" })
                    }}
                    disabled={purchaseLoading}
                  >
                    {t("inventory.cancel")}
                  </Button>
                  <Button
                    type="submit"
                    className="flex-1"
                    disabled={purchaseLoading || !purchaseForm.quantity || parseFloat(purchaseForm.quantity) <= 0}
                  >
                    {purchaseLoading
                      ? (t("inventory.loading"))
                      : t("inventory.save")}
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Inline "Create new product" modal — opens when
          the user clicks the '+ Neues Produkt' button on
          the tracked-products card. A focused,
          inventory-only subset of the /dashboard/products
          create form: name (required), sku (optional),
          unit (defaults to translated 'Stück'), initial
          stock (the value the new product starts with,
          '0' if left empty), and an optional low-stock
          threshold. All other product fields (price,
          VAT, type, description, inventory tracking) are
          filled with sensible defaults server-side; the
          user can edit them later on the products page.

          Mirrors the createProductFromSku flow on the
          create-invoice page (commit 87da439) so the
          two 'add product' entry points behave the
          same: select the new entry after save, refresh
          the in-memory list, surface a success toast. */}
      {showNewProductModal && (
        <div
          className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50"
          onClick={() => !newProductLoading && setShowNewProductModal(false)}
        >
          <div
            className="bg-white dark:bg-gray-800 rounded-lg shadow-2xl max-w-md w-full"
            onClick={(e) => e.stopPropagation()}
          >
            <Card>
              <CardHeader>
                <CardTitle>{t("inventory.newProductModalTitle")}</CardTitle>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                  {t("inventory.addNewProductDesc")}
                </p>
              </CardHeader>
              <CardContent>
                {/* Dual-mode UI. Mode 'search' (default) shows a
                    search bar + dropdown of existing products;
                    picking a match reuses the product. Mode
                    'create' shows the 5-field form for new
                    products. Both modes share the same
                    'initialStock' field so the user can stock
                    the product (existing or new) at creation
                    time. The two modes are mutually exclusive;
                    the user can switch via the 'Create new' link
                    in search mode or the back arrow in create
                    mode. The drop-down search uses the same UX
                    pattern as the product/customer pickers on
                    the create-invoice page (commits 87da439,
                    fd79838): onBlur 200ms delay, onMouseDown
                    preventDefault for the click. */}
                {newProductMode === "search" ? (
                  <div className="space-y-4">
                    <div className="relative">
                      <label className="block text-sm font-medium mb-1">
                        {t("inventory.searchExistingProduct")}
                      </label>
                      <Input
                        autoFocus
                        value={newProductSearch}
                        onChange={(e) => {
                          setNewProductSearch(e.target.value)
                          setShowNewProductDropdown(e.target.value.trim().length > 0)
                          // Pre-fill the create-mode name so
                          // the user can switch without losing
                          // their typing.
                          setNewProductForm(f => ({ ...f, name: e.target.value }))
                        }}
                        onFocus={() => {
                          if (newProductSearch.trim().length > 0) {
                            setShowNewProductDropdown(true)
                          }
                        }}
                        onBlur={() => {
                          setTimeout(() => setShowNewProductDropdown(false), 200)
                        }}
                        placeholder={t("inventory.searchProductPlaceholder")}
                        title={t("inventory.searchExistingProductHint")}
                      />
                      {showNewProductDropdown && (
                        <div className="absolute top-full left-0 right-0 mt-1 bg-white dark:bg-gray-800 border rounded-lg shadow-lg max-h-56 overflow-y-auto z-20">
                          {newProductMatches.length === 0 ? (
                            <>
                              <div className="px-3 py-2 text-gray-500 dark:text-gray-400 text-sm border-b">
                                {t("inventory.noProductsFound")}
                              </div>
                              <div
                                className="px-3 py-2 hover:bg-blue-50 cursor-pointer text-blue-700 dark:text-blue-300 text-sm font-medium border-t"
                                onMouseDown={(e) => {
                                  e.preventDefault()
                                  setNewProductMode("create")
                                  setShowNewProductDropdown(false)
                                }}
                              >
                                + {t("inventory.createNewProductWithName").replace("{name}", newProductSearch.trim() || "")}
                              </div>
                            </>
                          ) : (
                            newProductMatches.map((p) => (
                              <div
                                key={p.id}
                                className="px-3 py-2 hover:bg-blue-50 cursor-pointer"
                                onMouseDown={(e) => {
                                  e.preventDefault()
                                  useExistingProductInline(p)
                                }}
                              >
                                <div className="font-medium text-sm">{p.name}</div>
                                <div className="text-xs text-gray-500 dark:text-gray-400 font-mono">
                                  {p.sku && `${p.sku} · `}Aktueller Bestand: {parseFloat(p.stockQuantity).toFixed(2)} {p.unit}
                                </div>
                              </div>
                            ))
                          )}
                        </div>
                      )}
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-1">
                        {t("inventory.newProductInitialStock")}
                      </label>
                      <Input
                        type="number"
                        step="0.01"
                        min="0"
                        value={newProductForm.initialStock}
                        onChange={(e) => setNewProductForm({ ...newProductForm, initialStock: e.target.value })}
                        placeholder={t("inventory.newProductInitialStockPlaceholder")}
                        title={t("inventory.useExistingProductHint")}
                      />
                    </div>
                    <div className="flex gap-2 pt-2">
                      <Button
                        type="button"
                        variant="outline"
                        className="flex-1"
                        onClick={() => setShowNewProductModal(false)}
                        disabled={newProductLoading}
                      >
                        {t("inventory.cancel")}
                      </Button>
                      <Button
                        type="button"
                        className="flex-1"
                        onClick={() => setNewProductMode("create")}
                        disabled={newProductLoading}
                      >
                        + {t("inventory.addNewProduct")}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault()
                      createProductInline()
                    }}
                    className="space-y-4"
                  >
                    <button
                      type="button"
                      onClick={() => setNewProductMode("search")}
                      className="text-sm text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:text-blue-300 hover:underline"
                    >
                      ← {t("inventory.searchExistingProduct")}
                    </button>
                    <div>
                      <label className="block text-sm font-medium mb-1">
                        {t("customer.name") || t("product.name")} *
                      </label>
                      <Input
                        value={newProductForm.name}
                        onChange={(e) => setNewProductForm({ ...newProductForm, name: e.target.value })}
                        placeholder={t("settings.placeholderCompanyName") || "z.B. Lederpflege 250ml"}
                        required
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-1">{t("product.sku")}</label>
                      <Input
                        value={newProductForm.sku}
                        onChange={(e) => setNewProductForm({ ...newProductForm, sku: e.target.value })}
                        placeholder="PRD-001"
                        className="font-mono"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-1">{t("inventory.newProductUnit")}</label>
                      <Input
                        value={newProductForm.unit}
                        onChange={(e) => setNewProductForm({ ...newProductForm, unit: e.target.value })}
                        placeholder={t("inventory.newProductUnitPlaceholder")}
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm font-medium mb-1">{t("inventory.newProductInitialStock")}</label>
                        <Input
                          type="number"
                          step="0.01"
                          min="0"
                          value={newProductForm.initialStock}
                          onChange={(e) => setNewProductForm({ ...newProductForm, initialStock: e.target.value })}
                          placeholder={t("inventory.newProductInitialStockPlaceholder")}
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium mb-1">{t("inventory.newProductThreshold")}</label>
                        <Input
                          type="number"
                          step="0.01"
                          min="0"
                          value={newProductForm.lowStockThreshold}
                          onChange={(e) => setNewProductForm({ ...newProductForm, lowStockThreshold: e.target.value })}
                          placeholder={t("inventory.newProductThresholdPlaceholder")}
                        />
                      </div>
                    </div>
                    <div className="flex gap-4 pt-2">
                      <Button
                        type="button"
                        variant="outline"
                        className="flex-1"
                        onClick={() => {
                          setShowNewProductModal(false)
                          setNewProductForm({ name: "", sku: "", unit: "", initialStock: "", lowStockThreshold: "" })
                          setNewProductMode("search")
                        }}
                        disabled={newProductLoading}
                      >
                        {t("inventory.cancel")}
                      </Button>
                      <Button
                        type="submit"
                        className="flex-1"
                        disabled={newProductLoading || !newProductForm.name.trim()}
                      >
                        {newProductLoading
                          ? (t("inventory.loading"))
                          : t("inventory.save")}
                      </Button>
                    </div>
                  </form>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      )}
    </main>
  )
}
