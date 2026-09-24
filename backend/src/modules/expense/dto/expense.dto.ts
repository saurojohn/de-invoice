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


  @IsString() @IsOptional() @MaxLength(20)
  accountNumber?: string
}
