"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"

interface Customer {
  id: string
  name: string
}

export default function CreateInvoicePage() {
  const router = useRouter()
  const [customers, setCustomers] = useState<Customer[]>([])
  const [form, setForm] = useState({
    customerId: "",
    issueDate: new Date().toISOString().split("T")[0],
    dueDate: "",
    notes: "",
    items: [{ description: "", quantity: 1, unitPrice: 0, vatRate: 0.19 }],
  })
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    const companyId = localStorage.getItem("companyId")
    if (!companyId) {
      router.push("/login")
      return
    }

    // 获取客户列表
    fetch(`http://localhost:3001/api/v1/customers?companyId=${companyId}`)
      .then((res) => res.json())
      .then(setCustomers)
  }, [router])

  const addItem = () => {
    setForm({
      ...form,
      items: [...form.items, { description: "", quantity: 1, unitPrice: 0, vatRate: 0.19 }],
    })
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)

    try {
      const companyId = localStorage.getItem("companyId")
      const res = await fetch(`http://localhost:3001/api/v1/invoices?companyId=${companyId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      })

      if (res.ok) {
        router.push("/dashboard/invoices")
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="min-h-screen bg-gray-50">
      <header className="bg-white border-b shadow-sm">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <h1 className="text-2xl font-bold text-blue-600">创建发票</h1>
          <Button variant="outline" onClick={() => router.push("/dashboard/invoices")}>取消</Button>
        </div>
      </header>

      <div className="container mx-auto px-4 py-8 max-w-3xl">
        <form onSubmit={handleSubmit} className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>基本信息</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">客户</label>
                <select
                  className="w-full h-10 border rounded-md px-3"
                  value={form.customerId}
                  onChange={(e) => setForm({ ...form, customerId: e.target.value })}
                  required
                >
                  <option value="">选择客户</option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>
              <div className="grid md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-1">开票日期</label>
                  <Input
                    type="date"
                    value={form.issueDate}
                    onChange={(e) => setForm({ ...form, issueDate: e.target.value })}
                    required
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">到期日期</label>
                  <Input
                    type="date"
                    value={form.dueDate}
                    onChange={(e) => setForm({ ...form, dueDate: e.target.value })}
                    required
                  />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle>项目明细</CardTitle>
              <Button type="button" variant="outline" size="sm" onClick={addItem}>添加项目</Button>
            </CardHeader>
            <CardContent className="space-y-4">
              {form.items.map((item, index) => (
                <div key={index} className="grid md:grid-cols-5 gap-2 items-end">
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">描述</label>
                    <Input
                      value={item.description}
                      onChange={(e) => {
                        const items = [...form.items]
                        items[index].description = e.target.value
                        setForm({ ...form, items })
                      }}
                      placeholder="商品/服务描述"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">数量</label>
                    <Input
                      type="number"
                      min="1"
                      value={item.quantity}
                      onChange={(e) => {
                        const items = [...form.items]
                        items[index].quantity = Number(e.target.value)
                        setForm({ ...form, items })
                      }}
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">单价</label>
                    <Input
                      type="number"
                      step="0.01"
                      value={item.unitPrice}
                      onChange={(e) => {
                        const items = [...form.items]
                        items[index].unitPrice = Number(e.target.value)
                        setForm({ ...form, items })
                      }}
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">税率</label>
                    <select
                      className="w-full h-10 border rounded-md px-3"
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
                  <Button type="button" variant="ghost" onClick={() => {
                    const items = form.items.filter((_, i) => i !== index)
                    setForm({ ...form, items })
                  }}>删除</Button>
                </div>
              ))}
            </CardContent>
          </Card>

          <div className="flex gap-4">
            <Button type="submit" className="flex-1" disabled={loading}>
              {loading ? "创建中..." : "创建发票"}
            </Button>
          </div>
        </form>
      </div>
    </main>
  )
}
