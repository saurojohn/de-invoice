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
  Min,
  Max,
  MaxLength,
  ValidateIf,
} from "class-validator"
import { Type } from "class-transformer"

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
