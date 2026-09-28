/**
 * Tier 213 — request DTO for the UStVa create-expense
 * endpoint. Mirrors the UStVa expense (Eingangsrechnung
 * captured during the UStVa workflow). Same shape as the
 * standalone expense DTO (`CreateExpenseDto` in
 * expense/dto/expense.dto.ts) minus the validation that
 * runs there — the UStVa expense has a few more
 * flags (isIntraEU, isReverseCharge) that don't apply to
 * the general expense flow.
 */
import {
  IsString,
  IsOptional,
  IsNumber,
  IsDateString,
  IsBoolean,
  MinLength,
  MaxLength,
  Min,
  Max,
} from "class-validator"
import { Type, Transform } from "class-transformer"

/**
 * POST /ustva/expenses
 * Create an expense specifically for the UStVa flow.
 *
 * `vatAmount` and `grossAmount` are auto-computed
 * server-side if missing — the DTO accepts them as
 * optional numbers so the controller can fill in the
 * defaults. `vatRate` defaults to 0.19.
 */
export class CreateUstvaExpenseDto {
  @IsString()
  @MinLength(1, { message: "Beschreibung ist erforderlich" })
  @MaxLength(500)
  description!: string

  @IsDateString({}, { message: "invoiceDate is required (ISO date)" })
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
  @Max(9.9999)
  vatRate?: number

  @IsString() @IsOptional() @MaxLength(100)
  category?: string

  @IsOptional()
  @Transform(({ value }) => {
    if (typeof value === "string") {
      return value === "true" || value === "1"
    }
    return value
  })
  @IsBoolean()
  isIntraEU?: boolean

  @IsOptional()
  @Transform(({ value }) => {
    if (typeof value === "string") {
      return value === "true" || value === "1"
    }
    return value
  })
  @IsBoolean()
  isReverseCharge?: boolean

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

  @IsString() @IsOptional() @MaxLength(2000)
  notes?: string
}
