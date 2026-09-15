/**
 * Tier 383 — request DTOs for the customer credit-balance and payment
 * allocation routes.
 *
 * The bodies were inline types. Measured before this change:
 *   credit-adjust    amount 1e12 → 500; 5000-char description and undeclared
 *                    fields → 201
 *   credit-payout    paymentDate "abc" → 500; "2026-02-30" → 201; amount 1e12 → 500
 *   apply-credit     invoiceId 123 (a number) → 500
 *   allocate-payment paymentDate "2026-02-30" → 201, Payment stored 2026-03-02;
 *                    amount 1e12 → 201
 * Payment.amount and the credit ledger amounts are Decimal(12,4). Callers:
 * customer detail page (allocate), customer credit page (payout, adjust),
 * e2e 85/86/88/149/179, Playwright aging-credit and
 * customer-payment-allocation-tier146. The services keep their German
 * checks (amount > 0 / ≠ 0, customer / invoice / bank account of this
 * company, enough credit).
 */
import { IsDateString, IsNotEmpty, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator'

const MAX = 99999999.9999
const YMD = /^\d{4}-\d{2}-\d{2}/

export class CreditAdjustDto {
  // Signed: + adds credit, - uses credit (e2e 85 sends -20). 0 is refused by the service.
  @IsNumber({}, { message: 'Betrag muss eine Zahl sein' })
  @Min(-MAX) @Max(MAX, { message: 'Betrag darf höchstens 99999999.9999 sein' })
  amount!: number

  @IsString() @IsNotEmpty({ message: 'Beschreibung ist erforderlich' }) @MaxLength(500)
  description!: string

  @IsOptional() @IsString()
  createdById?: string
}

export class CreditPayoutDto {
  @IsNumber({}, { message: 'Betrag muss eine Zahl sein' })
  @Max(MAX, { message: 'Betrag darf höchstens 99999999.9999 sein' })
  amount!: number

  @Matches(YMD, { message: 'paymentDate muss ein Datum (YYYY-MM-DD) sein' })
  @IsDateString({ strict: true }, { message: 'paymentDate ist kein gültiges Datum' })
  paymentDate!: string

  @IsString() @IsNotEmpty() @MaxLength(64)
  bankAccountId!: string

  @IsOptional() @IsString() @MaxLength(500)
  description?: string

  @IsOptional() @IsString()
  createdById?: string
}

export class ApplyCreditDto {
  @IsString() @IsNotEmpty() @MaxLength(64)
  invoiceId!: string

  @IsNumber({}, { message: 'Betrag muss eine Zahl sein' })
  @Max(MAX, { message: 'Betrag darf höchstens 99999999.9999 sein' })
  amount!: number

  @IsOptional() @IsString()
  createdById?: string
}

export class AllocatePaymentDto {
  // amount <= 0 answers the handler's own "amount must be a positive number".
  @IsNumber({}, { message: 'amount must be a positive number' })
  @Max(MAX, { message: 'amount darf höchstens 99999999.9999 sein' })
  amount!: number

  @Matches(YMD, { message: 'paymentDate is required (ISO 8601)' })
  @IsDateString({ strict: true }, { message: 'paymentDate is invalid' })
  paymentDate!: string

  @IsString() @MaxLength(100)
  paymentMethod!: string

  @IsOptional() @IsString() @MaxLength(200)
  reference?: string

  @IsOptional() @IsString() @MaxLength(2000)
  notes?: string
}
