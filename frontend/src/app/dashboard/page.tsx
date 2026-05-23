"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"

interface Stats {
  invoicesCount: number
  customersCount: number
  totalRevenue: number
  overdueAmount: number
}

export default function DashboardPage() {
  const router = useRouter()
  const [stats, setStats] = useState<Stats>({ invoicesCount: 0, customersCount: 0, totalRevenue: 0, overdueAmount: 0 })
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const companyId = localStorage.getItem("companyId")
    if (!companyId) {
      router.push("/login")
      return
    }

    // 获取统计数据
    fetch(`http://localhost:3001/api/v1/invoices?companyId=${companyId}`)
      .then((res) => res.json())
      .then((invoices) => {
        const overdue = invoices
          .filter((inv: any) => inv.status === "overdue")
          .reduce((sum: number, inv: any) => sum + Number(inv.total), 0)
        const revenue = invoices
          .filter((inv: any) => inv.status === "paid")
          .reduce((sum: number, inv: any) => sum + Number(inv.total), 0)
        setStats({
          invoicesCount: invoices.length,
          customersCount: 0,
          totalRevenue: revenue,
          overdueAmount: overdue,
        })
      })
      .finally(() => setLoading(false))
  }, [router])

  const handleLogout = () => {
    localStorage.clear()
    router.push("/")
  }

  return (
    <main className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b shadow-sm">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <h1 className="text-2xl font-bold text-blue-600">德国发票系统</h1>
          <div className="flex gap-4 items-center">
            <span className="text-gray-600">仪表盘</span>
            <Button variant="outline" onClick={handleLogout}>退出</Button>
          </div>
        </div>
      </header>

      {/* Content */}
      <div className="container mx-auto px-4 py-8">
        <h2 className="text-2xl font-bold mb-6">概览</h2>

        {/* Stats Grid */}
        <div className="grid md:grid-cols-4 gap-6 mb-8">
          <Card>
            <CardContent className="pt-6">
              <div className="text-3xl font-bold text-blue-600">{stats.invoicesCount}</div>
              <div className="text-gray-600">发票总数</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="text-3xl font-bold text-green-600">
                €{stats.totalRevenue.toFixed(2)}
              </div>
              <div className="text-gray-600">已收款</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="text-3xl font-bold text-orange-600">
                €{stats.overdueAmount.toFixed(2)}
              </div>
              <div className="text-gray-600">逾期金额</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="text-3xl font-bold text-purple-600">{stats.customersCount}</div>
              <div className="text-gray-600">客户数量</div>
            </CardContent>
          </Card>
        </div>

        {/* Quick Actions */}
        <div className="grid md:grid-cols-3 gap-6">
          <Card className="cursor-pointer hover:shadow-lg transition" onClick={() => router.push("/dashboard/invoices")}>
            <CardHeader>
              <CardTitle>发票管理</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-gray-600 mb-4">创建、编辑和发送发票</p>
              <Button>管理发票</Button>
            </CardContent>
          </Card>
          <Card className="cursor-pointer hover:shadow-lg transition" onClick={() => router.push("/dashboard/customers")}>
            <CardHeader>
              <CardTitle>客户管理</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-gray-600 mb-4">管理客户信息和联系方式</p>
              <Button>管理客户</Button>
            </CardContent>
          </Card>
          <Card className="cursor-pointer hover:shadow-lg transition" onClick={() => router.push("/dashboard/products")}>
            <CardHeader>
              <CardTitle>商品管理</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-gray-600 mb-4">管理商品目录和定价</p>
              <Button>管理商品</Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </main>
  )
}
