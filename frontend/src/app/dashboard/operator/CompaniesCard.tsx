"use client"

/**
 * Tier 823 — the companies on the installation (GET /admin/companies), on
 * „Systembetrieb“: newest first, searchable by name or an admin's address,
 * fifty at a time. Shown by the operator page only, after /auth/me.
 */
import { useCallback, useEffect, useRef, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { L, useI18n } from "@/components/useI18n"
import { apiGet } from "@/lib/api"

interface CompanyRow {
  id: string
  name: string
  createdAt: string
  closedAt: string | null
  origin: "operator" | "invite" | "registration"
  invitedEmail: string | null
  members: number
  admins: string[]
  invoices: number
  lastLogin: string | null
}
interface CompaniesResponse {
  total: number
  totals: { companies: number; open: number; users: number }
  companies: CompanyRow[]
}

const PAGE = 50

function fill(text: string, values: Record<string, string | number>): string {
  return Object.entries(values).reduce((out, [k, v]) => out.split("{" + k + "}").join(String(v)), text)
}

export default function CompaniesCard() {
  const { getDateLocale } = useI18n()
  const [q, setQ] = useState("")
  const [data, setData] = useState<CompaniesResponse | null>(null)
  const [failed, setFailed] = useState(false)
  const [loading, setLoading] = useState(false)
  const asked = useRef(0)

  const load = useCallback(async (term: string, skip: number) => {
    const n = ++asked.current
    setLoading(true)
    try {
      const params = new URLSearchParams({ skip: String(skip), take: String(PAGE) })
      if (term.trim()) params.set("q", term.trim())
      const r = await apiGet<CompaniesResponse>("/api/v1/admin/companies?" + params.toString())
      if (n !== asked.current) return // a newer search has been sent
      setFailed(false)
      setData((prev) => (skip > 0 && prev ? { ...r, companies: [...prev.companies, ...r.companies] } : r))
    } catch {
      if (n === asked.current) setFailed(true)
    } finally {
      if (n === asked.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    const timer = setTimeout(() => load(q, 0), q ? 300 : 0)
    return () => clearTimeout(timer)
  }, [q, load])

  const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(getDateLocale()) : "—")
  const origin = (c: CompanyRow) =>
    c.origin === "operator" ? L("Betreiber") : c.origin === "invite" ? fill(L("Einladung an {email}"), { email: c.invitedEmail || "" }) : L("Registrierung")

  return (
    <Card data-testid="operator-companies">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{L("Firmen auf diesem Server")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {data && (
          <p className="text-gray-600 dark:text-gray-300" data-testid="operator-companies-summary">
            {/* Tier 825: „1 Firma" (was „1 Firmen") */}
            {fill(data.totals.companies === 1 ? L("1 Firma, davon {open} aktiv · {users} Benutzer") : L("{companies} Firmen, davon {open} aktiv · {users} Benutzer"), data.totals)}
          </p>
        )}
        <Input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={L("Firma oder E-Mail-Adresse suchen")}
          aria-label={L("Firma oder E-Mail-Adresse suchen")}
          maxLength={100}
          data-testid="operator-companies-search"
        />
        {failed && <p className="text-red-600 dark:text-red-400">{L("Konnte nicht abgerufen werden.")}</p>}
        {data && data.companies.length === 0 && !loading && (
          <p className="text-gray-500 dark:text-gray-400" data-testid="operator-companies-empty">{L("Keine Firma gefunden.")}</p>
        )}
        {data && data.companies.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="operator-companies-table">
              <thead>
                <tr className="border-b border-gray-200 dark:border-gray-700 text-left text-gray-500 dark:text-gray-400">
                  <th className="py-2 pr-3 font-medium">{L("Firma")}</th>
                  <th className="py-2 pr-3 font-medium">{L("Angelegt")}</th>
                  <th className="py-2 pr-3 font-medium">{L("Herkunft")}</th>
                  <th className="py-2 pr-3 font-medium">{L("Administrator")}</th>
                  <th className="py-2 pr-3 font-medium text-right">{L("Benutzer")}</th>
                  <th className="py-2 pr-3 font-medium text-right">{L("Rechnungen")}</th>
                  <th className="py-2 pr-3 font-medium">{L("Letzte Anmeldung")}</th>
                </tr>
              </thead>
              <tbody>
                {data.companies.map((c) => (
                  <tr key={c.id} className="border-b border-gray-100 dark:border-gray-800 align-top" data-testid="operator-companies-row" data-origin={c.origin}>
                    <td className="py-2 pr-3">
                      <span className="font-medium">{c.name}</span>
                      {c.closedAt && (
                        <span className="ml-2 rounded bg-gray-200 dark:bg-gray-700 px-1.5 py-0.5 text-xs">{L("geschlossen")}</span>
                      )}
                    </td>
                    <td className="py-2 pr-3 whitespace-nowrap">{day(c.createdAt)}</td>
                    <td className="py-2 pr-3 break-all">{origin(c)}</td>
                    <td className="py-2 pr-3 break-all">{c.admins.join(", ") || "—"}</td>
                    <td className="py-2 pr-3 text-right">{c.members}</td>
                    <td className="py-2 pr-3 text-right">{c.invoices}</td>
                    <td className="py-2 pr-3 whitespace-nowrap">{day(c.lastLogin)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data && data.companies.length < data.total && (
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="outline" size="sm" disabled={loading} onClick={() => load(q, data.companies.length)} data-testid="operator-companies-more">
              {L("Weitere laden")}
            </Button>
            <span className="text-gray-500 dark:text-gray-400">
              {fill(L("{shown} von {total} angezeigt"), { shown: data.companies.length, total: data.total })}
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
