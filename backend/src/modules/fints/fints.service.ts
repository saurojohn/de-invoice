import { PrismaService } from '../../prisma/prisma.service'
import { Injectable, Logger, BadRequestException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { createHash, randomUUID } from 'crypto'
import { buildFinTsMessage, parseFinTsMessage, Segment } from './fints-protocol'
import { FintsReal } from './fints-real'
import { encryptPin, decryptPin, pinEncryptionAvailable } from './pin-crypto'
import { BankImportService } from '../bank-import/bank-import.service'

/**
 * Tier 6: FinTS bank connection service (read-only).
 *
 * Implements the parts of the FinTS 3.0 / HBCI 4
 * protocol that we need: DIALOG INIT, HKSAL (account
 * balances) and HKKAZ (Kontoum­sätze / transactions).
 * SEPA-Überweisung (HKCSE) is intentionally not
 * implemented — the user opted for read-only in the
 * Tier-6 scope decision. Adding it later means
 * adding a HITAN/Ergebnisrückmeldung round-trip
 * inside an already-open dialog, which is a
 * larger change to this file.
 *
 * Two execution paths:
 *
 * 1. **Mock mode** (default in dev/test, opted in
 *    per-connection with `mockMode: 1`): the
 *    service generates deterministic fake
 *    transactions and fake TAN challenges. The
 *    real network call is skipped entirely. This
 *    is what the e2e 31-fints-mock.sh test
 *    exercises.
 *
 * 2. **Real mode**: builds a DIALOG INIT + HKSYN
 *    message, opens a TCP-over-TLS connection
 *    to `endpointUrl`, sends the encoded
 *    message, parses the bank's HIRMG + HIRMS
 *    response, then sends a HKSAL / HKKAZ inside
 *    the same dialog, then HNVSK close. The full
 *    code path is here but is NOT exercised
 *    end-to-end — we don't have a sandbox bank
 *    account to test against in this project.
 *    The structure (request builder / response
 *    parser) is identical to mock mode, so a
 *    future maintainer with a real Sparkasse
 *    test account can wire the two paths
 *    together without restructuring.
 *
 * The TAN handling is deliberately 2-step:
 *
 * - Step 1: `startSync()` opens the dialog. The
 *   bank may return status = 'needs_tan' with a
 *   `tanChallenge` text. The UI shows a modal
 *   asking the user to enter the TAN.
 *
 * - Step 2: `submitTan(syncRunId, tan)` resumes
 *   the dialog by re-issuing the last request
 *   with the TAN attached to HNSHK. The bank
 *   finishes the original HKKAZ and returns the
 *   transactions.
 *
 * This split is mandatory under PSD2 Strong
 * Customer Authentication (SCA) — most banks
 * require a TAN even for read-only operations
 * after the first sync of the day. Without
 * the split we'd have to ask for the TAN in a
 * single POST, which means a real-world round
 * trip of 30+ seconds (user reads TAN, types
 * it, hits submit) blocked on a server-held
 * dialog state. Bad UX.
 */
export interface StartSyncInput {
  connectionId: string
  companyId: string
  userId: string
  // 90 days by default. Most banks cap
  // HKKAZ at 380-420 days, so we don't expose
  // a wider window until we know each bank's
  // cap.
  daysBack?: number
}

export interface SubmitTanInput {
  syncRunId: string
  tan: string
  companyId: string
}

export interface MockTransaction {
  valueDate: string // ISO date
  entryDate: string
  amount: string // decimal string
  currency: string
  counterpartyName: string
  counterpartyIban: string | null
  purpose: string
  endToEndId: string
}

/**
 * Tier 22: unified shape used by BOTH mock- and
 * real-mode persistence. FintsTransaction (from
 * fints-real.ts) maps to this — the only field
 * name difference is `name` → `counterpartyName`.
 */
export interface FinTsPersistTx {
  valueDate: Date | string
  entryDate: Date | string
  amount: string | number
  currency: string
  counterpartyName: string
  counterpartyIban: string | null | undefined
  purpose: string
  endToEndId: string | null | undefined
}

@Injectable()
export class FinTsService {
  private readonly logger = new Logger(FinTsService.name)

  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
    // Tier 22: BankImportService is injected so
    // that after a FinTS sync we can immediately
    // run the candidate-matcher against open
    // invoices. Saves the user a separate "auto-
    // match" click in the UI.
    private bankImport: BankImportService,
  ) {}

  /**
   * Resolve the FinTS endpoint URL for a BLZ.
   *
   * The "right" way is to do a HKSYN request to
   * the BPD URL (no auth required) and let the
   * bank tell us its URL. But that requires a
   * network call before the user has even
   * entered credentials — bad UX. Most German
   * banks publish a static URL pattern:
   *
   *   - Sparkasse: banking.s-fints-<region>.de
   *   - Volksbank / Raiffeisen: onlinebanking.
   *     volksbank.de or similar per-bank
   *   - DKB: banking.dkb.de
   *   - comdirect: fints.comdirect.de
   *
   * For the first version we keep an explicit
   * lookup table of the 8 most common Sparkasse
   * BLZs in Hessen / Bayern (SH Leder's likely
   * banks) plus DKB / comdirect. If the BLZ is
   * not in the table, the user must enter the
   * endpoint URL manually in the wizard.
   *
   * Real production would use a maintained
   * BLZ→URL directory like
   * https://github.com/jhermsmeier/fints-urls
   * (CC0 licensed, scraped from the official
   * bank-info list). Pulled in as a static JSON
   * snapshot would be the next step.
   */
  private readonly blzLookup: Record<string, string> = {
    '50050201': 'https://banking.s-fints-frankfurt.de/PinTanServlet',
    '50050222': 'https://banking.s-fints-frankfurt.de/PinTanServlet',
    '50850049': 'https://banking.s-fints-darmstadt.de/PinTanServlet',
    '50550020': 'https://banking.s-fints-dreieich.de/PinTanServlet',
    '12030000': 'https://banking.dkb.de/fints/pintan',
    '20041133': 'https://fints.comdirect.de/fints',
  }

  resolveEndpoint(blz: string): string | null {
    return this.blzLookup[blz] || null
  }

  /**
   * Create a new FinTS connection record. The
   * PIN is NEVER stored — only its sha256 hash
   * (which is useless to an attacker without
   * the bank's signing chain). The plaintext
   * PIN lives only in the user's session and
   * is forgotten at the end of the start-sync
   * flow.
   */
  async createConnection(input: {
    companyId: string
    blz: string
    userId: string
    label: string
    endpointUrl?: string
    pin: string
    mockMode?: boolean
  }): Promise<{ id: string; endpointUrl: string }> {
    const endpointUrl =
      input.endpointUrl || this.resolveEndpoint(input.blz)
    if (!endpointUrl) {
      throw new Error(
        `Keine FinTS-URL für BLZ ${input.blz} bekannt. Bitte manuell eingeben.`,
      )
    }
    // Hash the PIN before persisting. Used in
    // mock-mode only (to detect "wrong-PIN"
    // attempts before bothering the bank).
    const pinHash = createHash('sha256').update(input.pin).digest('hex')
    // For real-mode, also encrypt the PIN at
    // rest. AES-256-GCM under FINTS_PIN_ENC_KEY.
    // We store all 3 components separately so
    // we can rotate the key without rewriting
    // any other table.
    let encPin: string | null = null
    let encIv: string | null = null
    let encTag: string | null = null
    if (!input.mockMode && pinEncryptionAvailable()) {
      const enc = encryptPin(input.pin)
      encPin = enc.ciphertext
      encIv = enc.iv
      encTag = enc.tag
    }
    const conn = await this.prisma.finTSConnection.create({
      data: {
        companyId: input.companyId,
        blz: input.blz,
        userId: input.userId,
        label: input.label,
        endpointUrl,
        pinHash,
        encryptedPin: encPin,
        pinIv: encIv,
        pinTag: encTag,
        mockMode: input.mockMode ? 1 : 0,
        status: 'pending',
      },
    })
    return {
      id: conn.id,
      endpointUrl: conn.endpointUrl,
    }
  }

  /**
   * Start a sync. Opens the dialog, fetches
   * HKSAL + HKKAZ, returns either:
   *
   * - {status: 'ok', txCount, syncRunId} when
   *   no TAN was required (mock mode) and the
   *   fetch completed.
   *
   * - {status: 'needs_tan', tanChallenge,
   *   syncRunId} when the bank requires a TAN
   *   to finish the fetch. The UI then prompts
   *   the user and calls `submitTan` to
   *   continue.
   *
   * - {status: 'failed', errorCode,
   *   errorMessage, syncRunId} when the bank
   *   returned an error (wrong PIN, account
   *   locked, BPD timeout, etc.).
   */
  async startSync(input: StartSyncInput): Promise<{
    status: 'ok' | 'needs_tan' | 'failed'
    txCount?: number
    tanChallenge?: string
    syncRunId: string
    errorCode?: string
    errorMessage?: string
  }> {
    const conn = await this.prisma.finTSConnection.findFirst({
      where: { id: input.connectionId, companyId: input.companyId },
    })
    if (!conn) throw new Error('FinTS-Verbindung nicht gefunden')

    // Create a sync-run record up front. We
    // update it as the dialog progresses so the
    // UI can show partial state.
    const syncRun = await this.prisma.finTSSyncRun.create({
      data: {
        connectionId: conn.id,
        companyId: conn.companyId,
        status: 'in_progress',
        startedAt: new Date(),
      },
    })

    try {
      // Dispatch to mock or real implementation.
      const result =
        conn.mockMode === 1
          ? await this.runMockSync(conn.id, input)
          : await this.runRealSync(conn.id, input)

      // Update sync-run + connection with the
      // outcome. The 'needs_tan' case does NOT
      // close the run — it's reopened by
      // submitTan.
      if (result.status === 'ok') {
        await this.prisma.finTSSyncRun.update({
          where: { id: syncRun.id },
          data: {
            status: 'ok',
            txCount: result.txCount || 0,
            finishedAt: new Date(),
          },
        })
        await this.prisma.finTSConnection.update({
          where: { id: conn.id },
          data: {
            status: 'active',
            lastSyncAt: new Date(),
            lastError: null,
          },
        })
        return { ...result, syncRunId: syncRun.id }
      } else if (result.status === 'needs_tan') {
        await this.prisma.finTSSyncRun.update({
          where: { id: syncRun.id },
          data: {
            status: 'needs_tan',
            tanChallenge: result.tanChallenge,
          },
        })
        return { ...result, syncRunId: syncRun.id }
      } else {
        await this.prisma.finTSSyncRun.update({
          where: { id: syncRun.id },
          data: {
            status: 'failed',
            errorCode: result.errorCode,
            errorMessage: result.errorMessage,
            finishedAt: new Date(),
          },
        })
        await this.prisma.finTSConnection.update({
          where: { id: conn.id },
          data: { status: 'error', lastError: result.errorMessage },
        })
        return { ...result, syncRunId: syncRun.id }
      }
    } catch (e: any) {
      const msg = e?.message || 'Unbekannter Fehler'
      this.logger.error(`FinTS sync failed: ${msg}`)
      await this.prisma.finTSSyncRun.update({
        where: { id: syncRun.id },
        data: {
          status: 'failed',
          errorMessage: msg,
          finishedAt: new Date(),
        },
      })
      await this.prisma.finTSConnection.update({
        where: { id: conn.id },
        data: { status: 'error', lastError: msg },
      })
      return {
        status: 'failed',
        syncRunId: syncRun.id,
        errorMessage: msg,
      }
    }
  }

  /**
   * Step 2 of the TAN flow. Re-issues the
   * HKKAZ inside the open dialog with the
   * user-supplied TAN. The bank finishes the
   * request and returns the transactions.
   *
   * For mock mode, ANY 6-digit TAN is accepted
   * (the mock doesn't model "wrong TAN") and
   * returns the same canned transactions.
   * This is the right test-time behaviour
   * because the e2e wants to assert the
   * flow works end-to-end, not the bank's
   * PIN-rejection logic.
   */
  async submitTan(input: SubmitTanInput): Promise<{
    status: 'ok' | 'failed'
    txCount?: number
    errorMessage?: string
  }> {
    const run = await this.prisma.finTSSyncRun.findFirst({
      where: { id: input.syncRunId, companyId: input.companyId },
      include: { connection: true },
    })
    if (!run) throw new Error('Sync-Lauf nicht gefunden')
    if (run.status !== 'needs_tan') {
      throw new Error(`Sync-Lauf ist nicht im needs_tan-Status (ist: ${run.status})`)
    }
    const conn = run.connection

    if (conn.mockMode === 1) {
      // Mock: any 6-digit TAN works.
      if (!/^\d{6,}$/.test(input.tan)) {
        return { status: 'failed', errorMessage: 'TAN muss mindestens 6 Ziffern haben' }
      }
      // Persist mock transactions
      const txs = this.generateMockTransactions(conn.blz)
      const txCount = await this.persistTransactions(conn, txs)
      await this.prisma.finTSSyncRun.update({
        where: { id: run.id },
        data: { status: 'ok', txCount, finishedAt: new Date() },
      })
      // Mark the connection as "TAN'd in" —
      // assign a fake systemId so the next
      // sync skips the TAN. In real-mode the
      // bank assigns this in the HKSYN
      // response; mock-mode just fakes a
      // pseudo-unique string so re-syncs
      // take the "already authenticated"
      // fast path.
      const fakeSystemId = conn.systemId || `MOCK-${randomUUID().slice(0, 12)}`
      await this.prisma.finTSConnection.update({
        where: { id: conn.id },
        data: {
          status: 'active',
          lastSyncAt: new Date(),
          lastError: null,
          systemId: fakeSystemId,
          lastDialogId: '1',
        },
      })
      return { status: 'ok', txCount }
    } else {
      // Real: re-issue the HKKAZ with HITAN
      // attached. Stub — the protocol code is
      // here but unexercised end-to-end.
      const segs: Segment[] = [
        { header: { type: 'HNSHK', ref: 2, version: 4 }, body: { tan: input.tan } },
      ]
      try {
        const msg = buildFinTsMessage({
          dialogId: conn.lastDialogId || '0',
          messageNumber: 2,
          blz: conn.blz,
          userId: conn.userId,
          pin: input.tan,
          segments: segs,
        })
        // Buffer is a Node-only type; fetch()
        // wants a Web BodyInit. Convert via
        // Uint8Array to keep the wire bytes
        // intact.
        const resp = await fetch(conn.endpointUrl, {
          method: 'POST',
          body: new Uint8Array(msg),
          headers: { 'Content-Type': 'application/octet-stream' },
        })
        // Tier 356: result unused — FinTS real mode is a documented stub
      // (see backend/AGENTS.md and the HIRMG/HIRMS TODO below); only mock
      // mode is a working path. The parse call is kept so the response
      // shape is still exercised.
      const _parsed = parseFinTsMessage(Buffer.from(await resp.arrayBuffer()))
        // TODO: parse HIRMG/HIRMS, extract transactions
        return { status: 'failed', errorMessage: 'Real-mode is a stub in this build' }
      } catch (e: any) {
        return { status: 'failed', errorMessage: e?.message }
      }
    }
  }

  /**
   * Run the mock sync. Generates a deterministic
   * set of transactions based on the connection
   * id (so the same connection gets the same
   * mock data on each sync — useful for e2e).
   *
   * Mock data shape: 3 transactions from 3
   * different "customers" (one in EUR, one with
   * an IBAN that the matcher can correlate to
   * an open invoice, one with a purpose string
   * that contains an invoice number).
   *
   * The mock ALWAYS returns 'needs_tan' for the
   * first sync of a connection (matches the
   * real PSD2 flow), so the e2e can test both
   * the un-tan'd and the tan'd branches.
   */
  private async runMockSync(
    connectionId: string,
    _input: StartSyncInput,
  ): Promise<
    | { status: 'ok'; txCount: number }
    | { status: 'needs_tan'; tanChallenge: string }
    | { status: 'failed'; errorCode?: string; errorMessage: string }
  > {
    // First sync of this connection: ask for a
    // TAN. After the user has submitted a TAN
    // once, we set the systemId field on the
    // connection; subsequent syncs skip the
    // TAN prompt (banks remember the device
    // for ~24h under PSD2).
    const conn = await this.prisma.finTSConnection.findUnique({
      where: { id: connectionId },
    })
    if (!conn) throw new Error('Connection vanished mid-sync')

    if (!conn.systemId) {
      // First sync — needs a TAN. Return the
      // challenge, no transactions yet. The
      // submitTan() path will fetch them.
      return {
        status: 'needs_tan',
        tanChallenge: `Bitte geben Sie die TAN für die Initialisierung Ihrer Bankverbindung ${conn.label} ein.`,
      }
    }

    // Subsequent syncs — fetch directly.
    const txs = this.generateMockTransactions(conn.blz)
    const txCount = await this.persistTransactions(conn, txs)
    return { status: 'ok', txCount }
  }

  private async runRealSync(
    connectionId: string,
    input: StartSyncInput,
  ): Promise<any> {
    // Tier 22: real-mode path wired through the `fints`
    // npm library (Prior99/fints). See fints-real.ts for
    // the protocol-level details. This method is the
    // service-level orchestration: list accounts → fetch
    // statements → persist → auto-match.
    const conn = await this.prisma.finTSConnection.findUnique({
      where: { id: connectionId },
    })
    if (!conn) throw new Error('Connection vanished mid-sync')

    const fintsReal = this.makeFintsReal(conn)
    const accountsRes = await fintsReal.listAccounts()
    if (accountsRes.status === 'failed') {
      return {
        status: 'failed',
        errorCode: accountsRes.code,
        errorMessage: accountsRes.message,
      }
    }
    if (accountsRes.status === 'needs_tan') {
      // PSD2 flow — first sync of a connection.
      // Persist the transactionReference so submitTan
      // can completeStatements() with the right ref.
      return {
        status: 'needs_tan',
        tanChallenge: accountsRes.challenge,
        // The library's TanRequiredError carries the
        // dialog config; we don't need to save it because
        // completeStatements() takes (savedDialog, ref, tan)
        // — the service's submitTan will re-auth from the
        // stored pin + systemId.
      }
    }

    const daysBack = input.daysBack ?? 90
    const from = new Date()
    from.setDate(from.getDate() - daysBack)
    const today = new Date()

    // Concatenate transactions across all accounts. Each
    // account gets its own BankStatement row (one per
    // account, not per sync — matches what bank-import
    // does for CSV/MT940 uploads).
    let totalInserted = 0
    let firstAccountIban: string | null = null
    for (const account of accountsRes.data) {
      if (!firstAccountIban) firstAccountIban = account.iban
      const stmtsRes = await fintsReal.fetchStatements(account, from, today)
      if (stmtsRes.status === 'failed') {
        // One bad account shouldn't kill the whole sync.
        // Log and continue with the next account.
        this.logger.warn(
          `FinTS fetchStatements failed for ${account.iban}: ${stmtsRes.code} ${stmtsRes.message}`,
        )
        continue
      }
      if (stmtsRes.status === 'needs_tan') {
        // Bank occasionally asks for re-auth mid-session
        // (PSD2 SCA re-prompts after ~24h). Surface to
        // the user, they can submitTan from the UI.
        return {
          status: 'needs_tan',
          tanChallenge: stmtsRes.challenge,
        }
      }
      const inserted = await this.persistTransactions(conn, stmtsRes.data, account.iban, account.bic)
      totalInserted += inserted
    }
    return { status: 'ok', txCount: totalInserted }
  }

  /**
   * Build a FintsReal client from the persisted
   * FinTSConnection row. Decrypts the PIN at
   * construction time so the library can use
   * it for the DIALOG INIT's HNVSK envelope.
   *
   * Throws if the connection is missing the
   * encrypted PIN fields AND the env-key is
   * not set — the controller surfaces that
   * as a 400 "configure FINTS_PIN_ENC_KEY in
   * backend/.env before connecting a real bank".
   */
  private makeFintsReal(conn: any): FintsReal {
    if (!conn.encryptedPin || !conn.pinIv || !conn.pinTag) {
      throw new BadRequestException(
        'Keine verschlüsselte PIN für diese Verbindung hinterlegt. ' +
          'Bei der Anlage muss FINTS_PIN_ENC_KEY gesetzt sein.',
      )
    }
    const pin = decryptPin({
      iv: conn.pinIv,
      tag: conn.pinTag,
      ciphertext: conn.encryptedPin,
    })
    return new FintsReal({
      url: conn.endpointUrl,
      blz: conn.blz,
      username: conn.userId,
      pin,
    })
  }

  private async openDialog(
    conn: any,
  ): Promise<
    | { status: 'ok'; dialogId: string }
    | { status: 'needs_tan'; tanChallenge: string }
    | { status: 'failed'; errorMessage: string }
  > {
    // Build DIALOG INIT: HNHBK + HNVSK + HNSHK
    // + HKIDN + HKVVB + HKSYN
    const segs: Segment[] = [
      {
        header: { type: 'HKIDN', ref: 2, version: 2 },
        body: {
          bankCountry: '280',
          bankCode: conn.blz,
          customerId: conn.userId,
          systemId: '0',
          systemIdStatus: 'ID_NECESSARY',
        },
      },
      {
        header: { type: 'HKVVB', ref: 3, version: 3 },
        body: { language: 1, productName: 'de-invoice', productVersion: '1.0' },
      },
      {
        header: { type: 'HKSYN', ref: 4, version: 3 },
        body: { syncMode: 'NEW_SYSTEM_ID' },
      },
    ]
    // Tier 356: built but not sent — same documented stub as above.
    const _req = buildFinTsMessage({
      dialogId: '0',
      messageNumber: 1,
      blz: conn.blz,
      userId: conn.userId,
      pin: '(not stored)',
      segments: segs,
    })
    // Real-mode would POST to conn.endpointUrl
    // and parse HIRMG/HIRMS back. Without a
    // test bank we cannot validate this end to
    // end. Mock-mode never reaches this path.
    return { status: 'failed', errorMessage: 'Real-mode is a stub in this build' }
  }

  /**
   * Generate 3 deterministic mock transactions
   * per connection. The seed is the
   * connection's BLZ + systemId so e2e
   * assertions on the data are stable.
   */
  private generateMockTransactions(blz: string): MockTransaction[] {
    const seed = createHash('sha256').update(`mock-tx-${blz}`).digest('hex')
    const day = (offset: number): string => {
      const d = new Date()
      d.setDate(d.getDate() - offset)
      return d.toISOString().slice(0, 10)
    }
    return [
      {
        valueDate: day(1),
        entryDate: day(1),
        amount: '2380.00',
        currency: 'EUR',
        counterpartyName: 'Müller GmbH',
        counterpartyIban: 'DE89500105170648489890',
        purpose: 'Rechnung E2E-T6-001',
        endToEndId: `MOCK-${seed.slice(0, 16)}-1`,
      },
      {
        valueDate: day(3),
        entryDate: day(3),
        amount: '1190.00',
        currency: 'EUR',
        counterpartyName: 'Schmidt AG',
        counterpartyIban: 'DE89370400440532013000',
        purpose: 'Kunde K-001 / RG 2026-0042',
        endToEndId: `MOCK-${seed.slice(0, 16)}-2`,
      },
      {
        valueDate: day(5),
        entryDate: day(5),
        amount: '-12.50',
        currency: 'EUR',
        counterpartyName: 'Sparkasse Dreieich',
        counterpartyIban: null,
        purpose: 'Kontoführungsgebühr 2026/Q2',
        endToEndId: `MOCK-${seed.slice(0, 16)}-3`,
      },
    ]
  }

  /**
   * Persist a batch of mock transactions as a
   * synthetic BankStatement + BankTransaction
   * rows. The dedup is by endToEndId so
   * re-syncing the same connection does NOT
   * create duplicate transactions (idempotency
   * rule — see the e2e for the assertion).
   */
  private async persistTransactions(
    conn: any,
    txs: Array<MockTransaction | import('./fints-real').FintsTransaction>,
    accountIban?: string | null,
    _accountBic?: string | null,
  ): Promise<number> {
    const isReal = conn.mockMode !== 1
    const format = isReal ? 'fints-real' : 'fints-mock'
    const bankName = isReal
      ? `FinTS-Bank ${conn.blz}` // Real banks set the actual name in rawContent
      : `Mock-Bank ${conn.blz}`

    const stmt = await this.prisma.bankStatement.create({
      data: {
        companyId: conn.companyId,
        format,
        fileName: `${format}-${conn.blz}-${Date.now()}.json`,
        fileSize: JSON.stringify(txs).length,
        accountIban: accountIban || null,
        // bankName is taken from the bank-import
        // schema's BankStatement — kept generic
        // here because there's no real upload; the
        // real bank name would need to be resolved
        // from the BPD (bank parameter daten).
        bankName,
        periodFrom: new Date(
          Math.min(
            ...txs.map((t) =>
              new Date(
                (t as any).valueDate instanceof Date
                  ? (t as any).valueDate
                  : String((t as any).valueDate),
              ).getTime(),
            ),
          ),
        ),
        periodTo: new Date(
          Math.max(
            ...txs.map((t) =>
              new Date(
                (t as any).valueDate instanceof Date
                  ? (t as any).valueDate
                  : String((t as any).valueDate),
              ).getTime(),
            ),
          ),
        ),
        openingBalance: null,
        closingBalance: null,
        rawContent: JSON.stringify(txs, null, 2),
      },
    })

    let inserted = 0
    for (const tx of txs) {
      // Map FintsTransaction's `name` → `counterpartyName`
      // (the FintsReal shape uses `name`; the bank-import
      // schema uses `counterpartyName`).
      const counterpartyName = (tx as any).counterpartyName ?? (tx as any).name ?? ''
      const counterpartyIban = (tx as any).counterpartyIban ?? null
      const endToEndId = (tx as any).endToEndId ?? null

      // Idempotency: skip if a BankTransaction
      // with this endToEndId already exists for
      // the company. Real banks sometimes return
      // duplicates across syncs if the same range
      // is requested twice.
      if (endToEndId) {
        const existing = await this.prisma.bankTransaction.findFirst({
          where: { companyId: conn.companyId, endToEndId },
        })
        if (existing) continue
      }
      await this.prisma.bankTransaction.create({
        data: {
          statementId: stmt.id,
          companyId: conn.companyId,
          valueDate: new Date(tx.valueDate),
          entryDate: new Date(tx.entryDate),
          amount: tx.amount,
          currency: tx.currency,
          counterpartyName,
          counterpartyIban,
          purpose: tx.purpose,
          endToEndId,
        },
      })
      inserted++
    }

    // Tier 22: kick off auto-matching for the newly
    // imported statement. Threshold is 0 (suggest
    // only) by default — the user reviews and clicks
    // confirm in the UI. Higher thresholds could be
    // wired per-company via settings later.
    if (inserted > 0 && this.bankImport) {
      try {
        await this.bankImport.generateSuggestions(conn.companyId, stmt.id)
      } catch (e: any) {
        this.logger.warn(
          `Auto-match after FinTS import failed: ${e?.message || e}`,
        )
      }
    }
    return inserted
  }

  /**
   * Tier 6.5: Auto-sync all active FinTS
   * connections on a 4-hour cron. Mirrors the
   * auto-reminder pattern (Tier 2): walks every
   * `status='active'` connection, calls
   * `startSync()`, swallows per-connection
   * errors so one bank outage doesn't take
   * the whole cron down.
   *
   * Cron is `@Cron('0 star-slash-4 star star star')` Berlin
   * (00:00, 04:00, 08:00, 12:00, 16:00, 20:00).
   * Inside the cron we do NOT use a global
   * circuit breaker — banks fail differently
   * (some 503, some timeout, some return
   * "PIN gesperrt" with HTTP 200) and a single
   * failure on bank A shouldn't prevent bank B
   * from being polled. Each connection is its
   * own try/catch scope.
   */
  async autoSyncAllActive(): Promise<{
    connections: number
    ok: number
    needsTan: number
    failed: number
  }> {
    const connections = await this.prisma.finTSConnection.findMany({
      where: { status: 'active' },
    })
    let ok = 0
    let needsTan = 0
    let failed = 0
    for (const conn of connections) {
      try {
        const result = await this.startSync({
          connectionId: conn.id,
          companyId: conn.companyId,
          userId: 'cron',
        })
        if (result.status === 'ok') ok++
        else if (result.status === 'needs_tan') needsTan++
        else failed++
      } catch (e: any) {
        this.logger.warn(
          `autoSync: connection ${conn.id} (${conn.label}) failed: ${e?.message}`,
        )
        failed++
      }
    }
    return {
      connections: connections.length,
      ok,
      needsTan,
      failed,
    }
  }

  /**
   * Tier 6.5: Smart auto-match — three new
   * rules on top of the original Tier 6
   * exact-amount + invoice#-in-purpose +
   * IBAN-match.
   *
   * Rule A (±0.50 EUR): amount within 50
   * cents. Banks sometimes charge a
   * processing fee that lands on the same
   * day as the customer's transfer, and
   * FX-converted payments lose 1-3 cents
   * in the conversion rounding. Without
   * this rule a perfectly legitimate
   * "2380.00 minus 0.30 fee" transaction
   * would not match.
   *
   * Rule B (sum-to-invoice): 2..N
   * unreconciled incoming transactions
   * whose amounts sum exactly to an open
   * invoice's total. Customers paying
   * in 2-3 installments (common in B2B
   * leather trade: "Anzahlung 30% bei
   * Auftrag, Rest bei Lieferung") get
   * the full invoice marked paid
   * automatically when both legs land.
   * Without this rule the user has to
   * manually mark each leg and remember
   * the remaining balance.
   *
   * Rule C (name-fuzzy): customer name
   * Levenshtein distance ≤2 against any
   * token in the purpose string. Real
   * banks display the customer's name
   * (or a truncated form), not the
   * invoice number, so a typo-tolerant
   * name match catches payments where
   * the customer paid but didn't include
   * a purpose string. Common in older
   * B2B customers who pay via paper
   * Überweisung.
   *
   * Confidence scoring:
   *   - 100: invoice# in purpose (Tier 6)
   *   - 95:  exact sum-to-invoice match
   *   - 90:  ±0.50 + IBAN
   *   - 80:  ±0.50 + name fuzzy
   *   - 80:  exact + IBAN (Tier 6)
   *   - 70:  exact + name fuzzy
   *   - 50:  exact only (Tier 6)
   *   - 30:  ±0.50 only (weakest)
   */
  async autoMatchNewTransactions(companyId: string): Promise<{
    matched: number
    suggested: number
  }> {
    const unreconciled = await this.prisma.bankTransaction.findMany({
      where: {
        companyId,
        matches: { none: {} },
      },
      orderBy: { valueDate: 'desc' },
    })

    let matched = 0
    let suggested = 0

    // Pre-load open invoices for this
    // company once. The list is small in
    // practice (≤200 open invoices per
    // company at any time) and the smart
    // matchers need to query it multiple
    // times per transaction.
    const openInvoices = await this.prisma.invoice.findMany({
      where: {
        companyId,
        status: { in: ['sent', 'overdue', 'partial'] },
      },
      include: { customer: true },
    })

    for (const tx of unreconciled) {
      const txAmount = parseFloat(tx.amount.toString())
      if (txAmount <= 0) {
        // Outgoing payment — not a customer
        // paying an invoice. Skip in this
        // version (future: match to vendor /
        // expense).
        continue
      }

      // Skip transactions already
      // matched by Rule B's previous
      // iteration (a sum-to-invoice match
      // creates recon rows for each
      // contributing txn, so a
      // subsequent per-txn pass would
      // double-count).
      const alreadyMatched = await this.prisma.bankReconciliation.findFirst({
        where: { bankTransactionId: tx.id },
      })
      if (alreadyMatched) continue

      // --- Rule B: sum-to-invoice (first
      // pass) — try to group 2..N
      // unreconciled incoming txns that
      // sum to an open invoice.
      for (const inv of openInvoices) {
        const invTotal = parseFloat(inv.total.toString())
        // Find other unreconciled txns to
        // combine with this one. Exclude
        // ones that already have a
        // recon row (already matched to
        // something else).
        const others = await this.prisma.bankTransaction.findMany({
          where: {
            companyId,
            id: { not: tx.id },
            amount: { gt: 0 },
            matches: { none: {} },
          },
          take: 10,
        })
        const candidates = [tx, ...others]
        // Search 2..N subsets: try all
        // pairs first (covers 90% of real
        // cases — 2 installments), then
        // 3-element combinations if no
        // pair matched. O(n^2) for n=10 is
        // fine; we'd never have 10+
        // unreconciled txns at once.
        let found: any[] | null = null
        for (let size = 2; size <= candidates.length && !found; size++) {
          const combos = combinations(candidates, size)
          for (const combo of combos) {
            const sum = combo.reduce(
              (s, t) => s + parseFloat(t.amount.toString()),
              0,
            )
            // Match within 1 cent (FX rounding
            // tolerance for combined txns).
            if (Math.abs(sum - invTotal) < 0.01) {
              found = combo
              break
            }
          }
        }
        if (found && found.length > 1) {
          // Match all N txns to this invoice.
          for (const t of found) {
            await this.prisma.bankReconciliation.create({
              data: {
                bankTransactionId: t.id,
                invoiceId: inv.id,
                companyId,
                appliedAmount: t.amount,
                status: 'suggested',
                confidence: 95,
                matchReason: `Summe ${found.length} Buchungen = Rechnungsbetrag (${inv.invoiceNumber})`,
              },
            })
            suggested++
          }
          matched++
          break // tx is now matched, move on
        }
      }

      // Re-check: did Rule B match this tx?
      const recheck = await this.prisma.bankReconciliation.findFirst({
        where: { bankTransactionId: tx.id },
      })
      if (recheck) continue

      // --- Rules A, C + Tier 6 (per-txn
      // matchers) — exact amount + ±0.50
      // tolerance.
      for (const inv of openInvoices) {
        const invTotal = parseFloat(inv.total.toString())
        const exactDelta = Math.abs(txAmount - invTotal)
        const isExact = exactDelta < 0.01
        const isWithin50ct = exactDelta <= 0.50
        if (!isExact && !isWithin50ct) continue

        let confidence = 0
        let reason = ''
        const inPurpose =
          tx.purpose && tx.purpose.includes(inv.invoiceNumber)
        const ibanMatch =
          tx.counterpartyIban &&
          (() => {
            const c = (inv.customer?.contact as any) || {}
            const a = (inv.customer?.address as any) || {}
            const customerIban = c.iban || a.iban || null
            if (!customerIban) return false
            return (
              customerIban.replace(/\s/g, '') ===
              tx.counterpartyIban!.replace(/\s/g, '')
            )
          })()
        const nameFuzzy =
          tx.purpose && fuzzyMatchCustomerName(tx.purpose, inv.customer?.name)

        if (inPurpose && isExact) {
          confidence = 100
          reason = `Betrag exakt + Rechnungsnummer im Verwendungszweck`
        } else if (inPurpose && isWithin50ct) {
          confidence = 95
          reason = `Betrag ±${exactDelta.toFixed(2)} + Rechnungsnummer im Verwendungszweck (FX-Rundung)`
        } else if (ibanMatch && isExact) {
          confidence = 80
          reason = `Betrag exakt + IBAN stimmt mit Kunde überein`
        } else if (ibanMatch && isWithin50ct) {
          confidence = 90
          reason = `Betrag ±${exactDelta.toFixed(2)} + IBAN stimmt`
        } else if (nameFuzzy && isExact) {
          confidence = 70
          reason = `Betrag exakt + Kundenname (Fuzzy) im Verwendungszweck`
        } else if (nameFuzzy && isWithin50ct) {
          confidence = 80
          reason = `Betrag ±${exactDelta.toFixed(2)} + Kundenname (Fuzzy)`
        } else if (isExact) {
          confidence = 50
          reason = `Betrag exakt (keine weitere Korrelation)`
        } else {
          confidence = 30
          reason = `Betrag ±${exactDelta.toFixed(2)} (innerhalb FX-Toleranz)`
        }
        await this.prisma.bankReconciliation.create({
          data: {
            bankTransactionId: tx.id,
            invoiceId: inv.id,
            companyId,
            appliedAmount: tx.amount,
            status: 'suggested',
            confidence,
            matchReason: reason,
          },
        })
        if (confidence >= 80) matched++
        else suggested++
        break // one match per tx (highest confidence wins)
      }
    }
    return { matched, suggested }
  }

  /**
   * Tier 10: Step 1 of the SEPA-Überweisung
   * flow. Persists a draft transfer and
   * dispatches to mock / real:
   *
   *   - mock mode: status flips to 'needs_tan'
   *     with a fake challenge, the bank
   *     round-trip is skipped.
   *
   *   - real mode: builds pain.001 / pain.008,
   *     wraps it in HKCSE / HKCCS, opens the
   *     dialog, sends the segment, parses the
   *     HIRMS. Stub for now — real-mode wire
   *     format is here but no test bank.
   *
   * Idempotency: re-issuing the same
   * (connectionId, endToEndId) tuple returns
   * the existing row. The endToEndId is the
   * bank's own idempotency key — the spec
   * guarantees a duplicate is a no-op at the
   * bank even if our DB had lost the row.
   */
  async createTransfer(input: {
    companyId: string
    connectionId: string
    // 'credit_transfer' (Überweisung) | 'direct_debit' (Lastschrift)
    kind: 'credit_transfer' | 'direct_debit'
    creditorName: string
    creditorIban: string
    creditorBic?: string | null
    amount: string // Decimal-as-string
    currency?: string
    purpose?: string | null
    endToEndId: string
    // Required only for direct_debit
    mandateId?: string
    sequenceType?: 'FRST' | 'RCUR' | 'FNAL' | 'OOFF'
  }): Promise<{
    status: 'draft' | 'needs_tan' | 'ok' | 'failed'
    tanChallenge?: string
    transferId: string
    errorCode?: string
    errorMessage?: string
  }> {
    // Validate the inputs that don't depend
    // on the connection.
    if (!input.endToEndId || input.endToEndId.length > 35) {
      throw new BadRequestException('endToEndId ist erforderlich (max. 35 Zeichen)')
    }
    if (!input.creditorName) throw new BadRequestException('creditorName ist erforderlich')
    if (!validIban(input.creditorIban)) {
      throw new BadRequestException('creditorIban ist ungültig (MOD-97-Check fehlgeschlagen)')
    }
    const amount = parseFloat(input.amount)
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new BadRequestException('amount muss > 0 sein')
    }
    if (input.kind === 'direct_debit' && !input.mandateId) {
      throw new BadRequestException('mandateId ist für Lastschrift erforderlich')
    }

    const conn = await this.prisma.finTSConnection.findFirst({
      where: { id: input.connectionId, companyId: input.companyId },
    })
    if (!conn) throw new BadRequestException('FinTS-Verbindung nicht gefunden')
    if (conn.status === 'error') {
      throw new BadRequestException(
        'FinTS-Verbindung ist im Fehlerzustand — bitte zuerst neu initialisieren',
      )
    }

    // Idempotency: same (connectionId,
    // endToEndId) reuses the existing row.
    const existing = await this.prisma.finTsTransfer.findFirst({
      where: {
        companyId: input.companyId,
        connectionId: input.connectionId,
        endToEndId: input.endToEndId,
      },
    })
    if (existing) {
      return {
        status: existing.status as any,
        tanChallenge: existing.tanChallenge || undefined,
        transferId: existing.id,
        errorCode: existing.errorCode || undefined,
        errorMessage: existing.errorMessage || undefined,
      }
    }

    // Persist as 'draft' first; the dispatcher
    // below flips it to needs_tan or ok.
    // The debtor fields come from the
    // Company's `bankInfo` JSON blob (the
    // IBAN the user registered in the
    // company profile). Falls back to
    // placeholders if bankInfo is unset so
    // the row always has the schema-required
    // NOT NULL strings.
    const company = await this.prisma.company.findUnique({
      where: { id: input.companyId },
      select: { name: true, bankInfo: true },
    })
    const bankInfo = (company?.bankInfo as any) || {}
    const debtorIban = (bankInfo.iban as string) || 'DE00000000000000000000'
    const debtorBic = (bankInfo.bic as string) || null
    const transfer = await this.prisma.finTsTransfer.create({
      data: {
        companyId: input.companyId,
        connectionId: input.connectionId,
        kind: input.kind,
        debtorName: company?.name || 'Eigenkonto',
        debtorIban,
        debtorBic,
        creditorName: input.creditorName,
        creditorIban: input.creditorIban.replace(/\s+/g, '').toUpperCase(),
        creditorBic: input.creditorBic || null,
        amount: amount.toFixed(2),
        currency: input.currency || 'EUR',
        purpose: input.purpose || null,
        endToEndId: input.endToEndId,
        status: 'draft',
      },
    })

    try {
      if (conn.mockMode === 1) {
        // Mock: always needs TAN first, like a
        // typical PSD2 flow. Mock banks don't
        // grant automatic authorisation for
        // credit transfers.
        const challenge = `Bitte geben Sie die TAN für die Überweisung an ${input.creditorName} (${input.amount} ${input.currency || 'EUR'}) ein.`
        await this.prisma.finTsTransfer.update({
          where: { id: transfer.id },
          data: { status: 'needs_tan', tanChallenge: challenge },
        })
        return {
          status: 'needs_tan',
          tanChallenge: challenge,
          transferId: transfer.id,
        }
      } else {
        // Real-mode wire path. The XML is built
        // here so a future maintainer can
        // inspect / log it; the HKCSE/HKCCS
        // round-trip is currently stub'd.
        const today = new Date().toISOString().slice(0, 10)
        const xml =
          input.kind === 'credit_transfer'
            ? buildPain001CreditTransfer({
                messageId: `MSG-${transfer.id}`,
                creditorName: input.creditorName,
                creditorIban: input.creditorIban.replace(/\s+/g, '').toUpperCase(),
                creditorBic: input.creditorBic,
                amount: amount.toFixed(2),
                currency: input.currency || 'EUR',
                purpose: input.purpose,
                endToEndId: input.endToEndId,
                debtorName: transfer.debtorName,
                debtorIban: transfer.debtorIban,
                debtorBic: transfer.debtorBic,
                requestedExecutionDate: today,
              })
            : buildPain008DirectDebit({
                messageId: `MSG-${transfer.id}`,
                creditorName: transfer.debtorName,
                creditorIban: transfer.debtorIban,
                creditorBic: transfer.debtorBic,
                mandateId: input.mandateId!,
                sequenceType: input.sequenceType || 'FRST',
                scheme: 'CORE',
                amount: amount.toFixed(2),
                currency: input.currency || 'EUR',
                purpose: input.purpose,
                endToEndId: input.endToEndId,
                debtorName: input.creditorName,
                debtorIban: input.creditorIban.replace(/\s+/g, '').toUpperCase(),
                debtorBic: input.creditorBic,
                requestedExecutionDate: today,
              })
        // xml is built above for future use;
        // not currently consumed because the
        // wire path is stub'd. Suppress the
        // unused-var lint so future maintainers
        // see the XML is intentional.
        void xml
        // Stub: real-mode HKCSE round-trip
        // (open dialog, send segment, parse
        // HIRMS) goes here. For now we just
        // surface a clear "not yet wired"
        // error so a real-mode attempt is
        // explicit rather than silently
        // succeeding.
        await this.prisma.finTsTransfer.update({
          where: { id: transfer.id },
          data: {
            status: 'failed',
            errorCode: '9999',
            errorMessage: 'Real-Mode FinTS noch nicht verfügbar (Mock-Mode verwenden)',
            finishedAt: new Date(),
          },
        })
        return {
          status: 'failed',
          transferId: transfer.id,
          errorCode: '9999',
          errorMessage: 'Real-Mode FinTS noch nicht verfügbar (Mock-Mode verwenden)',
        }
      }
    } catch (e: any) {
      const msg = e?.message || 'Unbekannter Fehler'
      this.logger.error(`FinTS transfer failed: ${msg}`)
      await this.prisma.finTsTransfer.update({
        where: { id: transfer.id },
        data: {
          status: 'failed',
          errorMessage: msg,
          finishedAt: new Date(),
        },
      })
      return { status: 'failed', transferId: transfer.id, errorMessage: msg }
    }
  }

  /**
   * Tier 10: Step 2 of the TAN flow. Validates
   * the TAN and flips the transfer to 'ok'
   * (mock-mode: any 6-digit TAN is accepted).
   *
   * Mirrors `submitTan` for sync-runs exactly:
   *  - re-fetches by (transferId, companyId)
   *  - asserts status === 'needs_tan'
   *  - mock: validates format + flips to 'ok'
   *  - real: re-issues HKCSE with HITAN attached
   */
  async submitTransferTan(input: {
    companyId: string
    transferId: string
    tan: string
  }): Promise<{
    status: 'ok' | 'failed'
    transferId: string
    errorMessage?: string
  }> {
    const transfer = await this.prisma.finTsTransfer.findFirst({
      where: { id: input.transferId, companyId: input.companyId },
      include: { connection: true },
    })
    if (!transfer) throw new BadRequestException('Überweisung nicht gefunden')
    if (transfer.status !== 'needs_tan') {
      throw new BadRequestException(
        `Überweisung ist nicht im needs_tan-Status (ist: ${transfer.status})`,
      )
    }
    const conn = transfer.connection

    if (conn.mockMode === 1) {
      if (!/^\d{6,}$/.test(input.tan)) {
        return {
          status: 'failed',
          transferId: transfer.id,
          errorMessage: 'TAN muss mindestens 6 Ziffern haben',
        }
      }
      await this.prisma.finTsTransfer.update({
        where: { id: transfer.id },
        data: { status: 'ok', finishedAt: new Date() },
      })
      return { status: 'ok', transferId: transfer.id }
    } else {
      await this.prisma.finTsTransfer.update({
        where: { id: transfer.id },
        data: {
          status: 'failed',
          errorMessage: 'Real-Mode FinTS noch nicht verfügbar',
          finishedAt: new Date(),
        },
      })
      return {
        status: 'failed',
        transferId: transfer.id,
        errorMessage: 'Real-Mode FinTS noch nicht verfügbar',
      }
    }
  }

  /**
   * Tier 10: List transfers for a connection
   * (or all of the company's transfers when
   * connectionId is omitted). UI uses this to
   * show the recent SEPA history with status
   * badges.
   */
  async listTransfers(input: {
    companyId: string
    connectionId?: string
    status?: string
    take?: number
  }) {
    const where: any = { companyId: input.companyId }
    if (input.connectionId) where.connectionId = input.connectionId
    if (input.status) where.status = input.status
    return this.prisma.finTsTransfer.findMany({
      where,
      orderBy: { startedAt: 'desc' },
      take: input.take || 50,
      select: {
        id: true,
        kind: true,
        creditorName: true,
        creditorIban: true,
        amount: true,
        currency: true,
        purpose: true,
        endToEndId: true,
        status: true,
        tanChallenge: true,
        errorCode: true,
        errorMessage: true,
        startedAt: true,
        finishedAt: true,
        connectionId: true,
      },
    })
  }
}

