"use client"

/**
 * Tier 611 — time tracking (Zeiterfassung).
 *
 * Hours worked are written down per day, with or without a customer and an
 * hourly rate. The open, billable hours of a customer become the lines of an
 * invoice draft with one click; from then on an entry is "billed" and cannot
 * be changed — until the draft is deleted or the invoice cancelled, which
 * opens it again.
 *
 * Tier 616: projects below the customer, and the rate a new entry starts
 * with (the project's, else the customer's default). Tier 617: a timer that
 * keeps running on the server — stopping it writes the entry. Tier 618: the
 * time sheet of what is listed, as a PDF.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import LanguageSwitcher from "@/components/LanguageSwitcher"
import { useI18n } from "@/components/useI18n"
import { useToast } from "@/components/useToast"
import { ApiError, apiDelete, apiFetch, apiGet, apiPost, apiPut } from "@/lib/api"
import { todayIso } from "@/lib/today"

interface TimeEntry {
  id: string
  date: string
  minutes: number
  description: string
  customerId: string | null
  customer: { id: string; name: string } | null
  projectId: string | null
  project: { id: string; name: string } | null
  hourlyRate: string | number | null
  billable: boolean
  invoiceId: string | null
  invoice: { id: string; invoiceNumber: string; status: string } | null
}
interface Summary {
  minutes: number
  openBillableMinutes: number
  openAmount: number
}
interface CustomerOption {
  id: string
  name: string
  defaultHourlyRate: string | number | null
}
interface Project {
  id: string
  name: string
  customerId: string | null
  customer: { id: string; name: string } | null
  hourlyRate: string | number | null
  effectiveRate: string | number | null
  budgetHours: string | number | null
  active: boolean
  minutes: number
  openMinutes: number
}
interface ReportRow {
  key: string | null
  name: string
  entries: number
  minutes: number
  billableMinutes: number
  billedMinutes: number
  openMinutes: number
  billedAmount: number
  openAmount: number
}
interface Rounding {
  minutes: number
  mode: "up" | "nearest"
}
interface RunningTimer {
  startedAt: string
  paused?: boolean // Tier 623
  elapsedSeconds: number
  customerId: string | null
  projectId: string | null
  description: string
}

/** "1:30", "1,5", "1.5" or "90m" → minutes; null when it is none of these */
function parseDuration(raw: string): number | null {
  const s = raw.trim().toLowerCase()
  if (!s) return null
  let m = /^(\d{1,3}):([0-5]\d)$/.exec(s)
  if (m) return Number(m[1]) * 60 + Number(m[2])
  m = /^(\d{1,4})\s*m(in)?$/.exec(s)
  if (m) return Number(m[1])
  m = /^(\d{1,3})(?:[.,](\d{1,2}))?\s*h?$/.exec(s)
  if (m) return Math.round(Number(`${m[1]}.${m[2] || "0"}`) * 60)
  return null
}
// as on the invoice line: hours with two decimals (50 min → 0,83 Std) times the rate
const lineAmount = (minutes: number, rate: number) => Math.round((Math.round((minutes / 60) * 100) / 100) * rate * 100) / 100
const hhmm = (minutes: number) => `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`
const hhmmss = (seconds: number) =>
  `${Math.floor(seconds / 3600)}:${String(Math.floor((seconds % 3600) / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`
const day = (iso: string) => String(iso).slice(0, 10).split("-").reverse().join(".")
const decimal = (raw: string): number | null => {
  if (raw.trim() === "") return null
  const n = Number(raw.replace(",", "."))
  return Number.isFinite(n) ? n : NaN
}

const BLANK = { date: "", customerId: "", projectId: "", duration: "", description: "", hourlyRate: "", billable: true }
const BLANK_PROJECT = { name: "", customerId: "", hourlyRate: "", budgetHours: "" }

