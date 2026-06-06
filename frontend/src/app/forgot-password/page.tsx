"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"

export default function ForgotPasswordPage() {
  const router = useRouter()
  const [email, setEmail] = useState("")
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const isValidEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim())

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setMessage(null)

    if (!isValidEmail(email)) {
      setError("Bitte geben Sie eine gültige E-Mail-Adresse ein.")
      return
    }

    setLoading(true)
    try {
      const res = await fetch("http://localhost:3001/api/v1/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim().toLowerCase() }),
      })
      const data = await res.json().catch(() => ({}))
      setMessage(
        data?.message ||
          "Falls ein Konto mit dieser E-Mail-Adresse existiert, wurde ein Link zum Zurücksetzen des Passworts versendet."
      )
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
          <CardTitle className="text-center text-2xl">Passwort zurücksetzen</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4" autoComplete="on">
            <p className="text-sm text-gray-600">
              Geben Sie Ihre E-Mail-Adresse ein. Wir senden Ihnen einen Link, mit dem Sie
              ein neues Passwort festlegen können. Der Link ist 1 Stunde gültig.
            </p>

            {message && (
              <div
                className="bg-green-50 text-green-800 border border-green-200 p-3 rounded text-sm"
                role="status"
              >
                {message}
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
              <label className="block text-sm font-medium mb-1" htmlFor="email">
                E-Mail-Adresse
              </label>
              <Input
                id="email"
                name="email"
                type="email"
                autoComplete="username"
                inputMode="email"
                maxLength={254}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="email@example.com"
                required
                disabled={loading}
              />
            </div>

            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? "Wird gesendet…" : "Link anfordern"}
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
