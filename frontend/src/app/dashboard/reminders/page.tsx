"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import LanguageSwitcher from "@/components/LanguageSwitcher"
import { useI18n } from "@/components/useI18n"

interface OverdueInvoice {
  id: string
  invoiceNumber: string
  customer: {
    name: string
    contact: {
      email?: string
      name?: string
    }
  }
  total: string
  dueDate: string
  daysOverdue: number
  reminderCount: number
}

interface ReminderStats {
  overdueCount: number
  totalOverdueAmount: string
  recentReminders: number
  // Per-level reminder counts surfaced by /reminders/stats.
  // Optional because the seed-stat set in the catch handler
  // also uses this shape (see the empty-fallback below).
  firstReminder?: number
  secondReminder?: number
  finalReminder?: number
}

export default function RemindersPage() {
  const router = useRouter()
  const { t, locale, getDateLocale } = useI18n()
  const [overdueInvoices, setOverdueInvoices] = useState<OverdueInvoice[]>([])
  const [stats, setStats] = useState<ReminderStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [selectedLevel, setSelectedLevel] = useState<Record<string, 'first' | 'second' | 'final'>>({})
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [bulkSending, setBulkSending] = useState(false)
  const [bulkResult, setBulkResult] = useState<{ ok: number; fail: number } | null>(null)

  useEffect(() => {
    const companyId = localStorage.getItem("companyId")
    const userId = localStorage.getItem("userId") || ""
    if (!companyId) {
      router.push("/login")
      return
    }

    Promise.all([
      fetch(`http://localhost:3001/api/v1/reminders/overdue?companyId=${companyId}`, {
        headers: { 'x-user-id': userId, 'x-company-id': companyId },
      }).then(r => r.json()),
      fetch(`http://localhost:3001/api/v1/reminders/stats?companyId=${companyId}`, {
        headers: { 'x-user-id': userId, 'x-company-id': companyId },
      }).then(r => r.json()),
    ])
      .then(([invoices, statsData]) => {
        // Defensive: the backend can return { statusCode, message }
        // when auth fails, or [] when there are no overdue invoices.
        const list = Array.isArray(invoices) ? invoices : []
        setOverdueInvoices(list)
        setStats(statsData)
        // Set default reminder levels
        const levels: Record<string, 'first' | 'second' | 'final'> = {}
        list.forEach((inv: OverdueInvoice) => {
          if (inv.reminderCount === 0) levels[inv.id] = 'first'
          else if (inv.reminderCount === 1) levels[inv.id] = 'second'
          else levels[inv.id] = 'final'
        })
        setSelectedLevel(levels)
      })
      .catch((err) => {
        console.error('Reminders load failed:', err)
        setOverdueInvoices([])
        setStats({
          overdueCount: 0,
          totalOverdueAmount: '0',
          recentReminders: 0,
          firstReminder: 0,
          secondReminder: 0,
          finalReminder: 0,
        })
      })
      .finally(() => setLoading(false))
  }, [router])

  const getReminderLevelLabel = (level: 'first' | 'second' | 'final') => {
    const labels = {
      first: t("reminder.level1"),
      second: t("reminder.level2"),
      final: t("reminder.levelFinal"),
    }
    return labels[level]
  }

  const getDaysOverdueLabel = (days: number) => {
    if (days === 1) return t("reminder.oneDay")
    return t("reminder.daysOverdue").replace("{days}", String(days))
  }

  const handleSendReminder = async (invoice: OverdueInvoice) => {
    const companyId = localStorage.getItem("companyId")
    if (!companyId) return

    const level = selectedLevel[invoice.id] || 'first'

    try {
      const emailData = await fetch(
        `http://localhost:3001/api/v1/reminders/${invoice.id}/email-data?companyId=${companyId}&level=${level}`
      ).then(r => r.json())

      // Create mailto link with pre-filled content
      const subject = encodeURIComponent(emailData.subject)
      const body = encodeURIComponent(emailData.body)
      const email = emailData.recipientEmail || invoice.customer.contact?.email || ''

      if (!email) {
        alert(t("reminder.noEmailForCustomer"))
        return
      }

      // Open email client with mailto:
      window.location.href = `mailto:${email}?subject=${subject}&body=${body}`

      // Record the reminder send in backend
      await fetch('http://localhost:3001/api/v1/reminders/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          invoiceId: invoice.id,
          companyId,
          recipientEmail: email,
          recipientName: emailData.recipientName,
          subject: emailData.subject,
          body: emailData.body,
          level,
        }),
      })

      // Refresh data
      const updatedInvoices = await fetch(
        `http://localhost:3001/api/v1/reminders/overdue?companyId=${companyId}`
      ).then(r => r.json())
      setOverdueInvoices(updatedInvoices)
    } catch (err) {
      console.error("Fehler beim Senden der Erinnerung:", err)
      alert(t("reminder.sendError"))
    }
  }

  /**
   * Bulk-send reminders to all selected invoices. We loop through the
   * existing single-send endpoint because each reminder is independently
   * personalised (subject/body per invoice). For a tighter backend
   * implementation we could add a /reminders/bulk endpoint that pre-renders
   * all the emails at once; the loop is fine for tens of reminders.
   */
  const handleBulkSend = async () => {
    if (selectedIds.size === 0) return
    if (!confirm(`${selectedIds.size} Erinnerungen versenden?`)) return
    setBulkSending(true)
    setBulkResult(null)
    let ok = 0
    let fail = 0
    for (const id of Array.from(selectedIds)) {
      const inv = overdueInvoices.find((o) => o.id === id)
      if (!inv) {
        fail++
        continue
      }
      const level = selectedLevel[id] || getNextReminderLevel(inv)
      try {
        await handleSendReminder(inv) // re-uses existing flow
        ok++
      } catch {
        fail++
      }
    }
    setBulkSending(false)
    setBulkResult({ ok, fail })
    setSelectedIds(new Set())
  }

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleSelectAll = () => {
    if (selectedIds.size === overdueInvoices.length) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(overdueInvoices.map((o) => o.id)))
    }
  }

  const getNextReminderLevel = (invoice: OverdueInvoice): 'first' | 'second' | 'final' => {
    if (invoice.reminderCount === 0) return 'first'
    if (invoice.reminderCount === 1) return 'second'
    return 'final'
  }

  return (
    <main className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <header className="bg-white dark:bg-gray-800 border-b shadow-sm">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <h1 className="text-2xl font-bold text-red-600 dark:text-red-400">
            {t("reminder.title")}
          </h1>
          <div className="flex gap-2 items-center">
            <Button variant="outline" onClick={() => router.push("/dashboard/reminders/templates")}>
              {t("reminder.templatesButton") || "Vorlagen bearbeiten"}
            </Button>
            <LanguageSwitcher />
            <Button variant="outline" onClick={() => router.push("/dashboard")}>
              {t("common.back")}
            </Button>
          </div>
        </div>
      </header>

      <div className="container mx-auto px-4 py-8">
        {/* Stats Cards */}
        {stats && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
            <Card>
              <CardContent className="pt-6">
                <div className="text-3xl font-bold text-red-600 dark:text-red-400">{stats.overdueCount}</div>
                <div className="text-gray-600 dark:text-gray-300">
                  {t("reminder.overdueInvoices")}
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6">
                <div className="text-3xl font-bold text-orange-600">
                  €{parseFloat(stats.totalOverdueAmount).toFixed(2)}
                </div>
                <div className="text-gray-600 dark:text-gray-300">
                  {t("reminder.overdueTotal")}
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6">
                <div className="text-3xl font-bold text-blue-600 dark:text-blue-400">{stats.recentReminders}</div>
                <div className="text-gray-600 dark:text-gray-300">
                  {t("reminder.sent30d")}
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {/* Overdue Invoices List */}
        {loading ? (
          <div className="text-center py-8">{t("common.loading")}</div>
        ) : overdueInvoices.length === 0 ? (
          <Card>
            <CardContent className="text-center py-12">
            <p className="text-gray-500 dark:text-gray-400 mb-4">
              {t("reminder.noOverdue")}
            </p>
              <div className="text-4xl mb-4">✓</div>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-4">
            {/* Bulk-action toolbar — appears when there are overdue invoices */}
            <div className="flex items-center justify-between bg-white dark:bg-gray-800 border rounded-lg px-4 py-2">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={selectedIds.size > 0 && selectedIds.size === overdueInvoices.length}
                  ref={(el) => {
                    if (el) el.indeterminate = selectedIds.size > 0 && selectedIds.size < overdueInvoices.length
                  }}
                  onChange={toggleSelectAll}
                />
                <span>
                  {selectedIds.size > 0
                    ? `${selectedIds.size} ausgewählt`
                    : "Alle auswählen"}
                </span>
              </label>
              <div className="flex items-center gap-2">
                {bulkResult && (
                  <span className={`text-sm ${bulkResult.fail === 0 ? "text-green-600 dark:text-green-400" : "text-orange-600"}`}>
                    ✓ {bulkResult.ok} versendet
                    {bulkResult.fail > 0 && `, ${bulkResult.fail} fehlgeschlagen`}
                  </span>
                )}
                <Button
                  onClick={handleBulkSend}
                  disabled={selectedIds.size === 0 || bulkSending}
                  className="bg-red-600 hover:bg-red-700 text-white"
                  size="sm"
                >
                  {bulkSending
                    ? `${selectedIds.size} …`
                    : `${selectedIds.size} Erinnerungen versenden`}
                </Button>
              </div>
            </div>

            {(overdueInvoices || []).map((invoice) => (
              <Card key={invoice.id} className={invoice.reminderCount > 0 ? "border-orange-300 dark:border-orange-700" : ""}>
                <CardContent className="pt-6">
                  <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                    <div className="flex items-start gap-3 flex-1">
                      {/* Per-row checkbox for bulk selection */}
                      <input
                        type="checkbox"
                        className="mt-1"
                        checked={selectedIds.has(invoice.id)}
                        onChange={() => toggleSelect(invoice.id)}
                      />
                      <div className="flex-1">
                      <div className="flex items-center gap-2 mb-2">
                        <span className="px-2 py-1 rounded text-xs font-medium bg-red-100 text-red-700 dark:text-red-300">
                          {invoice.invoiceNumber}
                        </span>
                        {invoice.reminderCount > 0 && (
                          <span className="px-2 py-1 rounded text-xs font-medium bg-orange-100 text-orange-700 dark:text-orange-300">
                            {invoice.reminderCount} {t("reminder.subtitle")}
                          </span>
                        )}
                      </div>
                      <div className="text-lg font-medium">{invoice.customer.name}</div>
                      <div className="text-sm text-gray-600 dark:text-gray-300">
                        {t("reminder.dueSince")}: {getDaysOverdueLabel(invoice.daysOverdue)}
                      </div>
                      <div className="text-sm text-gray-500 dark:text-gray-400">
                        {invoice.customer.contact?.email || (t("reminder.noEmail"))}
                      </div>
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-2xl font-bold text-red-600 dark:text-red-400">
                        €{parseFloat(invoice.total).toFixed(2)}
                      </div>
                      <div className="text-sm text-gray-500 dark:text-gray-400 mb-2">
                        {new Date(invoice.dueDate).toLocaleDateString(getDateLocale())}
                      </div>
                    </div>
                  </div>

                  <div className="mt-4 pt-4 border-t flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                    <div className="flex items-center gap-2">
                      <label className="text-sm text-gray-600 dark:text-gray-300">
                        {t("reminder.levelLabel")}
                      </label>
                      <select
                        value={selectedLevel[invoice.id] || 'first'}
                        onChange={(e) =>
                          setSelectedLevel((prev) => ({
                            ...prev,
                            [invoice.id]: e.target.value as 'first' | 'second' | 'final',
                          }))
                        }
                        className="border rounded px-2 py-1 text-sm"
                      >
                        <option value="first">{getReminderLevelLabel('first')}</option>
                        <option value="second">{getReminderLevelLabel('second')}</option>
                        <option value="final">{getReminderLevelLabel('final')}</option>
                      </select>
                    </div>
                    <Button
                      onClick={() => handleSendReminder(invoice)}
                      className="bg-red-600 hover:bg-red-700 text-white"
                    >
                      {t("reminder.sendByEmail")}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </main>
  )
}