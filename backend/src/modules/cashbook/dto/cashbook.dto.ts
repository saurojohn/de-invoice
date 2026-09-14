/**
 * Tier 211 — request DTOs for CashbookController.
 *
 * Replaces `@Body() body: any` (update entry) with a
 * class-validator decorated DTO so the global
 * ValidationPipe can reject unknown fields and coerce
 * types before the service layer runs.
 *
 * Note: `vatRate: number | null` is special-cased —
 * `null` means "clear the field" (different from
 * `undefined` which means "leave unchanged"). We use
 * `@ValidateIf` to allow `null` through while still
 * rejecting other non-number values.
 */
import {
  IsString,
  IsOptional,
  IsNumber,
  IsIn,
  IsDateString,
  Min,
  Max,
  MaxLength,
  ValidateIf,
} from "class-validator"
import { Type } from "class-transformer"

// CashBookEntry.amount and the CashBookDailyClose sums are Decimal(12,4).
const DECIMAL_12_4_MAX = 99999999.9999
const ENTRY_TYPES = ["einnahme", "ausgabe", "umbuchung", "eroeffnung"] as const
const DATE_MESSAGE = "muss ein gültiges Datum sein (JJJJ-MM-TT)"

/**
 * Tier 374 — POST /cashbook/entries.
 *
 * The body was an intersection type, invisible to ValidationPipe. Measured
 * before: businessDate "abc" → 500 (Invalid Date), vatRate 19 → 500 and
 * amount 1e12 → 500 (numeric field overflow). Callers: cashbook page and
 * backend e2e 01–06. Description emptiness and amount <= 0 stay in the
 * service, whose German messages e2e 05 asserts ("Beschreibung", "Betrag").
 */
export class CreateCashBookEntryDto {
  @IsString() @IsOptional()
  createdById?: string

  @IsDateString({ strict: true }, { message: `businessDate ${DATE_MESSAGE}` })
  businessDate!: string

  @IsIn(ENTRY_TYPES, { message: `type must be one of ${ENTRY_TYPES.join(", ")}` })
  type!: (typeof ENTRY_TYPES)[number]

  @IsString() @MaxLength(500)
  description!: string

  @Type(() => Number)
  @IsNumber({}, { message: "Betrag muss eine Zahl sein" })
  @Max(DECIMAL_12_4_MAX, { message: "Betrag darf höchstens 99999999.9999 sein" })
  amount!: number

  // The page sends null for eroeffnung/umbuchung.
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(1, { message: "vatRate ist ein Anteil (z. B. 0.19), höchstens 1" })
  vatRate?: number | null

  @IsString() @IsOptional() @MaxLength(200)
  counterparty?: string | null

  @IsString() @IsOptional() @MaxLength(50)
  belegNumber?: string | null

  @IsString() @IsOptional()
  expenseId?: string | null

  @IsString() @IsOptional()
  invoiceId?: string | null

  @IsString() @IsOptional() @MaxLength(2000)
  notes?: string | null
}

/**
 * Tier 374 — POST /cashbook/entries/:id/reverse. `reason` stays optional
 * here so an empty one still gets the service's "Begründung ist
 * erforderlich" (asserted by e2e 03).
 */
export class ReverseCashBookEntryDto {
  @IsString() @IsOptional() @MaxLength(2000)
  reason?: string

  @IsString() @IsOptional()
  createdById?: string
}

/**
 * Tier 374 — POST /cashbook/close-day. Measured before: date "abc" → 500
 * (Invalid Date reached Prisma). physicalCount is bounded by the
 * Decimal(12,4) columns it lands in; it may be negative in principle only
 * through a counting error, so the range is symmetric.
 */
export class CloseCashBookDayDto {
  @IsDateString({ strict: true }, { message: `date ${DATE_MESSAGE}` })
  date!: string

  @IsNumber({}, { message: "physicalCount is required (number)" })
  @Min(-DECIMAL_12_4_MAX)
  @Max(DECIMAL_12_4_MAX)
  physicalCount!: number

  @IsString() @IsOptional()
  closedById?: string

  @IsString() @IsOptional() @MaxLength(2000)
  differenzNote?: string
}

/** Tier 374 — POST /cashbook/reopen-day. */
export class ReopenCashBookDayDto {
  @IsDateString({ strict: true }, { message: `date ${DATE_MESSAGE}` })
  date!: string
}

/**
 * PUT /cashbook/entries/:id
 * Patch an existing cash book entry. Every field is
 * optional — the service treats undefined as "leave
 * unchanged". `vatRate: null` is a valid value meaning
 * "clear the VAT rate".
 */
export class UpdateCashBookEntryDto {
  @IsString() @IsOptional() @MaxLength(500)
  description?: string

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  amount?: number

  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(1)
  vatRate?: number | null

  @IsString() @IsOptional() @MaxLength(200)
  counterparty?: string | null

  @IsString() @IsOptional() @MaxLength(50)
  belegNumber?: string | null

  @IsString() @IsOptional() @MaxLength(2000)
  notes?: string | null
}
