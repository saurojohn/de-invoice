/**
 * 2FA endpoints. Three flows:
 *
 *   1) Setup (POST /auth/2fa/setup)
 *      - Caller is already logged in (uses x-user-id).
 *      - Returns { secret, qrCodeDataUrl, otpauthUrl }.
 *      - Does NOT enable 2FA yet — user must verify a code.
 *
 *   2) Enable (POST /auth/2fa/enable)
 *      - Caller sends { code }.
 *      - Verifies the code against the just-issued
 *        secret (which is held in a short-lived
 *        "pending 2FA" cache — see note below).
 *      - On success, persists secret + 10 recovery codes
 *        (plain returned ONCE to the user).
 *
 *   3) Verify on login (POST /auth/2fa/verify)
 *      - Called after /auth/login returned 401 with
 *        code 'TWO_FACTOR_REQUIRED' (see auth.service).
 *      - body: { email, code, recoveryCode? }.
 *      - On success, returns a one-time login token
 *        (re-uses the existing JWT/header auth path).
 *
 * The "pending secret" is held in a short-TTL in-memory
 * map keyed by userId. If the user takes longer than
 * 10 min to verify, they have to start over. This
 * avoids persisting an unverified TOTP secret to the
 * User table (which would be a footgun if a user
 * abandoned setup halfway).
 */
import {
  Body,
  Controller,
  Post,
  Req,
  Res,
  UseGuards,
  BadRequestException,
  UnauthorizedException,
} from "@nestjs/common"
import { Request, Response } from "express"
import { PrismaService } from "../../../prisma/prisma.service"
import { UserSessionService } from "../../../auth/user-session.service"
import { HeaderAuthGuard } from "../../../auth/header-auth.guard"
import { TwoFactorService } from "./two-factor.service"
import { Public } from "../../../auth/public.decorator"

// In-memory map of userId -> { secret, issuedAt }.
// 10-min TTL. Process-local — on restart the user has
// to restart setup (acceptable; rare and a fresh
// secret is more secure anyway).
const PENDING_TTL_MS = 10 * 60 * 1000
const pendingSecrets = new Map<
  string,
  { secret: string; issuedAt: number }
>()

function gcPending() {
  const now = Date.now()
  for (const [k, v] of pendingSecrets.entries()) {
    if (now - v.issuedAt > PENDING_TTL_MS) pendingSecrets.delete(k)
  }
}

