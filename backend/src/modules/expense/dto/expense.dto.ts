/**
 * Tier 211 — request DTOs for ExpenseController.
 *
 * Replaces `@Body() data: any` with class-validator
 * decorated DTOs so the global ValidationPipe can
 * reject unknown fields and coerce types before the
 * service layer runs. The service still does its
 * own `if (!data.description)` fallback for the case
 * when the pipe is bypassed (tests, internal calls,
 * cron).
 */
import {
  IsString,
  IsOptional,
  IsNumber,
  IsDateString,
  MinLength,
  MaxLength,
  Min,
  Max,
  IsBoolean,
  ValidateIf,
} from "class-validator"
import { Type, Transform } from "class-transformer"

/**
 * POST /expenses
 * Create a new expense (Eingangsrechnung / Beleg).
 */
export class CreateExpenseDto {
  @IsString()
  @MinLength(1, { message: "Beschreibung ist erforderlich" })
  @MaxLength(500)
  description!: string

  @IsDateString({}, { message: "Rechnungsdatum ist erforderlich (ISO date)" })
  invoiceDate!: string

  @IsString() @IsOptional() @MaxLength(50)
  invoiceNumber?: string

  @IsString() @IsOptional()
  supplierId?: string

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  netAmount?: number

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  vatAmount?: number

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  grossAmount?: number

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(1)
  vatRate?: number

  @IsString() @IsOptional() @MaxLength(100)
  category?: string

  // Tier 442: a supplier credit note — amounts entered positive, stored negative
  // (expense/credit-note.ts).
  @IsOptional()
  @Transform(({ value }) => (typeof value === "string" ? value === "true" || value === "1" : value))
  @IsBoolean()
  creditNote?: boolean

  // Tier 454: the day it was paid, when that was not through the bank import,
  // the SEPA run or the cash book (card, private account) — the EÜR counts an
  // expense when it is paid (§ 11 EStG).
  @IsOptional() @IsDateString({}, { message: "Bezahlt am muss ein Datum sein (ISO date)" })
  paidAt?: string

  @IsString() @IsOptional() @MaxLength(20)
  accountNumber?: string
}

/**
 * Tier 443 — PUT /expenses/:id and PUT /ustva/expenses/:id.
 * Every field optional; amounts are entered positive as on create, a credit
 * note keeps its sign unless `creditNote` says otherwise.
 */
export class UpdateExpenseDto {
  @IsOptional() @IsString() @MinLength(1, { message: "Beschreibung ist erforderlich" }) @MaxLength(500)
  description?: string

  @IsOptional() @IsDateString({}, { message: "Rechnungsdatum muss ein Datum sein (ISO date)" })
  invoiceDate?: string

  @IsString() @IsOptional() @MaxLength(50)
  invoiceNumber?: string

  // "" clears the supplier (the UStVA page's empty select).
  @IsString() @IsOptional()
  supplierId?: string

  @IsOptional() @Type(() => Number) @IsNumber() @Min(0)
  netAmount?: number

  @IsOptional() @Type(() => Number) @IsNumber() @Min(0)
  vatAmount?: number

  @IsOptional() @Type(() => Number) @IsNumber() @Min(0)
  grossAmount?: number

  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) @Max(1)
  vatRate?: number

  @IsString() @IsOptional() @MaxLength(100)
  category?: string

  @IsString() @IsOptional() @MaxLength(20)
  accountNumber?: string

  @IsOptional()
  @Transform(({ value }) => (typeof value === "string" ? value === "true" || value === "1" : value))
  @IsBoolean()
  isIntraEU?: boolean

  @IsOptional()
  @Transform(({ value }) => (typeof value === "string" ? value === "true" || value === "1" : value))
  @IsBoolean()
  isReverseCharge?: boolean

  @IsOptional()
  @Transform(({ value }) => (typeof value === "string" ? value === "true" || value === "1" : value))
  @IsBoolean()
  creditNote?: boolean

  @IsString() @IsOptional() @MaxLength(2000)
  notes?: string

  // Tier 454: the payment date entered by hand; null takes it out. A payment
  // through the bank, SEPA or the cash book is taken back there instead.
  @ValidateIf((o) => o.paidAt !== null && o.paidAt !== undefined)
  @IsDateString({}, { message: "Bezahlt am muss ein Datum sein (ISO date)" })
  paidAt?: string | null
}
