"use client"

import { useEffect, useState, useRef, useCallback } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import LanguageSwitcher from "@/components/LanguageSwitcher"
import { useI18n } from "@/components/useI18n"
import { apiGet, apiPost, apiDelete, ApiError } from "@/lib/api"

interface StorageSettings {
  localPath: string
  cloudEnabled: boolean
  cloudProvider: "s3" | "minio" | "local"
}

interface StorageStats {
  totalFiles: number
  totalSize: number
  totalSizeFormatted: string
  usageByType: Record<string, { count: number; size: number }>
}

interface StorageHealth {
  localPath: string
  reachable: boolean
  writable: boolean
  freeBytes?: number
  freeBytesFormatted?: string
}

interface StoredFile {
  filename: string
  originalName: string
  path: string
  type: string
  size: number
  uploadedAt: string
  url: string
}

interface CompanySettings {
  name: string
  legalName: string
  taxId: string
  vatId: string
  email: string
  phone: string
  address: {
    street: string
    postalCode: string
    city: string
    country: string
  }
  bankInfo: {
    bankName: string
    iban: string
    bic: string
  }
  settings: {
    defaultCurrency: string
    defaultLanguage: string
  }
  logoPath: string
  invoicePrefix: string
  defaultPaymentDays: number
}

export default function SettingsPage() {
  const router = useRouter()
  const { t, locale, getDateLocale } = useI18n()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [companyId, setCompanyId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(false)
  const [currentLogo, setCurrentLogo] = useState<string | null>(null)
  const [storageStats, setStorageStats] = useState<StorageStats | null>(null)
  const [storageHealth, setStorageHealth] = useState<StorageHealth | null>(null)
  const [storedFiles, setStoredFiles] = useState<StoredFile[]>([])
  const [storageSaving, setStorageSaving] = useState(false)
  const [storageSavedMsg, setStorageSavedMsg] = useState<string | null>(null)
  const [storageError, setStorageError] = useState<string | null>(null)
  const [storageLoading, setStorageLoading] = useState(false)

  const [form, setForm] = useState<CompanySettings>({
    name: "",
    legalName: "",
    taxId: "",
    vatId: "",
    email: "",
    phone: "",
    address: {
      street: "",
      postalCode: "",
      city: "",
      country: "Deutschland",
    },
    bankInfo: {
      bankName: "",
      iban: "",
      bic: "",
    },
    settings: {
      defaultCurrency: "EUR",
      defaultLanguage: "de",
    },
    logoPath: "",
    invoicePrefix: "INV",
    defaultPaymentDays: 30,
  })

  const [storageForm, setStorageForm] = useState<StorageSettings>({
    localPath: "",
    cloudEnabled: false,
    cloudProvider: "local",
  })

  // SMTP / Mail config
  interface MailConfig {
    configured: boolean
    smtpHost: string
    smtpPort: number
    smtpSecure: boolean
    smtpUser: string
    smtpPassword: string
    fromName: string
    fromEmail: string
    enabled: boolean
    source?: "env" | "database"
  }
  const [mailForm, setMailForm] = useState<MailConfig>({
    configured: false,
    smtpHost: "",
    smtpPort: 587,
    smtpSecure: false,
    smtpUser: "",
    smtpPassword: "",
    fromName: "",
    fromEmail: "",
    enabled: true,
  })
  const [mailSaving, setMailSaving] = useState(false)
  const [mailTesting, setMailTesting] = useState(false)
  const [mailMessage, setMailMessage] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    const storedCompanyId = localStorage.getItem("companyId")
    if (!storedCompanyId) {
      router.push("/login")
      return
    }
    setCompanyId(storedCompanyId)

    import("@/lib/api").then(({ apiGet }) => {
      apiGet<any>(`/api/v1/companies/${storedCompanyId}`)
        .then((data) => {
          if (data && data.id) {
            const address = data.address || {}
            const bankInfo = data.bankInfo || {}
            const settings = data.settings || {}

            setForm({
              name: data.name || "",
              legalName: data.legalName || "",
              taxId: data.taxId || "",
              vatId: data.vatId || "",
              email: data.email || "",
              phone: data.phone || "",
              address: {
                street: address.street || "",
                postalCode: address.postalCode || "",
                city: address.city || "",
                country: address.country || "Deutschland",
              },
              bankInfo: {
                bankName: bankInfo.bankName || "",
                iban: bankInfo.iban || "",
                bic: bankInfo.bic || "",
              },
              settings: {
                defaultCurrency: settings.defaultCurrency || "EUR",
                defaultLanguage: settings.defaultLanguage || "de",
              },
              logoPath: data.logoPath ?? "",
              // Use `??` (nullish coalescing), not `||`, for these —
              // `||` would silently rewrite 0 (Sofort fällig) to 30
              // and "" to "INV", making it look like the user's save
              // was ignored on the next page load.
              invoicePrefix: data.invoicePrefix ?? "INV",
              defaultPaymentDays: data.defaultPaymentDays ?? 30,
            })

            if (data.logoPath) {
              setCurrentLogo(`/images/${data.logoPath}`)
            }
          }
          setLoading(false)
        })
        .catch(() => {
          setLoading(false)
        })
    })

    // Fetch storage config (read by every authenticated user — no
    // @Require('company.update') on /storage/config GET)
    apiGet<any>("/api/v1/storage/config")
      .then((config) => {
        setStorageForm({
          localPath: config.localPath || "",
          cloudEnabled: config.cloudEnabled || false,
          cloudProvider: config.cloudProvider || "local",
        })
      })
      .catch((err) => {
        // 403/404 are common here if the user is on a role that
        // can't see storage config; surface the message so the user
        // isn't left wondering why the form is empty.
        const msg = err instanceof ApiError ? err.message : "Konfiguration konnte nicht geladen werden."
        setStorageError(msg)
      })

    // Fetch storage stats + health + file list. All three go through
    // apiGet/apiPost/etc so the x-user-id/x-company-id headers are
    // injected automatically — raw fetch() was the bug that made
    // every storage call return 401.
    if (storedCompanyId) {
      refetchStorage(storedCompanyId)
    }

    // Fetch mail config
    apiGet<any>(`/api/v1/mail/config?companyId=${storedCompanyId}`)
      .then((cfg) => {
        if (cfg) setMailForm((f) => ({ ...f, ...cfg }))
      })
      .catch(() => {})
  }, [router])

  // Re-load stats / health / file list. Used both on first mount
  // and after a successful save (so the new localPath shows up
  // immediately without a manual refresh).
  const refetchStorage = useCallback(async (cid: string) => {
    setStorageLoading(true)
    setStorageError(null)
    try {
      const [stats, health, files] = await Promise.all([
        apiGet<StorageStats>(`/api/v1/storage/stats?companyId=${cid}`),
        apiGet<StorageHealth>(`/api/v1/storage/health`),
        apiGet<StoredFile[]>(`/api/v1/storage/list?companyId=${cid}`),
      ])
      setStorageStats(stats)
      setStorageHealth(health)
      setStoredFiles(Array.isArray(files) ? files : [])
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "Speicherstatistik konnte nicht geladen werden."
      setStorageError(msg)
      // Clear stale data so the user doesn't act on numbers from a
      // previous successful load.
      setStorageStats(null)
      setStoredFiles([])
    } finally {
      setStorageLoading(false)
    }
  }, [])

  const saveMailConfig = async () => {
    if (!companyId) return
    setMailSaving(true)
    setMailMessage(null)
    try {
      const res = await fetch(
        `http://localhost:3001/api/v1/mail/config?companyId=${companyId}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(mailForm),
        },
      )
      const data = await res.json()
      if (res.ok) {
        setMailMessage({ ok: true, text: t("mail.savedOk") })
        setMailForm((f) => ({ ...f, configured: true }))
      } else {
        setMailMessage({ ok: false, text: data.message || t("common.saveError") })
      }
    } catch (e: any) {
      setMailMessage({ ok: false, text: e?.message || t("common.networkError") })
    } finally {
      setMailSaving(false)
    }
  }

  const testMailConnection = async () => {
    if (!companyId) return
    setMailTesting(true)
    setMailMessage(null)
    try {
      const res = await fetch(
        `http://localhost:3001/api/v1/mail/test?companyId=${companyId}`,
        { method: "POST" },
      )
      const data = await res.json()
      if (data.ok) {
        setMailMessage({ ok: true, text: `${t("mail.testOk")} (${data.from})` })
      } else {
        setMailMessage({ ok: false, text: data.error || (t("mail.testFailed")) })
      }
    } catch (e: any) {
      setMailMessage({ ok: false, text: e?.message || t("common.networkError") })
    } finally {
      setMailTesting(false)
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!companyId) return

    setSaving(true)
    try {
      const { apiPut, ApiError } = await import("@/lib/api")
      await apiPut(`/api/v1/companies/${companyId}`, form)
      // Refetch so the form reflects the canonical stored value —
      // without this, a user who just changed defaultPaymentDays from
      // 0 (Sofort fällig) to 14 would see "14" stay, but a user who
      // didn't touch it would see whatever the server sent back. The
      // `|| 30` → `?? 30` fix in the load function was the other half
      // of this same bug.
      const fresh = await apiGet<any>(`/api/v1/companies/${companyId}`)
      if (fresh && fresh.id) {
        const address = fresh.address || {}
        const bankInfo = fresh.bankInfo || {}
        const settings = fresh.settings || {}
        setForm({
          name: fresh.name ?? "",
          legalName: fresh.legalName ?? "",
          taxId: fresh.taxId ?? "",
          vatId: fresh.vatId ?? "",
          email: fresh.email ?? "",
          phone: fresh.phone ?? "",
          address: {
            street: address.street ?? "",
            postalCode: address.postalCode ?? "",
            city: address.city ?? "",
            country: address.country ?? "Deutschland",
          },
          bankInfo: {
            bankName: bankInfo.bankName ?? "",
            iban: bankInfo.iban ?? "",
            bic: bankInfo.bic ?? "",
          },
          settings: {
            defaultCurrency: settings.defaultCurrency ?? "EUR",
            defaultLanguage: settings.defaultLanguage ?? "de",
          },
          logoPath: fresh.logoPath ?? "",
          invoicePrefix: fresh.invoicePrefix ?? "INV",
          defaultPaymentDays: fresh.defaultPaymentDays ?? 30,
        })
      }
      alert(t("settings.saved"))
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : t("settings.saveError")
      alert(msg)
    } finally {
      setSaving(false)
    }
  }

  const handleLogoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || !companyId) return

    // Validate file type
    if (!file.type.startsWith("image/")) {
      alert(t("settings.invalidFileType"))
      return
    }

    // Validate file size (max 2MB)
    if (file.size > 2 * 1024 * 1024) {
      alert(t("settings.fileTooLarge"))
      return
    }

    setUploadProgress(true)

    try {
      const formData = new FormData()
      formData.append("file", file)
      formData.append("companyId", companyId)

      const res = await fetch("http://localhost:3001/api/v1/companies/upload-logo", {
        method: "POST",
        body: formData,
      })

      if (res.ok) {
        const data = await res.json()
        setCurrentLogo(`/images/${data.filename}`)
        setForm({ ...form, logoPath: data.filename })
        alert(t("settings.logoUploaded"))
      } else {
        alert(t("settings.uploadError"))
      }
    } catch (error) {
      alert(t("settings.uploadError"))
    } finally {
      setUploadProgress(false)
    }
  }

  const removeLogo = () => {
    setCurrentLogo(null)
    setForm({ ...form, logoPath: "" })
  }

  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return "0 B"
    const k = 1024
    const sizes = ["B", "KB", "MB", "GB"]
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i]
  }

  const deleteFile = async (f: StoredFile) => {
    if (!confirm(t("storage.fileDeleteConfirm"))) return
    const cid = localStorage.getItem("companyId")
    if (!cid) return
    try {
      // The backend's *splat route expects the path segments joined
      // by commas (see controller's `.replace(/,/g, '/')`), but our
      // f.path uses real slashes. Convert here, then pass the raw
      // string — apiFetch will URL-encode the slashes for us so the
      // server receives the comma-joined path intact.
      const splatPath = f.path.replace(/\//g, ",")
      await apiDelete(`/api/v1/storage/files/${splatPath}`)
      setStoredFiles((prev) => prev.filter((x) => x.path !== f.path))
      // Refresh stats so the deleted file's size disappears from
      // the totals immediately.
      try {
        const stats = await apiGet<StorageStats>(`/api/v1/storage/stats?companyId=${cid}`)
        setStorageStats(stats)
      } catch {
        // non-fatal
      }
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "Löschen fehlgeschlagen"
      alert(msg)
    }
  }

  if (loading) {
    return (
      <main className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-gray-500">{t("common.loading")}</div>
      </main>
    )
  }

  return (
    <main className="min-h-screen bg-gray-50">
      <header className="bg-white border-b shadow-sm">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <h1 className="text-2xl font-bold text-blue-600">{t("nav.settings")}</h1>
          <div className="flex gap-2 items-center">
            <button
              onClick={() => router.push("/dashboard/settings/users")}
              className="px-3 py-1 text-sm border border-blue-600 text-blue-700 rounded hover:bg-blue-50 font-medium"
              title="Benutzerverwaltung"
            >
              {t("users.title")}
            </button>
            <LanguageSwitcher />
            <Button variant="outline" onClick={() => router.push("/dashboard")}>
              {t("common.back")}
            </Button>
          </div>
        </div>
      </header>

      <div className="container mx-auto px-4 py-8 max-w-3xl">
        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Logo Upload Card */}
          <Card>
            <CardHeader>
              <CardTitle>{t("settings.companyLogo")}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-start gap-6">
                {/* Current Logo Preview */}
                <div className="w-40 h-40 border-2 border-dashed border-gray-300 rounded-lg flex items-center justify-center bg-gray-50 overflow-hidden">
                  {currentLogo ? (
                    <img
                      src={currentLogo}
                      alt={t("common.companyLogoAlt")}
                      className="max-w-full max-h-full object-contain"
                    />
                  ) : (
                    <span className="text-gray-400 text-sm text-center px-2">
                      {t("settings.noLogo")}
                    </span>
                  )}
                </div>

                {/* Upload Controls */}
                <div className="flex-1 space-y-3">
                  <input
                    type="file"
                    ref={fileInputRef}
                    onChange={handleLogoUpload}
                    accept="image/*"
                    className="hidden"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploadProgress}
                  >
                    {uploadProgress
                      ? t("settings.uploading")
                      : t("settings.uploadLogo")}
                  </Button>
                  {currentLogo && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={removeLogo}
                      className="ml-2 text-red-600"
                    >
                      {t("settings.removeLogo")}
                    </Button>
                  )}
                  <p className="text-xs text-gray-500">
                    {t("settings.logoRecommended")}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Company Info Card */}
          <Card>
            <CardHeader>
              <CardTitle>{t("settings.companyInfo")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-1">
                    {t("settings.companyNameReq")}
                  </label>
                  <Input
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    required
                    placeholder={t("settings.placeholderCompanyName")}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">
                    {t("settings.legalName")}
                  </label>
                  <Input
                    value={form.legalName}
                    onChange={(e) => setForm({ ...form, legalName: e.target.value })}
                    placeholder={t("settings.placeholderLegalName")}
                  />
                </div>
              </div>

              <div className="grid md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-1">UST-IDNr.</label>
                  <Input
                    value={form.vatId}
                    onChange={(e) => setForm({ ...form, vatId: e.target.value })}
                    placeholder="DE123456789"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">
                    {t("settings.taxId")}
                  </label>
                  <Input
                    value={form.taxId}
                    onChange={(e) => setForm({ ...form, taxId: e.target.value })}
                    placeholder={t("settings.placeholderTaxId")}
                  />
                </div>
              </div>

              {/* Contact info — shown on invoices and email footers */}
              <div className="grid md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-1">
                    E-Mail
                  </label>
                  <Input
                    type="email"
                    value={form.email}
                    onChange={(e) => setForm({ ...form, email: e.target.value })}
                    placeholder="info@firma.de"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">
                    Telefon
                  </label>
                  <Input
                    type="tel"
                    value={form.phone}
                    onChange={(e) => setForm({ ...form, phone: e.target.value })}
                    placeholder="+49 6181 12345"
                  />
                </div>
              </div>

              <div className="grid md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-1">
                    {t("settings.street")}
                  </label>
                  <Input
                    value={form.address.street}
                    onChange={(e) =>
                      setForm({ ...form, address: { ...form.address, street: e.target.value } })
                    }
                    placeholder="Musterstraße 123"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">
                    {t("settings.postalCode")}
                  </label>
                  <div className="flex gap-2">
                    <Input
                      value={form.address.postalCode}
                      onChange={(e) =>
                        setForm({ ...form, address: { ...form.address, postalCode: e.target.value } })
                      }
                      placeholder="12345"
                      className="w-28"
                    />
                    <Input
                      value={form.address.city}
                      onChange={(e) =>
                        setForm({ ...form, address: { ...form.address, city: e.target.value } })
                      }
                      placeholder={t("settings.placeholderCity")}
                      className="flex-1"
                    />
                  </div>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">{t("settings.country")}</label>
                <select
                  className="w-full h-10 border rounded-md px-3"
                  value={form.address.country}
                  onChange={(e) =>
                    setForm({ ...form, address: { ...form.address, country: e.target.value } })
                  }
                >
                  <option value="Deutschland">Deutschland</option>
                  <option value="Österreich">Österreich</option>
                  <option value="Schweiz">Schweiz</option>
                  <option value="Frankreich">Frankreich</option>
                  <option value="Niederlande">Niederlande</option>
                </select>
              </div>
            </CardContent>
          </Card>

          {/* Bank Info Card */}
          <Card>
            <CardHeader>
              <CardTitle>
                {t("settings.bankInfo")}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">
                  {t("settings.bankName")}
                </label>
                <Input
                  value={form.bankInfo.bankName}
                  onChange={(e) =>
                    setForm({ ...form, bankInfo: { ...form.bankInfo, bankName: e.target.value } })
                  }
                  placeholder="Deutsche Bank"
                />
              </div>
              <div className="grid md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-1">IBAN</label>
                  <Input
                    value={form.bankInfo.iban}
                    onChange={(e) =>
                      setForm({ ...form, bankInfo: { ...form.bankInfo, iban: e.target.value } })
                    }
                    placeholder="DE89 3704 0044 0532 0130 00"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">BIC / SWIFT</label>
                  <Input
                    value={form.bankInfo.bic}
                    onChange={(e) =>
                      setForm({ ...form, bankInfo: { ...form.bankInfo, bic: e.target.value } })
                    }
                    placeholder="COBADEFFXXX"
                  />
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Invoice Settings Card */}
          <Card>
            <CardHeader>
              <CardTitle>{t("settings.invoiceSettings")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid md:grid-cols-3 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-1">
                    {t("settings.invoicePrefix")}
                  </label>
                  <Input
                    value={form.invoicePrefix}
                    onChange={(e) => setForm({ ...form, invoicePrefix: e.target.value })}
                    placeholder="INV"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">
                    {t("settings.defaultPaymentDays")}
                  </label>
                  <select
                    className="w-full h-10 border rounded-md px-3"
                    value={form.defaultPaymentDays}
                    onChange={(e) =>
                      setForm({ ...form, defaultPaymentDays: Number(e.target.value) })
                    }
                  >
                    <option value={0}>{t("paymentTerm.immediate")}</option>
                    <option value={7}>{t("paymentTerm.days7")}</option>
                    <option value={14}>{t("paymentTerm.days14")}</option>
                    <option value={30}>{t("paymentTerm.days30")}</option>
                    <option value={60}>{t("paymentTerm.days60")}</option>
                    <option value={90}>{t("paymentTerm.days90")}</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">
                    {t("settings.defaultCurrency")}
                  </label>
                  <select
                    className="w-full h-10 border rounded-md px-3"
                    value={form.settings.defaultCurrency}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        settings: { ...form.settings, defaultCurrency: e.target.value },
                      })
                    }
                  >
                    <option value="EUR">EUR - Euro</option>
                    <option value="USD">USD - US Dollar</option>
                    <option value="CHF">CHF - Schweizer Franken</option>
                  </select>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Storage Settings Card */}
          <Card>
            <CardHeader>
              <CardTitle>{t("storage.title")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Top-level error banner (load failures, etc.) — shown
                  above the health banner so the user always sees
                  what's wrong. */}
              {storageError && !storageLoading && (
                <div className="bg-red-50 border border-red-200 text-red-800 text-sm rounded-lg px-4 py-2">
                  ⚠ {storageError}{" "}
                  <button
                    type="button"
                    onClick={() => companyId && refetchStorage(companyId)}
                    className="ml-2 underline"
                  >
                    {t("common.retry") || "Erneut versuchen"}
                  </button>
                </div>
              )}

              {/* Health status banner */}
              {storageHealth && (
                <div
                  className={`text-sm rounded-lg px-4 py-2 ${
                    storageHealth.reachable && storageHealth.writable
                      ? "bg-emerald-50 text-emerald-800 border border-emerald-200"
                      : "bg-orange-50 text-orange-800 border border-orange-200"
                  }`}
                >
                  {storageHealth.reachable && storageHealth.writable ? (
                    <>✓ {t("storage.healthLocal")} ({storageHealth.localPath})
                    {storageHealth.freeBytesFormatted && (
                      <> — {storageHealth.freeBytesFormatted} frei</>
                    )}
                    </>
                  ) : (
                    <>⚠ {t("storage.healthLocalMissing")} ({storageHealth.localPath})</>
                  )}
                </div>
              )}

              {/* Local path (read-only — server config) */}
              <div className="grid md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-1">
                    {t("storage.localPath")}
                  </label>
                  <Input
                    value={storageForm.localPath}
                    onChange={(e) => setStorageForm({ ...storageForm, localPath: e.target.value })}
                    placeholder="~/data/invoice-system"
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    {t("storage.localPathHint")}
                  </p>
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">
                    {t("storage.cloudProvider")}
                  </label>
                  <select
                    className="w-full h-10 border rounded-md px-3"
                    value={storageForm.cloudProvider}
                    onChange={(e) =>
                      setStorageForm({
                        ...storageForm,
                        cloudProvider: e.target.value as "local" | "s3" | "minio",
                      })
                    }
                  >
                    <option value="local">{t("storage.cloudProviderLocal")}</option>
                    <option value="s3">{t("storage.cloudProviderS3")}</option>
                    <option value="minio">{t("storage.cloudProviderMinio")}</option>
                  </select>
                </div>
              </div>

              {/* Cloud toggle (disabled for now — coming soon) */}
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-900">
                <strong>{t("storage.cloudStorage")}:</strong> {t("storage.cloudComingSoon")}
              </div>

              {/* Usage stats */}
              {storageStats && (
                <div className="mt-2 p-4 bg-gray-50 rounded-lg">
                  <h4 className="text-sm font-medium mb-3">{t("storage.usage")}</h4>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    <div>
                      <p className="text-xs text-gray-500">{t("storage.filesCount")}</p>
                      <p className="text-lg font-semibold">{storageStats.totalFiles}</p>
                    </div>
                    <div>
                      <p className="text-xs text-gray-500">{t("storage.totalSize")}</p>
                      <p className="text-lg font-semibold">{storageStats.totalSizeFormatted}</p>
                    </div>
                    {/* Safe access: usageByType might not have every key */}
                    {Object.entries(storageStats.usageByType || {}).map(([type, info]) => (
                      <div key={type}>
                        <p className="text-xs text-gray-500 uppercase">{type}</p>
                        <p className="text-sm">
                          {info.count} {t("storage.files")} ({formatBytes(info.size)})
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Stored files list — download / delete */}
              <div className="mt-2">
                <h4 className="text-sm font-medium mb-2">{t("storage.filesTitle")}</h4>
                {storedFiles.length === 0 ? (
                  <p className="text-sm text-gray-500 text-center py-4">
                    {t("storage.filesEmpty")}
                  </p>
                ) : (
                  <div className="overflow-x-auto border rounded-lg">
                    <table className="w-full text-sm">
                      <thead className="bg-gray-50 border-b">
                        <tr>
                          <th className="text-left px-3 py-2 font-medium">{t("storage.fileName")}</th>
                          <th className="text-left px-3 py-2 font-medium">{t("storage.fileType")}</th>
                          <th className="text-right px-3 py-2 font-medium">{t("storage.fileSize")}</th>
                          <th className="text-left px-3 py-2 font-medium">{t("storage.fileDate")}</th>
                          <th className="text-right px-3 py-2 font-medium">{t("storage.fileActions")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {storedFiles.slice(0, 20).map((f) => (
                          <tr key={f.path} className="border-b hover:bg-gray-50">
                            <td className="px-3 py-2 truncate max-w-xs" title={f.originalName}>
                              {f.originalName}
                            </td>
                            <td className="px-3 py-2 text-xs uppercase text-gray-500">{f.type}</td>
                            <td className="px-3 py-2 text-right">{formatBytes(f.size)}</td>
                            <td className="px-3 py-2 text-gray-500">
                              {new Date(f.uploadedAt).toLocaleDateString(getDateLocale())}
                            </td>
                            <td className="px-3 py-2 text-right space-x-2">
                              <button
                                onClick={() => {
                                  const a = document.createElement("a")
                                  a.href = `http://localhost:3001${f.url}`
                                  a.target = "_blank"
                                  a.rel = "noopener noreferrer"
                                  a.download = f.originalName
                                  document.body.appendChild(a)
                                  a.click()
                                  document.body.removeChild(a)
                                }}
                                className="text-blue-600 hover:underline text-xs"
                              >
                                {t("storage.fileDownload")}
                              </button>
                              <button
                                onClick={() => deleteFile(f)}
                                className="text-red-600 hover:underline text-xs"
                              >
                                {t("storage.fileDelete")}
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {storedFiles.length > 20 && (
                      <p className="text-xs text-gray-500 text-center py-2">
                        … {storedFiles.length - 20} weitere
                      </p>
                    )}
                  </div>
                )}
              </div>

              {/* Storage-only Save button (separate from company form) */}
              <div className="flex items-center justify-end gap-3 pt-2">
                {storageSavedMsg && (
                  <span className="text-sm text-emerald-700">✓ {storageSavedMsg}</span>
                )}
                {storageError && (
                  <span className="text-sm text-red-700">⚠ {storageError}</span>
                )}
                <Button
                  type="button"
                  variant="outline"
                  disabled={storageSaving}
                  onClick={async () => {
                    const cid = localStorage.getItem("companyId")
                    if (!cid) return
                    setStorageSaving(true)
                    setStorageSavedMsg(null)
                    setStorageError(null)
                    try {
                      await apiPost("/api/v1/storage/config", storageForm)
                      setStorageSavedMsg(t("storage.saveSuccess"))
                      // After saving, the new localPath takes effect
                      // immediately for new uploads but stats/files
                      // are still served from the old path. Refresh
                      // everything so the UI matches reality.
                      await refetchStorage(cid)
                    } catch (err) {
                      const msg = err instanceof ApiError ? err.message : "Speichern fehlgeschlagen"
                      setStorageError(msg)
                    } finally {
                      setStorageSaving(false)
                    }
                  }}
                >
                  {storageSaving ? "…" : t("common.save")}
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Submit */}
          <div className="flex gap-4">
            <Button type="submit" className="flex-1" disabled={saving}>
              {saving
                ? t("common.saving")
                : t("common.save")}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => router.push("/dashboard")}
            >
              {t("common.cancel")}
            </Button>
          </div>
        </form>

        {/* SMTP / Mail Configuration — separate, saved independently of company form */}
        <Card className="mt-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              {t("mail.title")}
              {mailForm.configured ? (
                <span className="text-xs px-2 py-1 rounded bg-green-100 text-green-700 font-normal">
                  {t("mail.configured")}
                </span>
              ) : (
                <span className="text-xs px-2 py-1 rounded bg-orange-100 text-orange-700 font-normal">
                  {t("mail.notConfigured")}
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-gray-600">
              {t("mail.description")}
            </p>

            <div className="grid md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium mb-1">
                  {t("mail.smtpServer")} *
                </label>
                <Input
                  value={mailForm.smtpHost}
                  onChange={(e) => setMailForm({ ...mailForm, smtpHost: e.target.value })}
                  placeholder="smtp.ionos.de"
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-sm font-medium mb-1">
                    {t("mail.port")}
                  </label>
                  <Input
                    type="number"
                    value={mailForm.smtpPort}
                    onChange={(e) => setMailForm({ ...mailForm, smtpPort: Number(e.target.value) })}
                    placeholder="587"
                  />
                </div>
                <div className="flex items-end pb-2">
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={mailForm.smtpSecure}
                      onChange={(e) => setMailForm({ ...mailForm, smtpSecure: e.target.checked })}
                      className="w-4 h-4"
                    />
                    SSL/TLS
                  </label>
                </div>
              </div>
            </div>

            <div className="grid md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium mb-1">
                  {t("mail.username")} *
                </label>
                <Input
                  value={mailForm.smtpUser}
                  onChange={(e) => setMailForm({ ...mailForm, smtpUser: e.target.value })}
                  placeholder="noreply@ihre-firma.de"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">
                  {t("mail.password")}
                  {mailForm.configured && (
                    <span className="text-xs text-gray-500 ml-2">
                      ({t("mail.passwordHint")})
                    </span>
                  )}
                </label>
                <Input
                  type="password"
                  value={mailForm.smtpPassword}
                  onChange={(e) => setMailForm({ ...mailForm, smtpPassword: e.target.value })}
                  placeholder="••••••••"
                />
              </div>
            </div>

            <div className="grid md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium mb-1">
                  {t("mail.fromName")}
                </label>
                <Input
                  value={mailForm.fromName}
                  onChange={(e) => setMailForm({ ...mailForm, fromName: e.target.value })}
                  placeholder="Ihre Firma GmbH"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">
                  {t("mail.fromEmail")}
                </label>
                <Input
                  type="email"
                  value={mailForm.fromEmail}
                  onChange={(e) => setMailForm({ ...mailForm, fromEmail: e.target.value })}
                  placeholder="noreply@ihre-firma.de"
                />
              </div>
            </div>

            {mailMessage && (
              <div
                className={`p-3 rounded text-sm ${mailMessage.ok ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"}`}
              >
                {mailMessage.ok ? "✓ " : "✗ "}
                {mailMessage.text}
              </div>
            )}

            <div className="flex gap-2">
              <Button onClick={saveMailConfig} disabled={mailSaving}>
                {mailSaving
                  ? t("mail.saving")
                  : t("mail.save")}
              </Button>
              <Button
                variant="outline"
                onClick={testMailConnection}
                disabled={mailTesting || !mailForm.smtpHost || !mailForm.smtpUser}
              >
                {mailTesting
                  ? t("mail.testing")
                  : t("mail.test")}
              </Button>
            </div>

            <p className="text-xs text-gray-500">
              {t("mail.source")}:{" "}
              <code className="bg-gray-100 px-1 rounded">{mailForm.source || "env"}</code>
            </p>
          </CardContent>
        </Card>
      </div>
    </main>
  )
}