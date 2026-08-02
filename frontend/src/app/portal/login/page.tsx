"use client"

/**
 * Tier 131: customer-facing portal login page.
 *
 * Public — no admin auth required. The customer types
 * their email, we POST /customer-portal/request-session,
 * and we show a "we've sent you a link" message. The
 * actual link arrives by email (NO-SMTP in dev logs
 * the URL to the backend stdout; the test reads it
 * from there).
 *
 * We deliberately don't show "no such email" — an
 * attacker who knows the customer email list could
 * otherwise probe. The API also returns 200 OK for
 * unknown emails (silent no-op).
 *
 * Rate limiting: the backend caps at 5 requests per
 * 5 min per email. We surface the 400 from the API
 * as a friendly "wait a few minutes" message.
 *
 * i18n: reuses the existing customer.* / portal.* keys
 * where possible. Adds 2 new keys (portal.loginTitle /
 * portal.checkEmail).
 */
import { useState } from "react"
import { useRouter } from "next/navigation"
import { apiPost, ApiError } from "@/lib/api"
import { useI18n } from "@/components/useI18n"

export default function PortalLoginPage() {
  const router = useRouter()
  const { t } = useI18n()
  const [email, setEmail] = useState("")
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!email || sending) return
    setSending(true)
    setError(null)
    try {
      await apiPost(
        `/api/v1/customer-portal/request-session?email=${encodeURIComponent(email)}`,
      )
      setSent(true)
    } catch (err) {
      // The backend rate-limits to 5 requests per
      // 5 min per email. Map 400 to a friendly
      // message; show the raw error otherwise.
      if (err instanceof ApiError && err.status === 400) {
        setError(t("portal.tooManyRequests") || "Zu viele Anfragen. Bitte warten Sie 5 Minuten.")
      } else {
        setError(err instanceof ApiError ? err.message : String(err))
      }
    } finally {
      setSending(false)
    }
  }

  return (
    <main className="min-h-screen bg-gradient-to-b from-gray-50 to-gray-100 dark:from-gray-900 dark:to-gray-800 flex items-center justify-center p-4">
      <div className="max-w-md w-full bg-white dark:bg-gray-800 shadow-lg rounded-lg p-8">
        <div className="text-center mb-6">
          <div className="text-3xl mb-2">📬</div>
          <h1
            className="text-2xl font-bold text-gray-900 dark:text-gray-100"
            data-testid="portal-login-title"
          >
            {t("portal.loginTitle") || "Kundenportal-Login"}
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-2">
            {t("portal.loginSubtitle") || "Geben Sie Ihre E-Mail-Adresse ein, um einen Login-Link anzufordern."}
          </p>
        </div>

        {sent ? (
          <div
            data-testid="portal-sent-message"
            className="bg-emerald-50 dark:bg-emerald-900/30 border border-emerald-200 dark:border-emerald-700 text-emerald-800 dark:text-emerald-200 rounded-md p-4 text-sm"
          >
            <strong>{t("portal.checkEmail") || "Prüfen Sie Ihr Postfach"}</strong>
            <p className="mt-2">
              {t("portal.checkEmailDesc") ||
                "Wir haben Ihnen einen Login-Link an die angegebene Adresse gesendet. Der Link ist 30 Tage gültig."}
            </p>
            <button
              onClick={() => {
                setSent(false)
                setEmail("")
              }}
              className="mt-3 text-xs text-emerald-700 dark:text-emerald-300 underline"
            >
              {t("portal.sendAnother") || "Andere E-Mail verwenden"}
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit}>
            <label
              htmlFor="portal-email"
              className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
            >
              {t("portal.emailLabel") || "E-Mail-Adresse"}
            </label>
            <input
              id="portal-email"
              type="email"
              required
              autoComplete="email"
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full border border-gray-300 dark:border-gray-600 rounded-md px-3 py-2 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              placeholder="kunde@example.com"
              data-testid="portal-email-input"
            />
            <button
              type="submit"
              disabled={sending || !email}
              className="mt-4 w-full bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 text-white font-medium rounded-md px-4 py-2 text-sm transition-colors"
              data-testid="portal-submit-button"
            >
              {sending
                ? (t("portal.sending") || "Sende...")
                : (t("portal.sendLogin") || "Login-Link anfordern")}
            </button>
            {error && (
              <p
                data-testid="portal-error"
                className="mt-3 text-sm text-red-600 dark:text-red-400"
              >
                {error}
              </p>
            )}
          </form>
        )}

        <p className="mt-6 text-xs text-gray-400 dark:text-gray-500 text-center">
          {t("portal.secureNote") || "Sicherheit: Der Login-Link funktioniert nur in diesem Browser und läuft nach 30 Tagen ab."}
        </p>
      </div>
    </main>
  )
}
