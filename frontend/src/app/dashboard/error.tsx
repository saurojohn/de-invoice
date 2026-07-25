"use client"

import { useEffect } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { useI18n } from "@/components/useI18n"

/**
 * Tier 99 — Dashboard error boundary.
 *
 * Catches unhandled client-side errors
 * in the /dashboard sub-tree. Renders
 * a contextual recovery path ("back to
 * dashboard") instead of the global
 * 500 page's "back to home".
 *
 * Note: this MUST be a client
 * component (App Router rule for
 * error boundaries). The "use client"
 * directive at the top is required.
 */
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  const { t } = useI18n()
  const router = useRouter()

  useEffect(() => {
    // eslint-disable-next-line no-console
    console.error("[dashboard-error]", error)
  }, [error])

  return (
    <div
      className="p-6 max-w-2xl mx-auto"
      data-testid="dashboard-error-page"
    >
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-8 text-center border border-red-200 dark:border-red-700">
        <div className="text-6xl mb-4">⚠️</div>
        <h1 className="text-2xl font-bold mb-2 text-gray-800 dark:text-gray-100">
          {t("common.serverError.title")}
        </h1>
        <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">
          {t("common.serverError.subtitle")}
        </p>
        {error.digest && (
          <div
            className="text-xs font-mono text-gray-500 dark:text-gray-400 mb-4"
            data-testid="dashboard-error-digest"
          >
            {t("common.serverError.code")} ({error.digest})
          </div>
        )}
        {process.env.NODE_ENV !== "production" && error.message && (
          <pre
            className="text-xs bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-700 rounded p-2 mb-4 overflow-auto max-h-40 text-left"
            data-testid="dashboard-error-message"
          >
            {error.message}
          </pre>
        )}
        <div className="flex justify-center gap-2">
          <Button
            type="button"
            onClick={() => reset()}
            className="bg-emerald-600 text-white hover:bg-emerald-700"
            data-testid="dashboard-error-retry"
          >
            ↻ {t("common.serverError.retry")}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => router.push("/dashboard")}
          >
            🏠 {t("common.pageNotFound.goHome")}
          </Button>
        </div>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-4">
          {t("common.serverError.contactSupport")}
        </p>
      </div>
    </div>
  )
}
