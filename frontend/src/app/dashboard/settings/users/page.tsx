"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import LanguageSwitcher from "@/components/LanguageSwitcher"
import { useI18n } from "@/components/useI18n"
import { useToast } from "@/components/useToast"

interface User {
  id: string
  email: string
  role: string
  status: string
  createdAt: string
  lastLogin: string | null
}

interface Invitation {
  id: string
  email: string
  role: string
  expiresAt: string
  createdAt: string
  createdBy?: { email: string }
}

export default function UsersPage() {
  const router = useRouter()
  const { t } = useI18n()
  const toast = useToast()

  const [users, setUsers] = useState<User[]>([])
  const [invitations, setInvitations] = useState<Invitation[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [currentUserId, setCurrentUserId] = useState<string | null>(null)
  const [currentUserRole, setCurrentUserRole] = useState<string | null>(null)

  // Invite form
  const [showInvite, setShowInvite] = useState(false)
  const [inviteEmail, setInviteEmail] = useState("")
  const [inviteRole, setInviteRole] = useState("accountant")
  const [inviting, setInviting] = useState(false)
  const [inviteMsg, setInviteMsg] = useState<string | null>(null)

  // Action feedback
  const [actionMsg, setActionMsg] = useState<string | null>(null)

  useEffect(() => {
    const companyId = localStorage.getItem("companyId")
    const userId = localStorage.getItem("userId")
    if (!companyId) {
      router.push("/login")
      return
    }
    setCurrentUserId(userId)
    loadAll(companyId, userId)
     
  }, [router])

  // If we got a 403 on the initial load, the user is not an admin
  // of the company they were trying to access. Bounce them to the
  // dashboard with an explanatory message rather than showing a
  // confusing "no access" warning in place.
  useEffect(() => {
    if (error && /Unzureichende Berechtigung|Forbidden/i.test(error)) {
      router.replace("/dashboard?notice=" + encodeURIComponent("Benutzerverwaltung erfordert Administrator-Rechte."))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [error])

  // Same handling for the case where localStorage points to a different
  // company than the one the user actually belongs to (stale session).
  useEffect(() => {
    if (!loading && currentUserRole === "unknown") {
      router.replace("/dashboard?notice=" + encodeURIComponent("Sitzung abgelaufen. Bitte melden Sie sich erneut an."))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, currentUserRole])

  const loadAll = async (companyId: string, userId: string | null) => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(
        `http://localhost:3001/api/v1/users?companyId=${companyId}`,
        { headers: { "x-user-id": userId || "", "x-company-id": companyId } }
      )
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        setError(data.message || `Fehler ${res.status}`)
        return
      }
      const data = await res.json()
      setUsers(data.users || [])
      setInvitations(data.pendingInvitations || [])

      // Cache current user's role for permission gates
      const me = (data.users || []).find((u: User) => u.id === userId)
      if (me) {
        setCurrentUserRole(me.role)
      } else {
        // The user is logged in but their id wasn't returned in the list.
        // This usually means localStorage points to a different company
        // than the one the user actually belongs to (e.g. stale session).
        // Treat as unauthorized and redirect.
         
        console.warn("[users] current user not in company user list — likely stale session")
        setCurrentUserRole("unknown")
      }
    } catch (err) {
      console.error("Users load error:", err)
      setError("Netzwerkfehler")
    } finally {
      setLoading(false)
    }
  }

  const isAdmin = currentUserRole === "admin"

  const sendInvite = async () => {
    const companyId = localStorage.getItem("companyId")
    const userId = localStorage.getItem("userId")
    if (!companyId || !userId) return
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(inviteEmail.trim())) {
      setInviteMsg("Bitte geben Sie eine gültige E-Mail-Adresse ein.")
      return
    }
    setInviting(true)
    setInviteMsg(null)
    try {
      const res = await fetch(
        `http://localhost:3001/api/v1/users/invitations?companyId=${companyId}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-user-id": userId,
            "x-company-id": companyId,
          },
          body: JSON.stringify({ email: inviteEmail.trim().toLowerCase(), role: inviteRole }),
        }
      )
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setInviteMsg(data.message || "Fehler beim Senden der Einladung")
        return
      }
      setInviteMsg(t("users.invitationSent"))
      setInviteEmail("")
      setInviteRole("accountant")
      await loadAll(companyId, userId)
    } catch {
      setInviteMsg("Netzwerkfehler")
    } finally {
      setInviting(false)
    }
  }

  const resendInvite = async (id: string) => {
    const companyId = localStorage.getItem("companyId")
    const userId = localStorage.getItem("userId")
    if (!companyId || !userId) return
    const res = await fetch(
      `http://localhost:3001/api/v1/users/invitations/${id}/resend?companyId=${companyId}`,
      {
        method: "POST",
        headers: { "x-user-id": userId, "x-company-id": companyId },
      }
    )
    if (res.ok) {
      setActionMsg("✓ Einladung erneut versendet")
      await loadAll(companyId, userId)
    }
  }

  const cancelInvite = async (id: string) => {
    if (!confirm(t("users.confirmCancel"))) return
    const companyId = localStorage.getItem("companyId")
    const userId = localStorage.getItem("userId")
    if (!companyId || !userId) return
    const res = await fetch(
      `http://localhost:3001/api/v1/users/invitations/${id}?companyId=${companyId}`,
      {
        method: "DELETE",
        headers: { "x-user-id": userId, "x-company-id": companyId },
      }
    )
    if (res.ok) {
      setActionMsg("✓ Einladung storniert")
      await loadAll(companyId, userId)
    }
  }

  const changeRole = async (userId: string, newRole: string) => {
    const companyId = localStorage.getItem("companyId")
    const myId = localStorage.getItem("userId")
    if (!companyId || !myId) return
    const res = await fetch(
      `http://localhost:3001/api/v1/users/${userId}/role?companyId=${companyId}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "x-user-id": myId,
          "x-company-id": companyId,
        },
        body: JSON.stringify({ role: newRole }),
      }
    )
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      toast.error(data.message || "Fehler beim Ändern der Rolle")
      return
    }
    setActionMsg("✓ Rolle aktualisiert")
    await loadAll(companyId, myId)
  }

  const setUserStatus = async (userId: string, status: "active" | "inactive") => {
    if (status === "inactive" && !confirm(t("users.confirmDeactivate"))) return
    const companyId = localStorage.getItem("companyId")
    const myId = localStorage.getItem("userId")
    if (!companyId || !myId) return
    const res = await fetch(
      `http://localhost:3001/api/v1/users/${userId}/status?companyId=${companyId}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "x-user-id": myId,
          "x-company-id": companyId,
        },
        body: JSON.stringify({ status }),
      }
    )
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      toast.error(data.message || "Fehler beim Ändern des Status")
      return
    }
    setActionMsg(status === "inactive" ? "✓ Benutzer deaktiviert" : "✓ Benutzer aktiviert")
    await loadAll(companyId, myId)
  }

  const formatDate = (s: string) => new Date(s).toLocaleDateString("de-DE")

  const roleLabel = (r: string) => {
    if (r === "admin") return t("users.roleAdmin")
    if (r === "accountant") return t("users.roleAccountant")
    if (r === "viewer") return t("users.roleViewer")
    return r
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 p-6">
      <div className="max-w-5xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t("users.title")}</h1>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{t("users.subtitle")}</p>
          </div>
          <div className="flex items-center gap-3">
            <LanguageSwitcher />
            <Button variant="outline" onClick={() => router.push("/dashboard/settings")}>
              {t("common.back")}
            </Button>
          </div>
        </div>

        {/* Show role notice only after we have determined the user is NOT admin.
            During loading, currentUserRole is null and we suppress the notice to
            avoid showing a misleading "no access" message that flashes on every
            page load. The 403 redirect above handles truly-unauthorized users. */}
        {currentUserRole !== null && !isAdmin && (
          <div className="bg-yellow-50 border border-yellow-200 text-yellow-800 px-4 py-3 rounded mb-4 text-sm">
            ⓘ {currentUserRole === "accountant"
              ? t("users.roleAccountantDesc")
              : currentUserRole === "viewer"
                ? t("users.roleViewerDesc")
                : `${t("common.info")}: ${t("users.title")} — ${t("users.roleAdmin")} only.`}
          </div>
        )}

        {loading && !error && (
          <div className="text-center text-gray-500 dark:text-gray-400 py-6 text-sm">…</div>
        )}

        {actionMsg && (
          <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 px-4 py-2 rounded mb-4 text-sm">
            {actionMsg}
          </div>
        )}

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 dark:text-red-300 px-4 py-3 rounded mb-4 text-sm">
            {error}
          </div>
        )}

        {/* Invite form */}
        {isAdmin && (
          <Card className="mb-6">
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle>{t("users.inviteUser")}</CardTitle>
                <Button size="sm" onClick={() => setShowInvite(!showInvite)}>
                  {showInvite ? "×" : `+ ${t("users.inviteUser")}`}
                </Button>
              </div>
            </CardHeader>
            {showInvite && (
              <CardContent>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <div className="md:col-span-1">
                    <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">
                      {t("users.inviteEmail")}
                    </label>
                    <input
                      type="email"
                      value={inviteEmail}
                      onChange={(e) => setInviteEmail(e.target.value)}
                      placeholder="mitarbeiter@firma.de"
                      className="w-full px-2 py-1.5 border rounded text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">
                      {t("users.inviteRole")}
                    </label>
                    <select
                      value={inviteRole}
                      onChange={(e) => setInviteRole(e.target.value)}
                      className="w-full px-2 py-1.5 border rounded text-sm"
                    >
                      <option value="accountant">{t("users.roleAccountant")}</option>
                      <option value="viewer">{t("users.roleViewer")}</option>
                      <option value="admin">{t("users.roleAdmin")}</option>
                    </select>
                  </div>
                  <div className="flex items-end">
                    <Button onClick={sendInvite} disabled={inviting} size="sm" className="w-full">
                      {inviting ? "…" : t("users.sendInvitation")}
                    </Button>
                  </div>
                </div>
                {inviteMsg && (
                  <p
                    className={`mt-2 text-sm ${
                      inviteMsg.includes("versendet") || inviteMsg.includes("sent")
                        ? "text-emerald-700"
                        : "text-red-700 dark:text-red-300"
                    }`}
                  >
                    {inviteMsg}
                  </p>
                )}
              </CardContent>
            )}
          </Card>
        )}

        {/* Pending invitations */}
        {isAdmin && (
          <Card className="mb-6">
            <CardHeader>
              <CardTitle>{t("users.pendingInvitations")}</CardTitle>
            </CardHeader>
            <CardContent>
              {invitations.length === 0 ? (
                <p className="text-sm text-gray-500 dark:text-gray-400 text-center py-3">{t("users.noInvitations")}</p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b">
                      <th className="text-left py-2 font-medium">{t("users.email")}</th>
                      <th className="text-left py-2 font-medium">{t("users.role")}</th>
                      <th className="text-left py-2 font-medium">{t("users.expires")}</th>
                      <th className="text-right py-2 font-medium">{t("ustva.actions")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {invitations.map((inv) => (
                      <tr key={inv.id} className="border-b hover:bg-gray-50 dark:bg-gray-900">
                        <td className="py-2">{inv.email}</td>
                        <td className="py-2">{roleLabel(inv.role)}</td>
                        <td className="py-2 text-gray-600 dark:text-gray-300">{formatDate(inv.expiresAt)}</td>
                        <td className="py-2 text-right space-x-2">
                          <button
                            onClick={() => resendInvite(inv.id)}
                            className="text-blue-600 dark:text-blue-400 hover:underline text-xs"
                          >
                            {t("users.resend")}
                          </button>
                          <button
                            onClick={() => cancelInvite(inv.id)}
                            className="text-red-600 dark:text-red-400 hover:underline text-xs"
                          >
                            {t("users.cancel")}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>
        )}

        {/* Active users */}
        <Card>
          <CardHeader>
            <CardTitle>
              {t("users.activeUsers")} ({users.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <p className="text-center text-gray-500 dark:text-gray-400 py-6">…</p>
            ) : users.length === 0 ? (
              <p className="text-sm text-gray-500 dark:text-gray-400 text-center py-3">{t("users.noUsers")}</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="text-left py-2 font-medium">{t("users.email")}</th>
                    <th className="text-left py-2 font-medium">{t("users.role")}</th>
                    <th className="text-left py-2 font-medium">{t("users.status")}</th>
                    <th className="text-left py-2 font-medium">{t("users.lastLogin")}</th>
                    <th className="text-left py-2 font-medium">{t("users.joined")}</th>
                    {isAdmin && <th className="text-right py-2 font-medium">{t("ustva.actions")}</th>}
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => {
                    const isMe = u.id === currentUserId
                    return (
                      <tr key={u.id} className="border-b hover:bg-gray-50 dark:bg-gray-900">
                        <td className="py-2">
                          {u.email}
                          {isMe && (
                            <span className="ml-2 text-xs text-gray-500 dark:text-gray-400">{t("users.yourAccount")}</span>
                          )}
                        </td>
                        <td className="py-2">
                          {isAdmin && !isMe ? (
                            <select
                              value={u.role}
                              onChange={(e) => changeRole(u.id, e.target.value)}
                              className="text-xs border rounded px-1.5 py-1"
                            >
                              <option value="admin">{t("users.roleAdmin")}</option>
                              <option value="accountant">{t("users.roleAccountant")}</option>
                              <option value="viewer">{t("users.roleViewer")}</option>
                            </select>
                          ) : (
                            <span>{roleLabel(u.role)}</span>
                          )}
                        </td>
                        <td className="py-2">
                          <span
                            className={`text-xs px-2 py-0.5 rounded ${
                              u.status === "active"
                                ? "bg-emerald-100 text-emerald-800"
                                : "bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-200"
                            }`}
                          >
                            {u.status === "active" ? t("users.statusActive") : t("users.statusInactive")}
                          </span>
                        </td>
                        <td className="py-2 text-gray-600 dark:text-gray-300">
                          {u.lastLogin ? formatDate(u.lastLogin) : t("users.never")}
                        </td>
                        <td className="py-2 text-gray-600 dark:text-gray-300">{formatDate(u.createdAt)}</td>
                        {isAdmin && (
                          <td className="py-2 text-right">
                            {!isMe && (
                              <>
                                {u.status === "active" ? (
                                  <button
                                    onClick={() => setUserStatus(u.id, "inactive")}
                                    className="text-orange-600 hover:underline text-xs"
                                  >
                                    {t("users.deactivate")}
                                  </button>
                                ) : (
                                  <button
                                    onClick={() => setUserStatus(u.id, "active")}
                                    className="text-emerald-600 hover:underline text-xs"
                                  >
                                    {t("users.activate")}
                                  </button>
                                )}
                              </>
                            )}
                          </td>
                        )}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}