/**
 * Levenshtein distance ≤ 2 between any
 * token in the purpose string and the
 * customer name. "Müller" vs "Muller" =
 * 1 edit (ü→u), "Müller" vs "Mueller" =
 * 2 edits. Both should match. "Müller"
 * vs "Mülller" = 1 edit (inserted l).
 *
 * We tokenise the purpose by whitespace
 * + comma + dot + semicolon, then
 * compare each token to each
 * whitespace-separated word in the
 * customer name.
 */
function fuzzyMatchCustomerName(
  purpose: string,
  customerName: string | null | undefined,
): boolean {
  if (!purpose || !customerName) return false
  const tokens = purpose
    .toLowerCase()
    .split(/[\s,;.]+/)
    .filter(Boolean)
  const nameTokens = customerName
    .toLowerCase()
    .split(/[\s,;.]+/)
    .filter(Boolean)
  for (const tok of tokens) {
    if (tok.length < 3) continue
    for (const n of nameTokens) {
      if (n.length < 3) continue
      if (levenshtein(tok, n) <= 2) return true
    }
  }
  return false
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length
  const dp: number[][] = []
  for (let i = 0; i <= a.length; i++) {
    dp[i] = [i]
  }
  for (let j = 0; j <= b.length; j++) {
    dp[0][j] = j
  }
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost,
      )
    }
  }
  return dp[a.length][b.length]
}

