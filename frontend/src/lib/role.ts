"use client"

/**
 * Tier 813 — the signed-in user's role in the active company, for showing
 * only the actions the backend allows (users.service.ts `can`: viewer <
 * accountant < admin; a Berater ranks as accountant; an auditor reads only).
 * `null` until /auth/me answers: nothing is hidden then, so an admin's page
 * does not flicker. The backend refuses either way — this only spares a
 * button that answers „Ihre Rolle reicht nicht aus".
 */
import { useEffect, useState } from "react"
import { apiGet } from "@/lib/api"

export type RoleLevel = "accountant" | "admin"

export function useRole(): string | null {
  const [role, setRole] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    apiGet<{ role?: string }>("/api/v1/auth/me")
      .then((me) => { if (alive) setRole(me?.role || null) })
      .catch(() => undefined)
    return () => { alive = false }
  }, [])
  return role
}

export function roleCan(role: string | null, level: RoleLevel): boolean {
  if (role === null) return true
  const effective = role === "berater" ? "accountant" : role
  const rank: Record<string, number> = { viewer: 0, accountant: 1, admin: 2 }
  return (rank[effective] ?? -1) >= rank[level]
}
