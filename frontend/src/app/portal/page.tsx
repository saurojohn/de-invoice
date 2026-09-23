"use client"

/**
 * Tier 131: customer portal main page.
 *
 * Public — no admin auth. Reads `?token=…` from the
 * URL and calls GET /customer-portal/invoices. Shows:
 *   - Customer name + customer number + address
 *   - Summary tiles (open / overdue / paid totals)
 *   - Invoice list table (number, date, due, total, status)
 *   - "Download PDF" button per row
 *   - "Mark as paid" button for non-paid rows
 *
 * Token comes from the URL (not localStorage) so the
 * customer can bookmark the page and come back later
 * (until the 30-day session expires).
 */
import { Suspense, useEffect, useRef, useState } from "react"

import { useRouter, useSearchParams } from "next/navigation"
import { apiGet, apiPost, apiPatch, ApiError } from "@/lib/api"
import { useI18n } from "@/components/useI18n"
import { useToast } from "@/components/useToast"

interface PortalCustomer {
  id: string
  name: string
  customerNumber: string | null
  type: string
  // Tier 155: profile edit. The Customer
  // model already has these — the portal
  // summary endpoint just didn't surface
  // them. The new GET /profile endpoint does.
  // We keep the fields optional so older
  // backends that don't include them still
  // type-check.
  vatId?: string | null
  contact?: any
  address: any
}

interface PortalInvoice {
  id: string
  invoiceNumber: string
  issueDate: string
  dueDate: string
  total: string
  currency: string
  status: string
  type: string
  daysOverdue: number
  // Tier 430: reported by the customer, not yet booked by the company.
  paymentReported?: { amount: string; reportedAt: string } | null
}

interface PortalSummary {
  totalOpen: number
  totalOverdue: number
  totalPaid: number
  currency: string
  invoiceCount: number
}

interface PortalData {
  customer: PortalCustomer
  invoices: PortalInvoice[]
  summary: PortalSummary
  session: { expiresAt: string; lastUsedAt: string | null }
}

function fmtEur(n: number, currency: string = "EUR"): string {
  try {
    return new Intl.NumberFormat("de-DE", {
      style: "currency",
      currency,
    }).format(n)
  } catch {
    return `${n.toFixed(2)} ${currency}`
  }
}

function fmtDate(iso: string): string {
  if (!iso) return "—"
  try {
    return new Intl.DateTimeFormat("de-DE", {
      day: "2-digit", month: "2-digit", year: "numeric",
    }).format(new Date(iso))
  } catch {
    return iso.slice(0, 10)
  }
}

function statusBadge(status: string, daysOverdue: number, t: any) {
  if (status === "paid") {
    return <span className="px-2 py-0.5 rounded text-xs bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300">{t("portal.statusPaid") || "Bezahlt"}</span>
  }
  if (status === "cancelled") {
    return <span className="px-2 py-0.5 rounded text-xs bg-gray-200 text-gray-700 dark:bg-gray-700 dark:text-gray-300">{t("portal.statusCancelled") || "Storniert"}</span>
  }
  if (daysOverdue > 0) {
    return <span className="px-2 py-0.5 rounded text-xs bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300">{t("portal.statusOverdue") || "Überfällig"} ({daysOverdue} {t("portal.days") || "Tage"})</span>
  }
  if (status === "draft") {
    return <span className="px-2 py-0.5 rounded text-xs bg-gray-200 text-gray-700 dark:bg-gray-700 dark:text-gray-300">{t("portal.statusDraft") || "Entwurf"}</span>
  }
  return <span className="px-2 py-0.5 rounded text-xs bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300">{t("portal.statusOpen") || "Offen"}</span>
}

function PortalPageInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { t, locale } = useI18n()
  const toast = useToast()
  const token = searchParams.get("token") || ""

  // Tier 155 fix: the `t` function from useI18n is a
  // NEW reference on every render (it's an inline
  // closure over `messages[locale]`). If we put `t`
  // in a useEffect deps array, the effect re-runs on
  // every render → infinite API call loop → the
  // throttler trips and the page goes blank. Stash
  // `t` in a ref keyed by `locale` so the effect only
  // re-runs when the locale actually changes, not
  // when the parent re-renders for any other reason.
  const tRef = useRef(t)
  tRef.current = t
  const [data, setData] = useState<PortalData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyInvoiceId, setBusyInvoiceId] = useState<string | null>(null)
  // Tier 155: profile edit state. The form is
  // local (not in `data`) so the user can
  // type freely without us re-rendering the
  // whole page. We seed it once from
  // `data.customer` (in a separate effect) so
  // the inputs start pre-populated.
  const [profileEdit, setProfileEdit] = useState(false)
  const [profileForm, setProfileForm] = useState<{
    name: string
    vatId: string
    contactEmail: string
    contactPhone: string
    addressStreet: string
    addressPostalCode: string
    addressCity: string
    addressCountry: string
  }>({
    name: "", vatId: "", contactEmail: "", contactPhone: "",
    addressStreet: "", addressPostalCode: "", addressCity: "", addressCountry: "",
  })
  const [profileSaving, setProfileSaving] = useState(false)
  const [profileResult, setProfileResult] = useState<{
    kind: "ok" | "err"
    msg: string
  } | null>(null)
  // Seed the form from the loaded customer.
  // We re-seed whenever `data.customer` changes
  // (e.g. after a save) but NOT while the user
  // is actively editing — that would clobber
  // their in-progress input.
  useEffect(() => {
    if (!data?.customer || profileEdit) return
    const c = data.customer
    setProfileForm({
      name: c.name || "",
      vatId: c.vatId || "",
      contactEmail: (c.contact as any)?.email || "",
      contactPhone: (c.contact as any)?.phone || "",
      addressStreet: (c.address as any)?.street || "",
      addressPostalCode: (c.address as any)?.postalCode || "",
      addressCity: (c.address as any)?.city || "",
      addressCountry: (c.address as any)?.country || "",
    })
  }, [data?.customer, profileEdit])

  useEffect(() => {
    if (!token) {
      setError(tRef.current("portal.missingToken") || "Kein Token in der URL. Bitte fordern Sie einen neuen Login-Link an.")
      setLoading(false)
      return
    }
    let cancelled = false
    apiGet<PortalData>(`/api/v1/customer-portal/invoices?token=${encodeURIComponent(token)}`)
      .then((d) => { if (!cancelled) { setData(d); setLoading(false) } })
      .catch((err) => {
        if (cancelled) return
        if (err instanceof ApiError && err.status === 401) {
          setError(tRef.current("portal.expiredLink") || "Ihr Login-Link ist abgelaufen oder ungültig. Bitte fordern Sie einen neuen an.")
        } else {
          setError(err instanceof ApiError ? err.message : String(err))
        }
        setLoading(false)
      })
    return () => { cancelled = true }
    // Depend on `locale` (not `t`) — `t` is a new
    // reference every render, see the comment at tRef.
  }, [token, locale])

  const downloadPdf = (invoiceId: string) => {
    if (!token) return
    // The PDF endpoint sets Content-Disposition: inline.
    // We want an actual download — open in a new tab
    // and let the browser handle the save dialog (most
    // browsers will respect the inline disposition +
    // filename parameter for a download).
    window.open(
      `/api/v1/customer-portal/invoice/${invoiceId}/pdf?token=${encodeURIComponent(token)}`,
      "_blank",
    )
  }

  const markPaid = async (invoiceId: string) => {
    if (!token || busyInvoiceId) return
    if (!confirm(t("portal.markPaidConfirm") || "Zahlung für diese Rechnung melden?")) return
    setBusyInvoiceId(invoiceId)
    try {
      await apiPost(
        `/api/v1/customer-portal/invoice/${invoiceId}/mark-paid?token=${encodeURIComponent(token)}`,
      )
      // Re-fetch to update the list
      const d = await apiGet<PortalData>(`/api/v1/customer-portal/invoices?token=${encodeURIComponent(token)}`)
      setData(d)
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : String(err))
    } finally {
      setBusyInvoiceId(null)
    }
  }

  // Tier 155: PATCH /customer-portal/profile
  // with the current form. We send the full
  // shape (not partial) so the backend's
  // "merge" is a no-op for the unchanged
  // keys. The backend validates the email
  // format and the name is non-empty; we
  // surface the error inline.
  const saveProfile = async () => {
    if (!token) return
    setProfileSaving(true)
    setProfileResult(null)
    try {
      const updated = await apiPatch<{
        id: string
        name: string
        vatId: string | null
        contact: any
        address: any
      }>(
        `/api/v1/customer-portal/profile?token=${encodeURIComponent(token)}`,
        {
          name: profileForm.name,
          vatId: profileForm.vatId || null,
          contact: {
            email: profileForm.contactEmail,
            phone: profileForm.contactPhone,
          },
          address: {
            street: profileForm.addressStreet,
            postalCode: profileForm.addressPostalCode,
            city: profileForm.addressCity,
            country: profileForm.addressCountry,
          },
        },
      )
      // Update the displayed customer in the
      // header. We construct a new PortalData
      // so React picks up the change.
      if (data) {
        setData({
          ...data,
          customer: {
            ...data.customer,
            name: updated.name,
            vatId: updated.vatId,
            contact: updated.contact,
            address: updated.address,
          },
        })
      }
      setProfileEdit(false)
      setProfileResult({ kind: "ok", msg: t("portal.profileSaved") || "Profile saved" })
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? err.message
          : String((err as any)?.message || err)
      setProfileResult({
        kind: "err",
        msg: (t("portal.profileSaveError") || "Profile could not be saved: {error}").replace(
          "{error}",
          msg,
        ),
      })
    } finally {
      setProfileSaving(false)
    }
  }

  if (loading) {
    return (
      <main className="min-h-screen bg-gray-50 dark:bg-gray-900 flex items-center justify-center">
        <p className="text-gray-500 dark:text-gray-400" data-testid="portal-loading">⏳</p>
      </main>
    )
  }

  if (error || !data) {
    return (
      <main className="min-h-screen bg-gradient-to-b from-gray-50 to-gray-100 dark:from-gray-900 dark:to-gray-800 flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-white dark:bg-gray-800 shadow-lg rounded-lg p-8 text-center">
          <div className="text-4xl mb-3">🔗</div>
          <h1 className="text-xl font-bold mb-3 text-gray-900 dark:text-gray-100">
            {t("portal.linkInvalid") || "Link ungültig"}
          </h1>
          <p className="text-sm text-gray-600 dark:text-gray-400 mb-6" data-testid="portal-error">
            {error}
          </p>
          <button
            onClick={() => router.push("/portal/login")}
            className="bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-md px-4 py-2 text-sm"
            data-testid="portal-back-to-login"
          >
            {t("portal.requestNew") || "Neuen Login-Link anfordern"}
          </button>
        </div>
      </main>
    )
  }

  const { customer, invoices, summary } = data
  const address = customer.address || {}
  const fullAddress = [address.street, [address.postalCode, address.city].filter(Boolean).join(" "), address.country]
    .filter(Boolean)
    .join(", ")

  return (
    <main className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <header className="bg-white dark:bg-gray-800 border-b shadow-sm">
        <div className="container mx-auto px-3 sm:px-4 py-3 sm:py-4 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="text-xl sm:text-2xl font-bold text-gray-900 dark:text-gray-100" data-testid="portal-customer-name">
              {customer.name}
            </h1>
            {customer.customerNumber && (
              <p className="text-xs text-gray-500 dark:text-gray-400 font-mono mt-0.5">
                {customer.customerNumber}
              </p>
            )}
            {fullAddress && (
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{fullAddress}</p>
            )}
          </div>
          <div className="text-right">
            <button
              onClick={() => router.push("/portal/login")}
              className="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 underline"
            >
              {t("portal.logout") || "Abmelden"}
            </button>
          </div>
        </div>
      </header>

      <div className="container mx-auto px-3 sm:px-4 py-4 sm:py-8">
        {/* Summary tiles */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6" data-testid="portal-summary">
          <div className="bg-white dark:bg-gray-800 rounded-lg p-4 shadow-sm border border-gray-200 dark:border-gray-700">
            <p className="text-xs text-gray-500 dark:text-gray-400 uppercase">
              {t("portal.openBalance") || "Offener Saldo"}
            </p>
            <p className="text-2xl font-bold mt-1 text-gray-900 dark:text-gray-100">
              {fmtEur(summary.totalOpen, summary.currency)}
            </p>
            <p className="text-xs text-gray-400 mt-1">
              {summary.invoiceCount} {t("portal.invoices") || "Rechnungen"}
            </p>
          </div>
          <div className="bg-white dark:bg-gray-800 rounded-lg p-4 shadow-sm border border-gray-200 dark:border-gray-700">
            <p className="text-xs text-gray-500 dark:text-gray-400 uppercase">
              {t("portal.overdue") || "Überfällig"}
            </p>
            <p className={`text-2xl font-bold mt-1 ${summary.totalOverdue > 0 ? "text-red-600 dark:text-red-400" : "text-gray-900 dark:text-gray-100"}`}>
              {fmtEur(summary.totalOverdue, summary.currency)}
            </p>
          </div>
          <div className="bg-white dark:bg-gray-800 rounded-lg p-4 shadow-sm border border-gray-200 dark:border-gray-700">
            <p className="text-xs text-gray-500 dark:text-gray-400 uppercase">
              {t("portal.paidYTD") || "Bezahlt (Gesamt)"}
            </p>
            <p className="text-2xl font-bold mt-1 text-emerald-700 dark:text-emerald-400">
              {fmtEur(summary.totalPaid, summary.currency)}
            </p>
          </div>
        </div>

        {/* Tier 155: profile card. Read-only
            by default; "Bearbeiten" flips it
            into an inline form. The form
            mirrors the Customer.contact /
            .address JSON shape so a PATCH
            with the full payload is
            round-trip-clean. */}
        <div
          className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-4 sm:p-6 mb-6"
          data-testid="portal-profile-card"
        >
          <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
            <div>
              <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
                {t("portal.profileTitle") || "Mein Profil"}
              </h2>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                {t("portal.profileSubtitle") ||
                  "Halten Sie Ihre Kontaktdaten und Rechnungsadresse aktuell."}
              </p>
            </div>
            {!profileEdit && (
              <button
                type="button"
                onClick={() => {
                  setProfileResult(null)
                  setProfileEdit(true)
                }}
                className="text-sm text-blue-600 dark:text-blue-400 hover:underline"
                data-testid="portal-profile-edit"
              >
                ✏ {t("portal.profileEdit") || "Bearbeiten"}
              </button>
            )}
          </div>

          {/* Result banner (success / error).
              Shown when not in edit mode (so
              the user sees the confirmation
              after closing the form). */}
          {profileResult && !profileEdit && (
            <div
              className={
                "mb-3 p-2 rounded text-sm border " +
                (profileResult.kind === "ok"
                  ? "bg-green-50 border-green-200 text-green-800 dark:bg-green-900/30 dark:border-green-700 dark:text-green-200"
                  : "bg-red-50 border-red-200 text-red-800 dark:bg-red-900/30 dark:border-red-700 dark:text-red-200")
              }
              data-testid={
                profileResult.kind === "ok"
                  ? "portal-profile-saved-ok"
                  : "portal-profile-save-error"
              }
            >
              {profileResult.kind === "ok" ? "✓ " : "✗ "}
              {profileResult.msg}
            </div>
          )}

          {/* Read-only view: stacked label
              / value pairs. The customer
              sees what they have on file. */}
          {!profileEdit && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
              <div>
                <p className="text-xs text-gray-500 dark:text-gray-400 uppercase">
                  {t("portal.profileNameLabel") || "Firmenname"}
                </p>
                <p
                  className="text-gray-900 dark:text-gray-100 mt-0.5"
                  data-testid="portal-profile-display-name"
                >
                  {data.customer.name || "—"}
                </p>
              </div>
              {data.customer.vatId && (
                <div>
                  <p className="text-xs text-gray-500 dark:text-gray-400 uppercase">
                    {t("portal.profileVatIdLabel") || "USt-IDNr."}
                  </p>
                  <p className="text-gray-900 dark:text-gray-100 mt-0.5 font-mono">
                    {data.customer.vatId}
                  </p>
                </div>
              )}
              <div>
                <p className="text-xs text-gray-500 dark:text-gray-400 uppercase">
                  {t("portal.profileEmailLabel") || "E-Mail"}
                </p>
                <p
                  className="text-gray-900 dark:text-gray-100 mt-0.5"
                  data-testid="portal-profile-display-email"
                >
                  {(data.customer.contact as any)?.email || "—"}
                </p>
              </div>
              <div>
                <p className="text-xs text-gray-500 dark:text-gray-400 uppercase">
                  {t("portal.profilePhoneLabel") || "Telefon"}
                </p>
                <p className="text-gray-900 dark:text-gray-100 mt-0.5">
                  {(data.customer.contact as any)?.phone || "—"}
                </p>
              </div>
              <div className="sm:col-span-2">
                <p className="text-xs text-gray-500 dark:text-gray-400 uppercase">
                  {t("portal.profileAddressLabel") || "Rechnungsadresse"}
                </p>
                <p
                  className="text-gray-900 dark:text-gray-100 mt-0.5 whitespace-pre-line"
                  data-testid="portal-profile-display-address"
                >
                  {[
                    (data.customer.address as any)?.street,
                    [
                      (data.customer.address as any)?.postalCode,
                      (data.customer.address as any)?.city,
                    ].filter(Boolean).join(" "),
                    (data.customer.address as any)?.country,
                  ]
                    .filter(Boolean)
                    .join("\n") || "—"}
                </p>
              </div>
            </div>
          )}

          {/* Edit form. Inputs are pre-populated
              from the same `profileForm` state
              that the seed effect writes. The
              "useEffect re-seeds on
              data?.customer" is gated by
              `profileEdit` so the user's
              in-progress input is NOT clobbered
              while they're typing. */}
          {profileEdit && (
            <div className="space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium mb-1">
                    {t("portal.profileNameLabel") || "Firmenname"}
                  </label>
                  <input
                    type="text"
                    value={profileForm.name}
                    onChange={(e) =>
                      setProfileForm({ ...profileForm, name: e.target.value })
                    }
                    data-testid="portal-profile-name-input"
                    className="w-full px-3 py-2 border rounded bg-white dark:bg-gray-700 dark:border-gray-600 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">
                    {t("portal.profileVatIdLabel") || "USt-IDNr."}
                  </label>
                  <input
                    type="text"
                    value={profileForm.vatId}
                    onChange={(e) =>
                      setProfileForm({ ...profileForm, vatId: e.target.value })
                    }
                    data-testid="portal-profile-vatid-input"
                    className="w-full px-3 py-2 border rounded bg-white dark:bg-gray-700 dark:border-gray-600 text-sm font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">
                    {t("portal.profileEmailLabel") || "E-Mail"}
                  </label>
                  <input
                    type="email"
                    value={profileForm.contactEmail}
                    onChange={(e) =>
                      setProfileForm({
                        ...profileForm,
                        contactEmail: e.target.value,
                      })
                    }
                    data-testid="portal-profile-email-input"
                    className="w-full px-3 py-2 border rounded bg-white dark:bg-gray-700 dark:border-gray-600 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">
                    {t("portal.profilePhoneLabel") || "Telefon"}
                  </label>
                  <input
                    type="tel"
                    value={profileForm.contactPhone}
                    onChange={(e) =>
                      setProfileForm({
                        ...profileForm,
                        contactPhone: e.target.value,
                      })
                    }
                    data-testid="portal-profile-phone-input"
                    className="w-full px-3 py-2 border rounded bg-white dark:bg-gray-700 dark:border-gray-600 text-sm"
                  />
                </div>
              </div>
              <div>
                <p className="text-xs font-medium mb-1 uppercase text-gray-500 dark:text-gray-400">
                  {t("portal.profileAddressLabel") || "Rechnungsadresse"}
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-6 gap-2">
                  <input
                    type="text"
                    value={profileForm.addressStreet}
                    onChange={(e) =>
                      setProfileForm({
                        ...profileForm,
                        addressStreet: e.target.value,
                      })
                    }
                    placeholder={t("portal.profileStreetLabel") || "Straße"}
                    data-testid="portal-profile-street-input"
                    className="sm:col-span-6 px-3 py-2 border rounded bg-white dark:bg-gray-700 dark:border-gray-600 text-sm"
                  />
                  <input
                    type="text"
                    value={profileForm.addressPostalCode}
                    onChange={(e) =>
                      setProfileForm({
                        ...profileForm,
                        addressPostalCode: e.target.value,
                      })
                    }
                    placeholder={t("portal.profilePostalCodeLabel") || "PLZ"}
                    data-testid="portal-profile-postalcode-input"
                    className="sm:col-span-2 px-3 py-2 border rounded bg-white dark:bg-gray-700 dark:border-gray-600 text-sm"
                  />
                  <input
                    type="text"
                    value={profileForm.addressCity}
                    onChange={(e) =>
                      setProfileForm({
                        ...profileForm,
                        addressCity: e.target.value,
                      })
                    }
                    placeholder={t("portal.profileCityLabel") || "Stadt"}
                    data-testid="portal-profile-city-input"
                    className="sm:col-span-2 px-3 py-2 border rounded bg-white dark:bg-gray-700 dark:border-gray-600 text-sm"
                  />
                  <input
                    type="text"
                    value={profileForm.addressCountry}
                    onChange={(e) =>
                      setProfileForm({
                        ...profileForm,
                        addressCountry: e.target.value,
                      })
                    }
                    placeholder={t("portal.profileCountryLabel") || "Land"}
                    data-testid="portal-profile-country-input"
                    className="sm:col-span-2 px-3 py-2 border rounded bg-white dark:bg-gray-700 dark:border-gray-600 text-sm"
                  />
                </div>
              </div>
              {profileResult && profileResult.kind === "err" && (
                <p
                  className="text-sm text-red-600"
                  data-testid="portal-profile-save-error"
                >
                  {profileResult.msg}
                </p>
              )}
              <div className="flex gap-2 justify-end">
                <button
                  type="button"
                  onClick={() => {
                    setProfileEdit(false)
                    setProfileResult(null)
                  }}
                  disabled={profileSaving}
                  className="px-3 py-2 text-sm border rounded hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
                  data-testid="portal-profile-cancel"
                >
                  {t("portal.profileCancel") || "Abbrechen"}
                </button>
                <button
                  type="button"
                  onClick={saveProfile}
                  disabled={profileSaving}
                  className="px-3 py-2 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
                  data-testid="portal-profile-save"
                >
                  {profileSaving
                    ? (t("portal.profileSaving") || "Speichere…")
                    : t("portal.profileSave") || "Speichern"}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Invoice list */}
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm" data-testid="portal-invoice-table">
            <thead className="bg-gray-50 dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-300">
                  {t("portal.colNumber") || "Nr."}
                </th>
                <th className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-300">
                  {t("portal.colDate") || "Datum"}
                </th>
                <th className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-300">
                  {t("portal.colDue") || "Fällig"}
                </th>
                <th className="text-right px-4 py-3 font-medium text-gray-600 dark:text-gray-300">
                  {t("portal.colAmount") || "Betrag"}
                </th>
                <th className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-300">
                  {t("portal.colStatus") || "Status"}
                </th>
                <th className="text-right px-4 py-3 font-medium text-gray-600 dark:text-gray-300">
                  {t("portal.colActions") || "Aktionen"}
                </th>
              </tr>
            </thead>
            <tbody>
              {invoices.length === 0 ? (
                <tr>
                  <td colSpan={6} className="text-center py-8 text-gray-500">
                    {t("portal.noInvoices") || "Noch keine Rechnungen."}
                  </td>
                </tr>
              ) : (
                invoices.map((inv) => (
                  <tr
                    key={inv.id}
                    className="border-b border-gray-100 dark:border-gray-700 last:border-b-0"
                    data-testid={`portal-invoice-row-${inv.invoiceNumber}`}
                  >
                    <td className="px-4 py-3 font-mono">
                      {/* Tier 133: clickable invoice number
                          links to the detail page with the
                          session token. The user can also
                          just download the PDF or mark-paid
                          from the row directly — these are
                          quick actions. The detail view is
                          for the full breakdown (line items
                          + payment history). */}
                      <a
                        href={`/portal/invoice/${inv.id}?token=${encodeURIComponent(token)}`}
                        className="text-blue-600 dark:text-blue-400 hover:underline"
                        data-testid={`portal-invoice-link-${inv.invoiceNumber}`}
                      >
                        {inv.invoiceNumber}
                      </a>
                    </td>
                    <td className="px-4 py-3">{fmtDate(inv.issueDate)}</td>
                    <td className="px-4 py-3">
                      {fmtDate(inv.dueDate)}
                      {inv.daysOverdue > 0 && (
                        <span className="ml-2 text-xs text-red-600 dark:text-red-400 font-medium">
                          (+{inv.daysOverdue})
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right font-medium">
                      {fmtEur(Number(inv.total), inv.currency)}
                    </td>
                    <td className="px-4 py-3">{statusBadge(inv.status, inv.daysOverdue, t)}</td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex gap-2 justify-end flex-wrap">
                        <button
                          onClick={() => downloadPdf(inv.id)}
                          className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
                          data-testid={`portal-pdf-button-${inv.invoiceNumber}`}
                        >
                          📄 {t("portal.pdf") || "PDF"}
                        </button>
                        {inv.paymentReported && inv.status !== "paid" && (
                          <span
                            className="text-xs text-amber-700 dark:text-amber-300"
                            data-testid={`portal-payment-reported-${inv.invoiceNumber}`}
                          >
                            ⏳ {t("portal.paymentReported") || "Zahlung gemeldet"}
                          </span>
                        )}
                        {inv.status !== "paid" && inv.status !== "cancelled" && !inv.paymentReported && (
                          <button
                            onClick={() => markPaid(inv.id)}
                            disabled={busyInvoiceId === inv.id}
                            className="text-xs text-emerald-600 dark:text-emerald-400 hover:underline disabled:opacity-50"
                            data-testid={`portal-markpaid-button-${inv.invoiceNumber}`}
                          >
                            {busyInvoiceId === inv.id
                              ? "⏳"
                              : `✓ ${t("portal.markPaid") || "Bezahlt"}`}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  )
}

export default function PortalPage() {
  return (
    <Suspense fallback={
      <main className="min-h-screen bg-gray-50 dark:bg-gray-900 flex items-center justify-center">
        <p className="text-gray-500 dark:text-gray-400">⏳</p>
      </main>
    }>
      <PortalPageInner />
    </Suspense>
  )
}