"use client"

import { useEffect, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"

export default function ResetPasswordPage() {
  const router = useRouter()
  const search = useSearchParams()
  const token = search.get("token") || ""

  const [password, setPassword] = useState("")
  const [confirm, setConfirm] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  useEffect(() => {
    if (!token) {
      setError(
        "Kein Token gefunden. Bitte fordern Sie einen neuen Link über die Passwort-vergessen-Seite an."
      )
    }
  }, [token])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setSuccess(null)

    if (password.length < 8) {
      setError("Passwort muss mindestens 8 Zeichen lang sein.")
      return
    }
    if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
      setError("Passwort muss Buchstaben und Zahlen enthalten.")
      return
    }
    if (password !== confirm) {
      setError("Passwörter stimmen nicht überein.")
      return
    }

    setLoading(true)
    try {
      const res = await fetch("http://localhost:3001/api/v1/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(data?.message || "Token ungültig oder abgelaufen.")
        return
      }
      setSuccess(
        data?.message || "Passwort wurde aktualisiert. Sie können sich jetzt anmelden."
      )
      setTimeout(() => router.push("/login"), 2000)
    } catch {
      setError("Netzwerkfehler. Bitte versuchen Sie es erneut.")
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-center text-2xl">Neues Passwort festlegen</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4" autoComplete="on">
            <p className="text-sm text-gray-600">
              Wählen Sie ein neues Passwort (mindestens 8 Zeichen, mit Buchstaben und Zahlen).
            </p>

            {success && (
              <div
                className="bg-green-50 text-green-800 border border-green-200 p-3 rounded text-sm"
                role="status"
              >
                {success}
              </div>
            )}
            {error && (
              <div
                className="bg-red-100 text-red-700 p-3 rounded text-sm"
                role="alert"
              >
                {error}
              </div>
            )}

            <div>
              <label className="block text-sm font-medium mb-1" htmlFor="password">
                Neues Passwort
              </label>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete="new-password"
                maxLength={128}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Mindestens 8 Zeichen"
                required
                disabled={loading || !token || !!success}
              />
            </div>

            <div>
              <label className="block text-sm font-medium mb-1" htmlFor="confirm">
                Passwort bestätigen
              </label>
              <Input
                id="confirm"
                name="confirm"
                type="password"
                autoComplete="new-password"
                maxLength={128}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="Passwort wiederholen"
                required
                disabled={loading || !token || !!success}
              />
            </div>

            <Button
              type="submit"
              className="w-full"
              disabled={loading || !token || !!success}
            >
              {loading ? "Wird gespeichert…" : "Passwort speichern"}
            </Button>

            <p className="text-center text-sm">
              <a href="/login" className="text-blue-600 hover:underline">
                ← Zurück zur Anmeldung
              </a>
            </p>
          </form>
        </CardContent>
      </Card>
    </main>
  )
}
