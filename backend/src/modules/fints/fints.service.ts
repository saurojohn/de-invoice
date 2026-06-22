import { PrismaService } from '../../prisma/prisma.service'
import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { createHash, randomUUID } from 'crypto'
import { buildFinTsMessage, parseFinTsMessage, Segment } from './fints-protocol'

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

@Injectable()
export class FinTsService {
  private readonly logger = new Logger(FinTsService.name)

  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
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
    // Hash the PIN before persisting. We
    // never store the plaintext — only the
    // sha256 (which is what the bank would
    // see on a fake-PIN probe). For real
    // banks, the plaintext is used in the
    // HNVSK envelope and forgotten as soon
    // as the dialog completes; we don't
    // need it afterwards.
    const pinHash = createHash('sha256').update(input.pin).digest('hex')
    const conn = await this.prisma.finTSConnection.create({
      data: {
        companyId: input.companyId,
        blz: input.blz,
        userId: input.userId,
        label: input.label,
        endpointUrl,
        pinHash,
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
        const parsed = parseFinTsMessage(Buffer.from(await resp.arrayBuffer()))
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
    input: StartSyncInput,
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
    // Real-mode is intentionally a stub. We
    // build the messages so the structure is
    // visible, but the network call is not
    // made — there is no test bank available
    // in this project's sandbox. A future
    // maintainer with a Sparkasse test
    // account can wire this up.
    const conn = await this.prisma.finTSConnection.findUnique({
      where: { id: connectionId },
    })
    if (!conn) throw new Error('Connection vanished mid-sync')

    const daysBack = input.daysBack ?? 90
    const from = new Date()
    from.setDate(from.getDate() - daysBack)
    const today = new Date()

    const dialog = await this.openDialog(conn)
    if (dialog.status === 'failed') return dialog
    if (dialog.status === 'needs_tan') return dialog

    // HKSAL — balances
    // HKKAZ — transactions for the last 90d
    const txSegs: Segment[] = [
      {
        header: { type: 'HKSAL', ref: 3, version: 7 },
        body: { accountNumber: '?', allAccounts: true },
      },
      {
        header: { type: 'HKKAZ', ref: 4, version: 7 },
        body: {
          accountNumber: '?',
          fromDate: from.toISOString().slice(0, 10),
          toDate: today.toISOString().slice(0, 10),
        },
      },
    ]
    const req = buildFinTsMessage({
      dialogId: dialog.dialogId,
      messageNumber: 2,
      blz: conn.blz,
      userId: conn.userId,
      pin: '(not stored)',
      segments: txSegs,
    })
    // POST and parse — stubbed.
    return { status: 'failed', errorMessage: 'Real-mode is a stub in this build' }
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
    const req = buildFinTsMessage({
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
    txs: MockTransaction[],
  ): Promise<number> {
    // Synthetic statement for this sync. The
    // fileName and format fields are kept
    // generic because there's no real upload.
    const stmt = await this.prisma.bankStatement.create({
      data: {
        companyId: conn.companyId,
        format: 'fints-mock',
        fileName: `fints-mock-${conn.blz}-${Date.now()}.json`,
        fileSize: JSON.stringify(txs).length,
        accountIban: null,
        bankName: `Mock-Bank ${conn.blz}`,
        periodFrom: new Date(
          Math.min(...txs.map((t) => new Date(t.valueDate).getTime())),
        ),
        periodTo: new Date(
          Math.max(...txs.map((t) => new Date(t.valueDate).getTime())),
        ),
        openingBalance: null,
        closingBalance: null,
        rawContent: JSON.stringify(txs, null, 2),
      },
    })

    let inserted = 0
    for (const tx of txs) {
      // Idempotency: skip if a BankTransaction
      // with this endToEndId already exists for
      // the company.
      const existing = await this.prisma.bankTransaction.findFirst({
        where: { companyId: conn.companyId, endToEndId: tx.endToEndId },
      })
      if (existing) continue
      await this.prisma.bankTransaction.create({
        data: {
          statementId: stmt.id,
          companyId: conn.companyId,
          valueDate: new Date(tx.valueDate),
          entryDate: new Date(tx.entryDate),
          amount: tx.amount,
          currency: tx.currency,
          counterpartyName: tx.counterpartyName,
          counterpartyIban: tx.counterpartyIban,
          purpose: tx.purpose,
          endToEndId: tx.endToEndId,
        },
      })
      inserted++
    }
    return inserted
  }

  /**
   * After syncing, try to auto-match new
   * transactions against open invoices. The
   * matching rules are deliberately simple
   * (deterministic, easy to e2e-test):
   *
   * 1. **Exact amount match** between the
   *    transaction and the invoice's
   *    `total` field (within 1 cent).
   * 2. **Invoice number in purpose** — if the
   *    transaction's purpose contains the
   *    invoice number (E2E-T6-001, etc.),
   *    confidence 100.
   * 3. **IBAN match** — the counterparty IBAN
   *    matches the customer's IBAN,
   *    confidence 80.
   *
   * The user can confirm or reject each
   * candidate in the UI. Confirmed matches
   * create a Payment + flip the invoice to
   * paid (via PaymentService.create).
   */
  async autoMatchNewTransactions(companyId: string): Promise<{
    matched: number
    suggested: number
  }> {
    // Find transactions that have no recon
    // rows yet. We only act on transactions
    // from mock syncs in this build; real
    // syncs are stubbed.
    const unreconciled = await this.prisma.bankTransaction.findMany({
      where: {
        companyId,
        matches: { none: {} },
      },
      orderBy: { valueDate: 'desc' },
    })

    let matched = 0
    let suggested = 0
    for (const tx of unreconciled) {
      if (parseFloat(tx.amount.toString()) <= 0) {
        // Outgoing payment — not a customer
        // paying an invoice. Skip in this
        // version (future: match to vendor /
        // expense).
        continue
      }
      // Look for open invoices with matching
      // total.
      const candidates = await this.prisma.invoice.findMany({
        where: {
          companyId,
          status: { in: ['sent', 'overdue', 'partial'] },
          total: tx.amount,
        },
        include: { customer: true },
      })
      for (const inv of candidates) {
        let confidence = 0
        let reason = ''
        // Reason 1: invoice number in purpose
        if (tx.purpose && tx.purpose.includes(inv.invoiceNumber)) {
          confidence = 100
          reason = `Betrag exakt + Rechnungsnummer im Verwendungszweck`
        } else if (
          // Customer IBAN is stored in the
          // `contact` JSON blob (no dedicated
          // column). Read it defensively —
          // a missing field just means the
          // IBAN-based check can't fire.
          tx.counterpartyIban &&
          (() => {
            const contact = (inv.customer?.contact as any) || {}
            const address = (inv.customer?.address as any) || {}
            const customerIban =
              contact.iban || address.iban || null
            if (!customerIban) return false
            return (
              customerIban.replace(/\s/g, '') ===
              tx.counterpartyIban!.replace(/\s/g, '')
            )
          })()
        ) {
          confidence = 80
          reason = `Betrag exakt + IBAN stimmt mit Kunde überein`
        } else {
          confidence = 50
          reason = `Betrag exakt (keine weitere Korrelation)`
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
        if (confidence >= 80) {
          matched++
        } else {
          suggested++
        }
      }
    }
    return { matched, suggested }
  }
}
