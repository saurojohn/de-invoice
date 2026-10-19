"use client"

/**
 * Tier 131: customer-facing portal login page.
 *
 * Tier 703: the owner, 19.10.2026 („2“) — a customer no longer asks for a
 * portal link with an e-mail address. The company sends the link (customer
 * page → „Portal-Login senden“) or a payment link for one invoice. This page
 * is where an expired or invalid link leads; it says how access is given.
 */
import { useI18n } from "@/components/useI18n"

export default function PortalLoginPage() {
  const { t } = useI18n()
  return (
    <main className="min-h-screen bg-gradient-to-b from-gray-50 to-gray-100 dark:from-gray-900 dark:to-gray-800 flex items-center justify-center p-4">
      <div className="max-w-md w-full bg-white dark:bg-gray-800 shadow-lg rounded-lg p-8">
        <div className="text-center mb-6">
          <div className="text-3xl mb-2">📬</div>
          <h1
            className="text-2xl font-bold text-gray-900 dark:text-gray-100"
            data-testid="portal-login-title"
          >
            {t("portal.loginTitle")}
          </h1>
        </div>
        <p className="text-sm text-gray-700 dark:text-gray-300" data-testid="portal-login-closed">
          {t("portal.accessByLink")}
        </p>
        <p className="mt-6 text-xs text-gray-400 dark:text-gray-500 text-center">
          {t("portal.secureNote")}
        </p>
      </div>
    </main>
  )
}
