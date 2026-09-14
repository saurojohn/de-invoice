/**
 * Tier 374 — request DTOs for POST /invoices/:id/payments and
 * POST /invoices/:id/credit-note.
 *
 * Both routes declared their bodies as inline object types, which the global
 * ValidationPipe cannot see (it only validates classes). Measured before this
 * change on a fresh stack:
 *   payments:    {} → 500 (plain Error), paymentDate "abc" → 500 (Invalid
 *                Date), amount 1e12 → 500 (numeric field overflow)
 *   credit-note: amount 1e12 → 500, line vatRate 19 → 500, and
 *                amount "zehn" → 201 with a FULL refund, because the NaN
 *                failed the `amount > 0` test and fell through to the
 *                mirror-every-line branch.
 *
 * Field sets are the union of every caller (invoice detail page, credit-note
 * modal, backend e2e 07/50/52/80/81/83/85/149, Playwright credit-note and
 * sequence-tier174). Checks the services already make with a German message
 * (amount > 0 for payments, CN-from-CN, cancelled original) stay there.
 */
import { Type } from 'class-transformer'
import {
  IsArray,
  IsDateString,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator'

// Payment.amount and InvoiceItem.quantity/unitPrice are Decimal(12,4).
const DECIMAL_12_4_MAX = 99999999.9999

export class CreatePaymentDto {
  // No lower bound here: PaymentService answers amount <= 0 with
  // "Betrag muss größer als 0 sein", which e2e 149 relies on.
  @IsNumber({}, { message: 'Betrag muss eine Zahl sein' })
  @Max(DECIMAL_12_4_MAX, { message: 'Betrag darf höchstens 99999999.9999 sein' })
  amount!: number

  // Callers send both "2026-06-01" and "2026-04-01T00:00:00.000Z".
  @IsDateString({ strict: true }, { message: 'Zahldatum muss ein gültiges Datum sein (JJJJ-MM-TT)' })
  paymentDate!: string

  @IsString()
  @IsNotEmpty({ message: 'Zahlungsweg ist erforderlich' })
  @MaxLength(100)
  paymentMethod!: string

  @IsOptional() @IsString() @MaxLength(500)
  reference?: string

  @IsOptional() @IsString() @MaxLength(2000)
  notes?: string

  @IsOptional() @IsString() @MaxLength(100)
  receiptNumber?: string
}

export class CreditNoteLineDto {
  @IsString()
  description!: string

  @IsOptional()
  @IsNumber()
  @Min(-DECIMAL_12_4_MAX)
  @Max(DECIMAL_12_4_MAX)
  quantity?: number

  // Sign is irrelevant: the service stores -abs(unitPrice).
  @IsNumber()
  @Min(-DECIMAL_12_4_MAX)
  @Max(DECIMAL_12_4_MAX)
  unitPrice!: number

  @IsOptional()
  @IsNumber()
  @Min(0, { message: 'MwSt-Satz darf nicht negativ sein' })
  @Max(1, { message: 'MwSt-Satz ist ein Anteil (z. B. 0.19), höchstens 1' })
  vatRate?: number
}

export class CreateCreditNoteDto {
  // Omitted → full refund. A value that is present must be a positive amount:
  // 0, a negative number or a non-number used to silently become a full
  // refund. The frontend only sends amount when it is > 0.
  @IsOptional()
  @IsNumber({}, { message: 'Betrag muss eine Zahl sein' })
  @Min(0.0001, { message: 'Betrag muss größer als 0 sein' })
  @Max(DECIMAL_12_4_MAX, { message: 'Betrag darf höchstens 99999999.9999 sein' })
  amount?: number

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreditNoteLineDto)
  lines?: CreditNoteLineDto[]

  @IsOptional() @IsString() @MaxLength(1000)
  reason?: string
}
