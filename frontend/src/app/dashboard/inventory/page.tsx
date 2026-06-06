"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"

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
  }, [router])

  const loadProducts = async (companyId: string) => {
    try {
      const res = await fetch(`http://localhost:3001/api/v1/products?companyId=${companyId}`)
      const data = await res.json()
      // Filter to only products with trackInventory enabled
      const trackedProducts = data.filter((p: any) => p.trackInventory)
      setProducts(trackedProducts)
    } catch (error) {
      console.error("Error loading products:", error)
    } finally {
      setLoading(false)
    }
  }

  const loadLowStock = async (companyId: string) => {
    try {
      const res = await fetch(`http://localhost:3001/api/v1/inventory/low-stock?companyId=${companyId}`)
      const data = await res.json()
      setLowStockProducts(data)
    } catch (error) {
      console.error("Error loading low stock products:", error)
    }
  }

  const loadHistory = async (productId: string) => {
    try {
      const res = await fetch(`http://localhost:3001/api/v1/inventory/${productId}/history`)
      const data = await res.json()
      setHistory(data)
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
      await fetch(`http://localhost:3001/api/v1/inventory/${selectedProduct.id}/adjust`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          quantity: parseFloat(adjustForm.quantity),
          changeType: adjustForm.changeType,
          notes: adjustForm.notes || null,
          referenceType: "manual",
        }),
      })

      // Reload data
      loadProducts(companyId)
      loadLowStock(companyId)
      loadHistory(selectedProduct.id)

      // Refresh selected product
      const res = await fetch(`http://localhost:3001/api/v1/inventory/${selectedProduct.id}`)
      const updated = await res.json()
      setSelectedProduct(updated)

      setShowAdjustModal(false)
      setAdjustForm({ quantity: "", changeType: "adjustment", notes: "" })
    } catch (error) {
      console.error("Error adjusting stock:", error)
    }
  }

  const getChangeTypeLabel = (type: string) => {
    switch (type) {
      case "sale":
        return "Verkauf"
      case "purchase":
        return "Einkauf"
      case "return":
        return "Retoure"
      case "adjustment":
        return "Korrektur"
      case "initial":
        return "Erstbestand"
      default:
        return type
    }
  }

  const getChangeTypeBadge = (type: string) => {
    switch (type) {
      case "sale":
        return "bg-red-100 text-red-700"
      case "purchase":
        return "bg-green-100 text-green-700"
      case "return":
        return "bg-blue-100 text-blue-700"
      case "adjustment":
        return "bg-yellow-100 text-yellow-700"
      case "initial":
        return "bg-gray-100 text-gray-700"
      default:
        return "bg-gray-100 text-gray-700"
    }
  }

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleString("de-DE", {
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
          <h1 className="text-2xl font-bold text-blue-600">Bestandsverwaltung</h1>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => router.push("/dashboard")}>
              Zurück
            </Button>
          </div>
        </div>
      </header>

      <div className="container mx-auto px-4 py-8">
        {/* Low Stock Warnings */}
        {lowStockProducts.length > 0 && (
          <Card className="mb-8 border-red-300 bg-red-50">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-red-700">
                <span className="text-xl">⚠️</span>
                Niedriger Bestand - {lowStockProducts.length} Produkte
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
                    <p className="text-sm text-gray-500">{product.sku || "Keine Artikelnummer"}</p>
                    <div className="mt-2 flex items-center justify-between">
                      <span className="text-red-600 font-bold">
                        {parseFloat(product.stockQuantity).toFixed(2)} {product.unit}
                      </span>
                      <span className="text-sm text-gray-500">
                        Schwelle: {parseFloat(product.lowStockThreshold || "0").toFixed(2)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          {/* Product List */}
          <Card>
            <CardHeader>
              <CardTitle>Produkte mit Bestandsverfolgung</CardTitle>
            </CardHeader>
            <CardContent>
              {loading ? (
                <div className="text-center py-8">Laden...</div>
              ) : products.length === 0 ? (
                <div className="text-center py-8 text-gray-500">
                  Keine Produkte mit Bestandsverfolgung
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
                            <p className="text-sm text-gray-500">{product.sku || "Keine Artikelnr."}</p>
                          </div>
                          <div className="text-right">
                            <p className={`font-bold ${isBelowThreshold ? "text-red-600" : "text-gray-900"}`}>
                              {currentStock.toFixed(2)} {product.unit}
                            </p>
                            {isBelowThreshold && (
                              <Badge variant="destructive" className="text-xs">
                                Niedriger Bestand
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
                      Bestand anpassen
                    </Button>
                  </CardHeader>
                  <CardContent>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="bg-gray-50 p-4 rounded-lg">
                        <p className="text-sm text-gray-500">Aktueller Bestand</p>
                        <p className="text-2xl font-bold">
                          {parseFloat(selectedProduct.stockQuantity).toFixed(2)} {selectedProduct.unit}
                        </p>
                      </div>
                      <div className="bg-gray-50 p-4 rounded-lg">
                        <p className="text-sm text-gray-500">Meldeschwelle</p>
                        <p className="text-2xl font-bold">
                          {parseFloat(selectedProduct.lowStockThreshold || "0").toFixed(2)} {selectedProduct.unit}
                        </p>
                      </div>
                    </div>
                    {selectedProduct.sku && (
                      <p className="mt-4 text-sm text-gray-500">Artikelnummer: {selectedProduct.sku}</p>
                    )}
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle>Bestandsverlauf</CardTitle>
                  </CardHeader>
                  <CardContent>
                    {history.length === 0 ? (
                      <p className="text-center py-4 text-gray-500">Kein Verlauf vorhanden</p>
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
                                  {parseFloat(entry.previousQty).toFixed(2)} → {parseFloat(entry.newQty).toFixed(2)}
                                </p>
                                {entry.notes && (
                                  <p className="text-xs text-gray-500">{entry.notes}</p>
                                )}
                              </div>
                            </div>
                            <div className="text-right">
                              <p className="text-xs text-gray-500">{formatDate(entry.createdAt)}</p>
                              {entry.reference && (
                                <p className="text-xs text-blue-600">Ref: {entry.reference}</p>
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
                  <p>Wählen Sie ein Produkt aus, um Details anzuzeigen</p>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </div>

      {/* Adjust Stock Modal */}
      {showAdjustModal && selectedProduct && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <Card className="w-full max-w-md">
            <CardHeader>
              <CardTitle>Bestand anpassen</CardTitle>
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
                  <label className="block text-sm font-medium mb-1">Aktueller Bestand</label>
                  <p className="text-lg font-bold">
                    {parseFloat(selectedProduct.stockQuantity).toFixed(2)} {selectedProduct.unit}
                  </p>
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Art der Anpassung</label>
                  <select
                    className="w-full h-10 border rounded-md px-3"
                    value={adjustForm.changeType}
                    onChange={(e) => setAdjustForm({ ...adjustForm, changeType: e.target.value })}
                  >
                    <option value="adjustment">Korrektur (Neuer Bestand)</option>
                    <option value="purchase">Einkauf (zug受加了)</option>
                    <option value="return">Retoure (zug受加了)</option>
                    <option value="initial">Erstbestand</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Menge</label>
                  <Input
                    type="number"
                    step="0.01"
                    value={adjustForm.quantity}
                    onChange={(e) => setAdjustForm({ ...adjustForm, quantity: e.target.value })}
                    placeholder={
                      adjustForm.changeType === "adjustment"
                        ? "Neuer Gesamtbestand"
                        : "Zu- oder Abnahme"
                    }
                    required
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    {adjustForm.changeType === "adjustment"
                      ? "Geben Sie den neuen Gesamtbestand ein"
                      : "Positive Zahl für Zugang, negative für Abgang"}
                  </p>
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Notiz (optional)</label>
                  <Input
                    value={adjustForm.notes}
                    onChange={(e) => setAdjustForm({ ...adjustForm, notes: e.target.value })}
                    placeholder="Grund für die Anpassung"
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
                    Abbrechen
                  </Button>
                  <Button type="submit" className="flex-1">
                    Bestand anpassen
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