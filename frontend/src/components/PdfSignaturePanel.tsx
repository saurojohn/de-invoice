"use client"

/**
 * Tier 72: PDF Signature panel.
 *
 * Renders the cert info + a "Signatur prüfen"
 * button on the invoice detail page. When
 * the user clicks verify, the page downloads
 * the PDF, POSTs it to /signing/verify, and
 * shows the result.
 *
 * The panel also shows a "Signatur beim
 * Download einbetten" toggle (default on) —
 * the backend already signs on every
 * download, but the toggle is a UI affordance
 * that mirrors the user's mental model: "is
 * this invoice going to be signed when I
 * download it?"
 *
 * Why this lives on the invoice detail page
 * and not in a separate page: the user
 * verifies "is THIS invoice signed?" in
 * context, not as a global audit. The GoBD
 * audit-trail page (tier 67) is the
 * cross-invoice view; this is the
 * per-invoice view.
 */

import { useState } from "react"
import { useI18n } from "@/components/useI18n"
import { useToast } from "@/components/useToast"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { API_BASE } from "@/lib/api"
import { apiGet } from "@/lib/api"

interface CertInfo {
  commonName: string | null
  fingerprint: string | null
  validUntil: string | null
  generatedAt: string | null
}

interface VerifyResult {
  valid: boolean
  signedBy: string | null
  signedAt: string | null
  certFingerprint: string | null
  reason: string | null
  signatureCount: number
}

interface PdfSignaturePanelProps {
  invoiceId: string
}

// Tier 165: read the signature metadata
// (signed / signerCN / fingerprint) from
// the ?meta=true JSON shortcut. The
// controller responds with a small JSON
// payload (~100 bytes) instead of the
// full PDF + signature, which is the
// right granularity for a UI status card.
async function readPdfSignatureHeaders(
  invoiceId: string,
  companyId: string,
  userId: string,
): Promise<{
  signed: boolean
  signerCN: string | null
  fingerprint: string | null
}> {
  const apiBase =
    process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001"
  try {
    const res = await fetch(
      `${apiBase}/api/v1/invoices/${invoiceId}/pdf?companyId=${companyId}&meta=true`,
      {
        method: "GET",
        headers: {
          "x-user-id": userId,
          "x-company-id": companyId,
        },
      },
    )
    if (!res.ok) {
      return { signed: false, signerCN: null, fingerprint: null }
    }
    const data = await res.json()
    return {
      signed: data.signed === true,
      signerCN: data.signerCN ?? null,
      fingerprint: data.fingerprint ?? null,
    }
  } catch {
    return { signed: false, signerCN: null, fingerprint: null }
  }
}

