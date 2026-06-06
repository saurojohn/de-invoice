"use client"

import { useState } from "react"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import LanguageSwitcher from "@/components/LanguageSwitcher"
import { useI18n } from "@/components/useI18n"

export default function HomePage() {
  const { t } = useI18n()
  const [isLoggedIn, setIsLoggedIn] = useState(false)

  return (
    <main className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <h1 className="text-2xl font-bold text-blue-600">
            {t("common.appName")}
          </h1>
          <nav className="flex gap-4 items-center">
            <LanguageSwitcher />
            {!isLoggedIn ? (
              <>
                <Button variant="ghost" onClick={() => window.location.href = '/login'}>
                  {t("auth.login")}
                </Button>
                <Button onClick={() => window.location.href = '/register'}>
                  {t("auth.register")}
                </Button>
              </>
            ) : (
              <Button variant="outline" onClick={() => setIsLoggedIn(false)}>
                {t("auth.logout")}
              </Button>
            )}
          </nav>
        </div>
      </header>

      {/* Hero Section */}
      <section className="py-20 text-center">
        <div className="container mx-auto px-4">
          <h2 className="text-4xl font-bold text-gray-900 mb-4">
            {t("home.heroTitle")}
          </h2>
          <p className="text-xl text-gray-600 mb-8 max-w-2xl mx-auto">
            {t("home.heroSubtitle")}
          </p>
          <div className="flex gap-4 justify-center">
            <Button size="lg" onClick={() => window.location.href = '/register'}>
              {t("home.startFree")}
            </Button>
            <Button
              size="lg"
              variant="outline"
              onClick={() => {
                const el = document.getElementById('features')
                if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
              }}
            >
              {t("home.learnMore")}
            </Button>
          </div>
        </div>
      </section>

      {/* Features Grid */}
      <section id="features" className="py-16 bg-white scroll-mt-16">
        <div className="container mx-auto px-4">
          <h3 className="text-3xl font-bold text-center mb-12">
            {t("home.coreFeatures")}
          </h3>
          <div className="grid md:grid-cols-3 gap-8">
            <Card>
              <CardHeader>
                <CardTitle>{t("home.featureInvoiceTitle")}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-gray-600">{t("home.featureInvoiceDesc")}</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>{t("home.featureAccountingTitle")}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-gray-600">{t("home.featureAccountingDesc")}</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>{t("home.featureVatTitle")}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-gray-600">{t("home.featureVatDesc")}</p>
              </CardContent>
            </Card>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="py-8 text-center text-gray-500">
        <p>© 2026 {t("common.appName")}. {t("home.footer")}</p>
      </footer>
    </main>
  )
}