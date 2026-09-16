import { IsInt, IsNumber, IsOptional, IsString, IsNotEmpty, Matches, Max, MaxLength, Min } from 'class-validator'

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
  @IsOptional() @IsNumber({}, { message: 'vatRate muss eine Zahl sein' })
  @Min(0) @Max(1, { message: 'vatRate muss zwischen 0 und 1 liegen (0.19 = 19 %)' })
  vatRate?: number

  // Upper bound against the transaction amount is checked in the service.
  @IsOptional() @IsNumber({}, { message: 'vatAmount muss eine Zahl sein' })
  @Min(0, { message: 'vatAmount darf nicht negativ sein' })
  vatAmount?: number
}

export class SuggestMatchesDto {
  // Already clamped to 0…100 in the service; rejected here instead of silently
  // clamped. 0 disables auto-confirm.
  @IsOptional() @IsInt({ message: 'autoConfirmThreshold muss eine ganze Zahl sein' })
  @Min(0) @Max(100, { message: 'autoConfirmThreshold muss zwischen 0 und 100 liegen' })
  autoConfirmThreshold?: number
}

export class MatchTransactionDto {
  @IsString() @IsNotEmpty({ message: 'invoiceId ist erforderlich' }) @MaxLength(64)
  invoiceId!: string
}
