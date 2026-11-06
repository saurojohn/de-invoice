import { StrictNumber } from '../../../common/strict-number'
import { IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, IsNotEmpty, Matches, Max, MaxLength, Min } from 'class-validator'

import { StrictBoolean } from '../../../common/strict-boolean'
/**
 * Tier 393 — bodies for the bank-import money routes. They were single
 * `@Body('x')` params, which the global ValidationPipe cannot check.
 *
 * Measured before, on a real debit transaction:
 *   - `expenseAccountNumber: "NICHT-EXISTENT-9999"` → 201, and an Account with
 *     that number ("Sonstige betriebliche Aufwendungen", type expense) was
 *     created in the company's chart of accounts and booked against. The UI
 *     field is a free-text prompt() defaulting to "4900", so a typo lands there
 *     permanently and flows on into DATEV / BWA / GuV / Bilanz.
 *   - `expenseId` of another company → the voucher was written and the bank
 *     transaction marked booked, THEN the ownership check failed: HTTP 404, but
 *     a voucher tagged `[expense:<foreign id>]` stayed in the books and the
 *     transaction was permanently consumed (`voucherId` set → "bereits als
 *     Aufwand gebucht").
 *   - `vatAmount: 999` on a 150 € transaction → 400 "Soll und Haben müssen
 *     ausgeglichen sein" from deep inside the voucher service.
 */
export class BookExpenseDto {
  /**
   * An account number from the chart of accounts (SKR03/04 are numeric).
   * A number that does not exist yet is still created on first use — that is
   * the intended convenience — but it has to look like an account number.
   */
  @IsOptional()
  @Matches(/^\d{3,8}$/, { message: 'expenseAccountNumber muss eine Kontonummer sein (3-8 Ziffern)' })
  expenseAccountNumber?: string

  @IsOptional() @IsString() @MaxLength(500)
  description?: string

  @IsOptional() @IsString() @MaxLength(64)
  supplierId?: string

  @IsOptional() @IsString() @MaxLength(64)
  expenseId?: string

  // 0…1 (0.19 = 19 %). The service picks the Vorsteuer account from this.
  @IsOptional() @StrictNumber() @IsNumber({}, { message: 'vatRate muss eine Zahl sein' })
  @Min(0) @Max(1, { message: 'vatRate muss zwischen 0 und 1 liegen (0.19 = 19 %)' })
  vatRate?: number

  // Upper bound against the transaction amount is checked in the service.
  @IsOptional() @StrictNumber() @IsNumber({}, { message: 'vatAmount muss eine Zahl sein' })
  @Min(0, { message: 'vatAmount darf nicht negativ sein' })
  vatAmount?: number

  // Tier 452: the debit is the expense less a Skonto (at most 10 %); the
  // difference becomes a supplier credit note split at the expense's rate.
  @IsOptional() @StrictBoolean() @IsBoolean()
  skonto?: boolean

  // Tier 809: the category of the expense a plain booking now records (the
  // EÜR / GuV / Anlage lines read it, e.g. „Bankgebühren", „Kfz").
  @IsOptional() @IsString() @MaxLength(100)
  category?: string
}

/**
 * Tier 809 — POST /bank-statements/:id/transactions/:txnId/rebook-as-expense:
 * a transaction booked „Als Aufwand" before Tier 809 (a voucher only, no
 * expense the reports read) is reversed and booked again with its expense.
 */
export class RebookAsExpenseDto {
  @IsOptional() @IsString() @MaxLength(100)
  category?: string

  // the rate of the bill behind it, when the old booking had no Vorsteuer
  @IsOptional() @StrictNumber() @IsIn([0, 0.07, 0.19], { message: 'vatRate muss 0, 0.07 oder 0.19 sein' })
  vatRate?: number
}

export class SuggestMatchesDto {
  // Already clamped to 0…100 in the service; rejected here instead of silently
  // clamped. 0 disables auto-confirm.
  @IsOptional() @StrictNumber() @IsInt({ message: 'autoConfirmThreshold muss eine ganze Zahl sein' })
  @Min(0) @Max(100, { message: 'autoConfirmThreshold muss zwischen 0 und 100 liegen' })
  autoConfirmThreshold?: number
}

export class MatchTransactionDto {
  @IsString() @IsNotEmpty({ message: 'invoiceId ist erforderlich' }) @MaxLength(64)
  invoiceId!: string
}

/**
 * Tier 808 — POST /bank-statements/:id/transactions/:txnId/book-tax: the
 * transaction is the payment (or refund) of a tax — a UStVA by month or
 * quarter, the Sondervorauszahlung or the annual VAT return by year, a KSt /
 * GewSt prepayment by quarter.
 */
export class BookTaxPaymentDto {
  @IsIn(['ustva', 'svz', 'ustja', 'kst', 'gewst'])
  kind!: 'ustva' | 'svz' | 'ustja' | 'kst' | 'gewst'

  @StrictNumber() @IsInt() @Min(2010) @Max(2100)
  year!: number

  @IsOptional() @StrictNumber() @IsInt() @Min(1) @Max(12)
  month?: number | null

  @IsOptional() @StrictNumber() @IsInt() @Min(1) @Max(4)
  quarter?: number | null
}