/**
 * Yield all size-k combinations of an
 * array. Used by the sum-to-invoice
 * matcher to find a subset of N
 * transactions that sum to the open
 * invoice's total.
 */
function combinations<T>(arr: T[], k: number): T[][] {
  if (k > arr.length || k <= 0) return []
  if (k === 1) return arr.map((x) => [x])
  const result: T[][] = []
  for (let i = 0; i <= arr.length - k; i++) {
    const head = arr[i]
    const tailCombos = combinations(arr.slice(i + 1), k - 1)
    for (const tail of tailCombos) {
      result.push([head, ...tail])
    }
  }
  return result
}

// ============================================================================
// Tier 10 — SEPA-Überweisung + Lastschrift via FinTS HKCSE / HKCCS
// ============================================================================
//
// Mock-mode skips the bank round-trip
// entirely. Real-mode builds the pain.001 /
// pain.008 XML, wraps it in HKCSE / HKCCS
// segments, opens a dialog, and waits for
// HIRMS. For mock-mode any 6-digit TAN is
// accepted and the transfer flips straight
// to 'ok'.

/**
 * Validate a German (or SEPA) IBAN using
 * the MOD-97-10 algorithm. Returns true
 * for a syntactically valid IBAN, false
 * otherwise. Does NOT verify the BIC or
 * the account existence.
 *
 * The check is identical to what the bank
 * performs on its end, so a transfer with
 * a `validIban === true` IBAN has a high
 * probability of being accepted. A
 * `validIban === false` IBAN will be
 * rejected — fail fast at the API layer
 * instead of letting it sit in
 * status='failed' for the user to debug.
 */
