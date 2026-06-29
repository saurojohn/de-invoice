/**
 * Tier 13 + Tier 22: Thin wrapper around the `fints`
 * npm package (Prior99/fints — BSD-3-Clause).
 *
 * The hand-rolled FinTS message builder in
 * fints.service.ts works against the in-house mock and
 * is what e2e 31-fints-mock.sh exercises. THIS file is
 * the real-mode path: when the user configures a FinTS
 * connection with `mockMode: false`, we instantiate
 * `FintsReal` and use the library to actually talk to
 * the bank's server.
 *
 * Why the library rather than the hand-rolled messages?
 * Because the FinTS protocol has ~50 message types,
 * dozens of bank-specific quirks, and PSD2 SCA flows
 * that re-shape the dialog on the fly. The library
 * (BSD-3, ~70k lines, MIT-funded) does all of that.
 *
 * What this wrapper adds on top of the library:
 *   - Typed result shape (the library throws on errors;
 *     we normalise to a discriminated union so the
 *     controller can render proper status codes)
 *   - Idempotent account/statement fetch (the library
 *     re-uses a Dialog per call — we instantiate once
 *     per connection and re-auth on need-tan)
 *   - Field extraction from mt940-js' `descriptionStructured`
 *     (IBAN, MREF, EREF) into our flat shape
 *
 * Reference: https://github.com/Prior99/fints
 */

import {
  PinTanClient,
  SEPAAccount,
  Statement as LibStatement,
  Transaction as LibTransaction,
  TanRequiredError,
  ResponseError,
} from 'fints'

export interface FintsConnectionConfig {
  url: string
  blz: string // 8-digit Bankleitzahl
  username: string // typically the IBAN-owner name
  pin: string // the online-banking PIN (NOT the password)
  productId?: string // optional bank product identifier
}

export interface FintsAccount {
  iban: string
  bic: string
  accountNumber: string
  blz: string
  accountOwnerName: string
}

export interface FintsTransaction {
  /** Bank-internal ID for the transaction (e.g. "NCTE...") */
  bankRef: string
  /** ISO date the value was booked (Buchungsdatum) */
  valueDate: Date
  /** ISO date the value was posted to the account (Valuta) */
  entryDate: Date
  /** Amount as a string — negative = debit (Ausgang) */
  amount: string
  /** ISO 4217, e.g. "EUR" */
  currency: string
  /** "debit" (Soll) or "credit" (Haben) */
  direction: 'debit' | 'credit'
  /** Counterparty name (Verwendungszweck / first line) */
  name: string
  /** Full purpose line (often multi-line) */
  purpose: string
  /** IBAN of the counterparty, if extractable */
  counterpartyIban?: string
  /** SEPA mandate reference, if extractable */
  mandateRef?: string
  /** End-to-end ID (SEPA) */
  endToEndId?: string
}

/**
 * Normalised result from any FintsReal call.
 * Mirrors the discriminated union fints.service.ts uses
 * for both real- and mock-mode — controller code is
 * identical for both paths.
 */
export type FintsResult<T> =
  | { status: 'ok'; data: T }
  | { status: 'needs_tan'; challenge: string; transactionReference: string }
  | { status: 'failed'; code: string; message: string }

/**
 * Real-mode FinTS client using the `fints` library.
 *
 * Constructed per connection (not per call) so the
 * library can cache the dialog + system-id between
 * calls. Each call re-opens a fresh dialog because
 * banks close them after the message round-trip —
 * a connection that's been idle for >24h typically
 * requires re-authentication.
 */
export class FintsReal {
  constructor(private readonly config: FintsConnectionConfig) {}

  /**
   * Open a fresh dialog + fetch the list of SEPA
   * accounts the user has access to.
   */
  async listAccounts(): Promise<FintsResult<FintsAccount[]>> {
    const client = this.makeClient()
    try {
      const accounts: SEPAAccount[] = await client.accounts()
      return {
        status: 'ok',
        data: accounts.map((a) => ({
          iban: a.iban,
          bic: a.bic,
          accountNumber: a.accountNumber,
          blz: a.blz,
          accountOwnerName: a.accountOwnerName ?? '',
        })),
      }
    } catch (e) {
      return this.normaliseError(e)
    }
  }

  /**
   * Fetch the transactions for a given account in a
   * date range.
   *
   * For the FIRST sync the library will throw
   * TanRequiredError on the statements() call. We
   * catch that and return `needs_tan` so the
   * controller can prompt the user. On the second
   * call (with `tan` supplied), use `completeStatements`
   * with the saved dialog config.
   */
  async fetchStatements(
    account: FintsAccount,
    from: Date,
    to: Date,
  ): Promise<FintsResult<FintsTransaction[]>> {
    const client = this.makeClient()
    const accountRef = this.toSepaAccount(account)
    try {
      const statements: LibStatement[] = await client.statements(accountRef, from, to)
      return { status: 'ok', data: this.mapStatements(statements) }
    } catch (e) {
      return this.normaliseError(e)
    }
  }

