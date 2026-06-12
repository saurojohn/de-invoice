"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import LanguageSwitcher from "@/components/LanguageSwitcher"
import { useI18n } from "@/components/useI18n"
import { apiGet } from "@/lib/api"

interface EmailRow {
  id: string
  recipientEmail: string
  recipientName?: string | null
  subject?: string | null
  status: string
  templateType?: string | null
  sentAt?: string | null
  createdAt: string
  bodyPreview?: string | null
  notes?: string | null
  invoice?: { id: string; invoiceNumber: string; status: string; total: string; customer?: { name?: string } | null } | null
}

interface EmailStats { counts: Record<string, number>; total: number; since: string }

const STATUS_COLOR: Record<string, string> = {
  sent: "bg-blue-100 text-blue-800",
  opened: "bg-emerald-100 text-emerald-800",
  failed: "bg-red-100 text-red-800",
  bounced: "bg-orange-100 text-orange-800",
  draft: "bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-200",
}

export default function EmailCenterPage() {
  const router = useRouter()
  const { t, locale, getDateLocale } = useI18n()
  const [emails, setEmails] = useState<EmailRow[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize] = useState(25)
  const [stats, setStats] = useState<EmailStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState<string>("")
  const [searchInput, setSearchInput] = useState("")
  const [search, setSearch] = useState("")
  const [selected, setSelected] = useState<EmailRow | null>(null)
  const [loadingDetail, setLoadingDetail] = useState(false)

  // Debounce search input → search state, same pattern as
  // the customer / invoice list pages (see React-search-input
  // gotchas in the agent memory).
  useEffect(() => {
    const h = setTimeout(() => setSearch(searchInput), 300)
    return () => clearTimeout(h)
  }, [searchInput])

  useEffect(() => {
    const companyId = localStorage.getItem("companyId")
    if (!companyId) {
      router.push("/login")
      return
    }
    setLoading(true)
    Promise.all([
      apiGet<{ data: EmailRow[]; total: number; page: number; pageSize: number }>(
        `/api/v1/mail/emails?companyId=${companyId}&page=${page}&pageSize=${pageSize}${statusFilter ? `&status=${statusFilter}` : ""}${search ? `&q=${encodeURIComponent(search)}` : ""}`
      ),
      apiGet<EmailStats>(`/api/v1/mail/emails/stats?companyId=${companyId}`),
    ])
      .then(([list, s]) => {
        setEmails(list?.data || [])
        setTotal(list?.total || 0)
        setStats(s)
      })
      .catch((err) => console.error("Email list load failed:", err))
      .finally(() => setLoading(false))
  }, [router, page, pageSize, statusFilter, search])

  const openDetail = (id: string) => {
    const companyId = localStorage.getItem("companyId")
    if (!companyId) return
    setLoadingDetail(true)
    apiGet<EmailRow>(`/api/v1/mail/emails/${id}?companyId=${companyId}`)
      .then((e) => setSelected(e))
      .catch((err) => console.error("Email detail failed:", err))
      .finally(() => setLoadingDetail(false))
  }

  const closeDetail = () => setSelected(null)

  const fmtDate = (s?: string | null) => {
    if (!s) return "—"
    const d = new Date(s)
    return d.toLocaleString(getDateLocale(), { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <div className="container mx-auto px-4 py-8">
        <div className="flex justify-between items-center mb-6">
          <div>
            <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100">
              {t("email.title") || "E-Mail Center"}
            </h1>
            <p className="text-gray-500 dark:text-gray-400 mt-1">
              {t("email.subtitle") || "Alle ausgehenden E-Mails mit Status und Anhängen"}
            </p>
          </div>
          <LanguageSwitcher />
        </div>

        {/* Stats tiles */}
        {stats && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
            {(["sent", "opened", "failed", "bounced"] as const).map((s) => (
              <Card key={s}>
                <CardContent className="pt-6">
                  <div className="text-2xl font-bold">{stats.counts[s] || 0}</div>
                  <div className="text-gray-500 dark:text-gray-400 text-sm mt-1">
                    {t(`email.status.${s}`) || s}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {/* Filters */}
        <Card className="mb-6">
          <CardContent className="pt-6">
            <div className="flex flex-wrap gap-3 items-center">
              <input
                type="text"
                placeholder={t("email.searchPlaceholder") || "Empfänger / Betreff suchen..."}
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                className="flex-1 min-w-[200px] border rounded px-3 py-2 text-sm"
              />
              <select
                value={statusFilter}
                onChange={(e) => { setStatusFilter(e.target.value); setPage(1) }}
                className="border rounded px-3 py-2 text-sm"
              >
                <option value="">{t("email.allStatuses") || "Alle Status"}</option>
                <option value="sent">{t("email.status.sent") || "Gesendet"}</option>
                <option value="opened">{t("email.status.opened") || "Geöffnet"}</option>
                <option value="failed">{t("email.status.failed") || "Fehlgeschlagen"}</option>
                <option value="bounced">{t("email.status.bounced") || "Zurückgewiesen"}</option>
              </select>
              <span className="text-sm text-gray-500 dark:text-gray-400 ml-auto">
                {total} {t("email.totalCount") || "E-Mails"}
              </span>
            </div>
          </CardContent>
        </Card>

        {/* Table */}
        <Card>
          <CardHeader>
            <CardTitle>{t("email.outbox") || "Postausgang"}</CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="text-center py-12 text-gray-500 dark:text-gray-400">
                {t("common.loading") || "Lädt..."}
              </div>
            ) : emails.length === 0 ? (
              <div className="text-center py-12 text-gray-500 dark:text-gray-400">
                {t("email.noEmails") || "Keine E-Mails gefunden."}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-gray-500 dark:text-gray-400">
                      <th className="py-2 font-medium">{t("email.colDate") || "Datum"}</th>
                      <th className="py-2 font-medium">{t("email.colRecipient") || "Empfänger"}</th>
                      <th className="py-2 font-medium">{t("email.colSubject") || "Betreff"}</th>
                      <th className="py-2 font-medium">{t("email.colInvoice") || "Rechnung"}</th>
                      <th className="py-2 font-medium">{t("email.colStatus") || "Status"}</th>
                      <th className="py-2 font-medium"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {emails.map((e) => (
                      <tr key={e.id} className="border-b hover:bg-gray-50 dark:bg-gray-900">
                        <td className="py-2 text-gray-600 dark:text-gray-300 whitespace-nowrap">
                          {fmtDate(e.sentAt || e.createdAt)}
                        </td>
                        <td className="py-2">
                          <div className="font-medium">{e.recipientName || e.recipientEmail}</div>
                          {e.recipientName && (
                            <div className="text-xs text-gray-500 dark:text-gray-400">{e.recipientEmail}</div>
                          )}
                        </td>
                        <td className="py-2 max-w-[300px] truncate">{e.subject || "—"}</td>
                        <td className="py-2">
                          {e.invoice ? (
                            <Link
                              href={`/dashboard/invoices/${e.invoice.id}`}
                              className="text-blue-600 dark:text-blue-400 hover:underline font-mono text-xs"
                            >
                              {e.invoice.invoiceNumber}
                            </Link>
                          ) : "—"}
                        </td>
                        <td className="py-2">
                          <span className={`text-xs px-2 py-0.5 rounded ${STATUS_COLOR[e.status] || STATUS_COLOR.draft}`}>
                            {t(`email.status.${e.status}`) || e.status}
                          </span>
                        </td>
                        <td className="py-2 text-right">
                          <Button variant="outline" size="sm" onClick={() => openDetail(e.id)}>
                            {t("common.view") || "Ansehen"}
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Pagination */}
            {!loading && totalPages > 1 && (
              <div className="flex items-center justify-between mt-4 pt-4 border-t">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => setPage(Math.max(1, page - 1))}
                >
                  {t("common.prev") || "Zurück"}
                </Button>
                <span className="text-sm text-gray-500 dark:text-gray-400">
                  {t("common.page") || "Seite"} {page} / {totalPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= totalPages}
                  onClick={() => setPage(Math.min(totalPages, page + 1))}
                >
                  {t("common.next") || "Weiter"}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Detail modal */}
      {selected && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <Card className="w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <CardHeader>
              <CardTitle>{selected.subject || "(ohne Betreff)"}</CardTitle>
              <div className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                {t("email.colRecipient") || "An"}: {selected.recipientName} &lt;{selected.recipientEmail}&gt;
              </div>
              <div className="text-sm text-gray-500 dark:text-gray-400">
                {t("email.colDate") || "Gesendet"}: {fmtDate(selected.sentAt || selected.createdAt)}
              </div>
              <div className="text-sm mt-1">
                <span className={`text-xs px-2 py-0.5 rounded ${STATUS_COLOR[selected.status] || STATUS_COLOR.draft}`}>
                  {t(`email.status.${selected.status}`) || selected.status}
                </span>
                {selected.invoice && (
                  <span className="ml-2 text-xs text-gray-500 dark:text-gray-400">
                    {t("email.colInvoice") || "Rechnung"}:{" "}
                    <Link href={`/dashboard/invoices/${selected.invoice.id}`} className="text-blue-600 dark:text-blue-400 hover:underline font-mono">
                      {selected.invoice.invoiceNumber}
                    </Link>
                  </span>
                )}
              </div>
            </CardHeader>
            <CardContent>
              {loadingDetail ? (
                <div className="text-center py-8 text-gray-500 dark:text-gray-400">
                  {t("common.loading") || "Lädt..."}
                </div>
              ) : (
                <>
                  <pre className="whitespace-pre-wrap text-sm bg-gray-50 dark:bg-gray-900 p-4 rounded border">
                    {selected.bodyPreview || t("email.noBodyPreview") || "(kein Vorschau-Text)"}
                  </pre>
                  {selected.notes && (
                    <div className="mt-4 p-3 bg-red-50 border border-red-200 text-red-800 rounded text-sm">
                      <strong>{t("email.notes") || "Fehler"}:</strong> {selected.notes}
                    </div>
                  )}
                  {Array.isArray((selected as any).attachmentPaths) && (selected as any).attachmentPaths.length > 0 && (
                    <div className="mt-4 text-sm">
                      <strong>{t("email.attachments") || "Anhänge"}:</strong>{" "}
                      {((selected as any).attachmentPaths as string[]).join(", ")}
                    </div>
                  )}
                </>
              )}
              <div className="mt-6 flex justify-end">
                <Button variant="outline" onClick={closeDetail}>
                  {t("common.close") || "Schließen"}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  )
}
