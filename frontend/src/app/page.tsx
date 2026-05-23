"use client"

import { useState } from "react"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

export default function HomePage() {
  const [isLoggedIn, setIsLoggedIn] = useState(false)

  return (
    <main className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <h1 className="text-2xl font-bold text-blue-600">德国发票系统</h1>
          <nav className="flex gap-4">
            {!isLoggedIn ? (
              <>
                <Button variant="ghost" onClick={() => window.location.href = '/login'}>
                  登录
                </Button>
                <Button onClick={() => window.location.href = '/register'}>
                  注册
                </Button>
              </>
            ) : (
              <Button variant="outline" onClick={() => setIsLoggedIn(false)}>
                退出
              </Button>
            )}
          </nav>
        </div>
      </header>

      {/* Hero Section */}
      <section className="py-20 text-center">
        <div className="container mx-auto px-4">
          <h2 className="text-4xl font-bold text-gray-900 mb-4">
            专业的德国发票管理解决方案
          </h2>
          <p className="text-xl text-gray-600 mb-8 max-w-2xl mx-auto">
            符合GoBD规范，支持XRechnung和ZUGFeRD标准，
            助您轻松管理欧盟发票和税务申报
          </p>
          <div className="flex gap-4 justify-center">
            <Button size="lg" onClick={() => window.location.href = '/register'}>
              免费开始
            </Button>
            <Button size="lg" variant="outline">
              了解更多
            </Button>
          </div>
        </div>
      </section>

      {/* Features Grid */}
      <section className="py-16 bg-white">
        <div className="container mx-auto px-4">
          <h3 className="text-3xl font-bold text-center mb-12">核心功能</h3>
          <div className="grid md:grid-cols-3 gap-8">
            <Card>
              <CardHeader>
                <CardTitle>发票管理</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-gray-600">
                  支持多种发票类型，自动编号，批量操作，
                  符合德国法律要求
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>会计核算</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-gray-600">
                  完整的复式记账，科目表管理，
                  自动生成会计凭证
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>VAT申报</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-gray-600">
                  实时VAT计算，支持欧盟多国税率，
                  自动生成申报报表
                </p>
              </CardContent>
            </Card>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="py-8 text-center text-gray-500">
        <p>© 2026 德国发票系统. 保留所有权利.</p>
      </footer>
    </main>
  )
}