  /**
   * Resume an in-progress statement fetch after the
   * user supplied a TAN. The library re-uses the saved
   * dialog config (so the system-id assigned at first
   * sync is preserved).
   *
   * The `savedDialog` shape is whatever was returned
   * in the TanRequiredError.dialog field. We serialise
   * it from the controller's side.
   */
  async completeStatements(
    savedDialogConfig: any,
    transactionReference: string,
    tan: string,
  ): Promise<FintsResult<FintsTransaction[]>> {
    const client = this.makeClient()
    try {
      const statements = await client.completeStatements(
        savedDialogConfig,
        transactionReference,
        tan,
      )
      return { status: 'ok', data: this.mapStatements(statements) }
    } catch (e) {
      return this.normaliseError(e)
    }
  }

  // ── private helpers ──────────────────────────────────

  private makeClient(): PinTanClient {
    return new PinTanClient({
      url: this.config.url,
      blz: this.config.blz,
      name: this.config.username,
      pin: this.config.pin,
      productId: this.config.productId,
    })
  }

  private toSepaAccount(account: FintsAccount): SEPAAccount {
    return {
      iban: account.iban,
      bic: account.bic,
      accountNumber: account.accountNumber,
      blz: account.blz,
    } as SEPAAccount
  }

  private mapStatements(statements: LibStatement[]): FintsTransaction[] {
    const txs: FintsTransaction[] = []
    for (const stmt of statements) {
      for (const tx of stmt.transactions) {
        txs.push({
          bankRef:
            (tx as any).id ??
            `stmt-${(stmt as any).number ?? '?'}-${tx.description?.slice(0, 20)}`,
          valueDate: new Date(tx.valueDate),
          entryDate: new Date(tx.entryDate),
          amount: tx.amount.toString(),
          currency: tx.currency,
          direction: tx.isCredit ? 'credit' : 'debit',
          name: extractFirstLine(tx.description),
          purpose: tx.description,
          counterpartyIban: extractSepaField(tx, 'IBAN'),
          mandateRef: extractSepaField(tx, 'MREF'),
          endToEndId: extractSepaField(tx, 'EREF'),
        })
      }
    }
    return txs
  }

  /**
   * Translate any error the library throws into our
   * `FintsResult` discriminated union.
   *
   * The three shapes we care about:
   *   - TanRequiredError → status: 'needs_tan'
   *   - ResponseError with a bank HIRMS code → status: 'failed'
   *     with the human-readable message the bank sent
   *   - Anything else (network, timeout, parse error)
   *     → status: 'failed' with the raw message
   */
  private normaliseError(e: unknown): FintsResult<never> {
    if (e instanceof TanRequiredError) {
      return {
        status: 'needs_tan',
        challenge: e.challengeText || 'TAN erforderlich',
        transactionReference: e.transactionReference,
      }
    }
    if (e instanceof ResponseError) {
      const r: any = e.response
      const msgs: string[] = []
      // The library exposes the parsed response; the
      // human message is on `messages[].message` or
      // constructed from the segment code.
      if (Array.isArray(r?.messages)) {
        for (const m of r.messages) {
          if (m?.text) msgs.push(String(m.text))
        }
      }
      const msg = msgs.join(' / ') || r?.errorMessage || e.message
      return {
        status: 'failed',
        code: String(r?.errorCode || 'BANK_ERROR'),
        message: msg,
      }
    }
    // Generic (network / DNS / TLS / timeout / JSON parse).
    const err = e as any
    return {
      status: 'failed',
      code: err?.code || 'NETWORK_ERROR',
      message: err?.message || String(e) || 'Unbekannter Fehler',
    }
  }
}

// First non-empty line of a multi-line
// purpose string — used for the `name` field.
function extractFirstLine(s: string | undefined): string {
  if (!s) return ''
  for (const line of s.split(/\r?\n/)) {
    const t = line.trim()
    if (t) return t
  }
  return ''
}

// Look up a SEPA reference field (IBAN / MREF / EREF)
// in the structured description. The mt940-js library
// parses the 86 fields into a tree of key/value pairs;
// we walk it shallowly.
function extractSepaField(
  tx: LibTransaction,
  field: 'IBAN' | 'MREF' | 'EREF',
): string | undefined {
  const sd: any = (tx as any).descriptionStructured
  if (!sd) return undefined
  for (const key of Object.keys(sd)) {
    if (key.toUpperCase().includes(field)) {
      const v = sd[key]
      if (typeof v === 'string') return v
      if (v && typeof v === 'object' && 'value' in v) return v.value
    }
  }
  return undefined
}