@Controller("auth/2fa")
export class TwoFactorController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly twoFactor: TwoFactorService,
    private readonly sessions: UserSessionService,
  ) {}

  /**
   * Generate a TOTP secret + QR code for the logged-in
   * user. Stores the secret in the pending cache; does
   * NOT persist to User yet.
   */
  @Post("setup")
  @UseGuards(HeaderAuthGuard)
  async setup(@Req() req: Request) {
    const userId = (req.headers["x-user-id"] as string) || ""
    if (!userId) throw new UnauthorizedException("Anmeldung erforderlich")
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, twoFactorEnabled: true },
    })
    if (!user) throw new UnauthorizedException("Ungültiger Benutzer")
    if (user.twoFactorEnabled) {
      throw new BadRequestException(
        "2FA ist bereits aktiviert. Zum Ändern erst deaktivieren.",
      )
    }
    const { secret, qrCodeDataUrl, otpauthUrl } =
      await this.twoFactor.generateSetup(user.email)
    pendingSecrets.set(userId, { secret, issuedAt: Date.now() })
    return { secret, qrCodeDataUrl, otpauthUrl }
  }

  /**
   * Verify a TOTP code against the pending secret. On
   * success, persist the secret to User and return 10
   * recovery codes (plain — display them once, never
   * retrievable again).
   */
  @Post("enable")
  @UseGuards(HeaderAuthGuard)
  async enable(@Req() req: Request, @Body() body: { code: string }) {
    const userId = (req.headers["x-user-id"] as string) || ""
    if (!userId) throw new UnauthorizedException("Anmeldung erforderlich")
    gcPending()
    const pending = pendingSecrets.get(userId)
    if (!pending) {
      throw new BadRequestException(
        "Setup abgelaufen oder nicht gestartet. Bitte neu starten.",
      )
    }
    const code = (body?.code || "").toString().trim()
    const result = await this.twoFactor.verifyCode(pending.secret, code, {
      enableOnSuccess: true,
    })
    if (!result.ok) {
      throw new BadRequestException(result.reason)
    }
    // Hash the recovery codes for storage. We hand the
    // user the PLAIN codes via this same response — they
    // never come back from the server after this.
    const recoveryHashes = (result.recoveryCodes || []).map((c) =>
      this.twoFactor.hashRecoveryCode(c, userId),
    )
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        twoFactorEnabled: true,
        twoFactorSecret: pending.secret,
        twoFactorConfirmedAt: new Date(),
        recoveryCodes: recoveryHashes,
      },
    })
    pendingSecrets.delete(userId)
    return {
      ok: true,
      enabled: true,
      recoveryCodes: result.recoveryCodes,
    }
  }

  /**
   * Disable 2FA. Requires the current TOTP code OR a
   * recovery code (so a stolen session cookie alone
   * can't disable 2FA — the attacker would also need
   * the user's authenticator).
   */
  @Post("disable")
  @UseGuards(HeaderAuthGuard)
  async disable(
    @Req() req: Request,
    @Body() body: { code?: string; recoveryCode?: string },
  ) {
    const userId = (req.headers["x-user-id"] as string) || ""
    if (!userId) throw new UnauthorizedException("Anmeldung erforderlich")
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    })
    if (!user || !user.twoFactorEnabled || !user.twoFactorSecret) {
      throw new BadRequestException("2FA ist nicht aktiviert")
    }
    const code = (body?.code || "").toString().trim()
    const recoveryCode = (body?.recoveryCode || "").toString().trim()
    if (!code && !recoveryCode) {
      throw new BadRequestException(
        "Code oder Recovery-Code ist erforderlich",
      )
    }
    let ok = false
    let remainingHashes: string[] = (user.recoveryCodes as any) || []
    if (recoveryCode) {
      const r = this.twoFactor.consumeRecoveryCode(
        recoveryCode,
        remainingHashes,
        userId,
      )
      ok = r.ok
      remainingHashes = r.remaining
    } else {
      ok = await this.twoFactor.verifyStoredCode(user.twoFactorSecret, code)
    }
    if (!ok) {
      throw new UnauthorizedException("Code ungültig")
    }
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        twoFactorEnabled: false,
        twoFactorSecret: null,
        twoFactorConfirmedAt: null,
        recoveryCodes: remainingHashes, // keep remaining recovery codes even after disable (or null)
      },
    })
    return { ok: true, enabled: false, remainingRecoveryCodes: remainingHashes.length }
  }

  /**
   * Second step of login: after the password was
   * accepted, the server returns 401 with
   * TWO_FACTOR_REQUIRED. The frontend collects the
   * 6-digit code (or recovery code) and posts it here.
   * On success, returns a "login complete" marker
   * (the actual session uses the x-user-id /
   * x-company-id headers, set by the client from
   * the prior /login response — we just confirm 2FA
   * passed).
   *
   * Note: for the simplest integration with the
   * existing HeaderAuthGuard-based flow, we re-issue
   * the user object to the client (same shape as
   * /auth/login). This is intentionally a "re-login"
   * that returns the same payload.
   */
  @Public()
  @Post("verify")
  async verify(
    @Body() body: {
      email: string
      code?: string
      recoveryCode?: string
    },
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const email = (body?.email || "").toString().trim().toLowerCase()
    if (!email) throw new BadRequestException("E-Mail ist erforderlich")
    const user = await this.prisma.user.findUnique({
      where: { email },
    })
    if (!user || !user.twoFactorEnabled || !user.twoFactorSecret) {
      // Don't leak whether 2FA is on. The 2FA path
      // was triggered by the login route, which already
      // validated the password; reaching here with
      // 2FA off is a server-side inconsistency.
      throw new BadRequestException("2FA nicht aktiviert")
    }
    const code = (body?.code || "").toString().trim()
    const recoveryCode = (body?.recoveryCode || "").toString().trim()
    if (!code && !recoveryCode) {
      throw new BadRequestException(
        "Code oder Recovery-Code ist erforderlich",
      )
    }
    let ok = false
    let remainingHashes: string[] = (user.recoveryCodes as any) || []
    if (recoveryCode) {
      const r = this.twoFactor.consumeRecoveryCode(
        recoveryCode,
        remainingHashes,
        user.id,
      )
      ok = r.ok
      remainingHashes = r.remaining
    } else {
      ok = await this.twoFactor.verifyStoredCode(user.twoFactorSecret, code)
    }
    if (!ok) {
      throw new UnauthorizedException("Code ungültig")
    }
    // Persist any consumed recovery code (one-time use).
    if (recoveryCode) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { recoveryCodes: remainingHashes },
      })
    }
    // Mark lastLogin + return the same shape /auth/login
    // returns, so the frontend can drop the result into
    // the same setState it uses for the password path.
    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLogin: new Date() },
    })
    // Tier 401: this route IS the second half of a login — /auth/login answers
            // `requires2fa` and stops, so a user with 2FA on never passes through the
    // session-minting branch there. Without this they would finish signing in
    // with no session at all, i.e. be unable to use the app once
    // ALLOW_HEADER_AUTH=0.
    const session = await this.sessions.issue(res, user.id, req as any)
    return {
      id: user.id,
      email: user.email,
      companyId: user.companyId,
      role: user.role,
      sessionToken: session.token,
      sessionExpiresAt: session.expiresAt,
    }
  }

  /**
   * GET status — used by the settings page to show
   * "2FA is on" / "2FA is off" + remaining recovery
   * code count.
   */
  @Post("status")
  @UseGuards(HeaderAuthGuard)
  async status(@Req() req: Request) {
    const userId = (req.headers["x-user-id"] as string) || ""
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { twoFactorEnabled: true, recoveryCodes: true },
    })
    return {
      enabled: !!user?.twoFactorEnabled,
      remainingRecoveryCodes: Array.isArray(user?.recoveryCodes)
        ? (user!.recoveryCodes as string[]).length
        : 0,
    }
  }
}
