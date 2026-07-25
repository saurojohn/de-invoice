"use client"

import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { useI18n } from "@/components/useI18n"

/**
 * Tier 99 — Dashboard-specific 404.
 *
 * Renders when a child route under
 * /dashboard/* doesn't exist
 * (e.g. /dashboard/invoices/99999 — a
 * non-existent invoice ID). The global
 * not-found.tsx would also handle this,
 * but having a dashboard-specific
 * boundary lets us show a more
 * contextual recovery path: "go back
 * to the dashboard" instead of "go to
 * the home page".
 *
 * Note: Next.js auto-discovers this
 * file as the not-found boundary for
 * the /dashboard sub-tree.
 */
export default function DashboardNotFound() {
  const { t } = useI18n()
  const router = useRouter()
  return (
    <div
      className="p-6 max-w-2xl mx-auto"
      data-testid="dashboard-not-found-page"
    >
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-8 text-center">
        <div className="text-6xl mb-4">🔍</div>
        <h1 className="text-2xl font-bold mb-2 text-gray-800 dark:text-gray-100">
          {t("common.pageNotFound.title")}
        </h1>
        <p className="text-sm text-gray-600 dark:text-gray-300 mb-6">
          {t("common.pageNotFound.subtitle")}
        </p>
        <div className="flex justify-center gap-2">
          <Button
            type="button"
            onClick={() => router.push("/dashboard")}
            className="bg-emerald-600 text-white hover:bg-emerald-700"
            data-testid="dashboard-not-found-home"
          >
            🏠 {t("common.pageNotFound.goHome")}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              if (typeof window !== "undefined" && window.history.length > 1) {
                router.back()
              } else {
                router.push("/dashboard")
              }
            }}
          >
            ← {t("common.pageNotFound.goBack")}
          </Button>
        </div>
      </div>
    </div>
  )
}
