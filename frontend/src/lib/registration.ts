"use client"

/**
 * Tier 820 — whether this installation takes new registrations
 * (GET /auth/registration, public). `null` until it answers: the offer to
 * register is not shown before it is known (backend/…/auth/registration.ts).
 */
import { useEffect, useState } from "react"
import { API_BASE } from "@/lib/api"

export function useRegistrationOpen(): boolean | null {
  const [open, setOpen] = useState<boolean | null>(null)
  useEffect(() => {
    let alive = true
    fetch(`${API_BASE}/api/v1/auth/registration`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (alive) setOpen(d ? d.open === true : true) })
      .catch(() => { if (alive) setOpen(true) })
    return () => { alive = false }
  }, [])
  return open
}
