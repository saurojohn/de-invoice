// Tier 13: Thin wrapper around the `fints`
// npm package (Prior99/fints — BSD-3-Clause).
//
// This file does NOT replace the
// hand-rolled FinTS service in
// fints.service.ts (which builds the
// DIALOG INIT + HKSYN messages itself).
// The hand-rolled implementation works
// against the in-house mock and is what
// e2e 31-fints-mock.sh exercises.
//
// This wrapper exists so that the moment
// the project gets access to a real
// Sparkasse / Volksbank / DKB / comdirect
// sandbox account, the real-mode path can
// be wired in by:
//
//   1. npm install fints   (done — v0.5.0)
//
//   2. Replace the `realSync()` and
//      `realFetch()` methods in
//      fints.service.ts with calls to
//      `fintsReal.listAccounts()` and
//      `fintsReal.fetchStatements()`
//      below.
//
//   3. Add a new connection flag
//      `fintsImplementation: 'handrolled'
//      | 'library'` so existing e2e
//      tests (which exercise the
//      hand-rolled path) keep working
//      while new real-mode tests use
//      the library.
//
// The library handles:
//   - DIALOG INIT / DIALOG END
//   - HKSYN (synchronization)
//   - HKSAL (account list)
//   - HKKAZ (transactions)
//   - PSD2 SCA (Strong Customer
//     Authentication) via PinTan
//   - All 50+ banks' quirks (it
//     auto-detects the bank's preferred
//     TAN scheme)
//
// It does NOT handle:
//   - SEPA transfers (intentional — we
//     built our own Tier-10 pain.001
//     builder for the transfer use
//     case)
//   - Holding data / securities
//   - Standing orders
//
// Reference: https://github.com/Prior99/fints

import { PinTanClient, SEPAAccount, Statement as LibStatement, Transaction as LibTransaction } from 'fints'

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
 * Real-mode FinTS sync using the `fints`
 * library. Returns the list of accounts
 * + their transactions in the given
 * date range.
 *
 * Used by fints.service.ts's real-mode
 * path. The hand-rolled path in
 * fints.service.ts is what's tested by
 * the existing e2e; this wrapper is
 * wired in once we have a real sandbox
 * bank to test against.
 *
 * Errors are passed through unchanged:
 *   - Wrong PIN: 4-digit error from the
 *     bank, typically "PIN ungültig"
 *   - TAN required: thrown as a typed
 *     error that the controller can
 *     catch and surface as
 *     `needs_tan` state
 *   - Network: connection refused /
 *     TLS handshake — propagated as-is
 */
export class FintsReal {
  constructor(private readonly config: FintsConnectionConfig) {}

  private get client(): PinTanClient {
    return new PinTanClient({
      url: this.config.url,
      blz: this.config.blz,
      name: this.config.username,
      pin: this.config.pin,
      productId: this.config.productId,
    })
  }

  /**
   * Probe the bank: open + close a dialog
   * to verify the credentials + endpoint
   * are valid. Returns the list of accounts
   * the bank exposes for this customer.
   */
  async listAccounts(): Promise<FintsAccount[]> {
    const client = this.client
    const accounts: SEPAAccount[] = await client.accounts()
    return accounts.map((a) => ({
      iban: a.iban,
      bic: a.bic,
      accountNumber: a.accountNumber,
      blz: a.blz,
      accountOwnerName: a.accountOwnerName ?? '',
    }))
  }

  /**
   * Fetch the transactions for a given
   * account in a date range. Maps the
   * library's Statement shape to our
   * FintsTransaction shape.
   */
  async fetchStatements(
    account: FintsAccount,
    from: Date,
    to: Date,
  ): Promise<FintsTransaction[]> {
    const client = this.client
    // The library expects a SEPAAccount.
    // We re-construct from the FintsAccount
    // we got from listAccounts().
    const accountRef: SEPAAccount = {
      iban: account.iban,
      bic: account.bic,
      accountNumber: account.accountNumber,
      blz: account.blz,
    } as SEPAAccount
    const statements: LibStatement[] = await client.statements(
      accountRef,
      from,
      to,
    )
    const txs: FintsTransaction[] = []
    for (const stmt of statements) {
      for (const tx of stmt.transactions) {
        // mt940-js' Transaction has its own
        // `id` field that we use as the
        // bankRef (it's the bank's internal
        // transaction id, formatted as
        // "NCC1655...." or similar).
        txs.push({
          bankRef: (tx as any).id ?? `stmt-${(stmt as any).number ?? '?'}-${tx.description?.slice(0, 20)}`,
          valueDate: new Date(tx.valueDate),
          entryDate: new Date(tx.entryDate),
          amount: tx.amount.toString(),
          currency: tx.currency,
          direction: tx.isCredit ? 'credit' : 'debit',
          name: extractFirstLine(tx.description),
          purpose: tx.description,
          // The structured 86 fields (counterparty IBAN,
          // mandate ref, E2E id) are parsed by the library
          // into a separate `descriptionStructured` object
          // on the Transaction. We surface them if
          // present.
          counterpartyIban: extractSepaField(tx, 'IBAN'),
          mandateRef: extractSepaField(tx, 'MREF'),
          endToEndId: extractSepaField(tx, 'EREF'),
        })
      }
    }
    return txs
  }
}

// First non-empty line of a multi-line
// purpose string, e.g.:
//   "Max Mustermann\nDE89 3704 0044 0532 0130 00\n"
//   → "Max Mustermann"
// Used for the `name` field of the
// transaction (we keep the full text
// in `purpose` for the UI to display).
function extractFirstLine(s: string | undefined): string {
  if (!s) return ''
  for (const line of s.split(/\r?\n/)) {
    const t = line.trim()
    if (t) return t
  }
  return ''
}

// Look up a SEPA reference field in the
// structured description. The library
// parses the 86 fields into a tree of
// key/value pairs; we pull the ones
// that match the SEPA reference tags.
function extractSepaField(tx: LibTransaction, field: 'IBAN' | 'MREF' | 'EREF'): string | undefined {
  const sd: any = (tx as any).descriptionStructured
  if (!sd) return undefined
  // The exact shape depends on the
  // mt940-js version; we walk it
  // shallowly to find any property
  // matching the field name.
  for (const key of Object.keys(sd)) {
    if (key.toUpperCase().includes(field)) {
      const v = sd[key]
      if (typeof v === 'string') return v
      if (v && typeof v === 'object' && 'value' in v) return v.value
    }
  }
  return undefined
}
