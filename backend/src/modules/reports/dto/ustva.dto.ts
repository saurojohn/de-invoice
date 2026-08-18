/**
 * Tier 213 — request DTOs for UstvaController.
 *
 * Replaces two `@Body() body: any` endpoints with
 * class-validator decorated DTOs so the global
 * ValidationPipe can reject unknown fields and
 * coerce types before the service layer runs.
 *
 * The German UStVa (Umsatzsteuervoranmeldung) is a
 * tax filing with strictly-defined lines per § 18
 * UStG. The DTO mirrors the field layout of the
 * service's `UstvaData` interface so the controller
 * can pass the body through unchanged after
 * ValidationPipe validation.
 */
import {
  IsString,
  IsOptional,
  IsNumber,
  IsInt,
  IsArray,
  IsIn,
  MinLength,
  MaxLength,
  Min,
  Max,
  ValidateNested,
} from "class-validator"
import { Type } from "class-transformer"

/**
 * One row in `salesByRate` (Umsätze nach Steuersatz).
 * Lines 20-23 of the official UStVa form.
 */
export class UstvaSalesByRateDto {
  @IsNumber() @Min(0) @Max(9.9999)
  rate!: number

  @IsString() @MaxLength(50)
  label!: string

  @IsNumber() @Min(0)
  net!: number

  @IsNumber() @Min(0)
  vat!: number
}

/**
 * Vorsteuer breakdown (input tax). Lines 50-66 of
 * the UStVa form.
 */
export class UstvaVorsteuerDto {
  @IsNumber() @Min(0)
  from19!: number

  @IsNumber() @Min(0)
  from7!: number

  @IsNumber() @Min(0)
  fromIgE!: number

  @IsNumber() @Min(0)
  fromReverseCharge!: number

  @IsNumber() @Min(0)
  total!: number
}

/**
 * Counts (informational, for the dashboard widget).
 */
export class UstvaCountsDto {
  @IsInt() @Min(0)
  invoices!: number

  @IsInt() @Min(0)
  expenses!: number
}

/**
 * The full UStVa shape — what the frontend
 * computed and the user is now saving as a draft
 * or submitting. Mirrors the service's `UstvaData`
 * interface field-for-field.
 */
export class UstvaDataDto {
  @IsString()
  companyId!: string

  @IsInt() @Min(2000) @Max(2100)
  year!: number

  @IsInt() @IsOptional() @Min(1) @Max(4)
  quarter?: number

  @IsInt() @IsOptional() @Min(1) @Max(12)
  month?: number

  @IsString() @MinLength(1) @MaxLength(50)
  periodLabel!: string

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => UstvaSalesByRateDto)
  salesByRate!: UstvaSalesByRateDto[]

  @IsNumber() @Min(0)
  igL!: number

  @IsNumber() @Min(0)
  export!: number

  @IsNumber() @Min(0)
  otherExempt!: number

  @IsNumber() @Min(0)
  reverseCharge!: number

  @ValidateNested()
  @Type(() => UstvaVorsteuerDto)
  vorsteuer!: UstvaVorsteuerDto

  @IsNumber() @Min(0)
  umsatzsteuer!: number

  @IsNumber() @Min(0)
  vorsteuerSum!: number

  /** Zahllast (positive) / Erstattung (negative). */
  @IsNumber()
  differenzbetrag!: number

  @ValidateNested()
  @Type(() => UstvaCountsDto)
  counts!: UstvaCountsDto
}

/**
 * POST /ustva/filings
 * Save (or submit) a UStVa filing. The shape is
 * `UstvaData` plus filing-level metadata
 * (taxNumber, notes, status).
 */
export class SaveUstvaFilingDto extends UstvaDataDto {
  @IsString() @IsOptional() @MaxLength(50)
  taxNumber?: string

  @IsString() @IsOptional() @MaxLength(2000)
  notes?: string

  @IsString() @IsOptional() @IsIn(['draft', 'submitted'])
  status?: 'draft' | 'submitted'
}
