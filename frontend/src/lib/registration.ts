"use client"

/**
 * Tier 820 — whether this installation takes new registrations
 * (GET /auth/registration, public). `null` until it answers: the offer to
 * register is not shown before it is known (backend/…/auth/registration.ts).
 * Tier 821: with an invitation to register a company of one's own, the
 * address it is for (null when the token is unknown, used or expired).
 */
import { useEffect, useState } from "react"
import { API_BASE } from "@/lib/api"

export interface RegistrationState {
  open: boolean
  /** Tier 825: the first registration needs the setup link (SETUP_TOKEN) */
  setupRequired: boolean
  invite: { email: string; expiresAt: string } | null
}

export function useRegistrationState(companyInvite?: string): RegistrationState | null {
  const [state, setState] = useState<RegistrationState | null>(null)
  useEffect(() => {
    let alive = true
    const q = companyInvite ? `?invite=${encodeURIComponent(companyInvite)}` : ""
    fetch(`${API_BASE}/api/v1/auth/registration${q}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (alive) setState(d ? { open: d.open === true, setupRequired: d.setupRequired === true, invite: d.invite ?? null } : { open: true, setupRequired: false, invite: null }) })
      .catch(() => { if (alive) setState({ open: true, setupRequired: false, invite: null }) })
    return () => { alive = false }
  }, [companyInvite])
  return state
}

export function useRegistrationOpen(): boolean | null {
  const state = useRegistrationState()
  return state ? state.open : null
}
