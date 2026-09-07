"use client"

import { useEffect } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import LanguageSwitcher from "@/components/LanguageSwitcher"
import { useI18n } from "@/components/useI18n"

/**
 * Tier 99 — Global 404 page.
 *
 * Renders when Next.js can't find the
 * route (URL doesn't match any
 * page/route in the App Router). The
 * middleware (src/middleware.ts) does
 * NOT redirect /not-found — Next.js
 * renders this file directly with a
 * 404 HTTP status.
 *
 * v1: minimal — a Card with the
 * title + subtitle + a "Zur Startseite"
 * button + the language switcher. The
 * user can also hit "back" via the
 * browser button. We don't add a search
 * box here (different feature — out of
 * scope for the polish tier).
 */
export default function NotFound() {
  const { t } = useI18n()
  const router = useRouter()

  // Log 404 to console for debugging —
  // some monitoring tools pick this up.
  useEffect(() => {
     
    console.warn("[404]", typeof window !== "undefined" ? window.location.pathname : "(SSR)")
  }, [])

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900 p-4">
      <Card className="max-w-md w-full" data-testid="not-found-page">
        <CardHeader>
          <div className="flex items-center justify-between mb-2">
            <span className="text-5xl">🔍</span>
            <LanguageSwitcher />
          </div>
          <CardTitle className="text-2xl">
            {t("common.pageNotFound.title")}
          </CardTitle>
          <div className="text-xs font-mono text-gray-500 dark:text-gray-400 mt-1">
            {t("common.pageNotFound.code")}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-gray-600 dark:text-gray-300">
            {t("common.pageNotFound.subtitle")}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              onClick={() => router.push("/dashboard")}
              className="bg-emerald-600 text-white hover:bg-emerald-700"
              data-testid="not-found-go-home"
            >
              🏠 {t("common.pageNotFound.goHome")}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                if (typeof window !== "undefined") {
                  if (window.history.length > 1) {
                    router.back()
                  } else {
                    router.push("/dashboard")
                  }
                }
              }}
              data-testid="not-found-go-back"
            >
              ← {t("common.pageNotFound.goBack")}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
