/**
 * Tier 211 — request DTOs for VatRateController.
 *
 * Replaces `@Body() data: any` with class-validator
 * decorated DTOs so the global ValidationPipe can
 * reject unknown fields and coerce types before the
 * service layer runs.
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
} from "class-validator"
import { Type } from "class-transformer"

/**
 * POST /vat-rates
 * Create a new VAT rate (or a per-company override
 * when companyId is provided).
 */
export class CreateVatRateDto {
  @IsString() @IsOptional() @MaxLength(50)
  companyId?: string

  @IsString()
  @MinLength(1)
  @MaxLength(2)
  countryCode!: string

  /**
   * Decimal rate — stored as DECIMAL(5,4) in Prisma,
   * so max value is 9.9999 (i.e. 999.99%). 0..1
   * covers the realistic 0% / 7% / 19% / 20% range.
   */
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(9.9999)
  rate!: number

  @IsString()
  @MinLength(1)
  @MaxLength(50)
  rateType!: string

  @IsString() @IsOptional() @MaxLength(200)
  name?: string

  @IsDateString()
  effectiveFrom!: string

  @IsDateString() @IsOptional()
  effectiveTo?: string

  @IsString() @IsOptional() @MaxLength(2000)
  description?: string

  @IsString() @IsOptional() @MaxLength(50)
  createdById?: string
}