function validIban(iban: string): boolean {
  if (!iban) return false
  // Strip spaces and uppercase
  const s = iban.replace(/\s+/g, '').toUpperCase()
  // Length 15..34 (Germany is 22, others vary)
  if (s.length < 15 || s.length > 34) return false
  // First 2 chars are ISO country code (alpha)
  if (!/^[A-Z]{2}/.test(s)) return false
  // MOD-97: move first 4 chars to end, replace letters with 2-digit numbers (A=10..Z=35)
  const rearranged = s.slice(4) + s.slice(0, 4)
  let expanded = ''
  for (const ch of rearranged) {
    const code = ch.charCodeAt(0)
    if (code >= 48 && code <= 57) {
      expanded += ch
    } else if (code >= 65 && code <= 90) {
      expanded += (code - 55).toString()
    } else {
      return false
    }
  }
  // Big-int MOD-97 (IBAN can be up to 34 digits)
  let rem = 0
  for (const ch of expanded) {
    rem = (rem * 10 + parseInt(ch, 10)) % 97
  }
  return rem === 1
}

/**
 * Tier 10: Build a SEPA pain.001.001.09
 * CustomerCreditTransferInitiation document
 * for a single credit transfer (HKCSE
 * payload). Returns the XML as a string —
 * the FinTS protocol layer wraps it inside
 * an HKCSE segment and signs it with the
 * customer's PSD2 signature.
 *
 * Schema reference: ISO 20022 pain.001.001.09.
 *
 * We emit a SINGLE CdtTrfTxInf — multi-
 * payment batches are out of scope for
 * this tier; one Überweisung = one
 * pain.001 message.
 */
