"use client"

import { useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import LanguageSwitcher from "@/components/LanguageSwitcher"
import { useI18n } from "@/components/useI18n"
import { useToast } from "@/components/useToast"
import { apiGet, apiPost, apiPut, apiDelete } from "@/lib/api"

type EntryType = "einnahme" | "ausgabe" | "umbuchung" | "eroeffnung"

interface CashEntry {
  id: string
  businessDate: string
  type: EntryType
  description: string
  amount: string          // Decimal → string from Prisma
  vatRate: string | null
  counterparty: string | null
  belegNumber: string | null
  notes: string | null
  reversesId: string | null
  reversedById: string | null
  dayClosed: boolean
  createdAt: string
}

interface EntriesList {
  data: CashEntry[]
  total: number
  page: number
  pageSize: number
}

interface DayBalance {
  anfang: number
  einnahmen: number
  ausgaben: number
  umbuchungen: number
  ende: number
  entries: CashEntry[]
}

interface LiveBalance {
  balance: number
  anfang: number
  einnahmen: number
  ausgaben: number
  umbuchungen: number
  entryCount: number
}

interface DayClose {
  id: string
  businessDate: string
  anfangsbestand: string
  einnahmenSum: string
  ausgabenSum: string
  umbuchungenSum: string
  endbestand: string
  physicalCount: string
  differenz: string
  differenzNote: string | null
  amendedAt: string | null
  closedById: string | null
  closedBy: { id: string; email: string } | null
  createdAt: string
}

interface MonthSummary {
  year: number
  month: number
  einnahmen: number
  ausgaben: number
  umbuchungen: number
  entryCount: number
  vatBreakdown: { rate: number; net: number; vat: number; gross: number }[]
}

const fmtMoney = (n: number) =>
  n.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const fmtDate = (s: string | null | undefined, locale = "de-DE") =>
  s ? new Date(s).toLocaleDateString(locale, { day: "2-digit", month: "2-digit", year: "numeric" }) : "—"

const todayISO = () => new Date().toISOString().split("T")[0]

export default function CashbookPage() {
  const router = useRouter()
  const { t, getDateLocale } = useI18n()
  const toast = useToast()
  const dl = getDateLocale()

  const [entries, setEntries] = useState<CashEntry[]>([])
  const [balance, setBalance] = useState<LiveBalance | null>(null)
  const [today, setToday] = useState<DayBalance | null>(null)
  const [todayClose, setTodayClose] = useState<DayClose | null>(null)
  const [recentCloses, setRecentCloses] = useState<DayClose[]>([])
  const [monthSummary, setMonthSummary] = useState<MonthSummary | null>(null)
  const [loading, setLoading] = useState(true)

  // Form state
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<CashEntry | null>(null)
  const [saving, setSaving] = useState(false)
  const [formType, setFormType] = useState<EntryType>("einnahme")
  const [formDate, setFormDate] = useState(todayISO())
  const [formDescription, setFormDescription] = useState("")
  const [formAmount, setFormAmount] = useState("")
  const [formVat, setFormVat] = useState("0.19")
  const [formCounterparty, setFormCounterparty] = useState("")
  const [formBeleg, setFormBeleg] = useState("")
  const [formNotes, setFormNotes] = useState("")

  // Z-Bericht modal state
  const [showZ, setShowZ] = useState(false)
  const [zDate, setZDate] = useState(todayISO())
  const [zCount, setZCount] = useState("")
  const [zNote, setZNote] = useState("")
  const [zPreview, setZPreview] = useState<DayBalance | null>(null)
  const [zSaving, setZSaving] = useState(false)
  // Tier 194 — set after a successful close, used to
  // enable the sign + PDF buttons in the Z-Bericht
  // modal. Null while the close hasn't happened yet
  // (or while the modal is in a fresh state).
  const [zLastCloseId, setZLastCloseId] = useState<string | null>(null)

  // Storno state
  const [stornoId, setStornoId] = useState<string | null>(null)
  const [stornoReason, setStornoReason] = useState("")

  const reload = async () => {
    const companyId = localStorage.getItem("companyId")
    if (!companyId) {
      router.push("/login")
      return
    }
    setLoading(true)
    try {
      const today = todayISO()
      const year = new Date().getFullYear()
      const month = new Date().getMonth() + 1
      const [list, bal, day, close, closes, monthSum] = await Promise.all([
        apiGet<EntriesList>(`/api/v1/cashbook/entries?companyId=${companyId}&pageSize=50`),
        apiGet<LiveBalance>(`/api/v1/cashbook/balance?companyId=${companyId}`),
        apiGet<DayBalance>(`/api/v1/cashbook/day?companyId=${companyId}&date=${today}`),
        apiGet<DayClose | null>(`/api/v1/cashbook/close?companyId=${companyId}&date=${today}`).catch(() => null),
        apiGet<DayClose[]>(`/api/v1/cashbook/closes?companyId=${companyId}&from=${year}-01-01&to=${year}-12-31`),
        apiGet<MonthSummary>(`/api/v1/cashbook/month?companyId=${companyId}&year=${year}&month=${month}`),
      ])
      setEntries(list.data)
      setBalance(bal)
      setToday(day)
      setTodayClose(close)
      setRecentCloses(closes)
      setMonthSummary(monthSum)
    } catch (e) {
      console.error("Cashbook load failed:", e)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { reload() /* eslint-disable-next-line */ }, [])

  // ========== Form handlers ==========

  const openCreate = (type: EntryType = "einnahme") => {
    setEditing(null)
    setFormType(type)
    setFormDate(todayISO())
    setFormDescription("")
    setFormAmount("")
    setFormVat(type === "einnahme" || type === "ausgabe" ? "0.19" : "0")
    setFormCounterparty("")
    setFormBeleg("")
    setFormNotes("")
    setShowForm(true)
  }

  const openEdit = (e: CashEntry) => {
    setEditing(e)
    setFormType(e.type)
    setFormDate(e.businessDate.split("T")[0])
    setFormDescription(e.description)
    setFormAmount(e.amount)
    setFormVat(e.vatRate ? String(Number(e.vatRate)) : "0")
    setFormCounterparty(e.counterparty || "")
    setFormBeleg(e.belegNumber || "")
    setFormNotes(e.notes || "")
    setShowForm(true)
  }

  const save = async () => {
    const companyId = localStorage.getItem("companyId")!
    const userId = localStorage.getItem("userId") || undefined
    if (!formDescription.trim()) {
      toast.warn(t("cashbook.errDescriptionRequired"))
      return
    }
    const amount = parseFloat(formAmount)
    if (!amount || amount <= 0) {
      toast.warn(t("cashbook.errAmountPositive"))
      return
    }
    setSaving(true)
    try {
      const body: any = {
        createdById: userId,
        businessDate: formDate,
        type: formType,
        description: formDescription.trim(),
        amount,
        vatRate: formType === "eroeffnung" || formType === "umbuchung" ? null : parseFloat(formVat),
        counterparty: formCounterparty.trim() || null,
        belegNumber: formBeleg.trim() || null,
        notes: formNotes.trim() || null,
      }
      if (editing) {
        await apiPut(`/api/v1/cashbook/entries/${editing.id}?companyId=${companyId}`, body)
      } else {
        await apiPost(`/api/v1/cashbook/entries?companyId=${companyId}`, body)
      }
      setShowForm(false)
      setEditing(null)
      await reload()
    } catch (e: any) {
      toast.error(e?.message || "Fehler")
    } finally {
      setSaving(false)
    }
  }

  const remove = async (e: CashEntry) => {
    const companyId = localStorage.getItem("companyId")!
    if (e.dayClosed) {
      toast.warn(t("cashbook.errClosedDay"))
      return
    }
    if (!confirm(t("cashbook.confirmDelete"))) return
    try {
      await apiDelete(`/api/v1/cashbook/entries/${e.id}?companyId=${companyId}`)
      await reload()
    } catch (err: any) {
      toast.error(err?.message || "Fehler")
    }
  }

  const doStorno = async () => {
    if (!stornoId || !stornoReason.trim()) {
      toast.warn(t("cashbook.reverseReason"))
      return
    }
    const companyId = localStorage.getItem("companyId")!
    const userId = localStorage.getItem("userId") || undefined
    try {
      await apiPost(`/api/v1/cashbook/entries/${stornoId}/reverse?companyId=${companyId}`, {
        reason: stornoReason.trim(),
        createdById: userId,
      })
      setStornoId(null)
      setStornoReason("")
      await reload()
    } catch (err: any) {
      toast.error(err?.message || "Fehler")
    }
  }

  // ========== Z-Bericht handlers ==========

  const openZ = async (date: string) => {
    setZDate(date)
    setZCount("")
    setZNote("")
    setShowZ(true)
    const companyId = localStorage.getItem("companyId")!
    try {
      const d = await apiGet<DayBalance>(`/api/v1/cashbook/day?companyId=${companyId}&date=${date}`)
      setZPreview(d)
      setZCount(d.ende.toFixed(2))
    } catch {
      setZPreview(null)
    }
  }

  const saveZ = async () => {
    const companyId = localStorage.getItem("companyId")!
    const userId = localStorage.getItem("userId") || undefined
    const physical = parseFloat(zCount)
    if (!zPreview || isNaN(physical)) return
    const diff = physical - zPreview.ende
    if (Math.abs(diff) > 0.001 && !zNote.trim()) {
      toast.warn(t("cashbook.zberichtNoteRequired"))
      return
    }
    setZSaving(true)
    try {
      await apiPost(`/api/v1/cashbook/close-day?companyId=${companyId}`, {
        date: zDate,
        physicalCount: physical,
        closedById: userId,
        differenzNote: zNote.trim() || undefined,
      })
      // Tier 194 — fetch the just-created close so
      // we have its id for the sign + PDF buttons.
      // The endpoint doesn't return the id in the
      // create response, so we list closes for the
      // day and pick the (only) one.
      const closes = await apiGet<DayClose[]>(`/api/v1/cashbook/closes?companyId=${companyId}&from=${zDate}&to=${zDate}`)
      if (closes && closes.length > 0) {
        setZLastCloseId(closes[0].id)
      }
      setShowZ(false)
      await reload()
    } catch (err: any) {
      toast.error(err?.message || "Fehler")
    } finally {
      setZSaving(false)
    }
  }

  const reopenDay = async (date: string) => {
    if (!confirm(t("cashbook.reopenConfirm"))) return
    const companyId = localStorage.getItem("companyId")!
    try {
      await apiPost(`/api/v1/cashbook/reopen-day?companyId=${companyId}`, { date })
      toast.success(t("cashbook.reopenDone"))
      await reload()
    } catch (err: any) {
      toast.error(err?.message || "Fehler")
    }
  }

  // Tier 194 — explicitly sign a closed day. The
  // closeDay flow already writes a hash, but the
  // user can (re-)sign any time to assert the
  // current state. Returns the verification
  // result so the caller can surface a status
  // message. Re-throws on hash mismatch (a real
  // tampering signal).
  const signClose = async (closeId: string) => {
    const companyId = localStorage.getItem("companyId")!
    const res = await fetch(
      `${process.env.NEXT_PUBLIC_API_BASE || "http://localhost:3001"}/api/v1/cashbook/close-day/${closeId}/sign?companyId=${companyId}`,
      {
        method: "POST",
        credentials: "include",
        headers: {
          "x-user-id": localStorage.getItem("userId") || "",
          "x-company-id": companyId,
        },
      },
    )
    if (!res.ok) {
      const body = await res.text()
      throw new Error(`Sign-Fehler: ${res.status} ${body}`)
    }
    const body = await res.json()
    if (!body.verification?.verified) {
      throw new Error(
        "Hash stimmt nicht — Buchungen wurden seit dem letzten Signieren verändert!",
      )
    }
    await reload()
    return body
  }

  const exportCsv = () => {
    const companyId = localStorage.getItem("companyId")!
    const year = new Date().getFullYear()
    const url = `/api/v1/cashbook/export?companyId=${companyId}&from=${year}-01-01&to=${year}-12-31`
    window.open(url, "_blank")
  }

  const typeLabel = (ty: EntryType | "storno") => {
    if (ty === "storno") return t("cashbook.type_storno")
    return t(`cashbook.type_${ty}` as any) || ty
  }

  // ========== Render ==========

  const hasOpening = useMemo(
    () => entries.some((e) => e.type === "eroeffnung"),
    [entries]
  )

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <div className="container mx-auto px-4 py-8">
        <div className="flex justify-between items-center mb-6">
          <div>
            <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100">{t("cashbook.title")}</h1>
            <p className="text-gray-500 dark:text-gray-400 mt-1">{t("cashbook.subtitle")}</p>
          </div>
          <div className="flex gap-2 items-center">
            <LanguageSwitcher />
            <Button variant="outline" onClick={() => router.push("/dashboard")}>
              {t("common.back")}
            </Button>
            <Button variant="outline" onClick={exportCsv}>
              {t("cashbook.exportCsv")}
            </Button>
          </div>
        </div>

        {/* Top tiles */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
          <Card>
            <CardContent className="pt-6">
              <div className="text-sm text-gray-500 dark:text-gray-400">{t("cashbook.balance")}</div>
              <div className="text-2xl font-bold text-emerald-700 mt-1">
                {balance ? `€ ${fmtMoney(balance.balance)}` : "—"}
              </div>
              <div className="text-xs text-gray-400 mt-1">{t("cashbook.balanceDesc")}</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="text-sm text-gray-500 dark:text-gray-400">{t("cashbook.anfangsbestand")}</div>
              <div className="text-2xl font-bold mt-1">
                {balance ? `€ ${fmtMoney(balance.anfang)}` : "—"}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="text-sm text-gray-500 dark:text-gray-400">{t("cashbook.entriesToday")}</div>
              <div className="text-2xl font-bold mt-1">{today?.entries.length ?? 0}</div>
              <div className="text-xs text-gray-400 mt-1">
                Einnahmen: € {fmtMoney(today?.einnahmen ?? 0)} ·
                Ausgaben: € {fmtMoney(today?.ausgaben ?? 0)}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="text-sm text-gray-500 dark:text-gray-400">{t("cashbook.endbestand")}</div>
              <div className="text-2xl font-bold mt-1">
                {today ? `€ ${fmtMoney(today.ende)}` : "—"}
              </div>
              <div className="text-xs text-gray-400 mt-1">
                {todayClose ? (t("cashbook.closedDay") + (todayClose.amendedAt ? ` (${t("cashbook.amended")})` : "")) : (zStatus(today))}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Today status + quick actions */}
        <Card className="mb-6">
          <CardContent className="pt-6">
            {!hasOpening ? (
              <div className="flex items-center justify-between bg-amber-50 border border-amber-200 rounded p-4">
                <div>
                  <div className="font-medium text-amber-900">{t("cashbook.noEroeffnungYet")}</div>
                  <div className="text-sm text-amber-700 mt-1">{t("cashbook.tooltip")}</div>
                </div>
                <Button onClick={() => openCreate("eroeffnung")}>
                  {t("cashbook.createEroeffnung")}
                </Button>
              </div>
            ) : (
              <div className="flex flex-wrap gap-2 items-center justify-between">
                <div className="text-sm text-gray-600 dark:text-gray-300">
                  {t("cashbook.entriesToday")}: <span className="font-mono">{today?.entries.length ?? 0}</span> ·
                  Endbestand: <span className="font-mono font-medium">€ {fmtMoney(today?.ende ?? 0)}</span>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => openCreate("einnahme")}>+ {t("cashbook.type_einnahme")}</Button>
                  <Button size="sm" variant="outline" onClick={() => openCreate("ausgabe")}>+ {t("cashbook.type_ausgabe")}</Button>
                  <Button size="sm" variant="outline" onClick={() => openCreate("umbuchung")}>+ {t("cashbook.type_umbuchung")}</Button>
                  {todayClose ? (
                    <Button size="sm" variant="ghost" onClick={() => reopenDay(todayISO())}>
                      {t("cashbook.reopen")}
                    </Button>
                  ) : (
                    <Button size="sm" onClick={() => openZ(todayISO())}>
                      {t("cashbook.zbericht")}
                    </Button>
                  )}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Recent closes */}
        {recentCloses.length > 0 && (
          <Card className="mb-6">
            <CardHeader>
              <CardTitle className="text-base">{t("cashbook.lastCloses")}</CardTitle>
            </CardHeader>
            <CardContent>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-500 dark:text-gray-400 text-xs border-b">
                    <th className="py-2">Datum</th>
                    <th className="text-right">Anfangsbestand</th>
                    <th className="text-right">Einnahmen</th>
                    <th className="text-right">Ausgaben</th>
                    <th className="text-right">Endbestand</th>
                    <th className="text-right">Gezählt</th>
                    <th className="text-right">Differenz</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {recentCloses.slice(0, 10).map((c) => {
                    const diff = Number(c.differenz)
                    return (
                      <tr key={c.id} className="border-b hover:bg-gray-50 dark:bg-gray-900">
                        <td className="py-2 font-mono">{fmtDate(c.businessDate, dl)}</td>
                        <td className="text-right font-mono">€ {fmtMoney(Number(c.anfangsbestand))}</td>
                        <td className="text-right font-mono text-emerald-700">€ {fmtMoney(Number(c.einnahmenSum))}</td>
                        <td className="text-right font-mono text-red-700 dark:text-red-300">€ {fmtMoney(Number(c.ausgabenSum))}</td>
                        <td className="text-right font-mono">€ {fmtMoney(Number(c.endbestand))}</td>
                        <td className="text-right font-mono">€ {fmtMoney(Number(c.physicalCount))}</td>
                        <td className={`text-right font-mono font-medium ${
                          diff > 0.01 ? "text-amber-700" : diff < -0.01 ? "text-red-700 dark:text-red-300" : "text-emerald-700"
                        }`}>
                          {diff === 0 ? t("cashbook.zberichtExact") : `€ ${fmtMoney(diff)}`}
                          {c.differenzNote && (
                            <div className="text-xs text-gray-500 dark:text-gray-400 font-normal italic mt-0.5">
                              {c.differenzNote}
                            </div>
                          )}
                          {c.amendedAt && (
                            <div className="text-xs text-gray-400 font-normal mt-0.5">
                              ({t("cashbook.amended")})
                            </div>
                          )}
                        </td>
                        <td>
                          <Button size="sm" variant="ghost" onClick={() => reopenDay(c.businessDate.split("T")[0])}>
                            {t("cashbook.reopen")}
                          </Button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </CardContent>
          </Card>
        )}

        {/* Month summary */}
        {monthSummary && (
          <Card className="mb-6">
            <CardHeader>
              <CardTitle className="text-base">
                {t("cashbook.monthSummary")} — {monthSummary.year}/{String(monthSummary.month).padStart(2, "0")}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
                <div>
                  <div className="text-xs text-gray-500 dark:text-gray-400">{t("cashbook.einnahmen")}</div>
                  <div className="text-xl font-bold text-emerald-700">€ {fmtMoney(monthSummary.einnahmen)}</div>
                </div>
                <div>
                  <div className="text-xs text-gray-500 dark:text-gray-400">{t("cashbook.ausgaben")}</div>
                  <div className="text-xl font-bold text-red-700 dark:text-red-300">€ {fmtMoney(monthSummary.ausgaben)}</div>
                </div>
                <div>
                  <div className="text-xs text-gray-500 dark:text-gray-400">Saldo</div>
                  <div className={`text-xl font-bold ${
                    monthSummary.einnahmen - monthSummary.ausgaben >= 0 ? "text-emerald-700" : "text-red-700 dark:text-red-300"
                  }`}>
                    € {fmtMoney(monthSummary.einnahmen - monthSummary.ausgaben)}
                  </div>
                </div>
              </div>
              {monthSummary.vatBreakdown.length > 0 && (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-gray-500 dark:text-gray-400 text-xs border-b">
                      <th className="py-2">MwSt %</th>
                      <th className="text-right">Netto</th>
                      <th className="text-right">MwSt</th>
                      <th className="text-right">Brutto</th>
                    </tr>
                  </thead>
                  <tbody>
                    {monthSummary.vatBreakdown.map((v, i) => (
                      <tr key={i} className="border-b">
                        <td className="py-2 font-mono">{(v.rate * 100).toFixed(0)}%</td>
                        <td className="text-right font-mono">€ {fmtMoney(v.net)}</td>
                        <td className="text-right font-mono">€ {fmtMoney(v.vat)}</td>
                        <td className="text-right font-mono">€ {fmtMoney(v.gross)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>
        )}

        {/* Entries list */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Buchungen</CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="text-center py-12 text-gray-500 dark:text-gray-400">{t("common.loading")}</div>
            ) : entries.length === 0 ? (
              <div className="text-center py-12 text-gray-500 dark:text-gray-400">{t("cashbook.empty")}</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-gray-500 dark:text-gray-400 text-xs border-b">
                      <th className="py-2">Datum</th>
                      <th>Typ</th>
                      <th>Beschreibung</th>
                      <th className="text-right">Betrag</th>
                      <th>Gegenkonto</th>
                      <th>Beleg-Nr</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {entries.map((e) => {
                      const isStorno = !!e.reversesId
                      const amt = Number(e.amount)
                      return (
                        <tr key={e.id} className={`border-b hover:bg-gray-50 dark:bg-gray-900 ${
                          e.dayClosed ? "bg-gray-50 dark:bg-gray-900" : ""
                        } ${isStorno ? "italic text-gray-500 dark:text-gray-400" : ""}`}>
                          <td className="py-2 font-mono text-xs">
                            {fmtDate(e.businessDate, dl)}
                            {e.dayClosed && (
                              <span className="ml-1 text-emerald-700" title={t("cashbook.closedDay")}>✓</span>
                            )}
                          </td>
                          <td>
                            <span className={`text-xs px-1.5 py-0.5 rounded ${
                              isStorno ? "bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300"
                              : e.type === "einnahme" ? "bg-emerald-100 text-emerald-800"
                              : e.type === "ausgabe" ? "bg-red-100 text-red-800"
                              : e.type === "eroeffnung" ? "bg-blue-100 text-blue-800"
                              : "bg-amber-100 text-amber-800"
                            }`}>
                              {typeLabel(isStorno ? "storno" : e.type)}
                            </span>
                          </td>
                          <td>
                            {e.description}
                            {e.notes && (
                              <div className="text-xs text-gray-400 italic mt-0.5">{e.notes}</div>
                            )}
                          </td>
                          <td className={`text-right font-mono font-medium ${
                            e.type === "einnahme" || e.type === "eroeffnung" ? "text-emerald-700"
                            : e.type === "ausgabe" || e.type === "umbuchung" ? "text-red-700 dark:text-red-300" : ""
                          }`}>
                            € {fmtMoney(amt)}
                          </td>
                          <td className="text-xs text-gray-500 dark:text-gray-400">{e.counterparty || "—"}</td>
                          <td className="text-xs text-gray-500 dark:text-gray-400 font-mono">{e.belegNumber || "—"}</td>
                          <td>
                            <div className="flex gap-1">
                              {!e.dayClosed && (
                                <>
                                  <Button size="sm" variant="ghost" onClick={() => openEdit(e)} title={t("common.edit") || "Bearbeiten"}>✎</Button>
                                  <Button size="sm" variant="ghost" onClick={() => remove(e)} title={t("cashbook.delete")}>🗑</Button>
                                </>
                              )}
                              <Button size="sm" variant="ghost" onClick={() => { setStornoId(e.id); setStornoReason("") }} title={t("cashbook.storno")}>↺</Button>
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Entry form modal */}
      {showForm && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <Card className="w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <CardHeader>
              <CardTitle>
                {editing ? t("cashbook.edit") : t("cashbook.new")} — {typeLabel(formType)}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium mb-1">{t("cashbook.type")}</label>
                    <select
                      value={formType}
                      onChange={(e) => setFormType(e.target.value as EntryType)}
                      disabled={!!editing}
                      className="w-full border rounded px-3 py-2 text-sm"
                    >
                      <option value="einnahme">{t("cashbook.type_einnahme")}</option>
                      <option value="ausgabe">{t("cashbook.type_ausgabe")}</option>
                      <option value="umbuchung">{t("cashbook.type_umbuchung")}</option>
                      {formType === "eroeffnung" && <option value="eroeffnung">{t("cashbook.type_eroeffnung")}</option>}
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1">{t("cashbook.businessDate")}</label>
                    <input
                      type="date"
                      value={formDate}
                      onChange={(e) => setFormDate(e.target.value)}
                      className="w-full border rounded px-3 py-2 text-sm"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium mb-1">{t("cashbook.description")} *</label>
                  <input
                    type="text"
                    value={formDescription}
                    onChange={(e) => setFormDescription(e.target.value)}
                    placeholder={
                      formType === "einnahme" ? "z.B. Barverkauf" :
                      formType === "ausgabe" ? "z.B. Porto, Büromaterial" :
                      formType === "umbuchung" ? "z.B. Umbuchung an Bank" :
                      "Anfangsbestand"
                    }
                    className="w-full border rounded px-3 py-2 text-sm"
                  />
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div>
                    <label className="block text-sm font-medium mb-1">{t("cashbook.amount")} *</label>
                    <input
                      type="number"
                      step="0.01"
                      min="0.01"
                      value={formAmount}
                      onChange={(e) => setFormAmount(e.target.value)}
                      placeholder="0,00"
                      className="w-full border rounded px-3 py-2 text-sm font-mono"
                    />
                  </div>
                  {(formType === "einnahme" || formType === "ausgabe") && (
                    <div>
                      <label className="block text-sm font-medium mb-1">{t("cashbook.vatRate")}</label>
                      <select
                        value={formVat}
                        onChange={(e) => setFormVat(e.target.value)}
                        className="w-full border rounded px-3 py-2 text-sm"
                      >
                        <option value="0.19">19%</option>
                        <option value="0.07">7%</option>
                        <option value="0">0%</option>
                      </select>
                    </div>
                  )}
                  <div>
                    <label className="block text-sm font-medium mb-1">{t("cashbook.belegNumber")}</label>
                    <input
                      type="text"
                      value={formBeleg}
                      onChange={(e) => setFormBeleg(e.target.value)}
                      placeholder="Bon-2026-001"
                      className="w-full border rounded px-3 py-2 text-sm font-mono"
                    />
                  </div>
                </div>

                {formType !== "eroeffnung" && (
                  <div>
                    <label className="block text-sm font-medium mb-1">{t("cashbook.counterparty")}</label>
                    <input
                      type="text"
                      value={formCounterparty}
                      onChange={(e) => setFormCounterparty(e.target.value)}
                      placeholder="Kunde / Lieferant"
                      className="w-full border rounded px-3 py-2 text-sm"
                    />
                  </div>
                )}

                <div>
                  <label className="block text-sm font-medium mb-1">{t("cashbook.notes")}</label>
                  <textarea
                    value={formNotes}
                    onChange={(e) => setFormNotes(e.target.value)}
                    rows={2}
                    className="w-full border rounded px-3 py-2 text-sm"
                  />
                </div>

                <div className="flex gap-2 pt-4 border-t">
                  <Button onClick={save} disabled={saving}>
                    {saving ? (t("common.saving") || "...") : (t("common.save") || "Speichern")}
                  </Button>
                  <Button variant="outline" onClick={() => { setShowForm(false); setEditing(null) }}>
                    {t("common.cancel")}
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Z-Bericht modal */}
      {showZ && zPreview && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <Card className="w-full max-w-lg">
            <CardHeader>
              <CardTitle>{t("cashbook.zbericht")} — {fmtDate(zDate, dl)}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">{t("cashbook.zberichtDesc")}</p>

              <div className="bg-gray-50 dark:bg-gray-900 rounded p-3 mb-4 text-sm space-y-1">
                <div className="flex justify-between">
                  <span>{t("cashbook.anfangsbestand")}:</span>
                  <span className="font-mono">€ {fmtMoney(zPreview.anfang)}</span>
                </div>
                <div className="flex justify-between text-emerald-700">
                  <span>+ {t("cashbook.einnahmen")}:</span>
                  <span className="font-mono">€ {fmtMoney(zPreview.einnahmen)}</span>
                </div>
                <div className="flex justify-between text-red-700 dark:text-red-300">
                  <span>− {t("cashbook.ausgaben")}:</span>
                  <span className="font-mono">€ {fmtMoney(zPreview.ausgaben)}</span>
                </div>
                {zPreview.umbuchungen > 0 && (
                  <div className="flex justify-between text-amber-700">
                    <span>− {t("cashbook.umbuchungen")}:</span>
                    <span className="font-mono">€ {fmtMoney(zPreview.umbuchungen)}</span>
                  </div>
                )}
                <div className="flex justify-between font-medium border-t pt-1 mt-1">
                  <span>{t("cashbook.endbestand")}:</span>
                  <span className="font-mono">€ {fmtMoney(zPreview.ende)}</span>
                </div>
              </div>

              <div className="space-y-3">
                <div>
                  <label className="block text-sm font-medium mb-1">
                    {t("cashbook.zberichtCount")} *
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={zCount}
                    onChange={(e) => setZCount(e.target.value)}
                    className="w-full border rounded px-3 py-2 text-sm font-mono"
                  />
                </div>

                {zCount && !isNaN(parseFloat(zCount)) && Math.abs(parseFloat(zCount) - zPreview.ende) > 0.001 && (
                  <>
                    <div className={`text-sm font-medium ${
                      parseFloat(zCount) > zPreview.ende ? "text-amber-700" : "text-red-700 dark:text-red-300"
                    }`}>
                      {t("cashbook.zberichtDifference")}: {parseFloat(zCount) > zPreview.ende ? "+" : ""}
                      € {fmtMoney(parseFloat(zCount) - zPreview.ende)} (
                      {parseFloat(zCount) > zPreview.ende ? t("cashbook.zberichtOver") : t("cashbook.zberichtUnder")})
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-1">
                        {t("cashbook.zberichtNote")} *
                      </label>
                      <textarea
                        value={zNote}
                        onChange={(e) => setZNote(e.target.value)}
                        rows={2}
                        placeholder="z.B. Bon 17 verloren"
                        className="w-full border rounded px-3 py-2 text-sm"
                      />
                    </div>
                  </>
                )}

                {zCount && !isNaN(parseFloat(zCount)) && Math.abs(parseFloat(zCount) - zPreview.ende) <= 0.001 && (
                  <div className="text-sm text-emerald-700 font-medium">
                    ✓ {t("cashbook.zberichtExact")}
                  </div>
                )}

                <div className="flex gap-2 pt-4 border-t">
                  <Button onClick={saveZ} disabled={zSaving}>
                    {zSaving ? "..." : t("cashbook.zberichtSave")}
                  </Button>
                  <Button variant="outline" onClick={() => setShowZ(false)}>
                    {t("common.cancel")}
                  </Button>
                </div>

                {/* Tier 194 — Integritäts-Signatur
                    and Kassenabschluss PDF buttons.
                    Only available after the close
                    row exists (after saveZ succeeds).
                    The button group sits in a
                    separate row so the modal
                    footer stays compact. */}
                {zLastCloseId && (
                  <div className="flex gap-2 pt-3 mt-3 border-t border-dashed">
                    <Button
                      variant="outline"
                      onClick={async () => {
                        setZSaving(true)
                        try {
                          await signClose(zLastCloseId)
                          toast.success(t("cashbook.zberichtSigned") || "Tagesabschluss signiert")
                        } catch (err: any) {
                          toast.error(err?.message || "Sign-Fehler")
                        } finally {
                          setZSaving(false)
                        }
                      }}
                      disabled={zSaving}
                      data-testid="zbericht-sign-button"
                    >
                      {t("cashbook.zberichtSign") || "Elektronisch signieren"}
                    </Button>
                    <Button
                      variant="outline"
                      onClick={async () => {
                        const companyId = localStorage.getItem("companyId")!
                        // Anchor trick — same pattern
                        // the UStVA PDF button uses
                        // (Tier 182). CORS does not
                        // expose Content-Disposition
                        // to JS, so we set a sane
                        // filename locally.
                        const a = document.createElement("a")
                        a.href = `/api/v1/cashbook/kassenabschluss.pdf?companyId=${companyId}&date=${zDate}`
                        a.download = `Kassenabschluss-${zDate.slice(0, 10)}.pdf`
                        document.body.appendChild(a)
                        a.click()
                        a.remove()
                      }}
                      data-testid="zbericht-pdf-button"
                    >
                      {t("cashbook.zberichtPdf") || "Kassenabschluss PDF"}
                    </Button>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Storno modal */}
      {stornoId && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <Card className="w-full max-w-md">
            <CardHeader>
              <CardTitle>{t("cashbook.storno")}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-gray-600 dark:text-gray-300 mb-3">
                {t("cashbook.reverseReason")}
              </p>
              <textarea
                value={stornoReason}
                onChange={(e) => setStornoReason(e.target.value)}
                rows={3}
                placeholder="z.B. Falscher Betrag eingegeben, Buchung doppelt"
                className="w-full border rounded px-3 py-2 text-sm"
              />
              <div className="flex gap-2 pt-4">
                <Button onClick={doStorno} disabled={!stornoReason.trim()}>
                  {t("cashbook.storno")}
                </Button>
                <Button variant="outline" onClick={() => { setStornoId(null); setStornoReason("") }}>
                  {t("common.cancel")}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  )
}

function zStatus(_today: DayBalance | null): string {
  // Used in tile to show "offen" if not closed today
  return "offen"
}
