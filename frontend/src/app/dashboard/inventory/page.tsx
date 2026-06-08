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
import { apiGet, apiPut, ApiError } from "@/lib/api"

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
      case "sale": return "bg-red-100 text-red-700"
      case "purchase": return "bg-green-100 text-green-700"
      case "return": return "bg-blue-100 text-blue-700"
      case "adjustment": return "bg-yellow-100 text-yellow-700"
      case "initial": return "bg-gray-100 text-gray-700"
      default: return "bg-gray-100 text-gray-700"
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

  return (
    <main className="min-h-screen bg-gray-50">
      <header className="bg-white border-b shadow-sm">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <h1 className="text-2xl font-bold text-blue-600">{t("inventory.title")}</h1>
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
          <Card className="mb-8 border-red-300 bg-red-50">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-red-700">
                <span className="text-xl">⚠️</span>
                {t("inventory.lowStockCount").replace("{count}", String(lowStockProducts.length))}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {lowStockProducts.map((product) => (
                  <div
                    key={product.id}
                    className="bg-white p-4 rounded-lg border border-red-200 cursor-pointer hover:border-red-400"
                    onClick={() => selectProduct(product)}
                  >
                    <p className="font-medium">{product.name}</p>
                    <p className="text-sm text-gray-500">{product.sku || t("inventory.noSku")}</p>
                    <div className="mt-2 flex items-center justify-between">
                      <span className="text-red-600 font-bold">
                        {parseFloat(product.stockQuantity).toFixed(2)} {product.unit}
                      </span>
                      <span className="text-sm text-gray-500">
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
          {/* Product List — every product with trackInventory=true */}
          <Card>
            <CardHeader>
              <CardTitle>{t("inventory.trackedProducts")}</CardTitle>
            </CardHeader>
            <CardContent>
              {loading ? (
                <div className="text-center py-8">{t("inventory.loading")}</div>
              ) : products.length === 0 ? (
                <div className="text-center py-8 text-gray-500">
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
                            ? "border-red-300 bg-red-50 hover:bg-red-100"
                            : "border-gray-200 hover:bg-gray-50"
                        }`}
                        onClick={() => selectProduct(product)}
                      >
                        <div className="flex items-center justify-between">
                          <div>
                            <p className="font-medium">{product.name}</p>
                            <p className="text-sm text-gray-500">{product.sku || t("inventory.noSku")}</p>
                          </div>
                          <div className="text-right">
                            <p className={`font-bold ${isBelowThreshold ? "text-red-600" : "text-gray-900"}`}>
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
                    <Button onClick={() => setShowAdjustModal(true)} size="sm">
                      {t("inventory.adjustStock")}
                    </Button>
                  </CardHeader>
                  <CardContent>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="bg-gray-50 p-4 rounded-lg">
                        <p className="text-sm text-gray-500">{t("inventory.currentStock")}</p>
                        <p className="text-2xl font-bold">
                          {parseFloat(selectedProduct.stockQuantity).toFixed(2)} {selectedProduct.unit}
                        </p>
                      </div>
                      <div className="bg-gray-50 p-4 rounded-lg">
                        <p className="text-sm text-gray-500">{t("inventory.threshold")}</p>
                        <p className="text-2xl font-bold">
                          {parseFloat(selectedProduct.lowStockThreshold || "0").toFixed(2)} {selectedProduct.unit}
                        </p>
                      </div>
                    </div>
                    {selectedProduct.sku && (
                      <p className="mt-4 text-sm text-gray-500">
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
                      <p className="text-center py-4 text-gray-500">{t("inventory.noHistory")}</p>
                    ) : (
                      <div className="space-y-3">
                        {history.map((entry) => (
                          <div key={entry.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
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
                                  <p className="text-xs text-gray-500">{entry.notes}</p>
                                )}
                              </div>
                            </div>
                            <div className="text-right">
                              <p className="text-xs text-gray-500">{formatDate(entry.createdAt)}</p>
                              {entry.reference && (
                                <p className="text-xs text-blue-600">{t("inventory.reference")}: {entry.reference}</p>
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
                <CardContent className="text-center py-12 text-gray-500">
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
                  <p className="text-xs text-gray-500 mt-1">
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
    </main>
  )
}
