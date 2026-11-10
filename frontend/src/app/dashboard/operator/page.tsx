"use client"

/**
 * Tier 822 — „Systembetrieb“: everything the installation's operator looks
 * after, on one page. The operator's functions were spread over the dashboard
 * (two cards), the user page (the registration and the company invitations),
 * the company settings (the storage) and the error page (the notification
 * channels); each area is summarised here with its state and a link to its
 * page, and the registration card is here in full. Tier 823: and the
 * companies on the installation (CompaniesCard).
 *
 * GET /auth/me says whether the session is the operator's; until it has, the
 * page asks for nothing else — a company that is not the operator gets the
 * notice and no request answered 403.
 */
import Link from "next/link"
import { useCallback, useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { L, useI18n } from "@/components/useI18n"
import { apiGet } from "@/lib/api"
import RegistrationCard from "@/components/RegistrationCard"
import CompaniesCard from "./CompaniesCard"

type Health = "green" | "amber" | "red" | "grey"

interface Summary {
  status: "ok" | "degraded" | "down"
  version?: string
  uptimeSec: number
  dbOk: boolean
  storageOk: boolean
  memory: { rssMB: number; heapMB: number }
  /** Tier 828: the running image's commit and build time (the operator's) */
  commit?: string | null
  builtAt?: string | null
}
interface CronRow { name: string; health: Health }
interface BackupStatus {
  db: { configured: boolean; latestAt: string | null; ageHours: number | null; ok: boolean }
  files: { configured: boolean; lastRunAt: string | null; ageHours: number | null; ok: boolean }
  offsite: { configured: boolean; remote: string | null }
  restore?: { lost: unknown[] }
}
interface StorageHealth { localPath: string; reachable: boolean; writable: boolean; freeBytes?: number; freeBytesFormatted?: string }
interface NotificationConfig {
  slack: { configured: boolean; host: string | null }
  email: { configured: boolean; recipients: string[]; smtpHost: string | null }
}

/** Tier 825: the free space with the page's decimal mark („789,61 GB"; the backend's text had a point) */
function free(s: StorageHealth, locale: string): string {
  if (typeof s.freeBytes !== "number") return s.freeBytesFormatted || ""
  const gb = s.freeBytes / 1024 ** 3
  return gb >= 1
    ? gb.toLocaleString(locale, { maximumFractionDigits: 2 }) + " GB"
    : (s.freeBytes / 1024 ** 2).toLocaleString(locale, { maximumFractionDigits: 1 }) + " MB"
}

/** an area's state: what it is, and the lines that say why */
interface Area { health: Health; lines: string[] }
const failed: Area = { health: "grey", lines: [] }

const DOT: Record<Health, string> = {
  green: "bg-green-500",
  amber: "bg-amber-500",
  red: "bg-red-500",
  grey: "bg-gray-400",
}

/** fills the {placeholders} of a sentence L() has looked up */
function F(text: string, values: Record<string, string | number>): string {
  return Object.entries(values).reduce((out, [k, v]) => out.split("{" + k + "}").join(String(v)), text)
}

function lastBackup(configured: boolean, ok: boolean, h: number | null): string {
  if (!configured) return L("nicht eingerichtet")
  const when = h === null ? L("noch keine Sicherung")
    : h < 1 ? L("letzte Sicherung vor weniger als einer Stunde")
    : h < 48 ? F(L("letzte Sicherung vor {n} Std."), { n: Math.round(h) })
    : F(L("letzte Sicherung vor {n} Tagen"), { n: Math.round(h / 24) })
  // Tier 825: „noch keine Sicherung" is the whole story — no „zu alt" after it
  return ok || h === null ? when : F(L("{when} — zu alt"), { when })
}

function uptime(sec: number): string {
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  return d > 0 ? F(L("seit {d} Tagen {h} Std."), { d, h }) : F(L("seit {h} Std. {m} Min."), { h, m: Math.floor((sec % 3600) / 60) })
}

function AreaCard({ id, title, area, href, linkText }: { id: string; title: string; area: Area | null; href?: string; linkText?: string }) {
  return (
    <Card data-testid={`operator-area-${id}`} data-health={area?.health ?? "loading"}>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <span className={"inline-block h-3 w-3 rounded-full " + (area ? DOT[area.health] : "bg-gray-200 dark:bg-gray-700")} aria-hidden />
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1 text-sm text-gray-700 dark:text-gray-300">
        {area === null ? (
          <p className="text-gray-500 dark:text-gray-400">…</p>
        ) : area.lines.length === 0 ? (
          <p className="text-gray-500 dark:text-gray-400">{L("Konnte nicht abgerufen werden.")}</p>
        ) : (
          area.lines.map((line) => <p key={line}>{line}</p>)
        )}
        {href && (
          <div className="pt-2">
            <Link href={href} className="text-blue-600 dark:text-blue-400 hover:underline" data-testid={`operator-link-${id}`}>
              {linkText || L("Öffnen")} →
            </Link>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

export default function OperatorPage() {
  const { getDateLocale } = useI18n() // renders the page again once the language is known (L())
  const [operator, setOperator] = useState<boolean | null>(null)
  const [server, setServer] = useState<Area | null>(null)
  const [jobs, setJobs] = useState<Area | null>(null)
  const [backup, setBackup] = useState<Area | null>(null)
  const [storage, setStorage] = useState<Area | null>(null)
  const [errors, setErrors] = useState<Area | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    const server = apiGet<Summary>("/api/v1/health/summary").then((s): Area => {
      // Tier 828: which code runs — the backend's commit, and the pages' own
      // (built in the same run of infra/prod/build.sh, or not)
      const fe = (process.env.NEXT_PUBLIC_GIT_COMMIT || "").trim().toLowerCase()
      const be = s.commit || ""
      const mismatch = !!fe && !!be && !fe.startsWith(be.slice(0, 7)) && !be.startsWith(fe.slice(0, 7))
      const built = s.builtAt ? new Date(s.builtAt).toLocaleString(getDateLocale(), { dateStyle: "short", timeStyle: "short" }) : ""
      const code = be
        ? F(L("Code {commit}, gebaut {when}"), { commit: be, when: built || "—" })
        : L("Code: unbekannt (nicht mit infra/prod/build.sh gebaut)")
      return {
        health: mismatch ? "amber" : s.status === "ok" ? "green" : s.status === "degraded" ? "amber" : "red",
        lines: [
          (s.status === "ok" ? L("Läuft") : s.status === "degraded" ? L("Eingeschränkt") : L("Gestört")) + (s.version && s.version !== "0.0.0" ? " · " + F(L("Version {v}"), { v: s.version }) : ""),
          code,
          ...(mismatch ? [F(L("Die Seiten sind von {fe}, der Server von {be} — beide neu bauen: bash infra/prod/build.sh backend frontend"), { fe, be })] : []),
          (s.dbOk ? L("Datenbank erreichbar") : L("Datenbank nicht erreichbar")) + " · " + (s.storageOk ? L("Ablage beschreibbar") : L("Ablage nicht beschreibbar")),
          F(L("Läuft {since} · {mb} MB Arbeitsspeicher"), { since: uptime(s.uptimeSec), mb: s.memory.rssMB }),
        ],
      }
    }).catch(() => failed).then(setServer)

    const jobs = Promise.all([
      apiGet<CronRow[]>("/api/v1/admin/cron-health"),
      apiGet<string[]>("/api/v1/admin/cron-health/warnings").catch(() => [] as string[]),
    ]).then(([rows, warnings]): Area => {
      const red = rows.filter((r) => r.health === "red").length
      const amber = rows.filter((r) => r.health === "amber").length
      const green = rows.filter((r) => r.health === "green").length
      return {
        health: red > 0 ? "red" : amber > 0 || warnings.length > 0 ? "amber" : "green",
        lines: [
          F(L("{n} Hintergrundjobs: {green} in Ordnung, {amber} verspätet, {red} fehlgeschlagen"), { n: rows.length, green, amber, red }),
          ...(warnings || []),
        ],
      }
    }).catch(() => failed).then(setJobs)

    const backup = apiGet<BackupStatus>("/api/v1/admin/backups/status").then((b): Area => {
      const lost = b.restore?.lost?.length ?? 0
      const bad = (b.db.configured && !b.db.ok) || (b.files.configured && !b.files.ok)
      return {
        health: bad ? "red" : !b.db.configured || lost > 0 || !b.offsite.configured ? "amber" : "green",
        lines: [
          F(L("Datenbank: {state}"), { state: lastBackup(b.db.configured, b.db.ok, b.db.ageHours) }),
          F(L("Belege: {state}"), { state: lastBackup(b.files.configured, b.files.ok, b.files.ageHours) }),
          F(L("Kopie außer Haus: {state}"), { state: b.offsite.configured ? (b.offsite.remote || L("eingerichtet")) : L("nicht eingerichtet") }),
          ...(lost > 0 ? [F(L("{n} Rechnungen nach einer Wiederherstellung nur als Kopie vorhanden"), { n: lost })] : []),
        ],
      }
    }).catch(() => failed).then(setBackup)

    const storage = apiGet<StorageHealth>("/api/v1/storage/health").then((s): Area => ({
      health: s.reachable && s.writable ? "green" : "red",
      lines: [
        s.localPath,
        (s.reachable && s.writable ? L("erreichbar und beschreibbar") : L("nicht erreichbar oder nicht beschreibbar")) + (free(s, getDateLocale()) ? " · " + F(L("{size} frei"), { size: free(s, getDateLocale()) }) : ""),
      ],
    })).catch(() => failed).then(setStorage)

    const errors = Promise.all([
      apiGet<{ openCount: number }>("/api/v1/system/errors?status=open&take=1"),
      apiGet<NotificationConfig>("/api/v1/system/notifications/config"),
    ]).then(([e, n]): Area => {
      const channel = n.email.configured || n.slack.configured
      return {
        health: !channel || !n.email.smtpHost ? "amber" : e.openCount > 0 ? "amber" : "green",
        lines: [
          F(L("Offene Fehlermeldungen: {n}"), { n: e.openCount }),
          F(L("Benachrichtigung per E-Mail: {state}"), { state: n.email.configured ? F(L("{n} Empfänger"), { n: n.email.recipients.length }) : L("nicht eingerichtet") }),
          F(L("Benachrichtigung per Slack: {state}"), { state: n.slack.configured ? (n.slack.host || L("eingerichtet")) : L("nicht eingerichtet") }),
          F(L("E-Mail-Versand (SMTP): {state}"), { state: n.email.smtpHost || L("nicht eingerichtet — keine Rechnung, Mahnung, Einladung oder Passwort-Rücksetzung per E-Mail") }),
        ],
      }
    }).catch(() => failed).then(setErrors)

    await Promise.all([server, jobs, backup, storage, errors])
    setLoading(false)
  }, [getDateLocale])

  useEffect(() => {
    apiGet<{ operator?: boolean }>("/api/v1/auth/me")
      .then((me) => setOperator(me?.operator === true))
      .catch(() => setOperator(false))
  }, [])
  useEffect(() => {
    if (operator) load()
  }, [operator, load])

  if (operator === null) {
    return <div className="p-6 text-gray-500 dark:text-gray-400">…</div>
  }
  if (!operator) {
    return (
      <div className="p-6 max-w-3xl space-y-4" data-testid="operator-not-allowed">
        <h1 className="text-2xl font-bold">{L("Systembetrieb")}</h1>
        <p className="text-gray-700 dark:text-gray-300">{L("Diese Seite ist dem Betreiber der Installation vorbehalten.")}</p>
        <Link href="/dashboard" className="text-blue-600 dark:text-blue-400 hover:underline">← {L("Zum Dashboard")}</Link>
      </div>
    )
  }

  const areas = [server, jobs, backup, storage, errors]
  const known = areas.filter((a): a is Area => a !== null)
  const attention = known.filter((a) => a.health !== "green").length

  return (
    <div className="p-4 sm:p-6 space-y-6 max-w-6xl">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link href="/dashboard" className="text-sm text-blue-600 dark:text-blue-400 hover:underline">← {L("Dashboard")}</Link>
          <h1 className="text-2xl font-bold mt-1">{L("Systembetrieb")}</h1>
          <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
            {L("Alles, was der Betreiber der Installation im Blick behält — für alle Firmen auf diesem Server.")}
          </p>
        </div>
        <Button onClick={load} disabled={loading} data-testid="operator-refresh">{L("Aktualisieren")}</Button>
      </div>

      {known.length === areas.length && (
        <p
          data-testid="operator-overall"
          className={"rounded border p-3 text-sm " + (attention === 0
            ? "border-green-300 bg-green-50 text-green-900 dark:border-green-800 dark:bg-green-950 dark:text-green-200"
            : "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200")}
        >
          {attention === 0 ? L("Alles in Ordnung.") : F(L("{n} von {all} Bereichen brauchen Aufmerksamkeit."), { n: attention, all: areas.length })}
        </p>
      )}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <AreaCard id="server" title={L("Server")} area={server} />
        <AreaCard id="jobs" title={L("Hintergrundjobs")} area={jobs} href="/dashboard/system-health" />
        <AreaCard id="backups" title={L("Datensicherung")} area={backup} href="/dashboard/backups" />
        <AreaCard id="storage" title={L("Ablage der Belege")} area={storage} href="/dashboard/settings#storage" linkText={L("Einstellungen")} />
        <AreaCard id="errors" title={L("Fehler und Benachrichtigung")} area={errors} href="/dashboard/system-errors" />
      </div>

      <div>
        <h2 className="text-lg font-semibold mb-3">{L("Registrierung und Firmen")}</h2>
        <RegistrationCard />
        {/* Tier 823: the companies on the installation */}
        <CompaniesCard />
      </div>
    </div>
  )
}
