"use client"

import { useEffect } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import LanguageSwitcher from "@/components/LanguageSwitcher"
import { useI18n } from "@/components/useI18n"

/**
 * Tier 99 — Global 500 error boundary.
 *
 * Renders when an unhandled error is
 * thrown in any client component under
 * the App Router. The "use client"
 * directive is required for error
 * boundaries (they MUST be client
 * components because they catch
 * render-time errors and need
 * `componentDidCatch` semantics).
 *
 * v1: minimal — title + subtitle + a
 * "retry" button that calls
 * `router.refresh()`. We log the error
 * to console so dev tools pick it up
 * (in production, this would route
 * to Sentry — already wired via the
 * src/lib/sentry.ts init, which
 * auto-instruments all throws).
 *
 * Note: this is the GLOBAL error
 * boundary. Per-route boundaries
 * (e.g. /dashboard/error.tsx) wrap
 * the dashboard sub-tree and let us
 * show a more contextual recovery
 * path (e.g. "go back to dashboard").
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  const { t } = useI18n()

  useEffect(() => {
    // Log to console — the Sentry init
    // (src/lib/sentry.ts) hooks into
    // onerror / unhandledrejection and
    // captures this automatically.
    // eslint-disable-next-line no-console
    console.error("[500]", error)
  }, [error])

  return (
    <html lang="de">
      <body>
        <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900 p-4">
          <Card
            className="max-w-md w-full border-red-200 dark:border-red-700"
            data-testid="global-error-page"
          >
            <CardHeader>
              <div className="flex items-center justify-between mb-2">
                <span className="text-5xl">⚠️</span>
                <LanguageSwitcher />
              </div>
              <CardTitle className="text-2xl">
                {t("common.serverError.title")}
              </CardTitle>
              <div className="text-xs font-mono text-gray-500 dark:text-gray-400 mt-1">
                {t("common.serverError.code")}
                {error.digest && (
                  <span className="ml-2" data-testid="error-digest">
                    ({error.digest})
                  </span>
                )}
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-gray-600 dark:text-gray-300">
                {t("common.serverError.subtitle")}
              </p>
              {process.env.NODE_ENV !== "production" && error.message && (
                <pre
                  className="text-xs bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-700 rounded p-2 overflow-auto max-h-40"
                  data-testid="error-message"
                >
                  {error.message}
                </pre>
              )}
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  onClick={() => reset()}
                  className="bg-emerald-600 text-white hover:bg-emerald-700"
                  data-testid="error-retry"
                >
                  ↻ {t("common.serverError.retry")}
                </Button>
              </div>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                {t("common.serverError.contactSupport")}
              </p>
            </CardContent>
          </Card>
        </div>
      </body>
    </html>
  )
}