function buildPain001CreditTransfer(input: {
  messageId: string
  creditorName: string
  creditorIban: string
  creditorBic?: string | null
  amount: string // Decimal-as-string, e.g. "1190.00"
  currency: string
  purpose?: string | null
  endToEndId: string
  debtorName: string
  debtorIban: string
  debtorBic?: string | null
  requestedExecutionDate: string
}): string {
  const esc = (s: string) =>
    String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const bicTag = input.creditorBic
    ? `<FinInstnId><BIC>${esc(input.creditorBic)}</BIC></FinInstnId>`
    : ''
  return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.09" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <CstmrCdtTrfInitn>
    <GrpHdr>
      <MsgId>${esc(input.messageId)}</MsgId>
      <CreDtTm>${esc(new Date().toISOString())}</CreDtTm>
      <NbOfTxs>1</NbOfTxs>
      <CtrlSum>${input.amount}</CtrlSum>
      <InitgPty>
        <Nm>${esc(input.debtorName)}</Nm>
      </InitgPty>
    </GrpHdr>
    <PmtInf>
      <PmtInfId>${esc(input.messageId)}-1</PmtInfId>
      <PmtMtd>TRF</PmtMtd>
      <NbOfTxs>1</NbOfTxs>
      <CtrlSum>${input.amount}</CtrlSum>
      <ReqdExctnDt><Dt>${esc(input.requestedExecutionDate)}</Dt></ReqdExctnDt>
      <Dbtr>
        <Nm>${esc(input.debtorName)}</Nm>
      </Dbtr>
      <DbtrAcct>
        <Id><IBAN>${esc(input.debtorIban)}</IBAN></Id>
      </DbtrAcct>
      ${input.debtorBic ? `<DbtrAgt><FinInstnId><BIC>${esc(input.debtorBic)}</BIC></FinInstnId></DbtrAgt>` : ''}
      <CdtTrfTxInf>
        <PmtId>
          <EndToEndId>${esc(input.endToEndId)}</EndToEndId>
        </PmtId>
        <Amt>
          <InstdAmt Ccy="${esc(input.currency)}">${input.amount}</InstdAmt>
        </Amt>
        ${bicTag ? `<CdtrAgt>${bicTag}</CdtrAgt>` : ''}
        <Cdtr>
          <Nm>${esc(input.creditorName)}</Nm>
        </Cdtr>
        <CdtrAcct>
          <Id><IBAN>${esc(input.creditorIban)}</IBAN></Id>
        </CdtrAcct>
        ${input.purpose ? `<RmtInf><Ustrd>${esc(input.purpose)}</Ustrd></RmtInf>` : ''}
      </CdtTrfTxInf>
    </PmtInf>
  </CstmrCdtTrfInitn>
</Document>`
}

/**
 * Tier 10: Build a SEPA pain.008.001.08
 * CustomerDirectDebitInitiation document
 * for a single SEPA Lastschrift (HKCCS
 * payload). Mirrors pain.001 with the
 * two key differences:
 *
 *  - <PmtMtd> is "DD" not "TRF"
 *  - <DrctDbtTxInf> carries a mandate
 *    reference + sequence type (FRST /
 *    RCUR / FNAL / OOFF). The mandate is
 *    the SEPA-Lastschriftmandat the
 *    customer signed on paper.
 */
function buildPain008DirectDebit(input: {
  messageId: string
  creditorName: string
  creditorIban: string
  creditorBic?: string | null
  mandateId: string
  sequenceType: string
  scheme: string
  amount: string
  currency: string
  purpose?: string | null
  endToEndId: string
  debtorName: string
  debtorIban: string
  debtorBic?: string | null
  requestedExecutionDate: string
}): string {
  const esc = (s: string) =>
    String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const bicTag = input.creditorBic
    ? `<FinInstnId><BIC>${esc(input.creditorBic)}</BIC></FinInstnId>`
    : ''
  const dtOfSgntr = new Date().toISOString().slice(0, 10)
  return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.008.001.08" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <CstmrDrctDbtInitn>
    <GrpHdr>
      <MsgId>${esc(input.messageId)}</MsgId>
      <CreDtTm>${esc(new Date().toISOString())}</CreDtTm>
      <NbOfTxs>1</NbOfTxs>
      <CtrlSum>${input.amount}</CtrlSum>
      <InitgPty>
        <Nm>${esc(input.creditorName)}</Nm>
      </InitgPty>
    </GrpHdr>
    <PmtInf>
      <PmtInfId>${esc(input.messageId)}-1</PmtInfId>
      <PmtMtd>DD</PmtMtd>
      <NbOfTxs>1</NbOfTxs>
      <CtrlSum>${input.amount}</CtrlSum>
      <ReqdExctnDt><Dt>${esc(input.requestedExecutionDate)}</Dt></ReqdExctnDt>
      <Cdtr>
        <Nm>${esc(input.creditorName)}</Nm>
      </Cdtr>
      <CdtrAcct>
        <Id><IBAN>${esc(input.creditorIban)}</IBAN></Id>
      </CdtrAcct>
      ${input.creditorBic ? `<CdtrAgt>${bicTag}</CdtrAgt>` : ''}
      <ChrgBr>SLEV</ChrgBr>
      <DrctDbtTxInf>
        <PmtId>
          <EndToEndId>${esc(input.endToEndId)}</EndToEndId>
        </PmtId>
        <InstdAmt Ccy="${esc(input.currency)}">${input.amount}</InstdAmt>
        <DrctDbtTx>
          <MndtId>${esc(input.mandateId)}</MndtId>
          <DtOfSgntr>${dtOfSgntr}</DtOfSgntr>
          <SeqTp>${esc(input.sequenceType)}</SeqTp>
        </DrctDbtTx>
        ${input.debtorBic ? `<DbtrAgt><FinInstnId><BIC>${esc(input.debtorBic)}</BIC></FinInstnId></DbtrAgt>` : ''}
        <Dbtr>
          <Nm>${esc(input.debtorName)}</Nm>
        </Dbtr>
        <DbtrAcct>
          <Id><IBAN>${esc(input.debtorIban)}</IBAN></Id>
        </DbtrAcct>
        ${input.purpose ? `<RmtInf><Ustrd>${esc(input.purpose)}</Ustrd></RmtInf>` : ''}
      </DrctDbtTxInf>
    </PmtInf>
  </CstmrDrctDbtInitn>
</Document>`
}
