"use client"

/**
 * Tier 66: MandantSwitcher — multi-tenant dropdown in the dashboard header.
 *
 * For a Berater (Steuerberater) who manages multiple companies
 * ("Mandanten"), this component renders a dropdown that lists every
 * company the user has access to (via the UserCompany join table).
 * Clicking an entry:
 *   1. POSTs to /api/v1/users/me/switch-company
 *   2. On success, updates the x-company-id cookie (via
 *      document.cookie) AND the localStorage entry
 *   3. Triggers a full page reload so every server-rendered /
 *      client-rendered piece picks up the new Mandant
 *
 * The page reload is the simplest way to invalidate every cached
 * fetch (React Query, useState, useEffect, etc.) without writing
 * a "Mandant context provider" + threading it through every page.
 * For Berater who switch Mandant a few times a day, the ~1s reload
 * is acceptable.
 *
 * For a single-Mandant user (1 grant), we still render the
 * dropdown so the user knows what Mandant they're in, but the
 * dropdown shows just the current company — no switching UI.
 *
 * Why dropdown vs. tab nav vs. global header strip: dropdown
 * mirrors the "Mandant wechseln" pattern in every German ERP
 * (DATEV, Lexware, sevDesk, etc.) — the user is trained to look
 * top-right for Mandant switching.
 */

import { useEffect, useState } from "react"
import { apiGet, apiPost } from "@/lib/api"
import { useI18n } from "@/components/useI18n"

interface AccessibleCompany {
  id: string
  name: string
  legalName: string | null
  email: string | null
  role: string
  isActive: boolean
}

interface AccessibleCompaniesResponse {
  activeCompanyId: string | null
  companies: AccessibleCompany[]
}

export default function MandantSwitcher() {
  const { t } = useI18n()
  const [data, setData] = useState<AccessibleCompaniesResponse | null>(null)
  const [open, setOpen] = useState(false)
  const [switching, setSwitching] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    // Fetch the user's accessible companies on mount.
    // We tolerate failure (a missing endpoint before
    // the backend restart completes, for example) —
    // the dropdown just doesn't render.
    apiGet<AccessibleCompaniesResponse>(
      `/api/v1/users/me/companies`,
    )
      .then((d) => setData(d))
      .catch((e) => {
        console.warn("MandantSwitcher load failed:", e)
      })
  }, [])

  if (!data) return null
  const active = data.companies.find((c) => c.isActive) || null

  const handleSwitch = async (targetId: string) => {
    if (targetId === data.activeCompanyId) {
      setOpen(false)
      return
    }
    setSwitching(true)
    setError(null)
    try {
      await apiPost(`/api/v1/users/me/switch-company`, {
        companyId: targetId,
      })
      // Update both the cookie (for the Next.js
      // middleware) AND localStorage (for the
      // apiFetch helper) so both layers see the
      // new Mandant on the next request.
      document.cookie = `x-company-id=${targetId}; path=/; max-age=86400; SameSite=Lax`
      localStorage.setItem("companyId", targetId)
      // Reload — every cached fetch (React Query,
      // useState, etc.) needs to re-fetch with
      // the new Mandant.
      window.location.reload()
    } catch (e: any) {
      setError(e?.message || t("common.error") || "Fehler")
      setSwitching(false)
    }
  }

  // Single-Mandant: just show the current company
  // name as a label, no dropdown.
  if (data.companies.length === 1) {
    return (
      <span
        className="text-xs text-gray-500 dark:text-gray-400"
        data-testid="mandant-switcher-single"
      >
        {active?.name}
      </span>
    )
  }

  return (
    <div className="relative" data-testid="mandant-switcher">
      <button
        onClick={() => setOpen(!open)}
        disabled={switching}
        className="text-xs px-2 py-1 rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-1"
        data-testid="mandant-switcher-button"
      >
        🏢 {active?.name || t("mandant.choose") || "Mandant wählen"}
        <span aria-hidden>▾</span>
      </button>
      {open && (
        <div
          className="absolute right-0 top-full mt-1 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded shadow-lg min-w-[200px] z-50"
          data-testid="mandant-switcher-dropdown"
        >
          {data.companies.map((c) => (
            <button
              key={c.id}
              onClick={() => handleSwitch(c.id)}
              disabled={switching}
              data-testid="mandant-switcher-option"
              data-mandant-id={c.id}
              className={`w-full text-left px-3 py-2 text-sm hover:bg-blue-50 dark:hover:bg-blue-900/30 flex items-center justify-between ${
                c.isActive
                  ? "bg-blue-50 dark:bg-blue-900/20 font-medium"
                  : ""
              }`}
            >
              <span>
                {c.name}
                {c.role && (
                  <span className="ml-2 text-xs text-gray-500">
                    ({c.role})
                  </span>
                )}
              </span>
              {c.isActive && <span className="text-blue-600">✓</span>}
            </button>
          ))}
          {error && (
            <p
              className="px-3 py-2 text-xs text-red-600 border-t"
              data-testid="mandant-switcher-error"
            >
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
