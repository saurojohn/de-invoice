"use client"

import { useEffect, useState } from "react"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import LanguageSwitcher from "@/components/LanguageSwitcher"
import LoginForm from "@/components/LoginForm"
import { useI18n } from "@/components/useI18n"
import { hasSession } from "@/lib/auth"
import { useRegistrationOpen } from "@/lib/registration"

export default function HomePage() {
  const { t } = useI18n()
  // Tier 819: signed in (a session from the last login in this browser) — then
  // the page offers the dashboard instead of the form. Read after mount: the
  // server renders no localStorage. (It was a state nothing ever set to true.)
  const [isLoggedIn, setIsLoggedIn] = useState(false)
  // Tier 820: closed after the first company — then no offer to register
  const registrationOpen = useRegistrationOpen()
  useEffect(() => {
    setIsLoggedIn(hasSession())
  }, [])
  const toLogin = () => {
    const el = document.getElementById("login")
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" })
    document.getElementById("email")?.focus({ preventScroll: true })
  }

  return (
    <main className="min-h-screen bg-gray-50 dark:bg-gray-900">
      {/* Header */}
      <header className="bg-white dark:bg-gray-800 border-b">
        <div className="container mx-auto px-4 py-4 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl sm:text-2xl font-bold text-blue-600">
            {t("common.appName")}
          </h1>
          <nav className="flex flex-wrap gap-2 sm:gap-4 items-center">
            <LanguageSwitcher />
            {!isLoggedIn ? (
              <>
                <Button variant="ghost" onClick={toLogin}>
                  {t("auth.login")}
                </Button>
                {registrationOpen && (
                  <Button onClick={() => window.location.href = '/register'}>
                    {t("auth.register")}
                  </Button>
                )}
              </>
            ) : (
              <Button onClick={() => window.location.href = '/dashboard'} data-testid="home-to-dashboard">
                {t("home.toDashboard")}
              </Button>
            )}
          </nav>
        </div>
      </header>

      {/* Hero Section — Tier 819: with the sign-in form beside it */}
      <section className="py-12 md:py-20">
        <div className="container mx-auto px-4 grid gap-10 md:grid-cols-2 md:items-center">
          <div className="text-center md:text-left">
          <h2 className="text-3xl md:text-4xl font-bold text-gray-900 dark:text-gray-100 mb-4">
            {t("home.heroTitle")}
          </h2>
          <p className="text-lg md:text-xl text-gray-600 dark:text-gray-300 mb-8 max-w-2xl mx-auto md:mx-0">
            {t("home.heroSubtitle")}
          </p>
          <div className="flex flex-wrap gap-4 justify-center md:justify-start">
            {registrationOpen && (
              <Button size="lg" onClick={() => window.location.href = '/register'}>
                {t("home.startFree")}
              </Button>
            )}
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
          <Card id="login" className="w-full max-w-md mx-auto scroll-mt-24 order-first md:order-none" data-testid="home-login">
            <CardHeader>
              <CardTitle className="text-center text-2xl">{t("auth.loginTitle")}</CardTitle>
            </CardHeader>
            <CardContent>
              {isLoggedIn ? (
                <div className="space-y-4 text-center">
                  <p className="text-gray-600 dark:text-gray-300">{t("home.signedIn")}</p>
                  <Button className="w-full" onClick={() => window.location.href = '/dashboard'}>
                    {t("home.toDashboard")}
                  </Button>
                </div>
              ) : (
                <LoginForm />
              )}
            </CardContent>
          </Card>
        </div>
      </section>

      {/* Features Grid */}
      <section id="features" className="py-16 bg-white dark:bg-gray-800 scroll-mt-16">
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
                <p className="text-gray-600 dark:text-gray-300">{t("home.featureInvoiceDesc")}</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>{t("home.featureAccountingTitle")}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-gray-600 dark:text-gray-300">{t("home.featureAccountingDesc")}</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>{t("home.featureVatTitle")}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-gray-600 dark:text-gray-300">{t("home.featureVatDesc")}</p>
              </CardContent>
            </Card>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="py-8 text-center text-gray-500 dark:text-gray-400">
        <p>© {new Date().getFullYear()} {t("common.appName")}. {t("home.footer")}</p>
      </footer>
    </main>
  )
}