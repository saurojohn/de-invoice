import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  BadRequestException,
  ForbiddenException,
  Req,
} from '@nestjs/common'
import { Auth, Require } from '../../auth/roles.decorator'
import { FinTsService } from './fints.service'
import { FintsSyncScheduler } from './fints-sync.scheduler'

interface CreateConnectionDto {
  companyId: string
  blz: string
  userId: string
  label: string
  pin: string
  endpointUrl?: string
  mockMode?: boolean
}

interface StartSyncDto {
  companyId: string
  daysBack?: number
}

interface SubmitTanDto {
  companyId: string
  tan: string
}

interface CreateTransferDto {
  companyId: string
  connectionId: string
  kind: 'credit_transfer' | 'direct_debit'
  creditorName: string
  creditorIban: string
  creditorBic?: string
  amount: string
  currency?: string
  purpose?: string
  endToEndId: string
  // direct_debit only
  mandateId?: string
  sequenceType?: 'FRST' | 'RCUR' | 'FNAL' | 'OOFF'
}

interface SubmitTransferTanDto {
  companyId: string
  tan: string
}

/**
 * Tier 6: FinTS bank connection controller.
 *
 * Follows the same pattern as
 * ExchangeRateController — companyId comes
 * from the body or query string (NOT from
 * HeaderAuthGuard), and the service is
 * responsible for the companyId-scoping
 * checks on the underlying rows. This
 * keeps the route handlers flat and
 * testable.
 */
@Auth()
@Controller('fints')
export class FinTsController {
  constructor(
    private readonly fints: FinTsService,
    private readonly scheduler: FintsSyncScheduler,
  ) {}

  /**
   * List the FinTS connections configured for
   * the current company. The PIN hash is
   * never returned to the frontend — only
   * metadata (label, bank, status, last sync).
   */
  @Get('connections')
  @Require('reports.read')
  async listConnections(@Query('companyId') companyId: string) {
    if (!companyId) {
      throw new BadRequestException('companyId is required')
    }
    return this.fints['prisma'].finTSConnection.findMany({
      where: { companyId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        blz: true,
        userId: true,
        label: true,
        endpointUrl: true,
        mockMode: true,
        tanMethod: true,
        status: true,
        lastSyncAt: true,
        lastError: true,
        createdAt: true,
      },
    })
  }

  /**
   * Create a new connection. The PIN is sent
   * once over HTTPS, the server hashes it
   * with SHA-256 and never stores the
   * plaintext. Real banks will only ever see
   * the hash via the dialog — the plaintext
   * is only used to authenticate the very
   * first dialog init. Subsequent syncs use
   * the system-id assigned by the bank.
   *
   * `mockMode` defaults to true for safety:
   * a typo'd PIN won't lock the user's real
   * bank account, and the dev/CI environment
   * never accidentally hits production.
   * Set explicitly to false to use real
   * FinTS.
   */
  @Post('connections')
  @Require('company.update')
  async createConnection(@Body() body: CreateConnectionDto) {
    if (!body?.companyId) {
      throw new BadRequestException('companyId is required')
    }
    if (!body?.blz || !body?.userId || !body?.label || !body?.pin) {
      throw new BadRequestException(
        'blz, userId, label und pin sind erforderlich',
      )
    }
    if (!/^\d{8}$/.test(body.blz)) {
      throw new BadRequestException('BLZ muss 8 Ziffern sein')
    }
    if (body.pin.length < 4) {
      throw new BadRequestException('PIN zu kurz')
    }
    // Tier 12 SSRF guard: if the user supplied
    // an endpointUrl, it MUST be HTTPS. We never
    // make plain-HTTP requests to a bank (PIN +
    // TAN would traverse the wire in cleartext).
    // We also reject localhost / private IP
    // ranges — even with auth, the bank-side
    // TLS cert would never match. This rule
    // catches "the user pasted
    // http://10.0.0.1/..." style SSRF attempts
    // before the value is persisted.
    if (body.endpointUrl) {
      let url: URL
      try {
        url = new URL(body.endpointUrl)
      } catch {
        throw new BadRequestException('endpointUrl ist keine gültige URL')
      }
      if (url.protocol !== 'https:') {
        throw new BadRequestException('endpointUrl muss HTTPS sein')
      }
      const host = url.hostname.toLowerCase()
      const isLocal =
        host === 'localhost' ||
        host === '127.0.0.1' ||
        host === '::1' ||
        host === '0.0.0.0' ||
        host.endsWith('.local') ||
        host.endsWith('.internal') ||
        /^10\./.test(host) ||
        /^192\.168\./.test(host) ||
        /^172\.(1[6-9]|2[0-9]|3[01])\./.test(host) ||
        /^169\.254\./.test(host)
      if (isLocal) {
        throw new BadRequestException(
          'endpointUrl darf nicht auf eine lokale/private IP zeigen',
        )
      }
    }
    return this.fints.createConnection({
      companyId: body.companyId,
      blz: body.blz,
      userId: body.userId,
      label: body.label,
      endpointUrl: body.endpointUrl,
      pin: body.pin,
      mockMode: body.mockMode ?? true, // Default to mock for safety
    })
  }

