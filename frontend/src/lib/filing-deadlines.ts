/**
 * Tier 801 — the returns due next and the period each VAT report opens on
 * (GET /ustva/deadlines, backend filing-deadlines.ts). One request per page
 * load: the UStVA page and its ZM card ask for the same answer.
 */
import { apiGet } from "@/lib/api"

export type UstvaRhythm = "monthly" | "quarterly" | "none"

export interface FilingDeadline {
  // Tier 802: the annual returns, the Sondervorauszahlung, the Dauerfrist application
  kind: "ustva" | "zm" | "oss" | "annual" | "svz" | "dauerfrist"
  year: number
  month: number | null
  quarter: number | null
  periodName: string
  periodEnd: string
  dueDate: string
  daysLeft: number
  status: "filed" | "open" | "overdue" | "running" | "option"
  noteCode: string | null
  note: string | null
  /** the Sondervorauszahlung (an estimate) */
  amount?: number
}

export interface FilingDeadlines {
  today: string
  berater: boolean
  /** Tier 803: the reminder mails seven and two days before a deadline */
  erinnerungMail: boolean
  kleinunternehmer: boolean
  rhythm: UstvaRhythm
  rhythmSource: "setting" | "filings" | "kleinunternehmer" | "default"
  dauerfrist: boolean
  dauerfristSource: "setting" | "sondervorauszahlung" | "default"
  bundesland: string | null
  ossVerfahren: boolean
  defaults: {
    ustva: { year: number; month: number | null; quarter: number | null } | null
    zm: { year: number; quarter: number }
    oss: { year: number; quarter: number }
  }
  deadlines: FilingDeadline[]
}

let pending: { companyId: string; at: number; promise: Promise<FilingDeadlines | null> } | null = null

/** null when the request fails — the pages then keep their own defaults. */
export function loadFilingDeadlines(fresh = false): Promise<FilingDeadlines | null> {
  const companyId = typeof window !== "undefined" ? localStorage.getItem("companyId") : null
  if (!companyId) return Promise.resolve(null)
  if (!fresh && pending && pending.companyId === companyId && Date.now() - pending.at < 30_000) return pending.promise
  const promise = apiGet<FilingDeadlines>(`/api/v1/ustva/deadlines?companyId=${companyId}`).catch(() => null)
  pending = { companyId, at: Date.now(), promise }
  return promise
}

/** "Dezember 2026" / "Q4 2026", in the page's language. */
export function deadlinePeriodLabel(d: { year: number; month: number | null; quarter: number | null }, locale: string): string {
  if (d.month) {
    const tag = locale === "en" ? "en-GB" : locale === "zh" ? "zh-CN" : "de-DE"
    return new Date(Date.UTC(d.year, d.month - 1, 1)).toLocaleDateString(tag, { month: "long", year: "numeric", timeZone: "UTC" })
  }
  if (d.quarter) return `Q${d.quarter} ${d.year}`
  // the annual returns, the Sondervorauszahlung: the year alone
  return String(d.year)
}

/** "11.01.2027" */
export function deadlineDay(iso: string): string {
  const [y, m, d] = iso.split("-")
  return `${d}.${m}.${y}`
}