export default function TimeTrackingPage() {
  const router = useRouter()
  const { t, locale } = useI18n()
  const toast = useToast()
  const [entries, setEntries] = useState<TimeEntry[]>([])
  const [summary, setSummary] = useState<Summary>({ minutes: 0, openBillableMinutes: 0, openAmount: 0 })
  const [customers, setCustomers] = useState<CustomerOption[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState({ ...BLANK })
  // the rate in the form is the default of the chosen customer / project until the user types one
  const [rateIsDefault, setRateIsDefault] = useState(true)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [filterCustomer, setFilterCustomer] = useState("")
  const [filterProject, setFilterProject] = useState("")
  const [filterState, setFilterState] = useState<"open" | "billed" | "all">("open")
  const [timer, setTimer] = useState<RunningTimer | null>(null)
  const [timerLoadedAt, setTimerLoadedAt] = useState(0)
  const [now, setNow] = useState(0)
  const [showProjects, setShowProjects] = useState(false)
  // Tier 624: the company's rounding rule
  const [rounding, setRounding] = useState<Rounding>({ minutes: 0, mode: "up" })
  // Tier 625: who worked how much
  const [showReport, setShowReport] = useState(false)
  const [reportBy, setReportBy] = useState<"user" | "customer" | "project">("user")
  const [reportFrom, setReportFrom] = useState("")
  const [reportTo, setReportTo] = useState("")
  const [report, setReport] = useState<{ rows: ReportRow[]; total: Omit<ReportRow, "key" | "name"> } | null>(null)
  const [projectForm, setProjectForm] = useState({ ...BLANK_PROJECT })

  const money = useMemo(
    () => new Intl.NumberFormat(locale === "en" ? "en-GB" : locale === "zh" ? "zh-CN" : "de-DE", { style: "currency", currency: "EUR" }),
    [locale],
  )
  const fail = (err: unknown, fallback: string) => toast.error(err instanceof ApiError ? err.message : fallback)

  // only the answer to the latest question counts (a slow answer to an
  // earlier filter must not replace the list of the current one)
  const loadSeq = useRef(0)
  const load = useCallback(async () => {
    const companyId = localStorage.getItem("companyId")
    if (!companyId) {
      router.push("/login")
      return
    }
    const seq = ++loadSeq.current
    try {
      const qs = new URLSearchParams({ companyId, state: filterState })
      if (filterCustomer) qs.set("customerId", filterCustomer)
      if (filterProject) qs.set("projectId", filterProject)
      const r = await apiGet<{ data: TimeEntry[]; summary: Summary }>(`/api/v1/time-entries?${qs.toString()}`)
      if (seq !== loadSeq.current) return
      setEntries(r.data)
      setSummary(r.summary)
    } catch (err) {
      fail(err, t("time.loadFailed"))
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterCustomer, filterProject, filterState])

  const loadProjects = useCallback(async () => {
    const companyId = localStorage.getItem("companyId")
    if (!companyId) return
    try {
      const r = await apiGet<{ data: Project[] }>(`/api/v1/time-projects?companyId=${companyId}&includeInactive=true`)
      setProjects(r.data)
    } catch {
      setProjects([])
    }
  }, [])

  const applyTimer = (running: RunningTimer | null) => {
    setTimer(running)
    setTimerLoadedAt(Date.now())
    setNow(Date.now())
  }

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    const companyId = localStorage.getItem("companyId")
    if (!companyId) return
    setForm((f) => ({ ...f, date: f.date || todayIso() }))
    apiGet<{ data: CustomerOption[] }>(`/api/v1/customers?companyId=${companyId}&pageSize=500`)
      .then((r) => setCustomers((r.data || []).map((c) => ({ id: c.id, name: c.name, defaultHourlyRate: c.defaultHourlyRate ?? null }))))
      .catch(() => setCustomers([]))
    loadProjects()
    apiGet<{ rounding: Rounding }>(`/api/v1/time-entries/settings?companyId=${companyId}`)
      .then((r) => setRounding(r.rounding))
      .catch(() => undefined)
    const today = todayIso()
    setReportFrom(`${today.slice(0, 8)}01`)
    setReportTo(today)
    apiGet<{ running: RunningTimer | null }>(`/api/v1/time-entries/timer?companyId=${companyId}`)
      .then((r) => {
        applyTimer(r.running)
        // a running timer brings its customer, project and note into the form
        if (r.running) {
          setForm((f) => ({
            ...f,
            customerId: r.running?.customerId || f.customerId,
            projectId: r.running?.projectId || f.projectId,
            description: f.description || r.running?.description || "",
          }))
        }
      })
      .catch(() => applyTimer(null))
  }, [loadProjects])

  // the clock of a running timer
  useEffect(() => {
    if (!timer || timer.paused) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [timer])
  const elapsed = timer ? timer.elapsedSeconds + (timer.paused ? 0 : Math.max(0, Math.floor((now - timerLoadedAt) / 1000))) : 0

  /** the rate a new entry for this customer / project starts with */
  const defaultRateFor = (customerId: string, projectId: string): string => {
    const project = projects.find((p) => p.id === projectId)
    const r = project?.effectiveRate ?? customers.find((c) => c.id === customerId)?.defaultHourlyRate ?? null
    return r === null || r === undefined ? "" : String(Number(r))
  }
  const pick = (customerId: string, projectId: string) => {
    // a project of a customer brings that customer along
    const project = projects.find((p) => p.id === projectId)
    if (project?.customerId) customerId = project.customerId
    const takeDefault = rateIsDefault || form.hourlyRate.trim() === ""
    setForm((f) => ({ ...f, customerId, projectId, ...(takeDefault ? { hourlyRate: defaultRateFor(customerId, projectId) } : {}) }))
    if (takeDefault) setRateIsDefault(true)
  }
  // as long as no rate was typed, the form shows the default of what is chosen —
  // also once the lists have arrived (a running timer brings its project before they do)
  useEffect(() => {
    if (!rateIsDefault || editingId) return
    const next = defaultRateFor(form.customerId, form.projectId)
    setForm((f) => (f.hourlyRate === next ? f : { ...f, hourlyRate: next }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects, customers, form.customerId, form.projectId, rateIsDefault, editingId])
  const projectsFor = (customerId: string) => projects.filter((p) => p.active && (!p.customerId || !customerId || p.customerId === customerId))

  const minutes = parseDuration(form.duration)
  const rate = decimal(form.hourlyRate)
  const rateValid = rate === null || (!Number.isNaN(rate) && rate >= 0)
  const formValid = !!form.date && minutes !== null && minutes > 0 && minutes <= 24 * 60 && form.description.trim().length > 0 && rateValid

  const save = async () => {
    const companyId = localStorage.getItem("companyId")
    if (!companyId || !formValid || minutes === null) return
    setBusy(true)
    try {
      const body = {
        date: form.date,
        minutes,
        description: form.description.trim(),
        customerId: form.customerId || null,
        projectId: form.projectId || null,
        hourlyRate: rate,
        billable: form.billable,
      }
      if (editingId) await apiPut(`/api/v1/time-entries/${editingId}?companyId=${companyId}`, body)
      else await apiPost(`/api/v1/time-entries?companyId=${companyId}`, body)
      // the next entry is usually the same day, customer, project and rate
      setForm({ ...BLANK, date: form.date, customerId: form.customerId, projectId: form.projectId, hourlyRate: form.hourlyRate, billable: form.billable })
      setEditingId(null)
      await Promise.all([load(), loadProjects()])
    } catch (err) {
      fail(err, t("time.saveFailed"))
    } finally {
      setBusy(false)
    }
  }

  const edit = (e: TimeEntry) => {
    setEditingId(e.id)
    setRateIsDefault(false)
    setForm({
      date: String(e.date).slice(0, 10),
      customerId: e.customerId || "",
      projectId: e.projectId || "",
      duration: hhmm(e.minutes),
      description: e.description,
      hourlyRate: e.hourlyRate === null ? "" : String(Number(e.hourlyRate)),
      billable: e.billable,
    })
    window.scrollTo({ top: 0, behavior: "smooth" })
  }

  const remove = async (e: TimeEntry) => {
    const companyId = localStorage.getItem("companyId")
    if (!companyId || !confirm(t("time.confirmDelete"))) return
    try {
      await apiDelete(`/api/v1/time-entries/${e.id}?companyId=${companyId}`)
      if (editingId === e.id) {
        setEditingId(null)
        setForm({ ...BLANK, date: todayIso() })
      }
      await Promise.all([load(), loadProjects()])
    } catch (err) {
      fail(err, t("time.saveFailed"))
    }
  }

  // ── the timer ──
  const startTimer = async () => {
    const companyId = localStorage.getItem("companyId")
    if (!companyId) return
    setBusy(true)
    try {
      const r = await apiPost<{ running: RunningTimer }>(`/api/v1/time-entries/timer/start?companyId=${companyId}`, {
        customerId: form.customerId || null,
        projectId: form.projectId || null,
        description: form.description.trim(),
      })
      applyTimer(r.running)
    } catch (err) {
      fail(err, t("time.timerFailed"))
    } finally {
      setBusy(false)
    }
  }
  const stopTimer = async () => {
    const companyId = localStorage.getItem("companyId")
    if (!companyId) return
    setBusy(true)
    try {
      const r = await apiPost<{ capped: boolean }>(`/api/v1/time-entries/timer/stop?companyId=${companyId}`, {
        description: form.description.trim(),
        customerId: form.customerId || null,
        projectId: form.projectId || null,
        ...(rate !== null && !Number.isNaN(rate) ? { hourlyRate: rate } : {}),
        billable: form.billable,
      })
      applyTimer(null)
      if (r.capped) toast.error(t("time.timerCapped"))
      setForm({ ...BLANK, date: todayIso(), customerId: form.customerId, projectId: form.projectId, hourlyRate: form.hourlyRate, billable: form.billable })
      await Promise.all([load(), loadProjects()])
    } catch (err) {
      fail(err, t("time.timerFailed"))
    } finally {
      setBusy(false)
    }
  }
  // Tier 623
  const pauseOrResume = async () => {
    const companyId = localStorage.getItem("companyId")
    if (!companyId || !timer) return
    setBusy(true)
    try {
      const r = await apiPost<{ running: RunningTimer }>(`/api/v1/time-entries/timer/${timer.paused ? "resume" : "pause"}?companyId=${companyId}`, {})
      applyTimer(r.running)
    } catch (err) {
      fail(err, t("time.timerFailed"))
    } finally {
      setBusy(false)
    }
  }
  // Tier 624
  const saveRounding = async (next: Rounding) => {
    const companyId = localStorage.getItem("companyId")
    if (!companyId) return
    try {
      const r = await apiPut<{ rounding: Rounding }>(`/api/v1/time-entries/settings?companyId=${companyId}`, { rounding: next })
      setRounding(r.rounding)
      toast.success(t("time.roundingSaved"))
    } catch (err) {
      toast.error(err instanceof ApiError && err.status !== 403 ? err.message : t("time.roundingFailed"))
    }
  }
  // Tier 625
  const loadReport = useCallback(async () => {
    const companyId = localStorage.getItem("companyId")
    if (!companyId || !showReport) return
    try {
      const qs = new URLSearchParams({ companyId, groupBy: reportBy })
      if (reportFrom) qs.set("from", reportFrom)
      if (reportTo) qs.set("to", reportTo)
      setReport(await apiGet(`/api/v1/time-entries/report?${qs.toString()}`))
    } catch (err) {
      fail(err, t("time.reportFailed"))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showReport, reportBy, reportFrom, reportTo])
  useEffect(() => {
    loadReport()
  }, [loadReport])

  const discardTimer = async () => {
    const companyId = localStorage.getItem("companyId")
    if (!companyId || !confirm(t("time.timerConfirmDiscard"))) return
    try {
      await apiDelete(`/api/v1/time-entries/timer?companyId=${companyId}`)
      applyTimer(null)
    } catch (err) {
      fail(err, t("time.timerFailed"))
    }
  }

  // what "bill" would take: the open, billable, priced entries of the chosen customer (and project)
  const billable = entries.filter((e) => !e.invoiceId && e.billable && e.customerId && e.customerId === filterCustomer && e.hourlyRate !== null)
  const billableAmount = billable.reduce((s, e) => s + lineAmount(e.minutes, Number(e.hourlyRate)), 0)

  const bill = async () => {
    const companyId = localStorage.getItem("companyId")
    if (!companyId || !filterCustomer || billable.length === 0) return
    if (!confirm(t("time.confirmBill", { count: billable.length }))) return
    setBusy(true)
    try {
      const r = await apiPost<{ invoiceId: string }>(`/api/v1/time-entries/bill?companyId=${companyId}`, {
        customerId: filterCustomer,
        entryIds: billable.map((e) => e.id),
      })
      router.push(`/dashboard/invoices/${r.invoiceId}`)
    } catch (err) {
      fail(err, t("time.billFailed"))
      setBusy(false)
    }
  }

  // Tier 618: the time sheet of what the filter lists
  const downloadTimesheet = async () => {
    const companyId = localStorage.getItem("companyId")
    if (!companyId) return
    try {
      const qs = new URLSearchParams({ companyId, state: filterState })
      if (filterCustomer) qs.set("customerId", filterCustomer)
      if (filterProject) qs.set("projectId", filterProject)
      const res = await apiFetch(`/api/v1/time-entries/timesheet.pdf?${qs.toString()}`, { throwOnError: false })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        toast.error(data.message || t("time.timesheetFailed"))
        return
      }
      const url = window.URL.createObjectURL(await res.blob())
      const a = document.createElement("a")
      a.href = url
      a.download = "Stundennachweis.pdf"
      document.body.appendChild(a)
      a.click()
      window.URL.revokeObjectURL(url)
      document.body.removeChild(a)
    } catch {
      toast.error(t("time.timesheetFailed"))
    }
  }

  // ── projects ──
  const projectRate = decimal(projectForm.hourlyRate)
  const projectBudget = decimal(projectForm.budgetHours)
  const projectValid =
    projectForm.name.trim().length > 0 &&
    (projectRate === null || (!Number.isNaN(projectRate) && projectRate >= 0)) &&
    (projectBudget === null || (!Number.isNaN(projectBudget) && projectBudget > 0))
  const addProject = async () => {
    const companyId = localStorage.getItem("companyId")
    if (!companyId || !projectValid) return
    setBusy(true)
    try {
      await apiPost(`/api/v1/time-projects?companyId=${companyId}`, {
        name: projectForm.name.trim(),
        customerId: projectForm.customerId || null,
        hourlyRate: projectRate,
        budgetHours: projectBudget,
      })
      setProjectForm({ ...BLANK_PROJECT, customerId: projectForm.customerId })
      await loadProjects()
    } catch (err) {
      fail(err, t("time.saveFailed"))
    } finally {
      setBusy(false)
    }
  }
  const setProjectActive = async (p: Project, active: boolean) => {
    const companyId = localStorage.getItem("companyId")
    if (!companyId) return
    try {
      await apiPut(`/api/v1/time-projects/${p.id}?companyId=${companyId}`, { active })
      await loadProjects()
    } catch (err) {
      fail(err, t("time.saveFailed"))
    }
  }
  const removeProject = async (p: Project) => {
    const companyId = localStorage.getItem("companyId")
    if (!companyId || !confirm(t("time.projectConfirmDelete", { name: p.name }))) return
    try {
      await apiDelete(`/api/v1/time-projects/${p.id}?companyId=${companyId}`)
      await loadProjects()
    } catch (err) {
      fail(err, t("time.saveFailed"))
    }
  }

  const stateOf = (e: TimeEntry) => (e.invoiceId ? "billed" : e.billable ? "open" : "notBillable")
  const amountOf = (e: TimeEntry) => (e.hourlyRate === null ? null : lineAmount(e.minutes, Number(e.hourlyRate)))
  const selectClass = "h-10 border rounded-md px-3 bg-white dark:bg-gray-800 max-w-full"

  return (
    <main className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <header className="bg-white dark:bg-gray-800 border-b shadow-sm">
        <div className="container mx-auto px-3 sm:px-4 py-3 sm:py-4 flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-xl sm:text-2xl font-bold text-blue-600 dark:text-blue-400">{t("time.title")}</h1>
          <div className="flex flex-wrap gap-2 items-center">
            <LanguageSwitcher />
            <Button variant="outline" size="sm" onClick={() => router.push("/dashboard")}>
              {t("common.back")}
            </Button>
          </div>
        </div>
      </header>

      <div className="container mx-auto px-3 sm:px-4 py-4 sm:py-8 max-w-5xl space-y-6">
        <Card data-testid="time-form">
          <CardHeader>
            <CardTitle>{editingId ? t("time.editEntry") : t("time.newEntry")}</CardTitle>
          </CardHeader>
          <CardContent>
            {/* Tier 617: the timer */}
            <div className="flex flex-wrap items-center gap-3 mb-4 pb-4 border-b" data-testid="time-timer" data-running={timer ? "true" : "false"}>
              {timer ? (
                <>
                  <span className="font-mono text-lg tabular-nums" data-testid="time-timer-clock">
                    {hhmmss(elapsed)}
                  </span>
                  {timer.paused && (
                    <span className="text-xs px-2 py-1 rounded bg-amber-100 text-amber-700 dark:text-amber-300" data-testid="time-timer-paused">
                      {t("time.timerPaused")}
                    </span>
                  )}
                  <Button onClick={stopTimer} disabled={busy} data-testid="time-timer-stop">
                    {t("time.timerStop")}
                  </Button>
                  <Button variant="outline" onClick={pauseOrResume} disabled={busy} data-testid="time-timer-pause">
                    {timer.paused ? t("time.timerResume") : t("time.timerPause")}
                  </Button>
                  <Button variant="outline" onClick={discardTimer} disabled={busy} data-testid="time-timer-discard">
                    {t("time.timerDiscard")}
                  </Button>
                  <span className="text-xs text-gray-500 dark:text-gray-400">{t("time.timerRunningHint")}</span>
                </>
              ) : (
                <>
                  <Button variant="outline" onClick={startTimer} disabled={busy || !!editingId} data-testid="time-timer-start">
                    {t("time.timerStart")}
                  </Button>
                  <span className="text-xs text-gray-500 dark:text-gray-400">{t("time.timerHint")}</span>
                </>
              )}
            </div>
            <div className="grid gap-3 md:grid-cols-4">
              <label className="block text-sm">
                <span className="block font-medium mb-1">{t("time.date")}</span>
                <Input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} data-testid="time-date" />
              </label>
              <label className="block text-sm">
                <span className="block font-medium mb-1">{t("time.customer")}</span>
                <select
                  className={`w-full ${selectClass}`}
                  value={form.customerId}
                  onChange={(e) => {
                    const customerId = e.target.value
                    const project = projects.find((p) => p.id === form.projectId)
                    pick(customerId, project?.customerId && project.customerId !== customerId ? "" : form.projectId)
                  }}
                  data-testid="time-customer"
                >
                  <option value="">{t("time.noCustomer")}</option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-sm">
                <span className="block font-medium mb-1">{t("time.project")}</span>
                <select className={`w-full ${selectClass}`} value={form.projectId} onChange={(e) => pick(form.customerId, e.target.value)} data-testid="time-project">
                  <option value="">{t("time.noProject")}</option>
                  {projectsFor(form.customerId).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                      {p.customer && !form.customerId ? ` (${p.customer.name})` : ""}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-sm">
                <span className="block font-medium mb-1">{t("time.duration")}</span>
                <Input
                  value={form.duration}
                  onChange={(e) => setForm({ ...form, duration: e.target.value })}
                  placeholder="1:30"
                  data-testid="time-duration"
                  aria-invalid={form.duration !== "" && minutes === null}
                />
                <span className="block text-xs text-gray-500 dark:text-gray-400 mt-1" data-testid="time-duration-hint">
                  {form.duration !== "" && (minutes === null || minutes <= 0 || minutes > 24 * 60) ? t("time.durationInvalid") : t("time.durationHint")}
                </span>
              </label>
              <label className="block text-sm md:col-span-2">
                <span className="block font-medium mb-1">{t("time.description")}</span>
                <Input
                  value={form.description}
                  maxLength={500}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  data-testid="time-description"
                />
              </label>
              <label className="block text-sm">
                <span className="block font-medium mb-1">{t("time.hourlyRate")}</span>
                <Input
                  inputMode="decimal"
                  value={form.hourlyRate}
                  onChange={(e) => {
                    setRateIsDefault(false)
                    setForm({ ...form, hourlyRate: e.target.value })
                  }}
                  placeholder="90"
                  data-testid="time-rate"
                  aria-invalid={!rateValid}
                />
              </label>
              <label className="flex items-center gap-2 text-sm md:mt-7">
                <input
                  type="checkbox"
                  checked={form.billable}
                  onChange={(e) => setForm({ ...form, billable: e.target.checked })}
                  data-testid="time-billable"
                />
                {t("time.billable")}
              </label>
            </div>
            <div className="flex flex-wrap gap-2 mt-4">
              <Button onClick={save} disabled={!formValid || busy} data-testid="time-save">
                {editingId ? t("time.saveChanges") : t("time.add")}
              </Button>
              {editingId && (
                <Button
                  variant="outline"
                  onClick={() => {
                    setEditingId(null)
                    setRateIsDefault(true)
                    setForm({ ...BLANK, date: todayIso() })
                  }}
                >
                  {t("common.cancel")}
                </Button>
              )}
              {/* Tier 624: the rounding rule */}
              <div className="ml-auto flex flex-wrap items-center gap-2 text-sm" data-testid="time-rounding" title={t("time.roundingHint")}>
                <span className="text-gray-600 dark:text-gray-300">{t("time.rounding")}:</span>
                <select
                  className="h-9 border rounded-md px-2 bg-white dark:bg-gray-800"
                  value={rounding.minutes}
                  onChange={(e) => saveRounding({ ...rounding, minutes: Number(e.target.value) })}
                  aria-label={t("time.rounding")}
                  data-testid="time-rounding-minutes"
                >
                  {[0, 5, 6, 10, 15, 30, 60].map((m) => (
                    <option key={m} value={m}>
                      {m === 0 ? t("time.rounding_0") : t("time.roundingStep", { minutes: m })}
                    </option>
                  ))}
                </select>
                {rounding.minutes > 0 && (
                  <select
                    className="h-9 border rounded-md px-2 bg-white dark:bg-gray-800"
                    value={rounding.mode}
                    onChange={(e) => saveRounding({ ...rounding, mode: e.target.value as Rounding["mode"] })}
                    aria-label={t("time.rounding")}
                    data-testid="time-rounding-mode"
                  >
                    <option value="up">{t("time.roundingMode_up")}</option>
                    <option value="nearest">{t("time.roundingMode_nearest")}</option>
                  </select>
                )}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Tier 616: projects */}
        <Card data-testid="time-projects">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>
              {t("time.projects")} ({projects.filter((p) => p.active).length})
            </CardTitle>
            <Button size="sm" variant="outline" onClick={() => setShowProjects(!showProjects)} data-testid="time-projects-toggle" aria-expanded={showProjects}>
              {showProjects ? t("time.projectsHide") : t("time.projectsShow")}
            </Button>
          </CardHeader>
          {showProjects && (
            <CardContent>
              <div className="grid gap-3 md:grid-cols-5 items-end">
                <label className="block text-sm md:col-span-2">
                  <span className="block font-medium mb-1">{t("time.projectName")}</span>
                  <Input value={projectForm.name} maxLength={120} onChange={(e) => setProjectForm({ ...projectForm, name: e.target.value })} data-testid="time-project-name" />
                </label>
                <label className="block text-sm">
                  <span className="block font-medium mb-1">{t("time.customer")}</span>
                  <select
                    className={`w-full ${selectClass}`}
                    value={projectForm.customerId}
                    onChange={(e) => setProjectForm({ ...projectForm, customerId: e.target.value })}
                    data-testid="time-project-customer"
                  >
                    <option value="">{t("time.projectInternal")}</option>
                    {customers.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block text-sm">
                  <span className="block font-medium mb-1">{t("time.hourlyRate")}</span>
                  <Input
                    inputMode="decimal"
                    value={projectForm.hourlyRate}
                    onChange={(e) => setProjectForm({ ...projectForm, hourlyRate: e.target.value })}
                    placeholder={t("time.projectRatePlaceholder")}
                    data-testid="time-project-rate"
                  />
                </label>
                <label className="block text-sm">
                  <span className="block font-medium mb-1">{t("time.projectBudget")}</span>
                  <Input
                    inputMode="decimal"
                    value={projectForm.budgetHours}
                    onChange={(e) => setProjectForm({ ...projectForm, budgetHours: e.target.value })}
                    data-testid="time-project-budget"
                  />
                </label>
              </div>
              <Button className="mt-3" onClick={addProject} disabled={!projectValid || busy} data-testid="time-project-add">
                {t("time.projectAdd")}
              </Button>
              {projects.length > 0 && (
                <div className="overflow-x-auto"><table className="w-full text-sm mt-4" data-testid="time-project-table">
                  <thead>
                    <tr className="text-left border-b">
                      <th className="py-2 pr-3">{t("time.projectName")}</th>
                      <th className="py-2 pr-3">{t("time.customer")}</th>
                      <th className="py-2 pr-3 text-right">{t("time.hourlyRate")}</th>
                      <th className="py-2 pr-3 text-right">{t("time.projectLogged")}</th>
                      <th className="py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {projects.map((p) => {
                      const budget = p.budgetHours === null ? null : Number(p.budgetHours)
                      const over = budget !== null && p.minutes / 60 > budget
                      return (
                        <tr key={p.id} className={`border-b last:border-0 ${p.active ? "" : "text-gray-400"}`} data-testid="time-project-row">
                          <td className="py-2 pr-3">
                            {p.name}
                            {!p.active && <span className="ml-2 text-xs">({t("time.projectArchived")})</span>}
                          </td>
                          <td className="py-2 pr-3">{p.customer?.name || t("time.projectInternal")}</td>
                          <td className="py-2 pr-3 text-right whitespace-nowrap">
                            {p.effectiveRate === null ? "—" : money.format(Number(p.effectiveRate))}
                            {p.hourlyRate === null && p.effectiveRate !== null && (
                              <span className="ml-1 text-xs text-gray-500 dark:text-gray-400">({t("time.projectRateOfCustomer")})</span>
                            )}
                          </td>
                          <td className={`py-2 pr-3 text-right whitespace-nowrap ${over ? "text-red-600 dark:text-red-400 font-medium" : ""}`} data-testid="time-project-logged">
                            {hhmm(p.minutes)}
                            {budget !== null && ` / ${hhmm(Math.round(budget * 60))}`}
                          </td>
                          <td className="py-2 text-right whitespace-nowrap">
                            <Button size="sm" variant="ghost" onClick={() => setProjectActive(p, !p.active)} data-testid="time-project-archive">
                              {p.active ? t("time.projectArchive") : t("time.projectRestore")}
                            </Button>
                            {p.minutes === 0 && (
                              <Button size="sm" variant="ghost" className="text-red-600 dark:text-red-400" onClick={() => removeProject(p)} data-testid="time-project-delete">
                                {t("common.delete")}
                              </Button>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table></div>
              )}
            </CardContent>
          )}
        </Card>

        {/* Tier 625: who worked how much */}
        <Card data-testid="time-report">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>{t("time.report")}</CardTitle>
            <Button size="sm" variant="outline" onClick={() => setShowReport(!showReport)} data-testid="time-report-toggle" aria-expanded={showReport}>
              {showReport ? t("time.reportHide") : t("time.reportShow")}
            </Button>
          </CardHeader>
          {showReport && (
            <CardContent>
              <div className="flex flex-wrap gap-3 items-end mb-4">
                <label className="block text-sm">
                  <span className="block font-medium mb-1">{t("time.reportFrom")}</span>
                  <Input type="date" value={reportFrom} onChange={(e) => setReportFrom(e.target.value)} data-testid="time-report-from" />
                </label>
                <label className="block text-sm">
                  <span className="block font-medium mb-1">{t("time.reportTo")}</span>
                  <Input type="date" value={reportTo} onChange={(e) => setReportTo(e.target.value)} data-testid="time-report-to" />
                </label>
                <div className="flex gap-2" role="group">
                  {(["user", "customer", "project"] as const).map((g) => (
                    <Button key={g} size="sm" variant={reportBy === g ? "default" : "outline"} onClick={() => setReportBy(g)} data-testid={`time-report-by-${g}`}>
                      {t(`time.reportBy_${g}`)}
                    </Button>
                  ))}
                </div>
              </div>
              {!report || report.rows.length === 0 ? (
                <p className="text-center text-gray-500 dark:text-gray-400 py-4" data-testid="time-report-empty">
                  {t("time.reportEmpty")}
                </p>
              ) : (
                <div className="overflow-x-auto"><table className="w-full text-sm" data-testid="time-report-table">
                  <thead>
                    <tr className="text-left border-b">
                      <th className="py-2 pr-3">{t(`time.reportBy_${reportBy}`)}</th>
                      <th className="py-2 pr-3 text-right">{t("time.reportHours")}</th>
                      <th className="py-2 pr-3 text-right">{t("time.reportBillable")}</th>
                      <th className="py-2 pr-3 text-right">{t("time.reportBilled")}</th>
                      <th className="py-2 pr-3 text-right">{t("time.reportOpen")}</th>
                      <th className="py-2 pr-3 text-right">{t("time.reportBilledAmount")}</th>
                      <th className="py-2 text-right">{t("time.reportOpenAmount")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.rows.map((r) => (
                      <tr key={r.key ?? "-"} className="border-b" data-testid="time-report-row">
                        <td className="py-2 pr-3">{r.name || t("time.reportNone")}</td>
                        <td className="py-2 pr-3 text-right whitespace-nowrap">{hhmm(r.minutes)}</td>
                        <td className="py-2 pr-3 text-right whitespace-nowrap">{hhmm(r.billableMinutes)}</td>
                        <td className="py-2 pr-3 text-right whitespace-nowrap">{hhmm(r.billedMinutes)}</td>
                        <td className="py-2 pr-3 text-right whitespace-nowrap">{hhmm(r.openMinutes)}</td>
                        <td className="py-2 pr-3 text-right whitespace-nowrap">{money.format(r.billedAmount)}</td>
                        <td className="py-2 text-right whitespace-nowrap">{money.format(r.openAmount)}</td>
                      </tr>
                    ))}
                    <tr className="font-semibold" data-testid="time-report-total">
                      <td className="py-2 pr-3">{t("time.reportTotal")}</td>
                      <td className="py-2 pr-3 text-right whitespace-nowrap">{hhmm(report.total.minutes)}</td>
                      <td className="py-2 pr-3 text-right whitespace-nowrap">{hhmm(report.total.billableMinutes)}</td>
                      <td className="py-2 pr-3 text-right whitespace-nowrap">{hhmm(report.total.billedMinutes)}</td>
                      <td className="py-2 pr-3 text-right whitespace-nowrap">{hhmm(report.total.openMinutes)}</td>
                      <td className="py-2 pr-3 text-right whitespace-nowrap">{money.format(report.total.billedAmount)}</td>
                      <td className="py-2 text-right whitespace-nowrap">{money.format(report.total.openAmount)}</td>
                    </tr>
                  </tbody>
                </table></div>
              )}
            </CardContent>
          )}
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex flex-wrap gap-3 items-end">
              <label className="block text-sm">
                <span className="block font-medium mb-1">{t("time.customer")}</span>
                <select
                  className={selectClass}
                  value={filterCustomer}
                  onChange={(e) => {
                    setFilterCustomer(e.target.value)
                    setFilterProject("")
                  }}
                  data-testid="time-filter-customer"
                >
                  <option value="">{t("time.allCustomers")}</option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-sm">
                <span className="block font-medium mb-1">{t("time.project")}</span>
                <select className={selectClass} value={filterProject} onChange={(e) => setFilterProject(e.target.value)} data-testid="time-filter-project">
                  <option value="">{t("time.allProjects")}</option>
                  {projects
                    .filter((p) => !filterCustomer || p.customerId === filterCustomer)
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                </select>
              </label>
              <div className="flex gap-2" role="group" aria-label={t("time.state")}>
                {(["open", "billed", "all"] as const).map((s) => (
                  <Button key={s} size="sm" variant={filterState === s ? "default" : "outline"} onClick={() => setFilterState(s)} data-testid={`time-state-${s}`}>
                    {t(`time.state_${s}`)}
                  </Button>
                ))}
              </div>
              <div className="ml-auto text-sm text-right" data-testid="time-summary">
                <div>
                  {t("time.sumHours")}: <strong data-testid="time-sum-hours">{hhmm(summary.minutes)}</strong>
                </div>
                <div>
                  {t("time.sumOpen")}: <strong data-testid="time-sum-open">{hhmm(summary.openBillableMinutes)}</strong> ·{" "}
                  <strong data-testid="time-sum-amount">{money.format(summary.openAmount)}</strong>
                </div>
              </div>
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              {filterCustomer && filterState !== "billed" && (
                <Button onClick={bill} disabled={busy || billable.length === 0} data-testid="time-bill">
                  {t("time.bill", { count: billable.length, amount: money.format(billableAmount) })}
                </Button>
              )}
              <Button variant="outline" onClick={downloadTimesheet} disabled={entries.length === 0} data-testid="time-timesheet">
                {t("time.timesheet")}
              </Button>
              {filterCustomer && filterState !== "billed" && <span className="text-xs text-gray-500 dark:text-gray-400">{t("time.billHint")}</span>}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            {loading ? (
              <p className="text-center text-gray-500 dark:text-gray-400 py-8">{t("common.loading")}</p>
            ) : entries.length === 0 ? (
              <p className="text-center text-gray-500 dark:text-gray-400 py-8" data-testid="time-empty">
                {t("time.empty")}
              </p>
            ) : (
              <div className="overflow-x-auto"><table className="w-full text-sm" data-testid="time-table">
                <thead>
                  <tr className="text-left border-b">
                    <th className="py-2 pr-3">{t("time.date")}</th>
                    <th className="py-2 pr-3">{t("time.customer")}</th>
                    <th className="py-2 pr-3">{t("time.description")}</th>
                    <th className="py-2 pr-3 text-right">{t("time.duration")}</th>
                    <th className="py-2 pr-3 text-right">{t("time.amount")}</th>
                    <th className="py-2 pr-3">{t("time.state")}</th>
                    <th className="py-2" />
                  </tr>
                </thead>
                <tbody>
                  {entries.map((e) => {
                    const amount = amountOf(e)
                    const state = stateOf(e)
                    return (
                      <tr key={e.id} className="border-b last:border-0" data-testid="time-row">
                        <td className="py-2 pr-3 whitespace-nowrap">{day(e.date)}</td>
                        <td className="py-2 pr-3">
                          {e.customer?.name || "—"}
                          {e.project && (
                            <span className="block text-xs text-gray-500 dark:text-gray-400" data-testid="time-row-project">
                              {e.project.name}
                            </span>
                          )}
                        </td>
                        <td className="py-2 pr-3">{e.description}</td>
                        <td className="py-2 pr-3 text-right whitespace-nowrap">{hhmm(e.minutes)}</td>
                        <td className="py-2 pr-3 text-right whitespace-nowrap" data-testid="time-row-amount">
                          {amount === null ? "—" : money.format(amount)}
                        </td>
                        <td className="py-2 pr-3 whitespace-nowrap" data-testid="time-row-state">
                          {state === "billed" && e.invoice ? (
                            <a href={`/dashboard/invoices/${e.invoice.id}`} className="underline text-green-700 dark:text-green-300">
                              {e.invoice.invoiceNumber}
                            </a>
                          ) : (
                            <span className={state === "open" ? "text-blue-700 dark:text-blue-300" : "text-gray-500 dark:text-gray-400"}>
                              {t(`time.state_${state}`)}
                            </span>
                          )}
                        </td>
                        <td className="py-2 text-right whitespace-nowrap">
                          {!e.invoiceId && (
                            <>
                              <Button size="sm" variant="ghost" onClick={() => edit(e)} data-testid="time-row-edit">
                                {t("common.edit")}
                              </Button>
                              <Button size="sm" variant="ghost" className="text-red-600 dark:text-red-400" onClick={() => remove(e)} data-testid="time-row-delete">
                                {t("common.delete")}
                              </Button>
                            </>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table></div>
            )}
          </CardContent>
        </Card>
      </div>
    </main>
  )
}
