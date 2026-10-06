import { IsDateString, IsIn, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator'
import { COMPANY_CAR_METHODS } from './private-use'

/** Tier 502: POST /company-cars */
export class CreateCompanyCarDto {
  @IsString() @MaxLength(100)
  name!: string

  /** gross list price at first registration */
  @IsNumber() @Min(1000) @Max(9999999)
  listPrice!: number

  @IsIn(COMPANY_CAR_METHODS as unknown as string[])
  method!: string

  @IsDateString()
  fromDate!: string

  @IsOptional() @IsDateString()
  untilDate?: string | null

  /** Tier 541: one-way distance home – business in km (none: no such trips) */
  @IsOptional() @IsInt() @Min(1) @Max(500)
  commuteKm?: number | null

  /** Tier 541: days per month with that trip (default 15) */
  @IsOptional() @IsInt() @Min(0) @Max(31)
  commuteDays?: number | null
}

/** Tier 502: PUT /company-cars/:id — the end of private use (sold, given back). */
export class EndCompanyCarDto {
  @IsOptional() @IsDateString()
  untilDate?: string | null

  /** Tier 541: the trips home – business can be set or changed later (null: none) */
  @IsOptional() @IsInt() @Min(1) @Max(500)
  commuteKm?: number | null

  @IsOptional() @IsInt() @Min(0) @Max(31)
  commuteDays?: number | null
}