  /**
   * Delete a connection. The PIN hash goes
   * with it — there's no way to "deactivate"
   * a connection without losing the system-id
   * (which is bank-side), so the right
   * primitive is full delete + re-create when
   * the user wants to re-enable.
   */
  @Delete('connections/:id')
  @Require('company.update')
  async deleteConnection(
    @Param('id') id: string,
    @Query('companyId') companyId: string,
  ) {
    if (!companyId) {
      throw new BadRequestException('companyId is required')
    }
    const conn = await this.fints['prisma'].finTSConnection.findFirst({
      where: { id, companyId },
    })
    if (!conn) throw new ForbiddenException('Verbindung nicht gefunden')
    await this.fints['prisma'].finTSConnection.delete({ where: { id } })
    return { ok: true }
  }

  /**
   * Step 1 of the sync. Opens a dialog,
   * fetches HKSAL + HKKAZ. Returns either:
   *   - {status: 'ok', txCount, syncRunId}
   *   - {status: 'needs_tan', tanChallenge, syncRunId}
   *   - {status: 'failed', errorCode, errorMessage, syncRunId}
   */
  @Post('connections/:id/sync')
  @Require('reports.read')
  async startSync(
    @Param('id') id: string,
    @Body() body: StartSyncDto,
    @Req() req: any,
  ) {
    if (!body?.companyId) {
      throw new BadRequestException('companyId is required')
    }
    return this.fints.startSync({
      connectionId: id,
      companyId: body.companyId,
      userId: req.headers['x-user-id'],
      daysBack: body?.daysBack,
    })
  }

  /**
   * Step 2 of the sync. Re-issues the HKKAZ
   * with the user-supplied TAN. The bank
   * finishes the request and returns the
   * transactions. For mock mode any 6-digit
   * TAN is accepted.
   */
  @Post('sync-runs/:id/tan')
  @Require('reports.read')
  async submitTan(
    @Param('id') id: string,
    @Body() body: SubmitTanDto,
  ) {
    if (!body?.companyId) {
      throw new BadRequestException('companyId is required')
    }
    if (!body?.tan) {
      throw new BadRequestException('TAN ist erforderlich')
    }
    return this.fints.submitTan({
      syncRunId: id,
      tan: body.tan,
      companyId: body.companyId,
    })
  }

  /**
   * List recent sync runs for a connection.
   * Useful for "why is my sync still pending"
   * debugging — the user sees the last
   * 5-10 attempts and their outcomes.
   */
  @Get('connections/:id/sync-runs')
  @Require('reports.read')
  async listSyncRuns(
    @Param('id') id: string,
    @Query('companyId') companyId: string,
  ) {
    if (!companyId) {
      throw new BadRequestException('companyId is required')
    }
    return this.fints['prisma'].finTSSyncRun.findMany({
      where: { connectionId: id, companyId },
      orderBy: { startedAt: 'desc' },
      take: 20,
    })
  }

  /**
   * After a sync, run auto-match on the new
   * transactions. Returns the number of
   * high-confidence matches (>=80) and the
   * number of low-confidence suggestions.
   */
  @Post('auto-match')
  @Require('reports.read')
  async autoMatch(@Body() body: { companyId: string }) {
    if (!body?.companyId) {
      throw new BadRequestException('companyId is required')
    }
    return this.fints.autoMatchNewTransactions(body.companyId)
  }

