/**
 * TOTP / RFC 6238 two-factor authentication.
 *
 * Design choices:
 *   - 30s time step, 6-digit code (Google Authenticator
 *     default). otplib handles the math.
 *   - Window = 1 (allow ±1 step = ±30s) to handle clock
 *     drift. Wider windows weaken the protection.
 *   - Secret is base32, 20 bytes (160 bits) — the
 *     RFC-recommended length. Generated via otplib's
 *     authenticator.generateSecret().
 *   - Recovery codes: 10 codes, 10 chars each, generated
 *     via crypto.randomBytes. Stored as SHA-256 hashes
 *     (salted with userId) so a DB leak doesn't compromise
 *     them.
 *   - One-time use: each code is removed from the
 *     recoveryCodes array after a successful use.
 *   - QR code: rendered as data URL (not a separate
 *     upload) so the frontend can <img src=...> it
 *     without a second round-trip.
 */
import { Injectable, Logger } from "@nestjs/common"
import { authenticator } from "otplib"
import * as qrcode from "qrcode"
import { createHash, randomBytes } from "crypto"

// 30s step + 6 digits (Google Authenticator default).
// Override the global defaults BEFORE importing — otplib
// reads these at import time, so we set them in the
// module init via authenticator.options below.
authenticator.options = {
  step: 30,
  window: 1,
  digits: 6,
}

const APP_NAME = "de-invoice"
const RECOVERY_CODE_COUNT = 10
const RECOVERY_CODE_LENGTH = 10

@Injectable()
export class TwoFactorService {
  private readonly logger = new Logger(TwoFactorService.name)

  /**
   * Generate a fresh TOTP secret + otpauth URL for the
   * QR code. The secret is base32 — the user scans the QR
   * with their authenticator app. This does NOT enable 2FA
   * yet; the user must verify a code (via verifyCode with
   * enableOnSuccess=true) to prove they scanned correctly.
   */
  async generateSetup(userEmail: string): Promise<{
    secret: string
    otpauthUrl: string
    qrCodeDataUrl: string
  }> {
    const secret = authenticator.generateSecret()
    const otpauthUrl = authenticator.keyuri(userEmail, APP_NAME, secret)
    // Render the QR as a data URL (base64 PNG). The
    // frontend just sets <img src={qrCodeDataUrl} />.
    // Width 300 is large enough to scan on a phone
    // without being huge on the page.
    const qrCodeDataUrl = await qrcode.toDataURL(otpauthUrl, {
      width: 300,
      margin: 1,
      errorCorrectionLevel: "M",
    })
    return { secret, otpauthUrl, qrCodeDataUrl }
  }

  /**
   * Verify a 6-digit code against a given secret. The
   * caller passes the secret (NOT the stored one on the
   * user record) during setup. After enableOnSuccess=true,
   * this also confirms the secret and returns the
   * recovery codes (plain, ONE TIME — caller must
   * display them and ask the user to save).
   */
  async verifyCode(
    secret: string,
    code: string,
    opts?: { enableOnSuccess?: boolean },
  ): Promise<{ ok: true; enabled: boolean; recoveryCodes?: string[] } | { ok: false; reason: string }> {
    if (!/^\d{6}$/.test(code)) {
      return { ok: false, reason: "Code muss 6 Ziffern sein" }
    }
    // otplib v12 verify returns null on bad code, the
    // matched step delta otherwise. Coerce to boolean
    // — null → false, anything else → true.
    const valid = authenticator.verify({ token: code, secret })
    if (!valid) {
      return { ok: false, reason: "Code ungültig oder abgelaufen" }
    }
    if (opts?.enableOnSuccess) {
      return { ok: true, enabled: true, recoveryCodes: this.generateRecoveryCodes() }
    }
    return { ok: true, enabled: false }
  }

  /**
   * Verify a code against the user's stored secret. Used
   * on every login (and on the "verify before disable"
   * step). Returns true if the code matches.
   */
  async verifyStoredCode(secret: string, code: string): Promise<boolean> {
    if (!/^\d{6}$/.test(code)) return false
    return Boolean(authenticator.verify({ token: code, secret }))
  }

  /**
   * Generate 10 single-use recovery codes. Each is
   * `XXXX-XXXX-XX` (10 chars, formatted with dashes
   * for readability). Avoids ambiguous chars (I, O, 0, 1)
   * so users don't fat-finger the code on a phone.
   */
  generateRecoveryCodes(): string[] {
    // Avoid ambiguous chars: I, O, 0, 1
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    const codes: string[] = []
    for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
      const raw = randomBytes(RECOVERY_CODE_LENGTH)
      let code = ""
      for (let b = 0; b < RECOVERY_CODE_LENGTH; b++) {
        code += alphabet[raw[b] % alphabet.length]
      }
      // Format as XXXX-XXXX-XX (10 chars → 4-4-2). Easier
      // to read on a phone / handwritten note.
      const formatted = `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8, 10)}`
      codes.push(formatted)
    }
    return codes
  }

  /**
   * Hash a recovery code the same way we'll compare it.
   * SHA-256 (not bcrypt) — recovery codes are
   * 10^10 = 10 billion possibilities, so the
   * brute-force window from a hash leak is small. SHA-256
   * is faster to compare in a hot login path. We salt
   * with a per-user secret derived from userId so the
   * hashes can't be reversed via a rainbow table of
   * common formats.
   */
  hashRecoveryCode(code: string, userId: string): string {
    const normalized = code.replace(/[-\s]/g, "").toUpperCase()
    return createHash("sha256")
      .update(`${userId}:${normalized}`)
      .digest("hex")
  }

  /**
   * Check a recovery code against the user's stored
   * hashes. Returns true if any matches; the matched
   * code is then removed from the array (one-time use).
   */
  consumeRecoveryCode(
    input: string,
    storedHashes: string[],
    userId: string,
  ): { ok: boolean; remaining: string[] } {
    const target = this.hashRecoveryCode(input, userId)
    const idx = storedHashes.indexOf(target)
    if (idx === -1) {
      return { ok: false, remaining: storedHashes }
    }
    const remaining = [...storedHashes]
    remaining.splice(idx, 1)
    return { ok: true, remaining }
  }
}