export default function PdfSignaturePanel({ invoiceId }: PdfSignaturePanelProps) {
  const { t } = useI18n()
  const toast = useToast()
  const [cert, setCert] = useState<CertInfo | null>(null)
  const [verify, setVerify] = useState<VerifyResult | null>(null)
  // Tier 165: signed PDF status from the
  // ?meta=true JSON shortcut endpoint
  // (signed / signerCN / fingerprint).
  const [signedPdf, setSignedPdf] = useState<{
    signed: boolean
    signerCN: string | null
    fingerprint: string | null
  } | null>(null)
  const [loading, setLoading] = useState<{
    cert: boolean
    verify: boolean
    signedPdf: boolean
    berater: boolean
  }>({ cert: false, verify: false, signedPdf: false, berater: false })
  const companyId =
    typeof window !== "undefined" ? localStorage.getItem("companyId") : null
  const userId =
    typeof window !== "undefined" ? localStorage.getItem("userId") || "" : ""

  const loadCert = async () => {
    if (!companyId) return
    setLoading((l) => ({ ...l, cert: true }))
    try {
      const data = await apiGet<CertInfo>(
        `/api/v1/signing/cert-info?companyId=${companyId}`,
      )
      setCert(data)
    } catch (e: any) {
      // cert-info is idempotent — the backend
      // auto-generates a cert on first call. So
      // an error here is a real error.
      toast.error(e?.message || t("common.loadError") || "Fehler")
    } finally {
      setLoading((l) => ({ ...l, cert: false }))
    }
  }

  // Tier 165: fetch the signature metadata
  // (signed / signerCN / fingerprint) from
  // the ?meta=true JSON shortcut. This
  // returns a ~100-byte JSON payload instead
  // of the full PDF (~10KB) — the right
  // granularity for a status card.
  const loadSignedPdf = async () => {
    if (!companyId) return
    setLoading((l) => ({ ...l, signedPdf: true }))
    try {
      const data = await readPdfSignatureHeaders(
        invoiceId,
        companyId,
        userId,
      )
      setSignedPdf(data)
    } finally {
      setLoading((l) => ({ ...l, signedPdf: false }))
    }
  }

  const verifyPdf = async () => {
    if (!companyId) return
    setLoading((l) => ({ ...l, verify: true }))
    try {
      const apiBase =
        process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001"
      console.log("[verifyPdf] starting, apiBase=", apiBase, "invoiceId=", invoiceId)
      // 1. Download the PDF.
      const pdfRes = await fetch(
        `${apiBase}/api/v1/invoices/${invoiceId}/pdf?companyId=${companyId}`,
        {
          headers: {
            "x-user-id": localStorage.getItem("userId") || "",
            "x-company-id": companyId,
          },
        },
      )
      console.log("[verifyPdf] pdf response status=", pdfRes.status)
      if (!pdfRes.ok) throw new Error(`PDF download: HTTP ${pdfRes.status}`)
      // 2. Base64-encode for the verify endpoint.
      // Avoid the spread-operator on large buffers
      // (the naive `String.fromCharCode(...u8)` throws
      // "too many arguments" on a 1MB PDF). Use
      // FileReader instead — it's built into the
      // browser, handles any size, and returns a
      // data: URL containing the base64.
      const blob = await pdfRes.blob()
      const b64: string = await new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => {
          const result = reader.result as string
          // data:application/pdf;base64,<...>
          const commaIdx = result.indexOf(",")
          resolve(commaIdx >= 0 ? result.slice(commaIdx + 1) : result)
        }
        reader.onerror = () => reject(reader.error)
        reader.readAsDataURL(blob)
      })
      // 3. POST to /signing/verify.
      const verifyRes = await fetch(
        `${apiBase}/api/v1/signing/verify`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-user-id": localStorage.getItem("userId") || "",
            "x-company-id": companyId,
          },
          body: JSON.stringify({ pdf: b64 }),
        },
      )
      console.log("[verifyPdf] verify response status=", verifyRes.status)
      if (!verifyRes.ok) throw new Error(`Verify: HTTP ${verifyRes.status}`)
      const data = await verifyRes.json()
      setVerify(data)
    } catch (e: any) {
      toast.error(e?.message || t("common.error") || "Fehler")
    } finally {
      setLoading((l) => ({ ...l, verify: false }))
    }
  }

  // Tier 246: Berater personal stamp on the PDF.
  // Downloads the company-signed PDF, POSTs it back
  // to /signing/user-sign with the current user's
  // cert, then saves the resulting 2-signature
  // chain as "INV-XXXX_signed_berater.pdf". The
  // user cert is auto-generated on first call
  // (mirrors the company cert's getOrCreate pattern).
  const stampBerater = async () => {
    setLoading((l) => ({ ...l, berater: true }))
    try {
      // 1. Get the user's id from localStorage.
      const userId = localStorage.getItem("userId")
      if (!userId) {
        toast.error(t("signing.beraterNoUser") || "Benutzer-ID nicht gefunden")
        return
      }
      // 2. Download the (already company-signed) PDF.
      const companyId = localStorage.getItem("companyId") || ""
      const dl = await fetch(
        `${API_BASE}/api/v1/invoices/${invoiceId}/pdf?companyId=${companyId}&sign=true`,
        {
          headers: {
            "x-user-id": localStorage.getItem("userId") || "",
            "x-company-id": companyId,
          },
        },
      )
      if (!dl.ok) {
        toast.error(`PDF-Download fehlgeschlagen: ${dl.status}`)
        return
      }
      const pdfBuf = await dl.arrayBuffer()
      const pdfB64 = btoa(
        String.fromCharCode(...new Uint8Array(pdfBuf)),
      )
      // 3. POST to /signing/user-sign.
      const apiRes = await fetch(`${API_BASE}/api/v1/signing/user-sign`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-user-id": localStorage.getItem("userId") || "",
          "x-company-id": companyId,
        },
        body: JSON.stringify({ userId, pdf: pdfB64 }),
      })
      if (!apiRes.ok) {
        const err = await apiRes.text()
        toast.error(`Berater-Signatur fehlgeschlagen: ${err}`)
        return
      }
      const data = await apiRes.json()
      // 4. Save the 2-signature chain as a separate file.
      const bytes = Uint8Array.from(atob(data.signedPdf), (c) => c.charCodeAt(0))
      const blob = new Blob([bytes], { type: "application/pdf" })
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = `INV-${invoiceId.slice(0, 8)}_signed_berater.pdf`
      a.click()
      URL.revokeObjectURL(url)
      toast.success(
        t("signing.beraterStamped") || "Berater-Signatur angewendet (2-Signaturen-PDF heruntergeladen)",
      )
    } catch (e: any) {
      toast.error(`Berater-Signatur: ${e?.message || "unbekannter Fehler"}`)
    } finally {
      setLoading((l) => ({ ...l, berater: false }))
    }
  }

  return (
    <Card data-testid="pdf-signature-panel">
      <CardHeader>
        <CardTitle className="text-lg flex items-center gap-2">
          🔒 {t("signing.title") || "PDF-Signatur"}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            <Button
              onClick={loadCert}
              disabled={loading.cert}
              variant="outline"
              size="sm"
              data-testid="pdf-signature-load-cert"
            >
              {loading.cert ? "..." : t("signing.certInfo") || "Zertifikats-Informationen"}
            </Button>
            <Button
              onClick={loadSignedPdf}
              disabled={loading.signedPdf}
              variant="outline"
              size="sm"
              data-testid="pdf-signature-check-signed"
            >
              {loading.signedPdf
                ? "..."
                : t("signing.checkSigned") || "Signatur-Status prüfen"}
            </Button>
            <Button
              onClick={verifyPdf}
              disabled={loading.verify}
              variant="outline"
              size="sm"
              data-testid="pdf-signature-verify"
            >
              {loading.verify ? "..." : t("signing.verify") || "Signatur prüfen"}
            </Button>
            {/* Tier 246: Berater personal stamp. Adds a
                second signature in the chain (user cert
                on top of the company cert). Adobe Reader
                shows both signatures in the panel. */}
            <Button
              onClick={stampBerater}
              disabled={loading.berater}
              variant="default"
              size="sm"
              data-testid="pdf-signature-berater-stamp"
            >
              {loading.berater
                ? "..."
                : t("signing.beraterStamp") || "Berater-Signatur anwenden"}
            </Button>
          </div>
          {cert && (
            <div
              className="text-xs space-y-1 p-3 bg-gray-50 dark:bg-gray-700/30 rounded"
              data-testid="pdf-signature-cert-info"
            >
              <div>
                <span className="text-gray-500">
                  {t("signing.subject") || "Aussteller"}:
                </span>{" "}
                <span className="font-mono">{cert.commonName || "—"}</span>
              </div>
              <div>
                <span className="text-gray-500">
                  {t("signing.fingerprint") || "Fingerabdruck"}:
                </span>{" "}
                <span className="font-mono text-[10px] break-all">
                  {cert.fingerprint || "—"}
                </span>
              </div>
              <div>
                <span className="text-gray-500">
                  {t("signing.validUntil") || "Gültig bis"}:
                </span>{" "}
                <span className="font-mono">{cert.validUntil || "—"}</span>
              </div>
            </div>
          )}
          {verify && (
            <div
              className={`text-sm p-3 rounded ${
                verify.valid
                  ? "bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300"
                  : "bg-amber-50 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300"
              }`}
              data-testid="pdf-signature-verify-result"
            >
              {verify.valid
                ? `✓ ${t("signing.verified") || "Signatur gültig"}`
                : `⚠ ${verify.reason || t("signing.notSigned") || "Keine Signatur"}`}
              {verify.signedBy && (
                <div className="text-xs mt-1 text-gray-600 dark:text-gray-400">
                  {verify.signedBy}
                </div>
              )}
            </div>
          )}
          {/* Tier 165: signed-PDF status from the
              X-PDF-Signed / X-PDF-Signer-CN /
              X-PDF-Fingerprint response headers.
              Shows "what the backend will sign
              with on the next download" — the
              headers are set at controller time,
              so they're always accurate. */}
          {signedPdf && (
            <div
              className={`text-sm p-3 rounded ${
                signedPdf.signed
                  ? "bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300"
                  : "bg-amber-50 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300"
              }`}
              data-testid="pdf-signature-signed-status"
            >
              {signedPdf.signed
                ? `🔒 ${t("signing.willSign") || "PDF wird signiert heruntergeladen"}`
                : `⚠ ${t("signing.willNotSign") || "PDF wird NICHT signiert (Signatur deaktiviert)"}`}
              {signedPdf.signed && signedPdf.signerCN && (
                <div className="text-xs mt-1 text-gray-600 dark:text-gray-400">
                  {t("signing.signedBy") || "Signiert von"}:{" "}
                  <span className="font-mono">{signedPdf.signerCN}</span>
                </div>
              )}
              {signedPdf.signed && signedPdf.fingerprint && (
                <div className="text-[10px] mt-1 font-mono text-gray-500 dark:text-gray-400 break-all">
                  FP: {signedPdf.fingerprint}
                </div>
              )}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