  /**
   * Tier 6.5: Manual override of the
   * 4-hour auto-sync cron. Bypasses the
   * schedule so an admin can force a
   * pull after a long bank outage, or
   * to test the flow after disabling
   * the cron. Same pattern as
   * `POST /reminders/auto-run` in
   * Tier 2.
   */
  @Post('auto-run')
  @Require('company.update')
  async autoRun() {
    return this.scheduler.runAutoSync()
  }

  /**
   * Read-only: last auto-sync outcome
   * (timestamp + counts). For the admin
   * UI to show "Letzter Auto-Sync: vor
   * 12 min, 3 ok, 1 needs_tan".
   */
  @Get('last-auto-run')
  @Require('reports.read')
  async lastAutoRun() {
    return this.scheduler.getLastAutoRun()
  }

  // ========================================================================
  // Tier 10 — SEPA-Überweisung / Lastschrift
  // ========================================================================

  /**
   * Tier 10: Step 1 of the SEPA-Überweisung
   * flow. Persists the transfer and returns
   * either:
   *   - {status: 'needs_tan', tanChallenge,
   *     transferId} — the bank wants a TAN
   *     before the money moves.
   *   - {status: 'ok', transferId} — single-
   *     shot successful (lastschrift without
   *     SCA, rare).
   *   - {status: 'failed', errorCode,
   *     errorMessage, transferId} — bank
   *     rejected.
   *
   * Same shape as `startSync` for read syncs.
   * The IBAN is validated MOD-97 server-side
   * before persisting — the bank would reject
   * a bad IBAN anyway but the user-facing
   * error message from the bank is less
   * helpful.
   */
  @Post('transfers')
  @Require('reports.read')
  async createTransfer(@Body() body: CreateTransferDto) {
    if (!body?.companyId) {
      throw new BadRequestException('companyId is required')
    }
    if (!body?.connectionId) {
      throw new BadRequestException('connectionId is required')
    }
    if (!body?.kind || !['credit_transfer', 'direct_debit'].includes(body.kind)) {
      throw new BadRequestException('kind muss "credit_transfer" oder "direct_debit" sein')
    }
    if (!body?.creditorName || !body?.creditorIban || !body?.amount || !body?.endToEndId) {
      throw new BadRequestException(
        'creditorName, creditorIban, amount, endToEndId sind erforderlich',
      )
    }
    return this.fints.createTransfer({
      companyId: body.companyId,
      connectionId: body.connectionId,
      kind: body.kind,
      creditorName: body.creditorName,
      creditorIban: body.creditorIban,
      creditorBic: body.creditorBic,
      amount: body.amount,
      currency: body.currency,
      purpose: body.purpose,
      endToEndId: body.endToEndId,
      mandateId: body.mandateId,
      sequenceType: body.sequenceType,
    })
  }

  /**
   * Tier 10: Step 2 of the TAN flow.
   * Re-issues the HKCSE/HKCCS with the user's
   * TAN. In mock-mode any 6-digit TAN
   * succeeds; real-mode is currently stub'd
   * (no sandbox bank to test against).
   */
  @Post('transfers/:id/tan')
  @Require('reports.read')
  async submitTransferTan(
    @Param('id') id: string,
    @Body() body: SubmitTransferTanDto,
  ) {
    if (!body?.companyId) {
      throw new BadRequestException('companyId is required')
    }
    if (!body?.tan) {
      throw new BadRequestException('TAN ist erforderlich')
    }
    return this.fints.submitTransferTan({
      transferId: id,
      tan: body.tan,
      companyId: body.companyId,
    })
  }

  /**
   * Tier 10: List recent SEPA transfers.
   * UI uses this to render the history panel
   * (status badge, amount, counterparty).
   */
  @Get('transfers')
  @Require('reports.read')
  async listTransfers(
    @Query('companyId') companyId: string,
    @Query('connectionId') connectionId?: string,
    @Query('status') status?: string,
  ) {
    if (!companyId) {
      throw new BadRequestException('companyId is required')
    }
    return this.fints.listTransfers({
      companyId,
      connectionId,
      status,
      take: 50,
    })
  }
}
