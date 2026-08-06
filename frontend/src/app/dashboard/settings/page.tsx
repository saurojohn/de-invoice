"use client"

import { useEffect, useState, useRef, useCallback } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import LanguageSwitcher from "@/components/LanguageSwitcher"
import DunningConfigCard from "@/components/DunningConfigCard"
import { useI18n } from "@/components/useI18n"
import { useToast } from "@/components/useToast"
import { apiGet, apiPost, apiPut, apiDelete, apiFetch, ApiError } from "@/lib/api"
// Tier 94: feature flags card (autoBookAfa + anlageV).
import { FeatureFlagsCard } from "./FeatureFlagsCard"

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
  fax: string
  website: string
  registerEntry: string
  managingDirector: string
  otherInfo: string
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
    defaultPrinter: string
  }
  logoPath: string
  invoicePrefix: string
  defaultPaymentDays: number
}

export default function SettingsPage() {
  const router = useRouter()
  const { t, locale, getDateLocale } = useI18n()
  const toast = useToast()
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

  // DATEV-Konten (per-company SKR03 overrides)
  const [datevConfig, setDatevConfig] = useState<Record<string, string>>({})
  const [datevDefaults, setDatevDefaults] = useState<Record<string, string>>({})
  const [datevBeraterNr, setDatevBeraterNr] = useState("")
  const [datevMandantenNr, setDatevMandantenNr] = useState("")
  const [datevSaving, setDatevSaving] = useState(false)
  const [datevSavedMsg, setDatevSavedMsg] = useState<string | null>(null)
  const [datevError, setDatevError] = useState<string | null>(null)
  const [datevLoading, setDatevLoading] = useState(false)
  // Tier 5 additions: opening balances (EB-Werte) and
  // per-year Buchungslauf counter. The openingBalances
  // list is editable inline; laufNr is keyed by year
  // and shown as a small editable table.
  interface OpeningBalance {
    konto: string
    betrag: number
    shVz: 'S' | 'H'
    buchungstext: string
  }
  const [datevOpeningBalances, setDatevOpeningBalances] = useState<OpeningBalance[]>([])
  const [datevLaufNr, setDatevLaufNr] = useState<Record<string, number>>({})
  // Tier 5d-ext: ECB exchange rate snapshot. Loaded
  // from /api/v1/exchange-rates (read-only display)
  // and refreshable via POST /api/v1/exchange-rates/
  // refresh. null = no snapshot yet (the cron
  // hasn't run, the company is fresh, or the
  // manual refresh has never been hit).
  interface RateSnapshot {
    date: string
    fetchedAt: string
    base: string
    rates: Record<string, string>
  }
  const [rateSnapshot, setRateSnapshot] = useState<RateSnapshot | null>(null)
  const [rateSnapshotLoading, setRateSnapshotLoading] = useState(false)
  const [rateSnapshotError, setRateSnapshotError] = useState<string | null>(null)
  const [rateSnapshotRefreshing, setRateSnapshotRefreshing] = useState(false)

  // Tier 5d-ext: load the cached ECB rate snapshot.
  // GET /api/v1/exchange-rates returns null when no
  // snapshot has ever been fetched — the UI shows the
  // "noch keine Kurse geladen" hint in that case.
  const fetchRateSnapshot = useCallback(async (cid: string) => {
    setRateSnapshotLoading(true)
    setRateSnapshotError(null)
    try {
      const data = await apiGet<RateSnapshot | null>(
        `/api/v1/exchange-rates?companyId=${cid}`,
      )
      setRateSnapshot(data)
    } catch (err: any) {
      setRateSnapshotError(err?.message || "Fehler beim Laden")
      setRateSnapshot(null)
    } finally {
      setRateSnapshotLoading(false)
    }
  }, [])

  // Manual refresh: hits POST /api/v1/exchange-rates/
  // refresh which calls the real ECB API. Typical
  // latency 500-1500ms. The button is disabled
  // while the request is in flight to prevent
  // double-clicks piling up concurrent fetches.
  const refreshRateSnapshot = useCallback(async () => {
    if (!companyId) return
    setRateSnapshotRefreshing(true)
    setRateSnapshotError(null)
    try {
      const data = await apiPost<RateSnapshot>(
        '/api/v1/exchange-rates/refresh',
        { companyId },
      )
      setRateSnapshot(data)
    } catch (err: any) {
      setRateSnapshotError(err?.message || "Fehler beim Aktualisieren")
    } finally {
      setRateSnapshotRefreshing(false)
    }
  }, [companyId])

  const [form, setForm] = useState<CompanySettings>({
    name: "",
    legalName: "",
    taxId: "",
    vatId: "",
    email: "",
    phone: "",
    fax: "",
    website: "",
    registerEntry: "",
    managingDirector: "",
    otherInfo: "",
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
      defaultPrinter: "",
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
              fax: data.fax || "",
              website: data.website || "",
              registerEntry: data.registerEntry || "",
              managingDirector: data.managingDirector || "",
              otherInfo: data.otherInfo || "",
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
                defaultPrinter: settings.defaultPrinter || "",
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

    // Fetch DATEV account config (per-company SKR03 overrides)
    setDatevLoading(true)
    apiGet<any>(`/api/v1/companies/${storedCompanyId}/datev-config`)
      .then((cfg) => {
        if (cfg) {
          setDatevDefaults(cfg.defaults || {})
          setDatevConfig(cfg.overrides || {})
          setDatevBeraterNr(cfg.overrides?.beraterNr || "")
          setDatevMandantenNr(cfg.overrides?.mandantenNr || "")
          // Tier 5: opening balances + Buchungslauf counter.
          // The backend returns them with the GET response.
          setDatevOpeningBalances(Array.isArray(cfg.openingBalances) ? cfg.openingBalances : [])
          setDatevLaufNr(cfg.laufNr && typeof cfg.laufNr === 'object' ? cfg.laufNr : {})
        }
      })
      .catch(() => {})
      .finally(() => setDatevLoading(false))
    // Tier 5d-ext: load the cached ECB rate snapshot
    // for this company. Fire-and-forget — its own
    // loader manages loading/error state.
    fetchRateSnapshot(storedCompanyId)
  }, [router, fetchRateSnapshot])

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

  // Save the per-company DATEV account map. Anything the
  // user has blanked out is dropped from the override so
  // the SKR03 default takes over again on the next export.
  async function saveDatevConfig() {
    if (!companyId) return
    setDatevSaving(true)
    setDatevSavedMsg(null)
    setDatevError(null)
    try {
      // Build a clean accounts object: only include keys
      // where the user typed something. The backend
      // sanitizer will further validate (3-5 digit numeric
      // only), so empty strings or garbage here just get
      // dropped — that's intentional.
      const accounts: Record<string, string> = {}
      for (const k of Object.keys(datevDefaults)) {
        const v = (datevConfig[k] || "").trim()
        if (v) accounts[k] = v
      }
      await apiPut(`/api/v1/companies/${companyId}/datev-config`, {
        accounts,
        beraterNr: datevBeraterNr.trim(),
        mandantenNr: datevMandantenNr.trim(),
        // Tier 5: opening balances + laufNr round-trip.
        // The backend sanitises each entry; partial rows
        // (e.g. an empty konto) are dropped silently.
        openingBalances: datevOpeningBalances,
        laufNr: datevLaufNr,
      })
      setDatevSavedMsg(t("settings.datevSaved"))
      const fresh = await apiGet<any>(`/api/v1/companies/${companyId}/datev-config`)
      if (fresh) {
        setDatevDefaults(fresh.defaults || {})
        setDatevConfig(fresh.overrides || {})
        setDatevBeraterNr(fresh.overrides?.beraterNr || "")
        setDatevMandantenNr(fresh.overrides?.mandantenNr || "")
        setDatevOpeningBalances(Array.isArray(fresh.openingBalances) ? fresh.openingBalances : [])
        setDatevLaufNr(fresh.laufNr && typeof fresh.laufNr === 'object' ? fresh.laufNr : {})
      }
    } catch (err) {
      setDatevError(err instanceof ApiError ? err.message : t("settings.datevSaveError"))
    } finally {
      setDatevSaving(false)
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
          fax: fresh.fax ?? "",
          website: fresh.website ?? "",
          registerEntry: fresh.registerEntry ?? "",
          managingDirector: fresh.managingDirector ?? "",
          otherInfo: fresh.otherInfo ?? "",
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
            defaultPrinter: settings.defaultPrinter ?? "",
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
      const msg = t("settings.invalidFileType")
      toast.error(msg)
      return
    }

    // Validate file size (max 2MB)
    if (file.size > 2 * 1024 * 1024) {
      const msg = t("settings.fileTooLarge")
      toast.error(msg)
      return
    }

    // Validate image dimensions. A logo of 4000x4000 pixels
    // is technically valid but bloats the rendered PDF
    // (PDFKit downscales, but the embedded base64 image
    // is large). We soft-warn above 1500px on the long
    // edge — the user gets a toast but the upload still
    // proceeds. A real product would resize server-side;
    // we leave that as a follow-up.
    const dimensions = await readImageDimensions(file).catch(() => null)
    if (dimensions) {
      const longEdge = Math.max(dimensions.width, dimensions.height)
      if (longEdge > 1500) {
        toast.warn(
          t("settings.logoLargeWarning", {
            w: String(dimensions.width),
            h: String(dimensions.height),
          }) ||
            `Logo ist ${dimensions.width}×${dimensions.height} px. Empfohlen: ≤ 1500 px.`,
        )
      }
    }

    setUploadProgress(true)

    try {
      const formData = new FormData()
      formData.append("file", file)
      formData.append("companyId", companyId)

      // Use apiFetch so the x-user-id / x-company-id auth headers
      // are injected automatically. The old raw fetch() call
      // dropped them, AND the upload endpoint had no @Auth()
      // guard — so the request "succeeded" but bypassed
      // authentication entirely (anyone could overwrite any
      // company's logo). Adding @Auth() to the backend endpoint
      // and using apiFetch here closes both holes.
      //
      // apiFetch detects FormData and skips the default
      // Content-Type so the browser can set the multipart
      // boundary itself.
      const res = await apiFetch("/api/v1/companies/upload-logo", {
        method: "POST",
        body: formData,
      })
      const data = await res.json()

      if (res.ok) {
        // Cache-bust the preview URL so the browser doesn't
        // serve the previous logo from its HTTP cache after
        // a re-upload of a new file with the same name.
        // (Backend now uses a unique filename per upload,
        // but cache-bust here is defence in depth.)
        setCurrentLogo(`/images/${data.filename}?t=${Date.now()}`)
        setForm({ ...form, logoPath: data.filename })
        toast.success(t("settings.logoUploaded"))
      } else {
        const msg = data?.message || t("settings.uploadError")
        toast.error(msg)
      }
    } catch (error) {
      const msg = error instanceof ApiError ? error.message : t("settings.uploadError")
      toast.error(msg)
    } finally {
      setUploadProgress(false)
      // Reset the input so the same file can be re-selected
      // (browsers fire onchange only on change, not when
      // the same file is picked twice in a row).
      if (fileInputRef.current) fileInputRef.current.value = ""
    }
  }

  const removeLogo = async () => {
    if (!companyId) return
    // Confirm before destroying the user's logo. The old
    // code just cleared local state and let the user
    // think it was deleted, but the file stayed on disk
    // and would reappear on the next GET.
    if (!confirm(t("settings.removeLogoConfirm") || "Logo wirklich entfernen?")) {
      return
    }
    setUploadProgress(true)
    try {
      await apiPost("/api/v1/companies/remove-logo", {})
      setCurrentLogo(null)
      setForm({ ...form, logoPath: "" })
      toast.success(t("settings.logoRemoved") || "Logo entfernt")
    } catch (error) {
      const msg =
        error instanceof ApiError
          ? error.message
          : t("settings.uploadError") || "Fehler beim Entfernen"
      toast.error(msg)
    } finally {
      setUploadProgress(false)
    }
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
      <main className="min-h-screen bg-gray-50 dark:bg-gray-900 flex items-center justify-center">
        <div className="text-gray-500 dark:text-gray-400">{t("common.loading")}</div>
      </main>
    )
  }

  return (
    <main className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <header className="bg-white dark:bg-gray-800 border-b shadow-sm">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <h1 className="text-2xl font-bold text-blue-600 dark:text-blue-400">{t("nav.settings")}</h1>
          <div className="flex gap-2 items-center">
            <button
              onClick={() => router.push("/dashboard/settings/users")}
              className="px-3 py-1 text-sm border border-blue-600 text-blue-700 dark:text-blue-300 rounded hover:bg-blue-50 font-medium"
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
                <div className="w-40 h-40 border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-lg flex items-center justify-center bg-gray-50 dark:bg-gray-900 overflow-hidden">
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
                      className="ml-2 text-red-600 dark:text-red-400"
                    >
                      {t("settings.removeLogo")}
                    </Button>
                  )}
                  <p className="text-xs text-gray-500 dark:text-gray-400">
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

              {/* Extended contact info — fax + website.
                  Both shown in the PDF letterhead contact line. */}
              <div className="grid md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-1">
                    {t("settings.fax")}
                  </label>
                  <Input
                    type="tel"
                    value={form.fax}
                    onChange={(e) => setForm({ ...form, fax: e.target.value })}
                    placeholder="+49 6181 12345-99"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">
                    {t("settings.website")}
                  </label>
                  <Input
                    type="url"
                    value={form.website}
                    onChange={(e) => setForm({ ...form, website: e.target.value })}
                    placeholder="www.shleder.de"
                  />
                </div>
              </div>

              {/* Legal info (Rechtliches / Impressum) — required by
                  §5 TMG for B2B invoices in Germany. Handelsregister
                  entry + managing director are the two pieces most
                  often requested on German invoices. */}
              <div className="grid md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-1">
                    {t("settings.registerEntry")}
                  </label>
                  <Input
                    value={form.registerEntry}
                    onChange={(e) => setForm({ ...form, registerEntry: e.target.value })}
                    placeholder="HRB 12345 Amtsgericht Offenbach am Main"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">
                    {t("settings.managingDirector")}
                  </label>
                  <Input
                    value={form.managingDirector}
                    onChange={(e) => setForm({ ...form, managingDirector: e.target.value })}
                    placeholder="Max Mustermann"
                  />
                </div>
              </div>

              {/* Misc. Impressum info that doesn't have a dedicated
                  field: WEEE/LUCID, Kleinunternehmer §19 UStG
                  disclaimer, Verpackungsregister, chamber memberships.
                  Multi-line free-text; rendered verbatim in the PDF
                  right footer. */}
              <div>
                <label className="block text-sm font-medium mb-1">
                  {t("settings.otherInfo")}
                </label>
                <textarea
                  className="w-full min-h-[80px] border rounded-md px-3 py-2 text-sm"
                  value={form.otherInfo}
                  onChange={(e) => setForm({ ...form, otherInfo: e.target.value })}
                  placeholder={t("settings.otherInfoPlaceholder")}
                  rows={3}
                />
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                  {t("settings.otherInfoHelp")}
                </p>
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

          {/* Tier 123: Dunning Config Card.
              The 3 Mahnung levels (Zahlungserinnerung,
              1. Mahnung, 2. Mahnung) have configurable
              Werktage thresholds + late fees. Without
              this UI, the operator had to edit the
              backend's auto-reminder.scheduler.ts and
              redeploy. */}
          <DunningConfigCard />

          {/* Tier 156: Bemerkungsvorlagen — per-company
              snippets the operator can drop into the
              invoice notes field. Same page, separate
              card so the dunning-related "fees +
              Werktage" stays self-contained. */}
          <Card>
            <CardHeader>
              <CardTitle>
                {t("noteTemplates.cardTitle") || "Bemerkungsvorlagen"}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-gray-600 dark:text-gray-400 mb-3">
                {t("noteTemplates.cardSubtitle") ||
                  "Gespeicherte Textbausteine, die auf der Rechnungs-Erstellung mit einem Klick in das Bemerkungs-Feld eingefügt werden."}
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => router.push("/dashboard/settings/note-templates")}
                data-testid="settings-note-templates-link"
              >
                {t("noteTemplates.openEditor") || "Vorlagen bearbeiten"} →
              </Button>
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

              {/* Default printer — free-text. The browser JS
                  sandbox can't actually pre-select a printer in
                  the OS print dialog (window.print() ignores any
                  printer argument), so this value is informational
                  only: the settings page shows it back, the PDF
                  download toast mentions it, and the user can
                  copy-paste it from the system print dialog. The
                  point is to make the preference visible and
                  reproducible across sessions — not to force the
                  OS. */}
              <div>
                <label className="block text-sm font-medium mb-1">
                  {t("settings.defaultPrinter")}
                </label>
                <Input
                  value={form.settings.defaultPrinter}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      settings: { ...form.settings, defaultPrinter: e.target.value },
                    })
                  }
                  placeholder={t("settings.defaultPrinterPlaceholder")}
                />
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                  {t("settings.defaultPrinterHelp")}
                </p>
              </div>
            </CardContent>
          </Card>

          {/* DATEV-Konten (per-company SKR03 overrides) */}
          <Card>
            <CardHeader>
              <CardTitle>{t("settings.datevTitle")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-gray-600 dark:text-gray-300">{t("settings.datevSubtitle")}</p>
              <p className="text-xs text-gray-500 dark:text-gray-400">{t("settings.datevDefaultsHint")}</p>

              {datevSavedMsg && (
                <div className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded p-2">
                  {datevSavedMsg}
                </div>
              )}
              {datevError && (
                <div className="text-sm text-red-700 dark:text-red-300 bg-red-50 border border-red-200 rounded p-2">
                  {datevError}
                </div>
              )}

              {datevLoading ? (
                <div className="text-sm text-gray-500 dark:text-gray-400">{t("common.loading")}</div>
              ) : (
                <>
                  <div className="grid md:grid-cols-2 gap-3">
                    {Object.keys(datevDefaults).map((k) => (
                      <div key={k}>
                        <label className="block text-xs text-gray-600 dark:text-gray-300 mb-1">
                          {t(`settings.datevAccount_${k}`) || k}
                        </label>
                        <Input
                          value={datevConfig[k] || ""}
                          onChange={(e) => setDatevConfig({ ...datevConfig, [k]: e.target.value })}
                          placeholder={datevDefaults[k] || ""}
                          maxLength={5}
                          className="font-mono"
                        />
                        <div className="text-xs text-gray-400 mt-0.5">
                          Standard: {datevDefaults[k]}
                        </div>
                      </div>
                    ))}
                  </div>

                  <div className="grid md:grid-cols-2 gap-3 pt-3 border-t">
                    <div>
                      <label className="block text-xs text-gray-600 dark:text-gray-300 mb-1">
                        {t("settings.datevBeraterNr")}
                      </label>
                      <Input
                        value={datevBeraterNr}
                        onChange={(e) => setDatevBeraterNr(e.target.value)}
                        placeholder="12345"
                        maxLength={5}
                        className="font-mono"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-600 dark:text-gray-300 mb-1">
                        {t("settings.datevMandantenNr")}
                      </label>
                      <Input
                        value={datevMandantenNr}
                        onChange={(e) => setDatevMandantenNr(e.target.value)}
                        placeholder="67890"
                        maxLength={5}
                        className="font-mono"
                      />
                    </div>
                  </div>

                  <div className="flex gap-2 pt-2">
                    <Button onClick={saveDatevConfig} disabled={datevSaving}>
                      {datevSaving ? "..." : t("common.save")}
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => {
                        setDatevConfig({})
                        setDatevBeraterNr("")
                        setDatevMandantenNr("")
                        // Tier 5: clear EB-Werte + Buchungslauf
                        // counter too, otherwise a partial
                        // reset leaves the new state in an
                        // inconsistent place.
                        setDatevOpeningBalances([])
                        setDatevLaufNr({})
                      }}
                    >
                      {t("settings.datevReset")}
                    </Button>
                  </div>

                  {/* Tier 5: Opening balances (EB-Werte) */}
                  <div className="pt-4 border-t border-gray-200 dark:border-gray-700 space-y-3">
                    <div>
                      <h3 className="text-sm font-semibold">{t("settings.datevOpeningBalancesTitle")}</h3>
                      <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                        {t("settings.datevOpeningBalancesSubtitle")}
                      </p>
                    </div>
                    {datevOpeningBalances.length === 0 ? (
                      <div className="text-xs italic text-gray-500 dark:text-gray-400">
                        {t("settings.datevOpeningBalancesEmpty")}
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {datevOpeningBalances.map((eb, idx) => (
                          <div
                            key={idx}
                            className="grid grid-cols-12 gap-2 items-end p-2 rounded border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/40"
                          >
                            <div className="col-span-3">
                              <label className="block text-[10px] text-gray-500 dark:text-gray-400 mb-0.5">
                                {t("settings.datevOpeningBalancesKonto")}
                              </label>
                              <Input
                                value={eb.konto}
                                onChange={(e) => {
                                  const v = e.target.value.replace(/\D/g, "").substring(0, 5)
                                  const next = [...datevOpeningBalances]
                                  next[idx] = { ...eb, konto: v }
                                  setDatevOpeningBalances(next)
                                }}
                                maxLength={5}
                                className="font-mono h-8"
                              />
                            </div>
                            <div className="col-span-3">
                              <label className="block text-[10px] text-gray-500 dark:text-gray-400 mb-0.5">
                                {t("settings.datevOpeningBalancesBetrag")}
                              </label>
                              <Input
                                type="number"
                                step="0.01"
                                min="0"
                                value={eb.betrag}
                                onChange={(e) => {
                                  const v = Number(e.target.value)
                                  const next = [...datevOpeningBalances]
                                  next[idx] = { ...eb, betrag: isNaN(v) ? 0 : v }
                                  setDatevOpeningBalances(next)
                                }}
                                className="font-mono h-8"
                              />
                            </div>
                            <div className="col-span-2">
                              <label className="block text-[10px] text-gray-500 dark:text-gray-400 mb-0.5">
                                {t("settings.datevOpeningBalancesShVz")}
                              </label>
                              <select
                                value={eb.shVz}
                                onChange={(e) => {
                                  const v = e.target.value as 'S' | 'H'
                                  const next = [...datevOpeningBalances]
                                  next[idx] = { ...eb, shVz: v }
                                  setDatevOpeningBalances(next)
                                }}
                                className="w-full h-8 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm font-mono"
                              >
                                <option value="S">{t("settings.datevOpeningBalancesShVzS")}</option>
                                <option value="H">{t("settings.datevOpeningBalancesShVzH")}</option>
                              </select>
                            </div>
                            <div className="col-span-3">
                              <label className="block text-[10px] text-gray-500 dark:text-gray-400 mb-0.5">
                                {t("settings.datevOpeningBalancesText")}
                              </label>
                              <Input
                                value={eb.buchungstext}
                                onChange={(e) => {
                                  const v = e.target.value.substring(0, 60)
                                  const next = [...datevOpeningBalances]
                                  next[idx] = { ...eb, buchungstext: v }
                                  setDatevOpeningBalances(next)
                                }}
                                maxLength={60}
                                className="h-8"
                              />
                            </div>
                            <div className="col-span-1">
                              <button
                                type="button"
                                onClick={() => {
                                  setDatevOpeningBalances(datevOpeningBalances.filter((_, i) => i !== idx))
                                }}
                                className="text-red-600 dark:text-red-400 text-xs hover:underline"
                              >
                                {t("settings.datevOpeningBalancesRemove")}
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setDatevOpeningBalances([
                          ...datevOpeningBalances,
                          { konto: "", betrag: 0, shVz: 'S', buchungstext: "" },
                        ])
                      }}
                    >
                      + {t("settings.datevOpeningBalancesAdd")}
                    </Button>
                  </div>

                  {/* Tier 5: Buchungslauf-Nr per fiscal year.
                      Read-only display — the counter is
                      advanced by the export endpoint, not
                      the user. Empty map = the export
                      falls back to "Lauf 001". */}
                  <div className="pt-4 border-t border-gray-200 dark:border-gray-700 space-y-2">
                    <div>
                      <h3 className="text-sm font-semibold">{t("settings.datevBuchungsLaufTitle")}</h3>
                      <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                        {t("settings.datevBuchungsLaufSubtitle")}
                      </p>
                    </div>
                    {Object.keys(datevLaufNr).length === 0 ? (
                      <div className="text-xs italic text-gray-500 dark:text-gray-400">
                        {t("settings.datevOpeningBalancesEmpty")}
                      </div>
                    ) : (
                      <table className="text-xs font-mono">
                        <thead>
                          <tr className="text-gray-500 dark:text-gray-400">
                            <th className="text-left pr-4">{t("settings.datevBuchungsLaufYear")}</th>
                            <th className="text-left pr-4">{t("settings.datevBuchungsLaufNext")}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {Object.entries(datevLaufNr)
                            .sort(([a], [b]) => Number(b) - Number(a))
                            .map(([year, n]) => (
                              <tr key={year}>
                                <td className="pr-4">{year}</td>
                                <td className="pr-4">
                                  L{String(n).padStart(3, '0')}
                                </td>
                              </tr>
                            ))}
                        </tbody>
                      </table>
                    )}
                  </div>

                  {/* Tier 5d-ext: ECB exchange rate snapshot.
                      Read-only display of the rates the
                      daily cron @ 02:00 Berlin has fetched.
                      The "Jetzt aktualisieren" button is
                      the manual override — useful right
                      after a company is created, or when
                      the cron failed. The displayed rates
                      are what buildBuchungenFromDb writes
                      to DATEV column 17 (Kurs) for every
                      non-EUR invoice / expense row. */}
                  <div className="pt-4 border-t border-gray-200 dark:border-gray-700 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <h3 className="text-sm font-semibold">
                          {t("settings.datevExchangeRatesTitle")}
                        </h3>
                        <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                          {t("settings.datevExchangeRatesSubtitle")}
                        </p>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={rateSnapshotRefreshing || !companyId}
                        onClick={refreshRateSnapshot}
                      >
                        {rateSnapshotRefreshing
                          ? t("settings.datevExchangeRatesRefreshing")
                          : t("settings.datevExchangeRatesRefresh")}
                      </Button>
                    </div>
                    {rateSnapshotError && (
                      <div className="text-xs text-red-600 dark:text-red-400">
                        {rateSnapshotError}
                      </div>
                    )}
                    {rateSnapshotLoading ? (
                      <div className="text-xs italic text-gray-500 dark:text-gray-400">
                        {t("settings.datevExchangeRatesLoading")}
                      </div>
                    ) : !rateSnapshot ? (
                      <div className="text-xs italic text-gray-500 dark:text-gray-400">
                        {t("settings.datevExchangeRatesEmpty")}
                      </div>
                    ) : (
                      <>
                        <div className="text-xs text-gray-500 dark:text-gray-400">
                          {t("settings.datevExchangeRatesLastSync", {
                            date: rateSnapshot.date,
                          })}
                        </div>
                        <table className="text-xs font-mono">
                          <thead>
                            <tr className="text-gray-500 dark:text-gray-400">
                              <th className="text-left pr-4">
                                {t("settings.datevExchangeRatesCurrency")}
                              </th>
                              <th className="text-left pr-4">
                                {t("settings.datevExchangeRatesRate")}
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {Object.entries(rateSnapshot.rates)
                              .sort(([a], [b]) => a.localeCompare(b))
                              .map(([code, rate]) => (
                                <tr key={code}>
                                  <td className="pr-4">{code}</td>
                                  <td className="pr-4">
                                    {rate} {rateSnapshot.base}
                                  </td>
                                </tr>
                              ))}
                          </tbody>
                        </table>
                      </>
                    )}
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          {/* Tier 94: Feature Flags (Auto-AfA + Anlage V) */}
          <FeatureFlagsCard />

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
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
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
                <div className="mt-2 p-4 bg-gray-50 dark:bg-gray-900 rounded-lg">
                  <h4 className="text-sm font-medium mb-3">{t("storage.usage")}</h4>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    <div>
                      <p className="text-xs text-gray-500 dark:text-gray-400">{t("storage.filesCount")}</p>
                      <p className="text-lg font-semibold">{storageStats.totalFiles}</p>
                    </div>
                    <div>
                      <p className="text-xs text-gray-500 dark:text-gray-400">{t("storage.totalSize")}</p>
                      <p className="text-lg font-semibold">{storageStats.totalSizeFormatted}</p>
                    </div>
                    {/* Safe access: usageByType might not have every key */}
                    {Object.entries(storageStats.usageByType || {}).map(([type, info]) => (
                      <div key={type}>
                        <p className="text-xs text-gray-500 dark:text-gray-400 uppercase">{type}</p>
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
                  <p className="text-sm text-gray-500 dark:text-gray-400 text-center py-4">
                    {t("storage.filesEmpty")}
                  </p>
                ) : (
                  <div className="overflow-x-auto border rounded-lg">
                    <table className="w-full text-sm">
                      <thead className="bg-gray-50 dark:bg-gray-900 border-b">
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
                          <tr key={f.path} className="border-b hover:bg-gray-50 dark:bg-gray-900">
                            <td className="px-3 py-2 truncate max-w-xs" title={f.originalName}>
                              {f.originalName}
                            </td>
                            <td className="px-3 py-2 text-xs uppercase text-gray-500 dark:text-gray-400">{f.type}</td>
                            <td className="px-3 py-2 text-right">{formatBytes(f.size)}</td>
                            <td className="px-3 py-2 text-gray-500 dark:text-gray-400">
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
                                className="text-blue-600 dark:text-blue-400 hover:underline text-xs"
                              >
                                {t("storage.fileDownload")}
                              </button>
                              <button
                                onClick={() => deleteFile(f)}
                                className="text-red-600 dark:text-red-400 hover:underline text-xs"
                              >
                                {t("storage.fileDelete")}
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {storedFiles.length > 20 && (
                      <p className="text-xs text-gray-500 dark:text-gray-400 text-center py-2">
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
                  <span className="text-sm text-red-700 dark:text-red-300">⚠ {storageError}</span>
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

          {/* Webhooks — outbound HTTP callbacks for
              business events. Tier 14.4. The actual
              page lives at /dashboard/settings/webhooks
              (separate page, not a modal — the list can
              get long, and the create form has ~12 event
              checkboxes). */}
          <Card>
            <CardHeader>
              <CardTitle>{t("webhooks.title")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm text-gray-700 dark:text-gray-300">
                {t("webhooks.subtitle")}
              </p>
              <Button
                onClick={() => router.push("/dashboard/settings/webhooks")}
                data-testid="webhooks-settings-link"
              >
                → {t("webhooks.title")}
              </Button>
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
                <span className="text-xs px-2 py-1 rounded bg-green-100 text-green-700 dark:text-green-300 font-normal">
                  {t("mail.configured")}
                </span>
              ) : (
                <span className="text-xs px-2 py-1 rounded bg-orange-100 text-orange-700 dark:text-orange-300 font-normal">
                  {t("mail.notConfigured")}
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-gray-600 dark:text-gray-300">
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
                    <span className="text-xs text-gray-500 dark:text-gray-400 ml-2">
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
                className={`p-3 rounded text-sm ${mailMessage.ok ? "bg-green-50 text-green-700 dark:text-green-300" : "bg-red-50 text-red-700 dark:text-red-300"}`}
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

            <p className="text-xs text-gray-500 dark:text-gray-400">
              {t("mail.source")}:{" "}
              <code className="bg-gray-100 dark:bg-gray-800 px-1 rounded">{mailForm.source || "env"}</code>
            </p>
          </CardContent>
        </Card>
      </div>
    </main>
  )
}

/**
 * Read image dimensions from a File by loading it into a
 * hidden <img>. Returns { width, height } in pixels or
 * null on failure. We don't actually USE the dimensions
 * to enforce a hard limit yet (logos bigger than 1500 px
 * just get a soft warn) — but having the helper means a
 * future server-side resize can reuse it via the same
 * canvas trick.
 */
function readImageDimensions(
  file: File,
): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    if (typeof window === "undefined") return resolve(null)
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      const out = { width: img.naturalWidth, height: img.naturalHeight }
      URL.revokeObjectURL(url)
      resolve(out)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      resolve(null)
    }
    img.src = url
  })
}